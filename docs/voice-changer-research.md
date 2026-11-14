# Voice Changer — Research & Decisions

What was researched for the voice changer (1.4.0–1.5.1), what was decided and why, and
what is still open. The shipped behavior is described in `AGENTS.md` (Key concepts →
Voice changer). Older task notes in `AGENTS.md` cite section numbers (§3b, §4b, §8…) from
the long first version of this file; git history keeps that version.

## 1. Constraints everything was measured against

- **Open-source and free first.** Paid services are allowed only as an opt-in, with
  a per-user quota or the user's own key (see §4).
- **Disclose anything that leaves the machine.** Every path that uploads mic audio or
  text shows an in-UI notice and is listed in the TOS (`lib/tos.ts`).
- **Web Audio only.** No native code and no loopback, so the web build and the
  Electron wrapper behave the same (see the `virtual-mic-capture` memory).
- **DSP must be real-time.** AI may be higher-latency (push-to-talk).

## 2. Where it sits in the audio graph

The mic's effect chain sits between the mic input and the mic bus:
`mic → micGate (AI mute) → volume → [fx₁ → … → fxₙ] → micBus`. The input meter taps
**after** the chain, so it shows what the game hears. Soundboard clips get their own
per-clip chain, built fresh on every play.

AI isn't a node in the chain. It records a push-to-talk clip, converts it, and plays the
result into the mic's chain head, so DSP still applies. While AI is on, `micGate` mutes
the raw mic, so only converted clips reach the cable.

**Why:** the limiter, meters and monitor split stay unchanged. Chains are swapped by
building the new chain before removing the old one, which avoids clicks.

## 3. DSP effects

**Shipped** (all in `lib/voice-fx.ts`, picked up by every editor via `EFFECT_DEFS`):

| Kind | How it's built |
| --- | --- |
| Robot, tremolo | oscillator modulating a gain |
| Echo | `DelayNode` + feedback + wet/dry |
| Reverb | `ConvolverNode` with a generated impulse response (no IR files) |
| Distortion, megaphone | `WaveShaperNode` (megaphone adds a narrow band-pass first) |
| Telephone, low-pass, high-pass | `BiquadFilterNode` |
| Chorus, flanger, vibrato | LFO-modulated `DelayNode` |
| Phaser | 4 swept all-pass biquads |
| Compressor | `DynamicsCompressorNode` |
| Bitcrusher, noise gate, pitch shift | our own AudioWorklets in `web/public/worklets/` |

**Decisions and reasons:**
- **Native nodes plus our own worklets, no DSP library.** No licensing exposure, no
  bundle cost, low latency. Worklets are same-origin, so the CSP needed no change.
- **Pitch shift is our own granular worklet** (two delay taps with a crossfade,
  −12..+12 semitones). It is pitch only. SoundTouchJS was the planned library, but its
  worklets ship inside npm packages and its documented use is buffer playback rather
  than a live mic stream, so it couldn't be verified.
- **Worklet loading is one registry** (`WORKLET_MODULES` + `ensureWorkletModules`).
  Every worklet effect registers the same way and falls back to passthrough if it fails.

**Rejected:**
- **Rubberband (WASM):** GPL, incompatible with a closed-source distributed app
  unless a commercial license is bought.
- **Tone.js `PitchShift`:** pitch only, and a whole framework for one effect.
- **Stereo widener:** the mic chain is mono, so there's nothing to widen.

## 4. AI voice

**Shipped engines:**

| Engine | What it does | Routing | Cost |
| --- | --- | --- | --- |
| **RVC⚡ZERO** (`r3gm/rvc_zero`, MIT, HF ZeroGPU Space) — default | push-to-talk voice conversion with RVC models | **browser-direct** via `@gradio/client` | free, each user's own ZeroGPU quota |
| **ElevenLabs** | push-to-talk conversion (STS) or re-speak (STT→TTS) | same-origin proxy `/api/ai/sts`, `/api/ai/tts` | app key + per-user monthly quota, or the user's own key |
| **Respeecher** | push-to-talk conversion (file mode) or re-speak | same-origin proxy | same as ElevenLabs |

**Decisions and reasons:**
- **rvc_zero is called from the browser, not through our server.** ZeroGPU meters GPU
  time per end user (via an `X-IP-Token` header). A proxy holding our token would
  give every user one shared, tiny quota. This is the one deliberate CSP widening:
  `connect-src` includes `https://*.hf.space wss://*.hf.space https://huggingface.co`.
