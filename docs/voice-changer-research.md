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

> **Update (1.4.1, §8a-bis):** a **pitch shift** later shipped as a self-authored
> DIY granular worklet (pitch only — no dependency). **Formant** remains deferred:
> SoundTouchJS is still the pick but couldn't be vendored/verified in-environment.
> See §8a-bis for the registry generalisation + the upgrade path.

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

## 8. 1.4.1 — More DSP effects + realtime-AI survey

> Task 1 of **1.4.1** ("Voice changer effects improvements"). Two axes: broaden
> the native DSP palette (ships), and survey a **realtime** AI voice path
> (**research/document only — no realtime code lands in 1.4.1**, owner decision
> 2026-06-16). The existing 1.4.0 push-to-talk `rvc_zero` path is untouched.

### 8a. New DSP effects (shipped)

All native Web Audio, real-time, no worklet, no external DSP library — added to
`lib/voice-fx.ts` as new `EffectKind` members so the chain editors, presets, and
persistence pick them up automatically via `EFFECT_DEFS`.

| Effect | Graph | Notes |
|---|---|---|
| **Chorus** | dry + one LFO-modulated `DelayNode` (~25 ms base) | rate/depth(ms)/mix |
| **Flanger** | chorus with a ~2 ms base delay + feedback loop | swept comb / "jet" |
| **Phaser** | 4 cascaded all-pass `BiquadFilter`s swept by one LFO + dry mix | moving notches |
| **Vibrato** | fully-wet LFO-modulated `DelayNode` | periodic pitch wobble |
| **Compressor** | `DynamicsCompressorNode` | threshold/ratio/attack/release; level-evening before the cable |
| **Megaphone** | narrow band-pass `BiquadFilter` → tanh `WaveShaper` | gritty bullhorn/PA timbre |

The modulation effects sum an `OscillatorNode → GainNode` onto a `DelayNode`'s (or
biquad's) `.frequency`/`.delayTime` AudioParam — the same pattern the existing
tremolo/robot use, so they reconcile params live with no chain rebuild.

**Considered but NOT shipped (native):**
- **Stereo widener** — the mic/source chain is effectively **mono** (single capture
  device → mono `MediaStreamSource`), so a Haas/mid-side widener has nothing to
  widen. Not useful until multi-channel sources exist.

### 8a-bis. Worklet-backed effects (shipped, appended)

Owner greenlit the noise gate + pitch shift after a follow-up pass (2026-06-16).
Both are **our own AudioWorklets** served same-origin from `web/public/worklets/`
(CSP `script-src 'self'` allows them, no change). The bitcrusher's lazy
register-once preload was **generalised** into a `WORKLET_MODULES` registry +
`chainNeedsWorklet`/`ensureWorkletModules` in `lib/voice-fx.ts` (replacing the
bitcrusher-specific helpers at the `audio-mixer.ts` call sites), so each
worklet-backed effect registers + preloads the same way with the same
optimistic-build → passthrough-fallback behavior.

| Effect | Worklet | Params | Notes |
|---|---|---|---|
| **Noise gate** | `noisegate-processor.js` | threshold/attack/hold/release/range | peak envelope follower + 3 dB hysteresis + hold; ramped gain (no click); `range` = closed-gate attenuation (dB) |
| **Pitch shift** | `pitch-processor.js` | pitch (semitones, −12..+12) | DIY dual-tap delay-line granular shifter, constant-power sin crossfade; **PITCH ONLY** |

- **Formant shift — RE-DEFERRED (⚠️ flag).** The planned pick was **SoundTouchJS**
  (`@soundtouchjs/audio-worklet` + `@soundtouchjs/formant-correction-worklet`,
  MPL-2.0). It ships its worklets inside its npm packages, which can't be vendored
  into `web/public/worklets/` without installing+building them, and its documented
  path is buffer playback rather than a live `MediaStreamSource` — neither
  verifiable under the no-install/no-run constraint. So per the locked fallback we
  ship a self-authored **pitch-only** granular worklet and re-defer formant. **To
  upgrade:** `pnpm add @soundtouchjs/audio-worklet @soundtouchjs/formant-
  correction-worklet`, copy their processor JS into `web/public/worklets/`, and
  point the `pitch` `createEffect` case at them (exposing `pitch` + `formant`).

### 8b. Realtime AI voice changer — survey (NOT implemented)

