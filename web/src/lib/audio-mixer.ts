"use client";

// MicMixer — the audio engine behind "Virtual Mic mode".
//
// It owns a single AudioContext and routes a set of SOURCES to two destinations:
//
//   sources ─┬─► cableBus ─┬─► limiter ─► ctx.destination ─►(setSinkId) virtual cable (game's mic)
//            │             └─► analyser  (cable peak meter tap, pre-limiter)
//            ├─► analyser  (per-input peak meter tap, post-volume)
//            └─► (per-source monitor send) ─► monitorBus ─► <audio>.setSinkId ─► your ears
//
// The limiter sits on the cable path because sources sum at unity: a hot mic +
// a clip can push the sum past 0 dBFS and hard-clip the virtual mic (which the
// listener hears as distortion even though the local monitor — a separate path —
// sounds fine). The analyser taps the pre-limiter sum so the UI meter can warn
// when you're driving it into clipping.
//
// Sources that can feed the virtual mic:
//   • INPUT lines  — any capture device Windows reports, captured with
//     getUserMedia: physical mics, virtual-cable recording sides (VB-Audio,
//     VoiceMeeter), and GoXLR mix buses (e.g. Broadcast Stream Mix). Routing
//     "any audio" into the mic is done by sending that audio to a cable / GoXLR
//     bus in Windows, which then shows up here as a capture device.
//   • SOUNDBOARD   — clips injected with injectClip().
//
// Every source always reaches the cable. Each source additionally has a "monitor
// send" gain (0 or 1) that decides whether you also hear it locally on the chosen
// monitor device — so e.g. you can monitor the soundboard without hearing your
// own mic echoed back. The cable target device is the app's "Output device".

export type MixerInputState = { deviceId: string; enabled: boolean; volume: number };

// Stable key for the soundboard line in the monitor selection.
export const SOUNDBOARD_KEY = "__soundboard__";

// A source that's summed into the cable, with an optional monitor send.
type Source = {
  // The node feeding the cable (its output is what monitorSend taps).
  out: AudioNode;
  monitorSend: GainNode;
};

