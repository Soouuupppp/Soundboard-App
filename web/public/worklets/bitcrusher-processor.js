// Bitcrusher AudioWorkletProcessor — the one custom worklet in the voice-fx
// palette (everything else is native Web Audio). Two degradations:
//   • bit-depth reduction — quantize each sample to `bits` steps (crunch)
//   • sample-rate reduction — hold a sample for `1/normFreq` frames (aliasing)
// Both params are k-rate-ish: read once per render quantum from the message-set
// fields (no AudioParam, to keep the subgraph a single node with no param plumbing).
//
// Registered lazily once via ctx.audioWorklet.addModule("/worklets/bitcrusher-processor.js").
// Served same-origin from web/public, so the CSP (script-src 'self') allows it.
class BitcrusherProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // bit depth 1..16 (lower = crunchier); k-rate so it can be automated.
      { name: "bits", defaultValue: 8, minValue: 1, maxValue: 16, automationRate: "k-rate" },
      // normalized frequency 0..1 (1 = no downsampling; lower = more aliasing).
      { name: "normFreq", defaultValue: 0.25, minValue: 0.01, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    // Per-channel sample-and-hold state across render quanta.
    this._phase = 0;
    this._last = [];
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    const bits = parameters.bits[0];
    const normFreq = parameters.normFreq[0];
    const step = Math.pow(0.5, bits); // quantization step for `bits` bits

    for (let ch = 0; ch < input.length; ch++) {
      const inCh = input[ch];
      const outCh = output[ch];
      if (this._last[ch] === undefined) this._last[ch] = 0;
      let phase = this._phase;
      let last = this._last[ch];
      for (let i = 0; i < inCh.length; i++) {
        phase += normFreq;
        if (phase >= 1) {
          phase -= 1;
          // Sample-rate reduce (hold) then bit-crush (quantize).
          last = step * Math.floor(inCh[i] / step + 0.5);
        }
        outCh[i] = last;
      }
      this._last[ch] = last;
      // Advance the shared phase only once (use the last channel's value;
      // all channels share the same downsample clock).
      if (ch === input.length - 1) this._phase = phase;
    }
    return true;
  }
}

registerProcessor("bitcrusher-processor", BitcrusherProcessor);