- **Paid providers go through a same-origin proxy.** The app's keys stay on the server
  (env), usage is metered per user (`lib/ai-quota.ts`: user override → role → env
  `DEFAULT_AI_QUOTA_SECONDS`), and no CSP change is needed. A user's own key is kept on
  their device (`soundboard:aiKeys`), sent per request, never stored server-side, and
  not metered.
- **Bundled voices are deliberately few.** Most public RVC models are scraped
  celebrity or character voices, which is a likeness and copyright risk in a
  distributed app. So the only bundled RVC model is `PhoenixStormJr/RVC-V2-default-voice`
  (MIT, credited in the UI), offered at three pitches. Anything else is a custom
  URL or voice id the user supplies, shown with a "use only voices you're entitled to"
  reminder.
- **Push-to-talk, not continuous.** It keeps free quotas and paid bills bounded and
  sends short bursts instead of a constant stream.
- **Re-speak uses the browser's Web Speech API** for the speech-to-text half. Chrome sends
  that audio to Google (disclosed via `STT_PRIVACY`). Electron's Chromium has no Google
  speech key, so re-speak is hidden in the desktop app.
- **The config is stored per profile, not per mic** (1.5.1). The mic's chain and AI
  settings live under a fixed `primary` key in the profile's `voiceFx`, so a new mic or
  device id doesn't lose them.

**Rejected or deferred, with reasons:**
- **In-browser AI (ONNX Runtime Web / WebGPU):** keeps audio local, but needs 100s of
  MB of models (feature extractor + generator + vocoder), and realtime RVC in the
  browser is still research-grade. Deferred until a maintained WebGPU package exists.
- **Voice cloning (OpenVoice V2):** a different model from RVC. Deferred; presets and
  custom URLs cover the need for now.
- **Respeecher continuous live (WebSocket):** the app runs as Next `output: "standalone"`,
  which has no WebSocket upgrade hook, and Respeecher's realtime protocol isn't
  publicly documented. It would need a custom Node server + Dockerfile change.
- **Paid realtime streaming in general:** an open-ended per-user bill for us and a
  continuous off-machine audio stream.

## 5. Open topics / things to explore

- **Formant shift.** Re-try SoundTouchJS (`@soundtouchjs/audio-worklet` +
  `@soundtouchjs/formant-correction-worklet`, MPL-2.0, safe as a dependency): install,
  copy the processor JS into `web/public/worklets/`, and validate it on a live mic stream
  before extending the `pitch` effect.
- **Realtime AI.** Preferred future route: self-host RVC / w-okada realtime VC on our
  own GPU behind a same-origin WebSocket proxy (no third party, no per-call bill). It
  needs the custom-server change above, plus ~4–6 GB VRAM on the host. ElevenLabs
  streaming is the hosted alternative (paid, third party).
- **Self-hosting rvc_zero** (MIT Gradio app as a second compose service) to escape
  ZeroGPU quotas and keep audio on our infra. Then the proxy returns and the HF CSP
  entries can go.
- **More safe RVC presets** if properly licensed original voices turn up (just another
  preset entry, no engine change).
- **In-browser AI** once WebGPU model packages mature.

## Sources

- [RVC⚡ZERO Space (`r3gm/rvc_zero`)](https://huggingface.co/spaces/r3gm/rvc_zero) · [source, MIT](https://github.com/R3gm/rvc_zero_ui)
- [Using ZeroGPU Spaces from the client (X-IP-Token, quota)](https://www.gradio.app/docs/python-client/using-zero-gpu-spaces)
- [Spaces as API endpoints](https://huggingface.co/docs/hub/spaces-api-endpoints)
- [RVC project](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) · [w-okada Realtime Voice Changer](https://github.com/w-okada/voice-changer)
- [OpenVoice V2](https://huggingface.co/myshell-ai/OpenVoiceV2)
- [ElevenLabs Voice Changer API](https://elevenlabs.io/docs/capabilities/voice-changer)
- [ONNX Runtime Web (WebGPU)](https://onnxruntime.ai/docs/tutorials/web/)
- [SoundTouchJS (MPL-2.0)](https://github.com/cutterbl/SoundTouchJS/) · [Tone.js `PitchShift`](https://tonejs.github.io/docs/PitchShift)
- [Pitch shifting in Web Audio API (Tuomas Siipola)](https://zpl.fi/pitch-shifting-in-web-audio-api/)
- [MDN: DynamicsCompressorNode](https://developer.mozilla.org/en-US/docs/Web/API/DynamicsCompressorNode)
