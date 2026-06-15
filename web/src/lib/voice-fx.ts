"use client";

// voice-fx.ts — the per-source DSP effect model for the 1.4.0 voice changer.
//
// Every effect is a self-contained subgraph exposing exactly ONE input node and
// ONE output node, so the mixer can wire an arbitrary ordered chain uniformly:
//
//   source.out ─► fx₁.input … fx₁.output ─► fx₂.input … ─► chain tail ─► (cable, monitor)
//
// All effects are NATIVE Web Audio (OscillatorNode/DelayNode/ConvolverNode/
// WaveShaperNode/BiquadFilterNode/GainNode) except the bitcrusher, which is our
// own AudioWorklet (public/worklets/bitcrusher-processor.js). Pitch/formant shift
// are intentionally NOT here (deferred — no external DSP library this version).
//
// An effect is described by an EffectConfig { kind, params }. createEffect builds
// the live subgraph; update(params) reconciles params without rebuilding (so the
// UI sliders are live); dispose() tears the subgraph down. Param metadata in
// EFFECT_DEFS drives the UI (sliders) and the default params.

export type EffectKind =
  | "robot"
  | "echo"
  | "reverb"
  | "distortion"
  | "telephone"
  | "tremolo"
  | "lowpass"
  | "highpass"
  | "bitcrusher";

export type EffectParams = Record<string, number>;

export type EffectConfig = {
  // Stable id so the UI can key/reorder rows without index churn.
  id: string;
  kind: EffectKind;
  params: EffectParams;
};

// A live effect subgraph. input/output are the single in/out nodes; update
// reconciles params live; dispose frees nodes (stops oscillators etc.).
export type Effect = {
  input: AudioNode;
  output: AudioNode;
  update: (params: EffectParams) => void;
  dispose: () => void;
};

type ParamDef = {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  // Optional unit suffix for the UI readout (e.g. "Hz", "%", "s").
  unit?: string;
};

type EffectDef = {
  kind: EffectKind;
  label: string;
  params: ParamDef[];
};

// Palette metadata — drives the "Add effect" picker, the param sliders, and the
// default params for a freshly-added effect. Order here is the menu order.
export const EFFECT_DEFS: EffectDef[] = [
  {
    kind: "robot",
    label: "Robot (ring mod)",
    params: [{ key: "freq", label: "Carrier", min: 20, max: 1200, step: 1, default: 120, unit: "Hz" }],
  },
  {
    kind: "echo",
    label: "Echo",
    params: [
      { key: "time", label: "Time", min: 0.02, max: 1, step: 0.01, default: 0.25, unit: "s" },
      { key: "feedback", label: "Feedback", min: 0, max: 0.95, step: 0.01, default: 0.35 },
      { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01, default: 0.4 },
    ],
  },
  {
    kind: "reverb",
    label: "Reverb",
    params: [
      { key: "decay", label: "Decay", min: 0.2, max: 5, step: 0.1, default: 1.8, unit: "s" },
      { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01, default: 0.4 },
    ],
  },
  {
    kind: "distortion",
    label: "Distortion",
    params: [{ key: "drive", label: "Drive", min: 1, max: 100, step: 1, default: 25 }],
  },
  {
    kind: "telephone",
    label: "Telephone",
    params: [
      { key: "freq", label: "Center", min: 300, max: 3000, step: 10, default: 1500, unit: "Hz" },
      { key: "q", label: "Resonance", min: 0.5, max: 20, step: 0.1, default: 6 },
    ],
  },
  {
    kind: "tremolo",
    label: "Tremolo",
    params: [
      { key: "rate", label: "Rate", min: 0.5, max: 20, step: 0.1, default: 6, unit: "Hz" },
      { key: "depth", label: "Depth", min: 0, max: 1, step: 0.01, default: 0.7 },
    ],
  },
  {
    kind: "lowpass",
    label: "Low-pass",
    params: [{ key: "freq", label: "Cutoff", min: 100, max: 18000, step: 10, default: 4000, unit: "Hz" }],
  },
  {
    kind: "highpass",
    label: "High-pass",
    params: [{ key: "freq", label: "Cutoff", min: 20, max: 8000, step: 10, default: 600, unit: "Hz" }],
  },
  {
    kind: "bitcrusher",
    label: "Bitcrusher",
    params: [
      { key: "bits", label: "Bits", min: 1, max: 16, step: 1, default: 6 },
      { key: "reduction", label: "Crush", min: 1, max: 50, step: 1, default: 8 },
    ],
  },
];

const EFFECT_DEF_BY_KIND = new Map(EFFECT_DEFS.map((d) => [d.kind, d]));

export function effectLabel(kind: EffectKind): string {
  return EFFECT_DEF_BY_KIND.get(kind)?.label ?? kind;
}

