"use client";

// AI voice — its own header popover (ver/1.4.1, split out of the Voice-changer
// popover). PRIMARY MIC ONLY: the selected input device (audio.inputDeviceId) is
// the AI source; its config is keyed by that deviceId in the engine's voiceFx map.
//
// Three surfaces, all driven from here:
//   • AiVoicePanel  — the header popover body (engine/voice/mode/PTT + binds)
//   • AiMainSection — a compact main-page strip (hold-to-talk + replay), shown on
//                     the dashboard only while AI is enabled (below upload, above board)
// The provider API keys live in Settings now (Task 4); push-to-talk bind state
// lives in VoiceChangerProvider; the VR bind PICKER renders from VrProvider.

import { useEffect, useRef, useState } from "react";
import { Wand2, ShieldAlert, Mic, Keyboard, Gamepad2, Repeat } from "lucide-react";
import type { AudioOutput, AiConfig, AiEngine, AiMode } from "@/lib/audio-output";
import { AI_PRESETS, AI_CUSTOM_ID, AI_MODEL_CREDIT, AI_PRIVACY_NOTICE, type AiVoice } from "@/lib/voice-ai";
import {
  PAID_VOICES,
  PAID_CUSTOM_ID,
  PAID_PRIVACY,
  RESPEECHER_LIVE_PRIVACY,
  PROVIDER_LABEL,
  type PaidProvider,
} from "@/lib/voice-ai-paid";
import { sttSupported, STT_PRIVACY } from "@/lib/voice-stt";
import { getProfileBind, setProfileBind, type VrProfile } from "@/lib/vr-bind";
import type { VoiceConfig } from "@/lib/voice-presets";
import { Select } from "@/components/Select";
import { Toggle } from "@/components/Toggle";
import { VrBindChips } from "@/components/VrBindChips";
import { VoicePresetBar } from "@/components/VoicePresetBar";
import { useVoiceChanger } from "@/components/VoiceChangerProvider";

// The VR controller profile + desktop-app presence are device-local; the popover
// reads them directly (Dashboard owns the live profile dropdown / SteamVR status).
function readControllerProfile(): VrProfile {
  if (typeof window === "undefined") return "index";
  try {
    const p = localStorage.getItem("soundboard:controllerProfile");
    return p === "quest" ? "quest" : "index";
  } catch {
    return "index";
  }
}
const hasDesktopApp = () => typeof window !== "undefined" && "soundboard" in window;

// Header popover body. Resolves the primary mic; if none is selected yet it lets
// the user pick one right here (so the popover isn't a dead end).
export function AiVoicePanel({ audio }: { audio: AudioOutput }) {
  const sourceKey = audio.inputDeviceId;

  if (!sourceKey) {
    const noMics = audio.inputDevices.length === 0;
    const labelsHidden = audio.inputDevices.some((d) => !d.label);
    const inputOptions = [
      { value: "", label: "None" },
      ...audio.inputDevices.map((d) => ({ value: d.deviceId, label: d.label || `Mic ${d.deviceId.slice(0, 6)}` })),
    ];
    return (
      <div className="space-y-2 text-sm">
        <h3 className="font-medium flex items-center gap-1.5"><Wand2 size={14} className="text-fuchsia-300" /> AI voice</h3>
        <p className="text-xs text-muted">Turn your mic into an AI voice. Pick your input device to start:</p>
        <label className="block">
          <span className="flex items-center gap-1.5 text-xs text-muted mb-1"><Mic size={12} /> Input device (mic)</span>
          <Select
            className="w-full"
            aria-label="Input device"
            value={audio.inputDeviceId}
            onChange={audio.setInputDeviceId}
            options={inputOptions}
          />
        </label>
        {(noMics || labelsHidden) && (
          <button type="button" className="btn-ghost text-xs" onClick={() => audio.requestLabelsPermission()}>
            {noMics ? "Find microphones (grants mic permission)" : "Show device names (grants mic permission once)"}
          </button>
        )}
        <p className="text-[11px] text-muted">This is the same setting as the Input device in Settings.</p>
      </div>
    );
  }

  const active = audio.virtualMicMode;
  return (
    <div className="space-y-3 text-sm">
      <h3 className="font-medium flex items-center gap-1.5"><Wand2 size={14} className="text-fuchsia-300" /> AI voice</h3>
      <p className="text-xs text-muted">
        Replace your mic with an AI voice (push-to-talk). It feeds the virtual-mic cable, so it only takes
        effect with Virtual Mic mode on.
      </p>
      {!active && (
        <p className="text-xs text-amber-300/90">
          Virtual Mic mode is off — settings are saved but won&apos;t be heard until you enable it in Settings.
        </p>
      )}
      {audio.aiError && <p className="text-xs text-red-400">AI voice error: {audio.aiError}</p>}
      <AiSection sourceKey={sourceKey} audio={audio} />
    </div>
  );
}

