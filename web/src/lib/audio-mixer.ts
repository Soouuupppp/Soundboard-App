"use client";

// MicMixer — the unified always-on audio engine (1.4.0 routing refactor).
//
// It owns a single AudioContext that is active in ALL modes (not just Virtual
// Mic): every soundboard play and — when Virtual Mic mode is on — the live mic
// flow through it, so per-clip effects are heard on normal output AND the cable.
// There is no separate normal-mode graph anymore. Output routing is always via
// ctx.setSinkId (needs Chromium 110+); callers degrade to a plain <audio> path
// when AudioContext.setSinkId is absent (no engine, no FX, no meter).
//
// Signal flow:
//
//   Soundboard clip(s) ─► [per-id FX chain] ─► soundboardBus(SB vol) ─┐
//                                                                      ├─► outputBus(global) ─► limiter ─► ctx.destination ─►(setSinkId) OUTPUT device
//   mic ─► micGate(AI mute) ─► (input vol) ─► [mic FX chain] ─► micBus(mic vol) ─┘   (mic exists only while Virtual Mic mode is on)
//   AI converted clip ─► (input vol) ─► [mic FX chain] ──────────────┘   (injected after micGate, so the raw-mic mute doesn't kill it)
//
//   soundboardBus ─► soundboardMonitorGate ──────────────────────────► monitorBus(global) ─► monitor tail ─►(setSinkId) MONITOR device
//   micBus ─► monitorMicGate(monitor-mic toggle) ────────────────────►
//   Preview clip ───────────────────────────────────────────────────►   (previews connect to monitorBus ONLY — never the cable/output)
//
// soundboardMonitorGate is 0 when the monitor device == the output device (the
// common default/default case) so a board play isn't heard twice on one device,
// and 1 when they differ so you still monitor the soundboard on a SEPARATE device.
// Previews connect to monitorBus directly (after the gate) so they stay audible
// even when monitor == output.
//
// Volume hierarchy (all 0..2, default 1): GLOBAL output is the master gain on
// both outputBus and monitorBus; SOUNDBOARD output (soundboardBus) and MIC output
// (micBus) are the two sub-bus levels under it. Per-clip / per-input volumes stay
// 0..1. The limiter sits on the output path so a hot sum (mic + clips, possibly
// >100% gains) can't hard-clip the virtual mic; the analyser taps the pre-limiter
// sum so the UI meter can warn about clipping.
//
// Monitoring: the soundboard is monitored locally via soundboardMonitorGate
// (soundboardBus → gate → monitorBus); the mic reaches the monitor only when the
// monitor-mic toggle opens monitorMicGate.
//
// Sources that can feed the cable in Virtual Mic mode:
//   • INPUT lines  — any capture device Windows reports, captured with
//     getUserMedia (physical mics, virtual-cable recording sides, GoXLR buses).
//     Routing "any audio" into the mic is done by sending that audio to a cable /
//     GoXLR bus in Windows, which then shows up here as a capture device.
//   • SOUNDBOARD   — clips injected with injectClip().

import {
  type EffectConfig,
  type EffectParams,
  type Effect,
  createEffect,
  chainNeedsWorklet,
  ensureWorkletModules,
} from "./voice-fx";

export type MixerInputState = { deviceId: string; enabled: boolean; volume: number };

// Stable key for the soundboard line in the monitor selection.
export const SOUNDBOARD_KEY = "__soundboard__";

// Per-source DSP effect chain (voice changer). `out` is the raw source node
// (an input's volume gain); `tail` is the chain output that feeds the sub-bus +
// meter; `effects` is the live series of effect subgraphs (head = effects[0].input,
// or `tail` itself when empty).
type SourceChain = {
  out: AudioNode;
  tail: GainNode;
  effects: Effect[];
};

type ActiveInput = {
  stream: MediaStream;
  src: MediaStreamAudioSourceNode;
  // Gate the RAW mic only (src → micGate → gain): zeroed when the AI voice
  // changer owns this device, so the live mic is removed from the cable+monitor
  // while injected converted clips (which connect after the gate) still pass.
  micGate: GainNode;
  gain: GainNode;
  // Chain output node — the micBus + meter taps hang off this.
  tail: GainNode;
  // Post-chain tap so each row meter shows its processed contribution.
  analyser: AnalyserNode;
  peakBuf: Float32Array<ArrayBuffer>;
};