// Default param set for a kind, used when a new effect is added.
export function defaultParams(kind: EffectKind): EffectParams {
  const def = EFFECT_DEF_BY_KIND.get(kind);
  const out: EffectParams = {};
  for (const p of def?.params ?? []) out[p.key] = p.default;
  return out;
}

let _idSeq = 0;
export function makeEffect(kind: EffectKind): EffectConfig {
  _idSeq += 1;
  return { id: `fx_${Date.now().toString(36)}_${_idSeq}`, kind, params: defaultParams(kind) };
}

function num(params: EffectParams, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

// ── Bitcrusher worklet registration (lazy, once per context) ───────────────
const BITCRUSHER_URL = "/worklets/bitcrusher-processor.js";
// Track which contexts have the module so addModule runs at most once each.
const registered = new WeakSet<BaseAudioContext>();
let pending: WeakMap<BaseAudioContext, Promise<void>> | null = null;

export function ensureBitcrusherModule(ctx: BaseAudioContext): Promise<void> {
  if (registered.has(ctx)) return Promise.resolve();
  if (!pending) pending = new WeakMap();
  const existing = pending.get(ctx);
  if (existing) return existing;
  const p = ctx.audioWorklet
    .addModule(BITCRUSHER_URL)
    .then(() => {
      registered.add(ctx);
    })
    .catch((e) => {
      // Leave it unregistered so a later effect can retry; the factory falls
      // back to a passthrough if the node can't be constructed.
      console.warn("[voice-fx] bitcrusher worklet failed to load", (e as Error)?.message);
      throw e;
    });
  pending.set(ctx, p);
  return p;
}

// Build a synthetic reverb impulse response: white noise with exponential decay,
// rendered offline. No IR files to ship; `decay` (seconds) sets the tail length.
function makeImpulseResponse(ctx: BaseAudioContext, decay: number): AudioBuffer {
  const seconds = Math.max(0.1, decay);
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(seconds * rate));
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      // Exponential decay envelope; random sign for a dense diffuse tail.
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
  }
  return buf;
}

// Build the distortion transfer curve for a given drive amount (tanh-ish).
function makeDistortionCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  const k = Math.max(1, drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x);
  }
  return curve;
}