Goal: continuous, low-latency (<~300 ms) live conversion, vs the current PTT
bursts. Two families, ranked by realtime feasibility.

**(a) In-browser / on-device (audio stays local).**
- *RVC / so-vits-svc in the browser (ONNX Runtime Web / WebGPU / WASM).* RVC's
  pipeline (HuBERT/ContentVec feature extraction + RVC model + a vocoder, often
  RMVPE for f0) is heavy; ContentVec alone is ~95 M params. ONNX Runtime Web's
  WebGPU EP can run mid-size models, but a full realtime RVC stack in-browser is
  still **research-grade** — chunked streaming inference, f0 estimation latency, and
  model download size (100s of MB) make a smooth realtime experience unlikely on
  commodity hardware today. **Verdict: not ready** for a shippable realtime feature;
  re-evaluate as WebGPU model zoos mature.
- *Lightweight DSP-AI hybrids* (formant/pitch via WORLD/Praat-style vocoders
  compiled to WASM) can be realtime but are **voice *modification*, not voice
  *conversion*** to a target speaker — closer to the DSP palette than to AI presets.

**(b) External realtime providers (audio leaves the machine — continuous stream).**
- **ElevenLabs** *Voice Changer* — speech-to-speech; a low-latency/streaming
  (Flash/realtime) tier exists. **Paid** (credit-metered; realtime tiers gated to
  paid plans). Best quality of the surveyed options.
- **Respeecher / Voicemod (Cloud) / Speechify / similar** — realtime voice-skin
  APIs, all **paid/commercial**, key-per-account.
- **Self-hosted RVC realtime** (the `rvc_zero` lineage or `w-okada` realtime VC) on
  our own GPU exposed via WebSocket — **free of per-call cost** but needs a GPU box
  + ops; this is the same "self-host" scale path already noted for the PTT case.