type AudioWithSink = HTMLAudioElement & {
  setSinkId?: (id: string) => Promise<void>;
};

type SinkCapableContext = AudioContext & {
  setSinkId?: (id: string) => Promise<void>;
};

export type InjectedClip = {
  gain: GainNode;
  stop: () => void;
};

const mlog = (...args: unknown[]) =>
  console.log("%c[sb-mixer]", "color:#22c55e;font-weight:bold", ...args);
const mwarn = (...args: unknown[]) =>
  console.warn("%c[sb-mixer]", "color:#e0a000;font-weight:bold", ...args);

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

// Bus/master gains run 0..2 (0–200%) so the user can boost above unity. The
// limiter protects the cable; >100% can distort normal output/monitor.
function clamp02(v: number) {
  return Math.max(0, Math.min(2, v));
}

function perfNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// Monitor watchdog tuning. The monitor tail (monitorBus → MediaStreamDestination
// → <audio>) accrues jitter-buffer latency over long uptime; rebuilding it resets
// the buffer to ~0. We poll on this cadence and treat a tick that arrives far
// later than scheduled as evidence the audio graph was suspended (PC sleep/resume
// or heavy background-tab throttling) — both known to fatten the buffer.
const MONITOR_WATCHDOG_INTERVAL_MS = 5000;
const MONITOR_STALE_GAP_MS = 12000;
// Debounce so a suspend→resume that fires both the statechange listener and the
// watchdog tick doesn't rebuild (and risk a click) twice in a row.
const MONITOR_REBUILD_DEBOUNCE_MS = 1000;