// The AI voice section for the mic: enable (mutes the raw mic), pick an engine
// (rvc_zero free / ElevenLabs / Respeecher), a voice + mode, push-to-talk (button +
// hotkeys), the required privacy disclosure, a usage meter, savable/sharable voice
// presets and provider attribution. PTT bind state comes from VoiceChangerProvider.
function AiSection({ sourceKey, audio }: { sourceKey: string; audio: AudioOutput }) {
  const vc = useVoiceChanger();
  const ai = audio.voiceFx[sourceKey]?.ai;
  const enabled = !!ai?.enabled;
  const engine: AiEngine = ai?.engine ?? "rvc_zero";
  const paid = engine === "elevenlabs" || engine === "respeecher";
  const mode: AiMode = ai?.mode ?? "sts";
  const voiceId = ai?.voiceId ?? AI_PRESETS[0].id;
  const custom = ai?.custom ?? null;
  const recording = audio.pttRecording.has(sourceKey);
  const sttOk = sttSupported();

  // Device-local profile + desktop presence (read once per popover open).
  const [controllerProfile] = useState<VrProfile>(readControllerProfile);
  const hasDesktop = hasDesktopApp();

  // Re-fetch the usage meter after a conversion lands (aiBusy falling edge).
  const [usageRefresh, setUsageRefresh] = useState(0);
  const prevBusy = useRef(false);
  useEffect(() => {
    if (prevBusy.current && !audio.aiBusy) setUsageRefresh((n) => n + 1);
    prevBusy.current = audio.aiBusy;
  }, [audio.aiBusy]);

  const base: AiConfig = ai ?? { enabled: false, voiceId };
  const setAi = (next: Partial<AiConfig>) => {
    audio.setSourceAi(sourceKey, { ...base, enabled: true, ...next });
  };
  const setCustom = (patch: Partial<AiVoice>) => {
    const cb: AiVoice = custom ?? { modelUrl: "", indexUrl: "", pitch: 0 };
    setAi({ voiceId: AI_CUSTOM_ID, custom: { ...cb, ...patch } });
  };

  // Switching engine resets the voice (the id namespace differs) + the mode.
  const changeEngine = (eng: AiEngine) => {
    if (eng === "rvc_zero") {
      setAi({ engine: eng, voiceId: AI_PRESETS[0].id, mode: undefined, live: undefined });
    } else {
      const first = PAID_VOICES[eng as PaidProvider][0]?.id ?? PAID_CUSTOM_ID;
      setAi({ engine: eng, voiceId: first, mode: "sts", live: false });
    }
  };

  // Apply a saved/shared voice preset onto the AI config (engine + identity). For a
  // paid engine seed a default mode if none is set.
  const applyVoice = (eng: AiEngine, cfg: VoiceConfig) => {
    if (eng === "rvc_zero") {
      setAi({ engine: eng, voiceId: cfg.voiceId, custom: cfg.custom ?? null, customVoiceId: undefined, mode: undefined, live: undefined });
    } else {
      setAi({ engine: eng, voiceId: cfg.voiceId, customVoiceId: cfg.customVoiceId, custom: null, mode: mode ?? "sts", live: false });
    }
  };
  const currentConfig: VoiceConfig = { voiceId, customVoiceId: ai?.customVoiceId, custom };

  const profBind = getProfileBind(vc.aiPttControllerBind, controllerProfile);
  const replayBind = getProfileBind(vc.aiReplayControllerBind, controllerProfile);

  const isRespeak = paid && mode === "respeak";
  const privacy = engine === "rvc_zero" ? AI_PRIVACY_NOTICE : PAID_PRIVACY[engine as PaidProvider];
  const attribution = engine === "rvc_zero" ? AI_MODEL_CREDIT : `Powered by ${PROVIDER_LABEL[engine as PaidProvider]}`;
  const paidVoices = paid ? PAID_VOICES[engine as PaidProvider] : [];

  return (
    <div className="rounded-lg border border-fuchsia-400/20 bg-fuchsia-500/[0.04] px-2.5 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-sm">
          <Wand2 size={13} className="text-fuchsia-300 shrink-0" /> Enable AI voice
        </span>
        <Toggle size="sm" checked={enabled} onChange={(b) => setAi({ enabled: b })} label="Toggle AI voice for the mic" />
      </div>

      {enabled && (
        <div className="grid gap-2 mt-2">
          {/* Engine picker — free rvc_zero vs paid providers. */}
          <Select
            className="w-full !py-1.5 text-xs"
            aria-label="AI engine"
            value={engine}
            onChange={(v) => changeEngine(v as AiEngine)}
            options={[
              { value: "rvc_zero", label: "RVC⚡ZERO (Free)" },
              { value: "elevenlabs", label: "ElevenLabs (paid)" },
              { value: "respeecher", label: "Respeecher (paid)" },
            ]}
          />

          {/* Usage meter (paid, app-key only). Provider keys are set in Settings. */}
          {paid && <AiUsageMeter refresh={usageRefresh} />}
          {paid && (
            <p className="text-[11px] text-muted">
              Paste your own provider API key in Settings to bypass the free quota.
            </p>
          )}

          {/* Required disclosure — audio/text leaves the machine. */}
          <p className="flex items-start gap-1.5 text-xs text-amber-300/90">
            <ShieldAlert size={13} className="shrink-0 mt-0.5" />
            <span>{privacy}</span>
          </p>
          {isRespeak && (
            <p className="flex items-start gap-1.5 text-xs text-amber-300/90">
              <ShieldAlert size={13} className="shrink-0 mt-0.5" />
              <span>{STT_PRIVACY}</span>
            </p>
          )}
          <p className="text-xs text-muted">
            Enabling AI removes your raw mic from the cable — only converted push-to-talk bursts pass.
          </p>

          {/* Mode (paid): voice conversion vs re-speak (STT→TTS). */}
          {paid && (
            <>
              <Select
                className="w-full !py-1.5 text-xs"
                aria-label="AI mode"
                value={mode}
                onChange={(v) => setAi({ mode: v as AiMode })}
                options={[
                  { value: "sts", label: "Voice conversion (STS)" },
                  { value: "respeak", label: "Re-speak (speech → text → voice)" },
                ]}
              />
              {isRespeak && !sttOk && (
                <p className="text-xs text-amber-300/90">
                  Speech recognition isn&apos;t available here (it needs Chrome — not the desktop app).
                </p>
              )}
              {engine === "respeecher" && mode === "sts" && (
                <p className="text-xs text-muted">
                  Continuous live mode — coming soon. Push-to-talk is available now.
                </p>
              )}
              {engine === "respeecher" && mode === "sts" && (
                <p className="text-[11px] text-muted/80">{RESPEECHER_LIVE_PRIVACY}</p>
              )}
            </>
          )}

          {/* Voice picker — rvc_zero presets / paid provider voices, + custom. */}
          {engine === "rvc_zero" ? (
            <>
              <Select
                className="w-full !py-1.5 text-xs"
                aria-label="AI voice preset"
                value={voiceId}
                onChange={(v) => (v === AI_CUSTOM_ID ? setCustom({}) : setAi({ voiceId: v, custom }))}
                options={[...AI_PRESETS.map((p) => ({ value: p.id, label: p.label })), { value: AI_CUSTOM_ID, label: "Custom…" }]}
              />
              {voiceId === AI_CUSTOM_ID && (
                <div className="grid gap-1.5">
                  <input className="input !py-1.5 text-xs" placeholder="Model URL (.pth)" value={custom?.modelUrl ?? ""} onChange={(e) => setCustom({ modelUrl: e.target.value })} />
                  <input className="input !py-1.5 text-xs" placeholder="Index URL (.index)" value={custom?.indexUrl ?? ""} onChange={(e) => setCustom({ indexUrl: e.target.value })} />
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted w-16 shrink-0">Pitch</span>
                    <input type="range" min={-12} max={12} step={1} value={custom?.pitch ?? 0} onChange={(e) => setCustom({ pitch: Number(e.target.value) })} className="flex-1 accent-accent" aria-label="Custom voice pitch" />
                    <span className="text-xs text-muted w-8 text-right tabular-nums">{custom?.pitch ?? 0}</span>
                  </div>
                  <p className="text-xs text-muted">Use only voices you have the rights to.</p>
                </div>
              )}
            </>
          ) : (
            <>
              <Select
                className="w-full !py-1.5 text-xs"
                aria-label="AI voice"
                value={voiceId === PAID_CUSTOM_ID || paidVoices.some((v) => v.id === voiceId) ? voiceId : PAID_CUSTOM_ID}
                onChange={(v) => setAi({ voiceId: v })}
                options={[...paidVoices.map((v) => ({ value: v.id, label: v.label })), { value: PAID_CUSTOM_ID, label: "Custom voice ID…" }]}
              />
              {voiceId === PAID_CUSTOM_ID && (
                <div className="grid gap-1">
                  <input
                    className="input !py-1.5 text-xs"
                    placeholder="Provider voice ID"
                    value={ai?.customVoiceId ?? ""}
                    onChange={(e) => setAi({ voiceId: PAID_CUSTOM_ID, customVoiceId: e.target.value })}
                  />
                  <p className="text-xs text-muted">Use only voices you have the rights to.</p>
                </div>
              )}
            </>
          )}

          {/* Savable / sharable voice presets (custom voice id / model+index URL). */}
          <VoicePresetBar engine={engine} config={currentConfig} onApply={applyVoice} />

          {/* Push-to-talk: hold the button (or the bound hotkey) to record. */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              className={`btn-ghost text-xs ${recording ? "!border-fuchsia-400/50 !bg-fuchsia-500/20 text-white" : ""}`}
              onPointerDown={(e) => { e.preventDefault(); audio.startPtt(sourceKey); }}
              onPointerUp={() => audio.stopPtt(sourceKey)}
              onPointerLeave={() => { if (recording) audio.stopPtt(sourceKey); }}
              title="Hold to record, release to convert"
            >
              <Mic size={14} className="mr-1" />
              {recording
                ? isRespeak ? "Listening… release to speak" : "Recording… release to convert"
                : isRespeak ? "Hold to re-speak" : "Hold to talk"}
            </button>
            {audio.aiBusy && <span className="text-xs text-fuchsia-300">{isRespeak ? "Synthesizing…" : "Converting…"}</span>}
          </div>
          {isRespeak && recording && (
            <p className="text-xs text-fuchsia-200/90 italic min-h-[1rem]">{audio.aiTranscript || "…"}</p>
          )}

          {/* Hotkeys (one global PTT bind, editable here). */}
          <div className="flex items-center gap-1.5 flex-wrap rounded-lg border border-white/10 bg-white/[0.03] p-1">
            <span className="text-xs text-muted px-1">PTT hotkey</span>
            <button
              type="button"
              className={`btn-ghost text-xs ${vc.capturingAiPtt ? "text-accent" : ""}`}
              onClick={() => vc.setCapturingAiPtt(!vc.capturingAiPtt)}
              title="Set a keyboard push-to-talk hotkey"
            >
              <Keyboard size={14} className="mr-1" />
              {vc.capturingAiPtt ? "Hold keys…" : vc.aiPttKeybind || "Set keybind"}
            </button>
            {vc.aiPttKeybind && !vc.capturingAiPtt && (
              <button type="button" className="btn-ghost text-xs !px-1.5" onClick={() => vc.setAiPttKeybind(null)} title="Clear PTT keybind">
                ×
              </button>
            )}
            {hasDesktop && (
              <>
                <span className="h-4 w-px bg-white/10" aria-hidden />
                <button type="button" className="btn-ghost text-xs" onClick={() => vc.setCapturingAiPttVr(true)} title="Set a controller push-to-talk bind">
                  <Gamepad2 size={14} className="mr-1" />
                  {profBind ? <VrBindChips value={profBind} /> : "Set controller"}
                </button>
                {profBind && (
                  <button
                    type="button"
                    className="btn-ghost text-xs !px-1.5"
                    onClick={() => vc.setAiPttControllerBind(setProfileBind(vc.aiPttControllerBind, controllerProfile, null))}
                    title="Clear PTT controller bind"
                  >
                    ×
                  </button>
                )}
              </>
            )}
          </div>

          {/* Replay: re-inject the last converted clip (button + hotkeys). */}
          <div className="flex items-center gap-1.5 flex-wrap rounded-lg border border-white/10 bg-white/[0.03] p-1">
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => audio.replayLastConversion()}
              title="Replay the last converted clip"
            >
              <Repeat size={14} className="mr-1" /> Replay last
            </button>
            <button
              type="button"
              className={`btn-ghost text-xs ${vc.capturingAiReplay ? "text-accent" : ""}`}
              onClick={() => vc.setCapturingAiReplay(!vc.capturingAiReplay)}
              title="Set a keyboard replay hotkey"
            >
              <Keyboard size={14} className="mr-1" />
              {vc.capturingAiReplay ? "Hold keys…" : vc.aiReplayKeybind || "Set keybind"}
            </button>
            {vc.aiReplayKeybind && !vc.capturingAiReplay && (
              <button type="button" className="btn-ghost text-xs !px-1.5" onClick={() => vc.setAiReplayKeybind(null)} title="Clear replay keybind">
                ×
              </button>
            )}
            {hasDesktop && (
              <>
                <span className="h-4 w-px bg-white/10" aria-hidden />
                <button type="button" className="btn-ghost text-xs" onClick={() => vc.setCapturingAiReplayVr(true)} title="Set a controller replay bind">
                  <Gamepad2 size={14} className="mr-1" />
                  {replayBind ? <VrBindChips value={replayBind} /> : "Set controller"}
                </button>
                {replayBind && (
                  <button
                    type="button"
                    className="btn-ghost text-xs !px-1.5"
                    onClick={() => vc.setAiReplayControllerBind(setProfileBind(vc.aiReplayControllerBind, controllerProfile, null))}
                    title="Clear replay controller bind"
                  >
                    ×
                  </button>
                )}
              </>
            )}
          </div>

          <p className="text-[11px] text-muted">{attribution}</p>
        </div>
      )}
    </div>
  );
}