**Cost / privacy / routing tradeoff (why it's deferred to a future version):**
- Any paid provider's key must live **server-side** (a proxy route) — unlike the
  1.4.0 browser-direct PTT (which spends each user's *own* free ZeroGPU quota), a
  paid realtime stream would bill **us** for **every user**, continuously. That's an
  open-ended cost we won't take on now.
- Realtime = a **persistent off-machine audio stream** (WebSocket/WebRTC), a larger
  privacy exposure than PTT bursts → would need a prominent always-on disclosure and
  a `connect-src`/`media-src` (and likely `connect-src wss:`) CSP widening to the
  provider.

**Recommended future pick (when realtime is built):** **self-host an RVC/​w-okada
realtime VC on our own GPU behind a same-origin WebSocket proxy** — keeps audio on
our infra (no third-party data sharing), no per-call vendor bill, and reuses the
documented "self-host the MIT Gradio app" scale path. If a hosted option is wanted
sooner, **ElevenLabs streaming** is the quality leader but is paid + sends audio to
a third party. **Implementation sketch (future):** a `lib/voice-ai-realtime.ts`
opening a WS to the proxy, `mic MediaStreamTrack → chunked PCM frames → proxy → GPU
VC → returned frames → a `MediaStreamAudioSourceNode` injected at the mic source's
chain head` (so DSP still applies), with the raw mic muted (the existing `aiMuted`
gate). None of this ships in 1.4.1.

### 8c. 1.4.1 verdict

Ship the **six new native DSP effects** (8a). **Realtime AI is documented only**
(8b) — no proxy, no new dependency, no CSP change; the 1.4.0 PTT path is unchanged.

### 8d. Paid AI voice — IMPLEMENTED (supersedes the §8b/§8c "deferred" verdict)

> Owner reversed the "paid/realtime = research-only" lock (2026-06-16, after the
> paid-provider research pass). 1.4.1 now ships **two paid AI features** alongside
> the free `rvc_zero` PTT path (which stays the default engine): **(A) STS** —
> speech→speech voice conversion (push-to-talk), and **(B) STT→TTS "re-speak"** —
> in-browser speech-to-text → paid text-to-speech.

**Providers:** ElevenLabs + Respeecher. `rvc_zero` (free, browser-direct, no key)
remains the default.

**Keys / billing (hybrid):** an **app-owned key** (env `ELEVENLABS_API_KEY` /
`RESPEECHER_API_KEY`) gated by a **per-user monthly quota** (seconds of AI audio,
resolved user override → role default → env `DEFAULT_AI_QUOTA_SECONDS`; see
`lib/ai-quota.ts` + the admin "AI voice" tab), **plus BYO key** — the user pastes
their own (device-local `soundboard:aiKeys`, sent as the `x-ai-key` header, **never
persisted server-side**, **not metered**).

**Routing (no CSP change):** all paid calls go through a **same-origin Next proxy**
(`POST /api/ai/sts` multipart, `POST /api/ai/tts` JSON; `lib/ai-providers.ts`
server clients). Because the browser only talks to our own origin, no
`connect-src` widening is needed (rvc_zero stays on the already-allowed HF hosts;
Web Speech is a native browser API). Routes are auth'd, `ai-mut` rate-limited, gate
on `aiEnabled` + `canUseAi`, and meter usage (STS = input seconds, TTS ≈ output
seconds; BYO skips). The proxy holds the app key or forwards the BYO key, then
discards it.

**STS interaction:** ElevenLabs = **PTT** (file Voice Changer, result streamed
back). Respeecher = **PTT/file mode only this version** — its **continuous-live**
(full-duplex WebSocket) path is **RE-DEFERRED**: the app deploys as Next
`output: "standalone"` (`node server.js`), whose server exposes no WS `upgrade`
hook and whose route handlers can't accept a WS upgrade, so a same-origin WS proxy
would require a custom server + Dockerfile change (untestable here) and
Respeecher's realtime WS framing isn't publicly specified. **To revisit:** adopt a
custom Node server (wrap/replace the standalone output) + obtain Respeecher's
realtime WS spec, then build `lib/voice-ai-realtime.ts` per the §8b sketch.

**STT→TTS re-speak (feature B):** in-browser `SpeechRecognition` (`lib/voice-stt.ts`)
for the STT half (interim transcript shown live; auto-synthesize on release), the
chosen provider's TTS for the synth half. ⚠️ **Electron:** its Chromium ships no
Google speech key, so `sttSupported()` is false there and the UI gates re-speak to
the web build.

**Voices:** curated safe presets per provider (ElevenLabs default library voices;
Respeecher = custom-only) + a **custom voice-ID** field, mirroring the rvc_zero
hybrid. **Disclosure:** every off-machine path (paid providers + the Web Speech
API) surfaces an in-UI privacy notice (`PAID_PRIVACY` / `STT_PRIVACY`), extending
the 1.4.0 `AI_PRIVACY_NOTICE` pattern.

**Persistence:** the AI config (`engine` / `mode` / `voiceId` / `customVoiceId` /
`live`) rides in the per-source voice-changer config (`AiConfig` in the `voiceFx`
map), which the Profiles batch already persists **per-profile server-side**; old
device-local rvc_zero `ai` blobs read as `engine: rvc_zero` (back-compat) and
migrate into the Default profile via the existing profiles migration. The **BYO key
stays device-local** (a secret).

## Sources

- [ONNX Runtime Web (WebGPU execution provider)](https://onnxruntime.ai/docs/tutorials/web/)
- [w-okada Realtime Voice Changer](https://github.com/w-okada/voice-changer)
- [ElevenLabs Voice Changer (speech-to-speech) API](https://elevenlabs.io/docs/capabilities/voice-changer)
- [MDN — DynamicsCompressorNode](https://developer.mozilla.org/en-US/docs/Web/API/DynamicsCompressorNode)
- [SoundTouchJS (`@soundtouchjs/audio-worklet`, MPL-2.0)](https://github.com/cutterbl/SoundTouchJS/)
- [Tone.js `PitchShift`](https://tonejs.github.io/docs/PitchShift)
- [Pitch shifting in Web Audio API — Tuomas Siipola](https://zpl.fi/pitch-shifting-in-web-audio-api/)
- [RVC project (Retrieval-based Voice Conversion)](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI)
- [RVC⚡ZERO Space (`r3gm/rvc_zero`)](https://huggingface.co/spaces/r3gm/rvc_zero)
- [rvc_zero source (`R3gm/rvc_zero_ui`, MIT)](https://github.com/R3gm/rvc_zero_ui)
- [Spaces as API endpoints (Gradio REST + auth)](https://huggingface.co/docs/hub/spaces-api-endpoints)
- [Using ZeroGPU Spaces from the client (X-IP-Token, quota)](https://www.gradio.app/docs/python-client/using-zero-gpu-spaces)
- [OpenVoice V2 (`myshell-ai/OpenVoiceV2`) — deferred cloning path](https://huggingface.co/myshell-ai/OpenVoiceV2)