type ActiveInput = Source & {
  stream: MediaStream;
  src: MediaStreamAudioSourceNode;
  gain: GainNode;
  // Post-volume tap so each row can show its own contribution to the cable.
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
  // Everything destined for the virtual cable sums here, then through the limiter
  // to ctx.destination.
  private cableBus: GainNode | null = null;
  // Brickwall-ish limiter on the cable so the summed sources can't clip the mic.
  private cableLimiter: DynamicsCompressorNode | null = null;
  // Taps the pre-limiter cable sum to drive the UI peak meter.
  private cableAnalyser: AnalyserNode | null = null;
  private peakBuf: Float32Array<ArrayBuffer> | null = null;
  // Everything you monitor locally sums here, then out to the monitor device.
  private monitorBus: GainNode | null = null;
  private monitorDest: MediaStreamAudioDestinationNode | null = null;
  private monitorEl: AudioWithSink | null = null;
  // Soundboard clips sum here; its monitor send decides local playback.
  private soundboardBus: GainNode | null = null;
  private soundboardMonitorSend: GainNode | null = null;

  private inputs = new Map<string, ActiveInput>();
  private cableDeviceId = "default";
  private monitorDeviceId = "default";
  // Which source keys are routed to the monitor bus (deviceIds + special keys).
  private monitoredKeys = new Set<string>([SOUNDBOARD_KEY]);
  // Serialize source reconciliation so overlapping calls can't double-open one.
  private syncChain: Promise<unknown> = Promise.resolve();

  isReady() {
    return this.ctx !== null;
  }

  // Current peak amplitude of the pre-limiter cable sum, as a linear 0..1+
  // value (can exceed 1.0 when the sources are driving the limiter into
  // clipping). Cheap enough to poll each animation frame for a meter.
  getCablePeak(): number {
    return peakOf(this.cableAnalyser, this.peakBuf);
  }

  // Current peak amplitude of a single live input (post its volume gain), linear
  // 0..1+. Returns 0 if that input isn't open. Cheap enough to poll per frame.
  getInputPeak(deviceId: string): number {
    const n = this.inputs.get(deviceId);
    return n ? peakOf(n.analyser, n.peakBuf) : 0;
  }

  async start(cableDeviceId: string) {
    if (this.ctx) return;
    mlog("start: creating AudioContext, cableDeviceId =", cableDeviceId || "(default)");
    const ctx = new AudioContext() as SinkCapableContext;
    const cableBus = ctx.createGain();
    // Limiter between the summed sources and the cable: catches peaks so a hot
    // sum doesn't hard-clip the virtual mic. Tuned as a fast brickwall limiter
    // (near-unity below ~-1 dBFS, hard knee, high ratio).
    const cableLimiter = ctx.createDynamicsCompressor();
    cableLimiter.threshold.value = -1;
    cableLimiter.knee.value = 0;
    cableLimiter.ratio.value = 20;
    cableLimiter.attack.value = 0.003;
    cableLimiter.release.value = 0.25;
    cableBus.connect(cableLimiter);
    cableLimiter.connect(ctx.destination);
    // Pre-limiter tap for the meter (so it shows the true incoming peak, not the
    // already-limited output). Not connected onward — it only analyses.
    const cableAnalyser = ctx.createAnalyser();
    cableAnalyser.fftSize = 1024;
    cableBus.connect(cableAnalyser);

    const monitorBus = ctx.createGain();
    const monitorDest = ctx.createMediaStreamDestination();
    monitorBus.connect(monitorDest);
    const monitorEl = new Audio() as AudioWithSink;
    monitorEl.srcObject = monitorDest.stream;

    const soundboardBus = ctx.createGain();
    soundboardBus.connect(cableBus);
    const soundboardMonitorSend = ctx.createGain();
    soundboardMonitorSend.gain.value = this.monitoredKeys.has(SOUNDBOARD_KEY) ? 1 : 0;
    soundboardBus.connect(soundboardMonitorSend).connect(monitorBus);

    this.ctx = ctx;
    this.cableBus = cableBus;
    this.cableLimiter = cableLimiter;
    this.cableAnalyser = cableAnalyser;
    this.peakBuf = new Float32Array(new ArrayBuffer(cableAnalyser.fftSize * 4));
    this.monitorBus = monitorBus;
    this.monitorDest = monitorDest;
    this.monitorEl = monitorEl;
    this.soundboardBus = soundboardBus;
    this.soundboardMonitorSend = soundboardMonitorSend;
    this.cableDeviceId = cableDeviceId;

    mlog("start: state =", ctx.state, "| setSinkId available =", typeof ctx.setSinkId === "function");
    await this.applyCableSink(cableDeviceId);
    await this.applyMonitorSink(this.monitorDeviceId);
    try {
      await ctx.resume();
    } catch {
      /* may stay suspended until a gesture */
    }
    await monitorEl.play().catch(() => {
      /* may be blocked until a gesture; armResumeOnGesture retries */
    });
    mlog("start: ready, state =", ctx.state);
    this.armResumeOnGesture();
  }

  private async applyCableSink(deviceId: string) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (typeof ctx.setSinkId !== "function") {
      throw new Error("AudioContext.setSinkId is unavailable (needs Chromium 110+).");
    }
    const target = deviceId && deviceId !== "default" ? deviceId : "";
    await ctx.setSinkId(target);
    mlog("applyCableSink: routed cable to", target ? target.slice(0, 8) : "(system default)");
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

  async setCableDevice(deviceId: string) {
    this.cableDeviceId = deviceId;
    if (this.ctx) await this.applyCableSink(deviceId);
  }

  async setMonitorDevice(deviceId: string) {
    this.monitorDeviceId = deviceId;
    if (this.ctx) await this.applyMonitorSink(deviceId);
  }

  // Set which source keys are heard on the monitor device. Applied to every
  // currently-active source's monitor send (0 = silent locally, 1 = monitored).
  setMonitored(keys: Iterable<string>) {
    this.monitoredKeys = new Set(keys);
    for (const [id, node] of this.inputs) {
      node.monitorSend.gain.value = this.monitoredKeys.has(id) ? 1 : 0;
    }
    if (this.soundboardMonitorSend) {
      this.soundboardMonitorSend.gain.value = this.monitoredKeys.has(SOUNDBOARD_KEY) ? 1 : 0;
    }
  }

  // Wire a freshly-created source: feed the cable always, and the monitor bus
  // through a send gain gated by whether this key is currently monitored.
  private connectSource(out: AudioNode, key: string): GainNode {
    const monitorSend = this.ctx!.createGain();
    monitorSend.gain.value = this.monitoredKeys.has(key) ? 1 : 0;
    out.connect(this.cableBus!);
    out.connect(monitorSend).connect(this.monitorBus!);
    return monitorSend;
  }

  // Reconcile live mic inputs with the desired state. Calls are queued so two
  // reconciles can't race into opening the same device twice.
  syncInputs(desired: MixerInputState[]): Promise<void> {
    const run = () => this.reconcileInputs(desired);
    this.syncChain = this.syncChain.then(run, run);
    return this.syncChain as Promise<void>;
  }

  private async reconcileInputs(desired: MixerInputState[]) {
    if (!this.ctx || !this.cableBus) return;
    const wanted = new Set(desired.filter((d) => d.enabled).map((d) => d.deviceId));

    for (const [id, node] of this.inputs) {
      if (!wanted.has(id)) {
        node.stream.getTracks().forEach((t) => t.stop());
        node.src.disconnect();
        node.gain.disconnect();
        node.analyser.disconnect();
        node.monitorSend.disconnect();
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
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: d.deviceId ? { exact: d.deviceId } : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        if (!this.ctx || !this.cableBus) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const src = this.ctx.createMediaStreamSource(stream);
        const gain = this.ctx.createGain();
        gain.gain.value = clamp01(d.volume);
        src.connect(gain);
        // Post-volume meter tap (analysis only — not connected onward).
        const analyser = this.ctx.createAnalyser();
        analyser.fftSize = 1024;
        gain.connect(analyser);
        const peakBuf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
        const monitorSend = this.connectSource(gain, d.deviceId);
        this.inputs.set(d.deviceId, { stream, src, gain, out: gain, monitorSend, analyser, peakBuf });
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

  // Inject a soundboard clip. The backing <audio> output is consumed by Web
  // Audio, so it does NOT also play to the default device — local playback only
  // happens if the soundboard is in the monitor selection.
  injectClip(url: string, volume: number, onEnded: () => void): InjectedClip | null {
    if (!this.ctx || !this.soundboardBus) return null;
    const el = new Audio(url);
    el.preload = "auto";
    const src = this.ctx.createMediaElementSource(el);
    const gain = this.ctx.createGain();
    gain.gain.value = clamp01(volume);
    src.connect(gain).connect(this.soundboardBus);

    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      src.disconnect();
      gain.disconnect();
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
    for (const node of this.inputs.values()) {
      node.stream.getTracks().forEach((t) => t.stop());
      node.src.disconnect();
      node.gain.disconnect();
      node.analyser.disconnect();
      node.monitorSend.disconnect();
    }
    this.inputs.clear();
    try {
      this.monitorEl?.pause();
      if (this.monitorEl) this.monitorEl.srcObject = null;
    } catch {
      /* ignore */
    }
    this.soundboardMonitorSend?.disconnect();
    this.soundboardBus?.disconnect();
    this.monitorBus?.disconnect();
    this.monitorDest?.disconnect();
    this.cableAnalyser?.disconnect();
    this.cableLimiter?.disconnect();
    this.cableBus?.disconnect();
    this.soundboardMonitorSend = null;
    this.soundboardBus = null;
    this.monitorBus = null;
    this.monitorDest = null;
    this.monitorEl = null;
    this.cableAnalyser = null;
    this.cableLimiter = null;
    this.peakBuf = null;
    this.cableBus = null;
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
