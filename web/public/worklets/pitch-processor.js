// Pitch-shift AudioWorkletProcessor (ver/1.4.1) — a self-contained, real-time,
// PITCH-ONLY shifter (no external DSP library, no formant correction).
//
// Why DIY instead of SoundTouchJS (the planned pick): SoundTouchJS ships its
// pitch/formant worklets inside its npm packages, which can't be vendored into
// web/public without installing+building them, and its documented path is buffer
// playback rather than a live MediaStreamSource — neither verifiable here. So
// formant is RE-DEFERRED and this self-authored worklet ships the pitch axis. To
// upgrade later: `pnpm add @soundtouchjs/audio-worklet @soundtouchjs/formant-
// correction-worklet`, copy their processor JS into this folder, and point the
// `pitch` createEffect case at them (exposing `pitch` + `formant`).
//
// Algorithm: a classic dual-tap delay-line granular pitch shifter. A circular
// buffer holds recent input; two read taps offset by half the window scroll at
// (1−ratio) and are cross-faded with a sin window (constant-power) so the
// wrap discontinuity is masked. `ratio = 2^(semitones/12)`.
//
// Registered lazily via ctx.audioWorklet.addModule("/worklets/pitch-processor.js");
// served same-origin so the CSP (script-src 'self') allows it.
const PITCH_WINDOW = 4096; // grain/window size in samples (~85ms @48k)

class PitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "pitch", defaultValue: 0, minValue: -24, maxValue: 24, automationRate: "k-rate" }];
  }

  constructor() {
    super();
    this._buf = new Float32Array(PITCH_WINDOW);
    this._write = 0;
    this._d = 0; // tap-A read offset behind the write head (0..N)
  }

  _read(pos) {
    const N = PITCH_WINDOW;
    let p = pos % N;
    if (p < 0) p += N;
    const i0 = Math.floor(p);
    const frac = p - i0;
    const i1 = i0 + 1 >= N ? 0 : i0 + 1;
    return this._buf[i0] * (1 - frac) + this._buf[i1] * frac;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output) return true;
    const inCh = input[0];
    const outCh = output[0];
    if (!outCh) return true;
    if (!inCh) {
      for (let ch = 0; ch < output.length; ch++) output[ch].fill(0);
      return true;
    }

    const N = PITCH_WINDOW;
    const half = N / 2;
    const semis = parameters.pitch[0];
    const ratio = Math.pow(2, semis / 12);
    const block = outCh.length;

    for (let i = 0; i < block; i++) {
      this._buf[this._write] = inCh[i];
      if (ratio === 1) {
        outCh[i] = inCh[i];
      } else {
        // Scroll the read offset so the tap plays back at `ratio` speed.
        this._d -= ratio - 1;
        if (this._d < 0) this._d += N;
        else if (this._d >= N) this._d -= N;
        const d1 = this._d;
        const d2 = d1 + half >= N ? d1 + half - N : d1 + half;
        const s1 = this._read(this._write - d1);
        const s2 = this._read(this._write - d2);
        // sin window → constant power crossfade (w1²+w2²=1, taps half apart).
        const w1 = Math.sin((Math.PI * d1) / N);
        const w2 = Math.sin((Math.PI * d2) / N);
        outCh[i] = s1 * w1 + s2 * w2;
      }
      this._write = this._write + 1 >= N ? 0 : this._write + 1;
    }

    // Mono processing → copy to any extra output channels.
    for (let ch = 1; ch < output.length; ch++) output[ch].set(outCh);
    return true;
  }
}

registerProcessor("pitch-processor", PitchProcessor);