// Read the max absolute sample currently in an analyser's time-domain buffer,
// as a linear 0..1+ peak (can exceed 1 when a signal is driving past 0 dBFS).
function peakOf(analyser: AnalyserNode | null, buf: Float32Array<ArrayBuffer> | null): number {
  if (!analyser || !buf) return 0;
  analyser.getFloatTimeDomainData(buf);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

export class MicMixer {
  private ctx: SinkCapableContext | null = null;
  // Global master on the combined sum → limiter → cable/output device.
  private outputBus: GainNode | null = null;
  // Brickwall-ish limiter on the output so the summed sources can't clip the mic.
  private limiter: DynamicsCompressorNode | null = null;
  // Taps the pre-limiter output sum to drive the UI peak meter.
  private outputAnalyser: AnalyserNode | null = null;
  private peakBuf: Float32Array<ArrayBuffer> | null = null;
  // Global master on the monitor path → monitor device (separate from output).
  private monitorBus: GainNode | null = null;
  private monitorDest: MediaStreamAudioDestinationNode | null = null;
  private monitorEl: AudioWithSink | null = null;
  // Soundboard sub-bus (SB output level). Clips inject here; fans to output+monitor.
  private soundboardBus: GainNode | null = null;
  // Gate between soundboardBus and monitorBus: 0 when monitor==output device (avoid
  // double-play on one device), 1 when they differ (monitor the board separately).
  private soundboardMonitorGate: GainNode | null = null;
  // Mic sub-bus (mic output level): every input tail sums here; fans to output +
  // (monitorMicGate)→monitor.
  private micBus: GainNode | null = null;
  // Single gate that adds the mic to the local monitor (monitor-mic toggle).
  private monitorMicGate: GainNode | null = null;

  private inputs = new Map<string, ActiveInput>();
  // Per-source effect chains (mic FX), keyed by deviceId.
  private chains = new Map<string, SourceChain>();
  // Desired effect configs per source key, kept so a device that reopens rebuilds
  // its chain. Survives reconcileInputs.
  private sourceEffects = new Map<string, EffectConfig[]>();
  // Capture devices whose raw mic is muted because the AI voice changer owns them
  // (PTT-only). Persisted across reopen like sourceEffects.
  private aiMuted = new Map<string, boolean>();
  private outputDeviceId = "default";
  private monitorDeviceId = "default";
  // Volume hierarchy (0..2). Stored so start() can apply them on (re)create.
  private globalVolume = 1;
  private soundboardVolume = 1;
  private micVolume = 1;
  private monitorMicOn = false;
  // Serialize source reconciliation so overlapping calls can't double-open one.
  private syncChain: Promise<unknown> = Promise.resolve();

  // Monitor-latency watchdog (see MONITOR_* constants above). The interval
  // detects long wall-clock gaps (sleep/throttle); the statechange listener
  // catches an explicit AudioContext suspend→resume. Both rebuild the monitor
  // tail so its jitter buffer can't drift seconds behind the real-time output.
  private monitorWatchdog: ReturnType<typeof setInterval> | null = null;
  private lastWatchdogTick = 0;
  private lastMonitorRebuild = 0;
  private onCtxStateChange: (() => void) | null = null;
  private lastCtxState: AudioContextState | null = null;

  isReady() {
    return this.ctx !== null;
  }

  // Current peak amplitude of the pre-limiter output sum, linear 0..1+ (can exceed
  // 1.0 when driving the limiter into clipping). Cheap enough to poll per frame.
  getOutputPeak(): number {
    return peakOf(this.outputAnalyser, this.peakBuf);
  }
  // Back-compat alias (the "cable" meter is the same pre-limiter output sum).
  getCablePeak(): number {
    return this.getOutputPeak();
  }

  // Current peak amplitude of a single live input (post chain), linear 0..1+.
  // Returns 0 if that input isn't open. Cheap enough to poll per frame.
  getInputPeak(deviceId: string): number {
    const n = this.inputs.get(deviceId);
    return n ? peakOf(n.analyser, n.peakBuf) : 0;
  }

  async start(outputDeviceId: string) {
    if (this.ctx) return;
    mlog("start: creating AudioContext, outputDeviceId =", outputDeviceId || "(default)");
    const ctx = new AudioContext() as SinkCapableContext;

    // Output path: global master → limiter → destination.
    const outputBus = ctx.createGain();
    outputBus.gain.value = this.globalVolume;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    outputBus.connect(limiter);
    limiter.connect(ctx.destination);
    // Pre-limiter tap for the meter (true incoming peak, not the limited output).
    const outputAnalyser = ctx.createAnalyser();
    outputAnalyser.fftSize = 1024;
    outputBus.connect(outputAnalyser);

    // Monitor path: global master → (rebuildable) tail → monitor device.
    const monitorBus = ctx.createGain();
    monitorBus.gain.value = this.globalVolume;

    // Sub-buses.
    const soundboardBus = ctx.createGain();
    soundboardBus.gain.value = this.soundboardVolume;
    const micBus = ctx.createGain();
    micBus.gain.value = this.micVolume;
    const monitorMicGate = ctx.createGain();
    monitorMicGate.gain.value = this.monitorMicOn ? 1 : 0;
    const soundboardMonitorGate = ctx.createGain();
    soundboardMonitorGate.gain.value = this.soundboardMonitorGateValue();

    // Fan-out: soundboard → output + (gate) monitor; mic → output + (gate) monitor.
    soundboardBus.connect(outputBus);
    soundboardBus.connect(soundboardMonitorGate).connect(monitorBus);
    micBus.connect(outputBus);
    micBus.connect(monitorMicGate).connect(monitorBus);

    this.ctx = ctx;
    this.outputBus = outputBus;
    this.limiter = limiter;
    this.outputAnalyser = outputAnalyser;
    this.peakBuf = new Float32Array(new ArrayBuffer(outputAnalyser.fftSize * 4));
    this.monitorBus = monitorBus;
    this.soundboardBus = soundboardBus;
    this.soundboardMonitorGate = soundboardMonitorGate;
    this.micBus = micBus;
    this.monitorMicGate = monitorMicGate;
    this.outputDeviceId = outputDeviceId;

    mlog("start: state =", ctx.state, "| setSinkId available =", typeof ctx.setSinkId === "function");
    await this.applyOutputSink(outputDeviceId);
    // Build the monitor tail (dest + <audio>), route it, and start it.
    this.rebuildMonitorTail(true);
    try {
      await ctx.resume();
    } catch {
      /* may stay suspended until a gesture */
    }
    mlog("start: ready, state =", ctx.state);
    this.armResumeOnGesture();
    this.startMonitorWatchdog();
  }

  // (Re)create the monitor tail: monitorBus → MediaStreamDestination → <audio>.
  // The monitorBus stays put; only this tail is swapped, which resets the bridge's
  // jitter buffer to ~0. Builds the new tail before retiring the old one and
  // re-applies the monitor sink, so the device selection is preserved and the swap
  // is as gapless as possible. The output path is never touched.
  private rebuildMonitorTail(force = false) {
    const ctx = this.ctx;
    const monitorBus = this.monitorBus;
    if (!ctx || !monitorBus) return;
    const now = perfNow();
    if (!force && now - this.lastMonitorRebuild < MONITOR_REBUILD_DEBOUNCE_MS) return;
    this.lastMonitorRebuild = now;

    const oldDest = this.monitorDest;
    const oldEl = this.monitorEl;

    const dest = ctx.createMediaStreamDestination();
    const el = new Audio() as AudioWithSink;
    el.srcObject = dest.stream;
    monitorBus.connect(dest);
    this.monitorDest = dest;
    this.monitorEl = el;
    void this.applyMonitorSink(this.monitorDeviceId).then(() => {
      el.play().catch(() => {
        /* may be blocked until a gesture; armResumeOnGesture retries */
      });
    });

    if (oldDest) {
      try { monitorBus.disconnect(oldDest); } catch { /* ignore */ }
      try { oldDest.disconnect(); } catch { /* ignore */ }
    }
    if (oldEl) {
      try {
        oldEl.pause();
        oldEl.srcObject = null;
      } catch { /* ignore */ }
    }
  }

  // Arm the watchdog: a poll that rebuilds the monitor tail after a long
  // wall-clock gap (sleep/resume, background throttle), plus a statechange
  // listener that rebuilds on an explicit suspend→resume.
  private startMonitorWatchdog() {
    const ctx = this.ctx;
    if (!ctx) return;
    this.lastCtxState = ctx.state;
    this.onCtxStateChange = () => {
      const s = ctx.state;
      if (s === "running" && this.lastCtxState !== "running") {
        mlog("monitor watchdog: context resumed — rebuilding monitor tail");
        this.rebuildMonitorTail();
      }
      this.lastCtxState = s;
    };
    ctx.addEventListener("statechange", this.onCtxStateChange);

    this.lastWatchdogTick = perfNow();
    this.monitorWatchdog = setInterval(() => {
      const now = perfNow();
      const gap = now - this.lastWatchdogTick;
      this.lastWatchdogTick = now;
      if (gap > MONITOR_STALE_GAP_MS) {
        mlog("monitor watchdog:", Math.round(gap), "ms gap — rebuilding monitor tail");
        this.rebuildMonitorTail();
      }
    }, MONITOR_WATCHDOG_INTERVAL_MS);
  }

  private async applyOutputSink(deviceId: string) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (typeof ctx.setSinkId !== "function") {
      throw new Error("AudioContext.setSinkId is unavailable (needs Chromium 110+).");
    }
    const target = deviceId && deviceId !== "default" ? deviceId : "";
    await ctx.setSinkId(target);
    mlog("applyOutputSink: routed output to", target ? target.slice(0, 8) : "(system default)");
  }

  private async applyMonitorSink(deviceId: string) {
    const el = this.monitorEl;
    if (!el) return;
    const target = deviceId && deviceId !== "default" ? deviceId : "";
    if (target && typeof el.setSinkId === "function") {
      await el.setSinkId(target).catch((e) =>
        mwarn("monitor setSinkId failed", target.slice(0, 8), (e as Error)?.message),
      );
    } else if (typeof el.setSinkId === "function") {
      await el.setSinkId("").catch(() => {});
    }
  }

  // If the context started suspended (no user gesture yet), resume it — and retry
  // any monitor playback that autoplay blocked — on the first interaction.
  private armResumeOnGesture() {
    const ctx = this.ctx;
    if (!ctx || typeof window === "undefined") return;
    if (ctx.state !== "suspended") return;
    const resume = () => {
      ctx.resume().catch(() => {});
      this.monitorEl?.play().catch(() => {});
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
    };
    window.addEventListener("pointerdown", resume, { once: true });
    window.addEventListener("keydown", resume, { once: true });
  }

  // 0 when the monitor and output devices are the same (board play would be heard
  // twice on one device), 1 when they differ (monitor the board on its own device).
  private soundboardMonitorGateValue(): number {
    return this.monitorDeviceId === this.outputDeviceId ? 0 : 1;
  }
  private recomputeSoundboardMonitorGate() {
    if (this.soundboardMonitorGate) {
      this.soundboardMonitorGate.gain.value = this.soundboardMonitorGateValue();
    }
  }

  async setOutputDevice(deviceId: string) {
    this.outputDeviceId = deviceId;
    this.recomputeSoundboardMonitorGate();
    if (this.ctx) await this.applyOutputSink(deviceId);
  }

  async setMonitorDevice(deviceId: string) {
    this.monitorDeviceId = deviceId;
    this.recomputeSoundboardMonitorGate();
    if (this.ctx) await this.applyMonitorSink(deviceId);
  }

  // Global master (0..2) on both output and monitor.
  setGlobalVolume(volume: number) {
    this.globalVolume = clamp02(volume);
    if (this.outputBus) this.outputBus.gain.value = this.globalVolume;
    if (this.monitorBus) this.monitorBus.gain.value = this.globalVolume;
  }

  // Soundboard sub-bus level (0..2).
  setSoundboardVolume(volume: number) {
    this.soundboardVolume = clamp02(volume);
    if (this.soundboardBus) this.soundboardBus.gain.value = this.soundboardVolume;
  }

  // Mic sub-bus level (0..2).
  setMicVolume(volume: number) {
    this.micVolume = clamp02(volume);
    if (this.micBus) this.micBus.gain.value = this.micVolume;
  }

  // Add/remove the mic from the local monitor (monitor-mic toggle).
  setMonitorMic(on: boolean) {
    this.monitorMicOn = on;
    if (this.monitorMicGate) this.monitorMicGate.gain.value = on ? 1 : 0;
  }

  // Wire a freshly-created input source: build its effect chain (out → [fx…] →
  // tail), then sum the tail into micBus. Returns the tail so the caller can hang
  // a meter analyser off it.
  private connectSource(out: AudioNode, key: string): { tail: GainNode } {
    const ctx = this.ctx!;
    const tail = ctx.createGain();
    const configs = this.sourceEffects.get(key) ?? [];
    const effects = this.buildChain(out, tail, configs);
    this.chains.set(key, { out, tail, effects });
    tail.connect(this.micBus!);

    // If the chain wants a worklet-backed effect whose module isn't loaded yet, the
    // nodes built above fell back to passthroughs — load the module(s), rebuild once.
    if (chainNeedsWorklet(configs)) {
      ensureWorkletModules(ctx, configs).then(
        () => {
          const c = this.chains.get(key);
          if (c) this.rebuildChain(c, this.sourceEffects.get(key) ?? []);
        },
        () => { /* worklet unavailable — passthrough stays */ },
      );
    }
    return { tail };
  }

  // Wire out → e0 → e1 → … → tail in series (or out → tail when no effects).
  private buildChain(out: AudioNode, tail: GainNode, configs: EffectConfig[]): Effect[] {
    const ctx = this.ctx!;
    const effects = configs.map((c) => createEffect(ctx, c));
    let node: AudioNode = out;
    for (const e of effects) {
      node.connect(e.input);
      node = e.output;
    }
    node.connect(tail);
    return effects;
  }

  // Live-update a single effect's params without rebuilding the chain (smooth
  // for slider drags). Positional — index matches the configs array.
  updateEffectParams(key: string, index: number, params: EffectParams) {
    const e = this.chains.get(key)?.effects[index];
    if (e) e.update(params);
  }

  // Replace a source's effect configuration. Persisted in sourceEffects so a
  // reopened device rebuilds it; rebuilt live (make-before-break) if active.
  setSourceEffects(key: string, configs: EffectConfig[]) {
    this.sourceEffects.set(key, configs);
    const chain = this.chains.get(key);
    const ctx = this.ctx;
    if (!chain || !ctx) {
      mwarn(
        "setSourceEffects: no live chain for",
        key === SOUNDBOARD_KEY ? "soundboard" : key.slice(0, 8),
        `— ${configs.length} effect(s) saved but NOT applied (source not open in the mixer).`,
      );
      return;
    }
    mlog(
      "setSourceEffects:",
      key.slice(0, 8),
      "→",
      configs.length,
      "effect(s):",
      configs.map((c) => c.kind).join(" → ") || "(none)",
    );
    const build = () => {
      const c = this.chains.get(key);
      if (c) this.rebuildChain(c, configs);
    };
    if (chainNeedsWorklet(configs)) ensureWorkletModules(ctx, configs).then(build, build);
    else build();
  }

  // Whether a source currently has a live effect chain (i.e. it's open in the
  // mixer). Lets the UI flag "effects won't apply until you enable this source".
  hasLiveChain(key: string): boolean {
    return this.chains.has(key);
  }

  // Rebuild a chain in place, make-before-break (mirrors rebuildMonitorTail): wire
  // the NEW series into the same tail, then splice the source off the OLD head and
  // dispose the old effects. The brief overlap avoids a silent gap/click.
  private rebuildChain(chain: SourceChain, configs: EffectConfig[]) {
    if (!this.ctx) return;
    const oldEffects = chain.effects;
    const oldHead: AudioNode = oldEffects.length ? oldEffects[0].input : chain.tail;
    const newEffects = this.buildChain(chain.out, chain.tail, configs);
    const newHead: AudioNode = newEffects.length ? newEffects[0].input : chain.tail;
    if (oldHead !== newHead) {
      try { chain.out.disconnect(oldHead); } catch { /* already gone */ }
    }
    for (const e of oldEffects) {
      try { e.dispose(); } catch { /* ignore */ }
    }
    chain.effects = newEffects;
  }

  // Tear down a source's chain (effects + tail) and forget it. Leaves the
  // persisted sourceEffects config intact so a reopen rebuilds it.
  private disposeChain(key: string) {
    const chain = this.chains.get(key);
    if (!chain) return;
    for (const e of chain.effects) {
      try { e.dispose(); } catch { /* ignore */ }
    }
    try { chain.tail.disconnect(); } catch { /* ignore */ }
    this.chains.delete(key);
  }

  // Reconcile live mic inputs with the desired state. Calls are queued so two
  // reconciles can't race into opening the same device twice. Pass [] to close
  // every input (e.g. when Virtual Mic mode turns off) without stopping the engine.
  syncInputs(desired: MixerInputState[]): Promise<void> {
    const run = () => this.reconcileInputs(desired);
    this.syncChain = this.syncChain.then(run, run);
    return this.syncChain as Promise<void>;
  }

  // Open a capture device, preferring an exact deviceId match but falling back to
  // a relaxed (ideal) constraint when the driver rejects `exact`.
  private async openDeviceStream(deviceId: string): Promise<MediaStream> {
    const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false } as const;
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: deviceId ? { exact: deviceId } : undefined, ...base },
      });
    } catch (e) {
      const name = (e as Error)?.name;
      if (name !== "OverconstrainedError" && name !== "NotFoundError") throw e;
      mwarn(
        "exact deviceId rejected for",
        deviceId.slice(0, 8),
        `(${name}) — retrying with a relaxed constraint`,
      );
      return navigator.mediaDevices.getUserMedia({
        audio: { deviceId: deviceId ? { ideal: deviceId } : undefined, ...base },
      });
    }
  }

  private async reconcileInputs(desired: MixerInputState[]) {
    if (!this.ctx || !this.micBus) return;
    const wanted = new Set(desired.filter((d) => d.enabled).map((d) => d.deviceId));

    for (const [id, node] of this.inputs) {
      if (!wanted.has(id)) {
        node.stream.getTracks().forEach((t) => t.stop());
        node.src.disconnect();
        node.micGate.disconnect();
        node.gain.disconnect();
        node.analyser.disconnect();
        this.disposeChain(id);
        this.inputs.delete(id);
      }
    }

    for (const d of desired) {
      if (!d.enabled) continue;
      const existing = this.inputs.get(d.deviceId);
      if (existing) {
        existing.gain.gain.value = clamp01(d.volume);
        continue;
      }
      try {
        mlog("opening input mic", d.deviceId.slice(0, 8), "vol", d.volume);
        const stream = await this.openDeviceStream(d.deviceId);
        if (!this.ctx || !this.micBus) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        // The relaxed fallback (or a "Default - …" alias) can resolve to a device
        // that's ALREADY open under another key — summing the same mic twice would
        // comb-filter/echo on the cable. If so, drop this duplicate.
        const actualId = stream.getAudioTracks()[0]?.getSettings().deviceId;
        if (actualId && actualId !== d.deviceId) {
          const dupeKey = [...this.inputs].find(([, n]) =>
            n.stream.getAudioTracks()[0]?.getSettings().deviceId === actualId,
          )?.[0];
          if (dupeKey) {
            mwarn(
              "input",
              d.deviceId.slice(0, 8),
              "resolved to the same device as",
              dupeKey.slice(0, 8),
              "— dropping the duplicate to avoid echo",
            );
            stream.getTracks().forEach((t) => t.stop());
            continue;
          }
        }
        const src = this.ctx.createMediaStreamSource(stream);
        // micGate gates the RAW mic only; injected AI clips connect after it.
        const micGate = this.ctx.createGain();
        micGate.gain.value = this.aiMuted.get(d.deviceId) ? 0 : 1;
        const gain = this.ctx.createGain();
        gain.gain.value = clamp01(d.volume);
        src.connect(micGate).connect(gain);
        // Build the source's effect chain: gain → [fx…] → tail → micBus.
        const { tail } = this.connectSource(gain, d.deviceId);
        // Post-CHAIN meter tap off the tail (analysis only) so the row meter
        // reflects the processed signal.
        const analyser = this.ctx.createAnalyser();
        analyser.fftSize = 1024;
        tail.connect(analyser);
        const peakBuf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
        this.inputs.set(d.deviceId, { stream, src, micGate, gain, tail, analyser, peakBuf });
        mlog("input mic open OK", d.deviceId.slice(0, 8));
      } catch (e) {
        mwarn("could not open input", d.deviceId.slice(0, 8), (e as Error)?.name, (e as Error)?.message);
      }
    }
  }

  setInputVolume(deviceId: string, volume: number) {
    const n = this.inputs.get(deviceId);
    if (n) n.gain.gain.value = clamp01(volume);
  }

  // Mute/unmute a capture device's RAW mic (AI voice changer owns it: only its
  // injected converted clips should reach the cable). Persisted so a reopen
  // reapplies it. Injected clips connect after the gate, so they still pass.
  setSourceAiMuted(deviceId: string, muted: boolean) {
    this.aiMuted.set(deviceId, muted);
    const n = this.inputs.get(deviceId);
    if (n) n.micGate.gain.value = muted ? 0 : 1;
  }

  // The live MediaStream for a capture device (so PTT can record from the same
  // capture the mixer already opened). Null if the device isn't active.
  getSourceStream(deviceId: string): MediaStream | null {
    return this.inputs.get(deviceId)?.stream ?? null;
  }

  // Inject a converted AI clip into a capture device's path so it flows through
  // that source's DSP chain (and the input volume) before the cable/monitor — the
  // "DSP + AI coexist" requirement. Falls back to the soundboard line if the
  // device isn't open. Mirrors injectClip's lifecycle.
  injectClipToSource(deviceId: string, url: string, volume: number, onEnded: () => void): InjectedClip | null {
    const node = this.inputs.get(deviceId);
    if (!this.ctx || !node) return this.injectClip(url, volume, onEnded);
    // node.gain is the chain head; connecting here means the clip passes through
    // the volume gain → effect chain → tail → micBus (after the raw-mic gate).
    const dest = node.gain;
    return this.injectInto(dest, url, volume, onEnded);
  }

  // Make sure a per-clip chain's worklet deps (only the bitcrusher) are loaded so
  // the next injectClip builds the real node instead of a passthrough. Call when a
  // sound's effect config is set/loaded; play() itself stays synchronous.
  preloadEffects(configs: EffectConfig[]) {
    if (this.ctx && chainNeedsWorklet(configs)) ensureWorkletModules(this.ctx, configs).catch(() => {});
  }

  // Inject a soundboard clip into the soundboard sub-bus, through an optional
  // PER-CLIP effect chain (1.4.0 per-id Sound Effects). The backing <audio> output
  // is consumed by Web Audio, so it does NOT also play to the default device —
  // local playback happens via the always-on soundboard monitor send.
  injectClip(url: string, volume: number, onEnded: () => void, effects?: EffectConfig[]): InjectedClip | null {
    if (!this.ctx || !this.soundboardBus) return null;
    return this.injectInto(this.soundboardBus, url, volume, onEnded, effects);
  }

  // Inject a PREVIEW clip onto the monitor bus ONLY — never the output/cable — so
  // Saved/public/admin previews are heard locally but don't leak into the game mic.
  // Still honours the clip's per-id effect chain so a preview sounds like the play.
  injectPreview(url: string, volume: number, onEnded: () => void, effects?: EffectConfig[]): InjectedClip | null {
    if (!this.ctx || !this.monitorBus) return null;
    return this.injectInto(this.monitorBus, url, volume, onEnded, effects);
  }

  // Shared clip-injection helper: <audio> → MediaElementSource → gain → [fx…] →
  // dest. The optional effect chain is built fresh per play (read from the per-id
  // config at trigger time) and disposed on end/stop alongside the source.
  private injectInto(
    dest: AudioNode,
    url: string,
    volume: number,
    onEnded: () => void,
    effects?: EffectConfig[],
  ): InjectedClip | null {
    if (!this.ctx) return null;
    const ctx = this.ctx;
    const el = new Audio(url);
    el.preload = "auto";
    const src = ctx.createMediaElementSource(el);
    const gain = ctx.createGain();
    gain.gain.value = clamp01(volume);
    src.connect(gain);
    // Build the per-clip chain (gain → fx₀ → … → dest), or wire gain → dest direct.
    const fx: Effect[] = (effects ?? []).map((c) => createEffect(ctx, c));
    let node: AudioNode = gain;
    for (const e of fx) {
      node.connect(e.input);
      node = e.output;
    }
    node.connect(dest);

    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      src.disconnect();
      gain.disconnect();
      for (const e of fx) {
        try { e.dispose(); } catch { /* ignore */ }
      }
    };
    const finish = () => {
      cleanup();
      onEnded();
    };
    el.addEventListener("ended", finish);
    el.addEventListener("error", finish);
    el.play().catch(finish);

    return {
      gain,
      stop: () => {
        try {
          el.pause();
          el.currentTime = 0;
        } catch {
          /* ignore */
        }
        cleanup();
      },
    };
  }

  async stop() {
    // Tear down the monitor watchdog first so it can't rebuild mid-teardown.
    if (this.monitorWatchdog !== null) {
      clearInterval(this.monitorWatchdog);
      this.monitorWatchdog = null;
    }
    if (this.ctx && this.onCtxStateChange) {
      this.ctx.removeEventListener("statechange", this.onCtxStateChange);
    }
    this.onCtxStateChange = null;
    this.lastCtxState = null;

    for (const node of this.inputs.values()) {
      node.stream.getTracks().forEach((t) => t.stop());
      node.src.disconnect();
      node.micGate.disconnect();
      node.gain.disconnect();
      node.analyser.disconnect();
    }
    this.inputs.clear();
    // Dispose every effect chain. ctx.close() also frees the nodes, but disposing
    // stops oscillators/LFOs cleanly first.
    for (const key of Array.from(this.chains.keys())) this.disposeChain(key);
    try {
      this.monitorEl?.pause();
      if (this.monitorEl) this.monitorEl.srcObject = null;
    } catch {
      /* ignore */
    }
    this.soundboardBus?.disconnect();
    this.soundboardMonitorGate?.disconnect();
    this.micBus?.disconnect();
    this.monitorMicGate?.disconnect();
    this.monitorBus?.disconnect();
    this.monitorDest?.disconnect();
    this.outputAnalyser?.disconnect();
    this.limiter?.disconnect();
    this.outputBus?.disconnect();
    this.soundboardBus = null;
    this.soundboardMonitorGate = null;
    this.micBus = null;
    this.monitorMicGate = null;
    this.monitorBus = null;
    this.monitorDest = null;
    this.monitorEl = null;
    this.outputAnalyser = null;
    this.limiter = null;
    this.peakBuf = null;
    this.outputBus = null;
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        /* ignore */
      }
      this.ctx = null;
    }
  }
}