// Compact main-page AI strip (Task 3) — rendered on the dashboard between the
// upload card and the board only while AI is enabled for the primary mic. Surfaces
// the interactive controls (hold-to-talk + replay + status) so the user doesn't
// have to open the popover to talk. Configuration stays in the popover.
export function AiMainSection({ audio }: { audio: AudioOutput }) {
  const sourceKey = audio.inputDeviceId;
  const ai = sourceKey ? audio.voiceFx[sourceKey]?.ai : undefined;
  if (!sourceKey || !ai?.enabled) return null;

  const engine: AiEngine = ai.engine ?? "rvc_zero";
  const paid = engine === "elevenlabs" || engine === "respeecher";
  const isRespeak = paid && (ai.mode ?? "sts") === "respeak";
  const recording = audio.pttRecording.has(sourceKey);

  return (
    <section className="card">
      <div className="flex items-center gap-2 mb-3">
        <Wand2 size={16} className="text-fuchsia-300" />
        <h2 className="font-semibold tracking-tight">AI voice</h2>
        {!audio.virtualMicMode && (
          <span className="text-xs text-amber-300/90">(Virtual Mic mode off — enable it in Settings)</span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          className={`btn-primary text-sm ${recording ? "!bg-fuchsia-500/30 !border-fuchsia-400/50" : ""}`}
          onPointerDown={(e) => { e.preventDefault(); audio.startPtt(sourceKey); }}
          onPointerUp={() => audio.stopPtt(sourceKey)}
          onPointerLeave={() => { if (recording) audio.stopPtt(sourceKey); }}
          title="Hold to record, release to convert"
        >
          <Mic size={16} className="mr-1.5" />
          {recording
            ? isRespeak ? "Listening… release to speak" : "Recording… release to convert"
            : isRespeak ? "Hold to re-speak" : "Hold to talk"}
        </button>
        <button
          type="button"
          className="btn-ghost text-sm"
          onClick={() => audio.replayLastConversion()}
          title="Replay the last converted clip"
        >
          <Repeat size={16} className="mr-1.5" /> Replay last
        </button>
        {audio.aiBusy && <span className="text-sm text-fuchsia-300">{isRespeak ? "Synthesizing…" : "Converting…"}</span>}
        {audio.aiError && <span className="text-sm text-red-400">{audio.aiError}</span>}
      </div>
      {isRespeak && recording && (
        <p className="text-sm text-fuchsia-200/90 italic mt-2 min-h-[1.25rem]">{audio.aiTranscript || "…"}</p>
      )}
    </section>
  );
}

// Small monthly AI-quota meter (seconds), re-fetched when `refresh` changes.
function AiUsageMeter({ refresh }: { refresh: number }) {
  const [usage, setUsage] = useState<{ used: number; cap: number } | null>(null);
  useEffect(() => {
    let cancel = false;
    fetch("/api/ai/usage")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancel && d && typeof d.used === "number") setUsage({ used: d.used, cap: d.cap }); })
      .catch(() => {});
    return () => { cancel = true; };
  }, [refresh]);
  if (!usage) return null;
  const pct = usage.cap > 0 ? Math.min(100, (usage.used / usage.cap) * 100) : 0;
  return (
    <div className="text-xs text-muted">
      <div className="flex justify-between">
        <span>AI quota this month</span>
        <span className="tabular-nums">{usage.used} / {usage.cap}s</span>
      </div>
      <div className="mt-1 h-1 w-full rounded-full bg-white/10 overflow-hidden">
        <div className="h-full bg-accent-grad" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
