// Livepad capture AudioWorkletProcessor. Converts the (already mono) input to
// 16-bit PCM and posts ~4096-frame chunks to the main thread, where the rolling
// buffer lives. The ring is deliberately NOT here: a snapshot copies megabytes, and
// this thread also renders the live mic and the board.
//
// Chunks are transferred, and the main thread sends each ArrayBuffer back once it
// has copied it into the ring, so a steady state allocates nothing on this thread.
//
// Registered lazily via ctx.audioWorklet.addModule("/worklets/livepad-capture-processor.js").
// Served same-origin from web/public, so the CSP (script-src 'self') allows it.
const CHUNK_FRAMES = 4096;

class LivepadCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._free = [];
    this._chunk = new Int16Array(CHUNK_FRAMES);
    this._filled = 0;
    this._stopped = false;
    this.port.onmessage = (e) => {
      if (e.data === "stop") this._stopped = true;
      else if (e.data instanceof ArrayBuffer) this._free.push(new Int16Array(e.data));
    };
  }

  process(inputs) {
    if (this._stopped) return false; // lets the browser collect this node
    const input = inputs[0] && inputs[0][0];
    if (!input) return true; // no connected source this quantum

    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      this._chunk[this._filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this._filled === CHUNK_FRAMES) {
        const full = this._chunk;
        this.port.postMessage(full.buffer, [full.buffer]);
        // Only allocate if the main thread has fallen behind returning buffers.
        this._chunk = this._free.pop() || new Int16Array(CHUNK_FRAMES);
        this._filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("livepad-capture-processor", LivepadCaptureProcessor);
