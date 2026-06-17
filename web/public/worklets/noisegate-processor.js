// Noise-gate AudioWorkletProcessor (ver/1.4.1). A peak/envelope follower drives a
// hysteresis gate with a hold time and a ramped gain, so a quiet mic is silenced
// between phrases without chattering on the threshold or clicking on open/close.
//
//   • envelope follower — fast (~1ms) peak tracker of |x|
//   • hysteresis — opens at `threshold`, closes only below threshold−3dB
//   • hold — stay open `hold` seconds after the level drops, then close
//   • range — how far the closed gate attenuates (dB; not necessarily −inf)
//   • attack/release — smooth the GAIN ramp toward the open/closed target
//
// Registered lazily via ctx.audioWorklet.addModule("/worklets/noisegate-processor.js").
// Served same-origin from web/public, so the CSP (script-src 'self') allows it.
class NoiseGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "threshold", defaultValue: -45, minValue: -100, maxValue: 0, automationRate: "k-rate" },
      { name: "attack", defaultValue: 0.005, minValue: 0, maxValue: 0.5, automationRate: "k-rate" },
      { name: "hold", defaultValue: 0.05, minValue: 0, maxValue: 2, automationRate: "k-rate" },
      { name: "release", defaultValue: 0.1, minValue: 0.001, maxValue: 2, automationRate: "k-rate" },
      // dB the gate attenuates by when closed (e.g. −60 ≈ near silence, 0 = open).
      { name: "range", defaultValue: -60, minValue: -100, maxValue: 0, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this._env = 0; // envelope follower (linear amplitude)
    this._gain = 0; // current applied gain (linear), ramps toward the target
    this._hold = 0; // remaining hold samples
    this._open = false;
    this._gains = null; // scratch: per-sample gain reused across channels
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output) return true;
    const inCh = input[0];
    const outCh = output[0];
    if (!outCh) return true;
    if (!inCh) {
      // No input connected — emit silence (the gate would be closed anyway).
      for (let ch = 0; ch < output.length; ch++) output[ch].fill(0);
      return true;
    }

    const sr = sampleRate; // global in AudioWorkletGlobalScope
    const block = outCh.length;

    const thrDb = parameters.threshold[0];
    const openThr = Math.pow(10, thrDb / 20);
    const closeThr = Math.pow(10, (thrDb - 3) / 20); // 3 dB hysteresis
    const rangeGain = Math.pow(10, parameters.range[0] / 20);
    // Smoothing coefficients (one-pole). Guard against 0 → divide-by-zero.
    const envCoeff = Math.exp(-1 / (0.001 * sr)); // ~1ms detector
    const atkCoeff = Math.exp(-1 / (Math.max(parameters.attack[0], 1e-4) * sr));
    const relCoeff = Math.exp(-1 / (Math.max(parameters.release[0], 1e-4) * sr));
    const holdSamples = Math.floor(parameters.hold[0] * sr);

    if (!this._gains || this._gains.length !== block) this._gains = new Float32Array(block);
    const gains = this._gains;

    for (let i = 0; i < block; i++) {
      const a = Math.abs(inCh[i]);
      // Peak follower: instant attack, smoothed decay.
      this._env = a > this._env ? a : a + envCoeff * (this._env - a);

      if (this._env >= openThr) {
        this._open = true;
        this._hold = holdSamples;
      } else if (this._env < closeThr) {
        if (this._hold > 0) this._hold--;
        else this._open = false;
      }

      const target = this._open ? 1 : rangeGain;
      const coeff = target > this._gain ? atkCoeff : relCoeff;
      this._gain = target + coeff * (this._gain - target);
      gains[i] = this._gain;
      outCh[i] = inCh[i] * this._gain;
    }

    // Apply the same gain envelope to any extra channels (detection is from ch0).
    for (let ch = 1; ch < output.length; ch++) {
      const src = input[ch] || inCh;
      const dst = output[ch];
      for (let i = 0; i < block; i++) dst[i] = src[i] * gains[i];
    }
    return true;
  }
}

registerProcessor("noisegate-processor", NoiseGateProcessor);
