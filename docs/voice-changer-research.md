# Voice Changer — Research & Decisions (1.4.0)

> Task 1 of the 1.4.0 "Voice Changer" version. This is the evaluation that feeds
> tasks 2–4. The distilled **locked decisions** also live in `CLAUDE.md` under
> `### Tasks — 1.4.0`; this file is the long-form reasoning, security analysis,
> and licensing notes behind them.

## 1. Goal & constraints

Add a **customizable voice changer on top of the existing Virtual Mic** so a user
can transform a source's audio (primarily their live mic) before it reaches the
virtual cable that games/calls read as the microphone.

Hard constraints carried from the project (see the `virtual-mic-capture` memory
and `CLAUDE.md`):

- **Open-source first, security first, free-only.** External APIs are in scope
  **only if free**, and any path where **mic audio leaves the machine** must be
  called out explicitly in the UI.
- **Web Audio feature** — no native code, capture-devices/cables only — so it
  works identically in the web build and the Electron wrapper.
- **Per-source opt-in**, consistent with the `SourceMixRow` model in
  `audio-mixer.ts`.
- **DSP effects must be real-time**; **AI conversion may be higher-latency /
  push-to-talk**.

### Owner decisions locked during planning (2026-06-15)

| Decision | Choice |
| --- | --- |
| AI audio privacy | **Free external API OK with explicit in-UI disclosure** (local-first preferred, API acceptable) |
| AI ship bar | **DSP committed; AI best-effort** (ship disabled/"coming soon" if no free endpoint settles) |
| AI voice type | **Both presets and cloning** |
| AI sources | **Live mic only** (DSP available to every source) |
| DSP mode | **Stackable chain** (multiple effects in series per source) |
| DSP + AI | **Can coexist** (AI output runs through the source's DSP chain) |
| Persistence | **Device-local localStorage** (`soundboard:voicefx`), no DB change |
| UI | **Third Control Panel tab "Voice changer"** |

---

## 2. Where the voice changer plugs into the existing audio graph

Today (`lib/audio-mixer.ts`), every source reaches the cable + monitor like this:

```
source.out ─┬─► cableBus(micOutVol) ─► limiter ─► ctx.destination ─►(setSinkId) virtual cable
            ├─► analyser            (per-source post-volume meter tap)
            └─► monitorSend(0..1) ─► monitorBus ─► <audio>.setSinkId ─► your ears
```

The voice changer inserts a **per-source effect chain** between `source.out` and
that fan-out:

```
source.out ─► [ fx₁ ─► fx₂ ─► … ─► fxₙ ] ─┬─► cableBus ─► limiter ─► cable
                                          ├─► analyser   (move the meter tap POST-chain)
                                          └─► monitorSend ─► monitorBus
```

This keeps the limiter, metering, and monitor split unchanged — only the node
feeding them moves from the raw source to the processed chain output. The meter
tap moves **post-chain** so the row meter reflects what the game actually hears.

The **AI path is not a live node insert** — it is push-to-talk: capture a chunk
of the live-mic stream, send it off for conversion, then **inject the converted
clip back into the live-mic source path** (so it still flows through that
source's DSP chain, satisfying "DSP + AI coexist").

---

## 3. DSP effects — evaluation

The starter set is **robot/ring-mod, echo/reverb** plus the native extras below.
Pitch shift and formant shift were in the original locked set but are
**deferred** for now (owner decision, 2026-06-15) — see §3b — so this version
ships **native-Web-Audio-only DSP with no external DSP dependency**.

### 3a. Effects that are pure native Web Audio (no dependency, MIT-equivalent)

These need no library — just standard nodes — so they are zero-risk on
licensing, bundle size, and latency:

| Effect | Implementation | Notes |
| --- | --- | --- |
| **Robot / ring-mod** | `OscillatorNode → GainNode.gain` (amplitude-multiply the signal by a carrier) | Classic "robot" timbre; carrier freq is the one param. |
| **Echo / delay** | `DelayNode` + feedback `GainNode` + wet/dry mix gains | Params: time, feedback, mix. |
| **Reverb** | `ConvolverNode` with a **synthetically generated impulse response** (noise burst with exponential decay rendered in an `OfflineAudioContext`) | No IR files needed to ship; an optional small IR pack can broaden it later. Params: decay, mix. |
| **Distortion / overdrive** | `WaveShaperNode` with a tanh/clip curve | Param: drive. |
| **Telephone / band-pass** | `BiquadFilterNode` (bandpass) | "Walkie-talkie" character. |
| **Tremolo** | LFO `OscillatorNode → GainNode.gain` (sub-audio rate) | Params: rate, depth. |
| **Low-pass / high-pass** | `BiquadFilterNode` | Tone shaping; cheap chain building blocks. |
| **Bitcrusher** | tiny `AudioWorkletProcessor` (sample-rate + bit-depth reduction) | One small worklet we author (MIT, ours). |

All of the above are real-time and trivially chainable as `{ input, output }`
subgraphs.

### 3b. Pitch shift + formant shift (needs a library) — ⏸️ DEFERRED

> **Owner decision (2026-06-15): drop both pitch shift and formant shift this
> version.** Neither ships in 1.4.0, and **no external DSP library
> (SoundTouchJS/Tone.js/etc.) is added** — the DSP path is native Web Audio only
> (§3a). The evaluation below is retained as the record for when this is revisited;
> if/when pitch/formant come back, **SoundTouchJS (MPL-2.0)** remains the
> recommended pick.

Pitch/formant shifting is **not** a native Web Audio node. Options evaluated:

| Option | License | Real-time | Formant preservation | Verdict |
| --- | --- | --- | --- | --- |
| **SoundTouchJS AudioWorklet** — `@soundtouchjs/audio-worklet` (pitch/tempo) + `@soundtouchjs/formant-correction-worklet` (LPC formant) | **MPL-2.0** | Yes (runs on the audio render thread, exposes `pitch` / `pitchSemitones` / `playbackRate` AudioParams) | **Yes** — dedicated LPC-based formant-correction worklet | **Recommended.** Covers both required effects with one well-maintained lib. |
| **Tone.js `PitchShift`** | MIT | Yes (granular, low latency) | **No** (pitch only) | Fallback if SoundTouch is rejected; would leave "formant shift" unmet or hand-rolled. Also a heavier framework if pulled in just for this. |
| **Custom phase-vocoder `AudioWorklet`** | MIT (ours) | Yes (more latency than granular) | Possible but significant DSP work | Last resort; reinvents what SoundTouch already ships. |
| **Rubberband (WASM)** | **GPL/commercial dual** | Yes | Yes (excellent) | **Rejected** — GPL is incompatible with this proprietary, distributed (Electron) app unless we buy the commercial license (not free). |

**Licensing note (important correction):** SoundTouchJS is **MPL-2.0**, not
LGPL. MPL-2.0 is *file-level* copyleft: you may use it as a dependency in a
proprietary, closed-source app without any obligation to open your own code —
only modifications **to the MPL-licensed files themselves** must be published.
That makes it safe for both the web build and the distributed Electron build.
(An earlier planning note worried about LGPL/GPL; that concern is moot for
SoundTouch, and Rubberband — the actual GPL option — is what we reject.)

**Worklet serving + CSP:** the worklet processor JS is served same-origin from
`web/public/worklets/…` and registered with `ctx.audioWorklet.addModule(url)`.
The CSP in `middleware.ts` is `script-src 'self' 'nonce-…'` and `default-src
'self'`, so a same-origin worklet module is allowed with **no CSP change**.

**Recommended DSP pick (this version):** native nodes for everything in 3a
**only** — pitch & formant (and the SoundTouchJS dependency) are deferred per the
owner decision above. Keeping the chain native-only means zero added dependency,
zero licensing surface, and the smallest bundle; SoundTouchJS can be slotted in
later as one more chain effect without reworking the engine.

---

## 4. AI voice conversion — evaluation

Two broad directions, ranked on security → free → quality/feasibility:

### 4a. In-browser, local (audio never leaves the machine)

Run an RVC / so-vits / OpenVoice model client-side via **ONNX Runtime Web** or
**Transformers.js** with the **WebGPU** backend.

- **Security:** best — audio stays local, consistent with the project's
  loopback/native rejection ethos.
- **Reality check:** heavy. Models are tens-to-hundreds of MB to download on
  first use; quality RVC needs WebGPU (not universal) and a feature extractor
  (HuBERT/ContentVec) + the generator, both of which are large; in-browser RVC is
  still **immature** in 2026 with no turnkey, well-maintained JS package. Cloning
  in-browser is harder still.
- **Verdict:** **document as the preferred future local path, do not ship now.**
  Too much weight/risk for a best-effort task this version.

### 4b. Free external API — `r3gm/rvc_zero` (LOCKED choice)

The locked AI provider is the **`r3gm/rvc_zero`** Hugging Face Gradio Space
(**RVC⚡ZERO**). Source is **`R3gm/rvc_zero_ui`, MIT-licensed**.

- **What it does:** speech-to-speech **voice conversion** (also TTS, which we
  don't use). Voice model can be supplied three ways — upload `.pth`+`.index`,
  give **download URLs**, or pick a **preset**. Params: pitch algorithm
  (`rmvpe+`), pitch (semitones), index rate, denoise, reverb, output format.
- **Capability fit:** RVC needs a **pre-trained model per voice**, so rvc_zero
  cleanly delivers **preset voices** (we curate a list of public RVC model URLs).
  It does **not** do zero-shot **cloning** from a reference sample — that's a
  different model (OpenVoice V2). **Owner decision (2026-06-15): ship presets now,
  cloning later** (OpenVoice is the future cloning path; not this version).

**Driving it (Gradio REST flow):**
1. `POST {space}/gradio_api/upload` (multipart) → server file path for the clip.
2. `POST {space}/gradio_api/call/{api_name}` `{ data: [audioPath, modelUrl, indexUrl, pitch, …] }` → `event_id`.
3. `GET {space}/gradio_api/call/{api_name}/{event_id}` (SSE) → output file path.
4. `GET {space}/gradio_api/file={outputPath}` → converted audio.

The **`@gradio/client`** JS package wraps all four (`Client.connect("r3gm/rvc_zero")`
→ `client.predict(api_name, payload)`).

**⚠️ ZeroGPU + the routing decision (LOCKED: browser-direct).** rvc_zero runs on
**ZeroGPU**, which meters GPU time per **HF account / per-IP** via an `X-IP-Token`
header HF's edge injects for the *end user's* browser session. A server proxy with
*our* token would make **all users share one tiny quota** ("exceeded GPU quota").
So the locked path is **browser-direct**: the browser runs `@gradio/client`
straight to the Space so **each user spends their own anonymous ZeroGPU
allotment** (IP-based) and we hold **no HF token**.

- **CSP change required (deliberate):** this **reverses** the earlier "same-origin
  proxy" plan. The browser must reach the Space, so `middleware.ts` must add the HF
  hosts to **`connect-src`** — `https://*.hf.space https://huggingface.co` (the
  Space resolves to `https://r3gm-rvc-zero.hf.space`; config/upload/call/SSE/file
  all hit that host). The converted audio comes back as a `blob:` we already allow
  in `media-src`. No proxy route, no server token.
- **Security tradeoff (must disclose):** the user's mic audio is uploaded to a
  third-party Space (Hugging Face). This is a real privacy cost and **must be
  surfaced in the UI** ("audio is sent to Hugging Face (rvc_zero) for conversion")
  wherever AI is enabled.
- **Reliability caveat:** free ZeroGPU Spaces queue, rate-limit, sleep when idle,
  and can change/disappear. Hence **best-effort** + push-to-talk, with the UI
  degrading to disabled/"coming soon" if the Space is unavailable.

**Scale path — self-hosting (documented alternative).** Because `rvc_zero_ui` is
**MIT**, we can later run our own copy to escape ZeroGPU quotas and keep audio on
our own infra. It's a standalone **Gradio 5.x Python app** (`torch==2.5.1` +
`infer-rvc-python`, ~Python 3.10), added as a second `docker-compose` service. An
**NVIDIA CUDA GPU (~4–6 GB VRAM)** gives near-real-time conversion; **CPU-only
runs but is slow** (~10–60 s for a few seconds of audio). Base models
(HuBERT/ContentVec + `rmvpe`, a few hundred MB) auto-download on first run;
per-voice `.pth`/`.index` are URL-fetched or mounted. If self-hosted, the proxy
path returns (CSP stays `'self'`, audio never leaves your infra). Not in scope for
1.4.0 — recorded as the scaling option.

**Preset policy + concrete list (LOCKED: hybrid).** Most public RVC models are
**scraped celebrity / game-character voices** — bundling those as built-in presets
in a *distributed* app (the Electron build + public instance) is a real
copyright/likeness/impersonation risk (AI Hub's own terms forbid redistribution
and impersonation). Confirmed-*original* RVC voices are scarce. So the locked shape
is **hybrid**: a tiny set of **confirmed-safe** bundled presets + a **custom RVC
model URL** field (rvc_zero accepts model/index URLs) where the user supplies — and
owns the rights to — any other voice.

Bundled safe presets are built from the **one** confirmed-safe original model and
its RVC **pitch** param (so several presets, zero extra impersonation risk):

```
// PhoenixStormJr/RVC-V2-default-voice — generic original test voice, MIT (attribution required)
const DEFAULT_MODEL = "https://huggingface.co/PhoenixStormJr/RVC-V2-default-voice/resolve/main/default.pth";
const DEFAULT_INDEX = "https://huggingface.co/PhoenixStormJr/RVC-V2-default-voice/resolve/main/added_IVF511_Flat_nprobe_1_default_v2.index";

PRESETS = [
  { id: "neutral", label: "Neutral",        modelUrl: DEFAULT_MODEL, indexUrl: DEFAULT_INDEX, pitch:  0 },
  { id: "deep",    label: "Deeper",         modelUrl: DEFAULT_MODEL, indexUrl: DEFAULT_INDEX, pitch: -7 },
  { id: "high",    label: "Higher",         modelUrl: DEFAULT_MODEL, indexUrl: DEFAULT_INDEX, pitch: +7 },
]
// + a "Custom…" entry: user-entered { modelUrl, indexUrl, pitch }
```

Notes: MIT requires **attribution** for the bundled model — credit PhoenixStormJr
in the Voice-changer UI (or a credits/about line). The custom-URL field carries a
short "use only voices you're entitled to" reminder beside the security
disclosure. If a better-licensed *original* voice surfaces later, add it as another
`PRESETS` entry — no engine change.

### AI verdict

For 1.4.0, **wire `r3gm/rvc_zero` browser-direct** as a **best-effort,
push-to-talk, live-mic-only, preset-voices** feature: `@gradio/client` from the
browser, curated preset model URLs, per-user ZeroGPU quota, a deliberate
`connect-src` widening to the HF hosts, and an explicit security disclosure.
**Voice cloning is deferred** (OpenVoice V2 later). **Defer in-browser local (4a)**
until a mature WebGPU package exists; **self-hosting (above) is the documented
scale path.** If the Space proves undependable during implementation, ship the AI
controls disabled — **DSP is the committed deliverable, AI is not.**

---

## 5. Persistence & UI (locked)

- **Persistence:** device-local `localStorage` key **`soundboard:voicefx`** shaped
  `{ [sourceKey]: { effects: EffectConfig[]; ai?: { enabled, voiceId, custom?: { modelUrl, indexUrl, pitch } } } }`,
  where `sourceKey` is a capture `deviceId` or `SOUNDBOARD_KEY`. `ai` is only set on
  **capture-device** keys (never the soundboard); `voiceId` indexes the preset list
  or `"custom"`. The **PTT hotkey** binds are separate device-local keys
  (`soundboard:aiPttKeybind` / `soundboard:aiPttControllerBind`), mirroring
  cancel-all.

- **AI runtime behavior (locked):** the AI section shows on **each capture-device
  row** (hidden on the soundboard). **Push-to-talk** is both an on-screen hold
  button and a **bindable keyboard + VR hotkey** (`AI_PTT_BIND` sentinel through the
  existing matchers). **AI replaces the raw mic:** while AI is enabled on a device,
  the mixer mutes that device's raw cable+monitor send and only the converted PTT
  clips pass (through its DSP chain) — converted sound, no doubling, PTT-bursts
  only.
  Mirrors the existing `soundboard:output` settings pattern — **no DB/schema
  change**.
- **UI:** a **third Control Panel pill tab "Voice changer"** (beside *Output &
  volume* / *Virtual Mic mode*, gated on `supportsSinkId`). Each source is a card
  with a **per-source stackable effect-chain editor** (ordered list, add/remove/
  reorder, param sliders) via the shared `Select`; the **live-mic** card also shows
  the **AI section** (preset picker / reference-sample upload for cloning +
  push-to-talk + the security disclosure).

---

## 6. Recommended picks (summary)

1. **DSP, real-time (ships) — native Web Audio only, no external DSP dependency:**
   - Native Web Audio nodes for robot/ring-mod, echo, reverb (generated IR),
     distortion, telephone/band-pass, tremolo, filters, and an in-house bitcrusher
     worklet.
   - **Pitch + formant shift are deferred** (owner decision) — no SoundTouchJS or
     other DSP library is added this version. The engine is built so a
     library-backed effect can be added later as one more chain entry.
   - Per-source **stackable chain**; chain rebuilds use make-before-break splicing
     (mirror `rebuildMonitorTail`) to avoid clicks.
2. **AI, best-effort (push-to-talk, live mic only):** **`r3gm/rvc_zero`**
   (ZeroGPU, MIT) called **browser-direct** via **`@gradio/client`** for **preset
   voices** (curated public RVC model URLs), using each user's own per-IP ZeroGPU
   quota (we hold no HF token). Requires a deliberate **`connect-src` widening** to
   `https://*.hf.space https://huggingface.co` in `middleware.ts`, plus an explicit
   "audio is sent to Hugging Face" disclosure. **Cloning is deferred** (OpenVoice
   V2 later); in-browser ONNX/WebGPU local conversion is **deferred**; **self-host
   (MIT Gradio app + GPU)** is the documented scale path.
3. **No native code, no loopback** — honors the `virtual-mic-capture` constraint.
4. **CSP:** DSP needs no change; the AI path **intentionally widens `connect-src`**
   to the HF hosts (browser-direct was chosen over a proxy to get per-user quota).

## 7. Resolved

The pitch/formant + library question is **settled**: the owner deferred both pitch
shift and formant shift (2026-06-15), so **no DSP library is added** this version
and the DSP path is native Web Audio only. The SoundTouchJS evaluation (and the
MPL-2.0 licensing finding) is preserved in §3b for whenever pitch/formant are
revisited.

## Sources

- [SoundTouchJS (`@soundtouchjs/audio-worklet`, MPL-2.0)](https://github.com/cutterbl/SoundTouchJS/)
- [Tone.js `PitchShift`](https://tonejs.github.io/docs/PitchShift)
- [Pitch shifting in Web Audio API — Tuomas Siipola](https://zpl.fi/pitch-shifting-in-web-audio-api/)
- [RVC project (Retrieval-based Voice Conversion)](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI)
- [RVC⚡ZERO Space (`r3gm/rvc_zero`)](https://huggingface.co/spaces/r3gm/rvc_zero)
- [rvc_zero source (`R3gm/rvc_zero_ui`, MIT)](https://github.com/R3gm/rvc_zero_ui)
- [Spaces as API endpoints (Gradio REST + auth)](https://huggingface.co/docs/hub/spaces-api-endpoints)
- [Using ZeroGPU Spaces from the client (X-IP-Token, quota)](https://www.gradio.app/docs/python-client/using-zero-gpu-spaces)
- [OpenVoice V2 (`myshell-ai/OpenVoiceV2`) — deferred cloning path](https://huggingface.co/myshell-ai/OpenVoiceV2)