// Construct a live effect subgraph for one config. Each branch returns a single
// input/output pair plus update()/dispose(). For wet/dry effects (echo, reverb)
// the input fans into a dry gain + a wet path that both sum into the output.
export function createEffect(ctx: AudioContext, cfg: EffectConfig): Effect {
  const { kind } = cfg;
  const p = cfg.params;

  switch (kind) {
    case "robot": {
      // Ring modulation: multiply the signal by a carrier oscillator. A GainNode
      // whose gain is DRIVEN by the oscillator (gain starts at 0) does the multiply.
      const input = ctx.createGain();
      const ring = ctx.createGain();
      ring.gain.value = 0;
      const osc = ctx.createOscillator();
      osc.frequency.value = num(p, "freq", 120);
      osc.connect(ring.gain);
      input.connect(ring);
      osc.start();
      return {
        input,
        output: ring,
        update: (np) => {
          osc.frequency.value = num(np, "freq", 120);
        },
        dispose: () => {
          try { osc.stop(); } catch { /* already stopped */ }
          osc.disconnect();
          input.disconnect();
          ring.disconnect();
        },
      };
    }

    case "echo": {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const delay = ctx.createDelay(1.0);
      delay.delayTime.value = num(p, "time", 0.25);
      const feedback = ctx.createGain();
      feedback.gain.value = num(p, "feedback", 0.35);
      const wet = ctx.createGain();
      wet.gain.value = num(p, "mix", 0.4);
      const dry = ctx.createGain();
      dry.gain.value = 1 - num(p, "mix", 0.4);
      // input → dry → output ; input → delay ↺feedback → wet → output
      input.connect(dry).connect(output);
      input.connect(delay);
      delay.connect(feedback).connect(delay);
      delay.connect(wet).connect(output);
      return {
        input,
        output,
        update: (np) => {
          delay.delayTime.value = num(np, "time", 0.25);
          feedback.gain.value = num(np, "feedback", 0.35);
          const mix = num(np, "mix", 0.4);
          wet.gain.value = mix;
          dry.gain.value = 1 - mix;
        },
        dispose: () => {
          input.disconnect();
          delay.disconnect();
          feedback.disconnect();
          wet.disconnect();
          dry.disconnect();
          output.disconnect();
        },
      };
    }

    case "reverb": {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const conv = ctx.createConvolver();
      conv.buffer = makeImpulseResponse(ctx, num(p, "decay", 1.8));
      let lastDecay = num(p, "decay", 1.8);
      const wet = ctx.createGain();
      wet.gain.value = num(p, "mix", 0.4);
      const dry = ctx.createGain();
      dry.gain.value = 1 - num(p, "mix", 0.4);
      input.connect(dry).connect(output);
      input.connect(conv).connect(wet).connect(output);
      return {
        input,
        output,
        update: (np) => {
          const decay = num(np, "decay", 1.8);
          // Regenerating the IR every slider tick is expensive; only rebuild on
          // a meaningful change.
          if (Math.abs(decay - lastDecay) > 0.05) {
            conv.buffer = makeImpulseResponse(ctx, decay);
            lastDecay = decay;
          }
          const mix = num(np, "mix", 0.4);
          wet.gain.value = mix;
          dry.gain.value = 1 - mix;
        },
        dispose: () => {
          input.disconnect();
          conv.disconnect();
          wet.disconnect();
          dry.disconnect();
          output.disconnect();
        },
      };
    }

    case "distortion": {
      const shaper = ctx.createWaveShaper();
      shaper.curve = makeDistortionCurve(num(p, "drive", 25));
      shaper.oversample = "2x";
      return {
        input: shaper,
        output: shaper,
        update: (np) => {
          shaper.curve = makeDistortionCurve(num(np, "drive", 25));
        },
        dispose: () => {
          shaper.disconnect();
        },
      };
    }

    case "telephone": {
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = num(p, "freq", 1500);
      filter.Q.value = num(p, "q", 6);
      return {
        input: filter,
        output: filter,
        update: (np) => {
          filter.frequency.value = num(np, "freq", 1500);
          filter.Q.value = num(np, "q", 6);
        },
        dispose: () => filter.disconnect(),
      };
    }

    case "tremolo": {
      // Amplitude modulation at a sub-audio rate: a GainNode whose gain is
      // (1 - depth) + depth * (0..1 LFO). The LFO osc (±1) is scaled into 0..1.
      const input = ctx.createGain();
      const amp = ctx.createGain();
      const depth = num(p, "depth", 0.7);
      amp.gain.value = 1 - depth; // baseline; LFO adds the rest
      const lfo = ctx.createOscillator();
      lfo.frequency.value = num(p, "rate", 6);
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = depth / 2; // osc is ±1 → ±depth/2 around baseline+depth/2
      // Shift baseline so the modulated gain swings between (1-depth) and 1.
      amp.gain.value = 1 - depth / 2;
      lfo.connect(lfoDepth).connect(amp.gain);
      input.connect(amp);
      lfo.start();
      return {
        input,
        output: amp,
        update: (np) => {
          const d = num(np, "depth", 0.7);
          amp.gain.value = 1 - d / 2;
          lfoDepth.gain.value = d / 2;
          lfo.frequency.value = num(np, "rate", 6);
        },
        dispose: () => {
          try { lfo.stop(); } catch { /* already stopped */ }
          lfo.disconnect();
          lfoDepth.disconnect();
          input.disconnect();
          amp.disconnect();
        },
      };
    }

    case "lowpass":
    case "highpass": {
      const filter = ctx.createBiquadFilter();
      filter.type = kind === "lowpass" ? "lowpass" : "highpass";
      filter.frequency.value = num(p, "freq", kind === "lowpass" ? 4000 : 600);
      return {
        input: filter,
        output: filter,
        update: (np) => {
          filter.frequency.value = num(np, "freq", kind === "lowpass" ? 4000 : 600);
        },
        dispose: () => filter.disconnect(),
      };
    }

    case "bitcrusher": {
      // The worklet may not be registered yet (addModule is async). Build the
      // node optimistically; if construction throws, fall back to a passthrough
      // gain so the chain never breaks. ensureBitcrusherModule should be awaited
      // by the caller before (re)building a chain containing a bitcrusher.
      try {
        const node = new AudioWorkletNode(ctx, "bitcrusher-processor");
        const bits = node.parameters.get("bits");
        const normFreq = node.parameters.get("normFreq");
        if (bits) bits.value = num(p, "bits", 6);
        // "reduction" (1..50) maps to a normalized hold frequency (1 = none).
        if (normFreq) normFreq.value = 1 / Math.max(1, num(p, "reduction", 8));
        return {
          input: node,
          output: node,
          update: (np) => {
            if (bits) bits.value = num(np, "bits", 6);
            if (normFreq) normFreq.value = 1 / Math.max(1, num(np, "reduction", 8));
          },
          dispose: () => node.disconnect(),
        };
      } catch {
        const pass = ctx.createGain();
        return { input: pass, output: pass, update: () => {}, dispose: () => pass.disconnect() };
      }
    }

    default: {
      // Exhaustiveness guard + safe passthrough for an unknown kind.
      const pass = ctx.createGain();
      return { input: pass, output: pass, update: () => {}, dispose: () => pass.disconnect() };
    }
  }
}

// True if a chain contains a bitcrusher (so the caller can preload the worklet).
export function chainNeedsBitcrusher(effects: EffectConfig[]): boolean {
  return effects.some((e) => e.kind === "bitcrusher");
}
