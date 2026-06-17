"use client";

// Settings popover body (1.4.0) — the audio config that used to live in the
// inline Control Panel's "Output & volume" + "Virtual Mic" tabs. Everything is
// LIVE: each control writes straight to the global engine (no save button).
//
//   Devices: Output · Monitor · Input (single primary mic)
//   Volume hierarchy (0–200%): Global → Soundboard + Mic
//   Toggles: Virtual Mic mode · Monitor mic
//
// >100% volumes can distort normal output/monitor (the cable limiter still
// protects the virtual mic) — flagged inline.

import { useEffect, useRef, useState } from "react";
import { Volume2, Headphones, Mic, KeyRound } from "lucide-react";
import type { AudioOutput } from "@/lib/audio-output";
import { readAiKeys, writeAiKeys, PROVIDER_LABEL, type AiKeys, type PaidProvider } from "@/lib/voice-ai-paid";
import { Select } from "@/components/Select";
import { Toggle } from "@/components/Toggle";
import { PeakMeter } from "@/components/LevelMeter";

// A 0–200% volume slider row (the three sub-bus gains). Bus gains run 0..2.
function VolumeRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm shrink-0 w-24">{label}</span>
      <input
        type="range"
        min={0}
        max={2}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-accent"
        aria-label={label}
      />
      <span className="text-xs text-muted w-10 text-right tabular-nums">
        {Math.round(value * 100)}%
      </span>
    </div>
  );
}

export function SettingsPanel({ audio }: { audio: AudioOutput }) {
  const labelsHidden = audio.devices.some((d) => !d.label) || audio.inputDevices.some((d) => !d.label);
  const deviceOptions = [
    { value: "default", label: "System default" },
    ...audio.devices.map((d) => ({ value: d.deviceId, label: d.label || `Output ${d.deviceId.slice(0, 6)}` })),
  ];
  const inputOptions = [
    { value: "", label: "None" },
    ...audio.inputDevices.map((d) => ({ value: d.deviceId, label: d.label || `Mic ${d.deviceId.slice(0, 6)}` })),
  ];

  return (
    <div className="space-y-3 text-sm">
      <h3 className="font-medium">Settings</h3>

      {!audio.supportsSinkId ? (
        <p className="text-xs text-muted">
          This browser can&apos;t route audio to a specific device (needs Chromium 110+). Use your OS
          audio settings; only master volume is available here.
        </p>
      ) : (
        <>
          {/* Devices */}
          <label className="block">
            <span className="flex items-center gap-1.5 text-xs text-muted mb-1"><Volume2 size={12} /> Output device</span>
            <Select className="w-full" aria-label="Output device" value={audio.deviceId} onChange={audio.setDeviceId} options={deviceOptions} />
          </label>
          <label className="block">
            <span className="flex items-center gap-1.5 text-xs text-muted mb-1"><Headphones size={12} /> Monitor device</span>
            <Select className="w-full" aria-label="Monitor device" value={audio.monitorDeviceId} onChange={audio.setMonitorDeviceId} options={deviceOptions} />
          </label>
          <label className="block">
            <span className="flex items-center gap-1.5 text-xs text-muted mb-1"><Mic size={12} /> Input device (mic)</span>
            <Select className="w-full" aria-label="Input device" value={audio.inputDeviceId} onChange={audio.setInputDeviceId} options={inputOptions} />
          </label>

          {labelsHidden && (
            <button type="button" className="btn-ghost text-xs" onClick={() => audio.requestLabelsPermission()}>
              Show device names (grants mic permission once)
            </button>
          )}
        </>
      )}

      {/* Volume hierarchy */}
      <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.02] p-3">
        <VolumeRow label="Global output" value={audio.globalVolume} onChange={audio.setGlobalVolume} />
        <VolumeRow label="Soundboard" value={audio.soundboardVolume} onChange={audio.setSoundboardVolume} />
        <VolumeRow label="Mic" value={audio.micOutputVolume} onChange={audio.setMicOutputVolume} />
        <p className="text-[11px] text-muted">
          Above 100% can distort normal output/monitor; the cable limiter still protects the virtual mic.
        </p>
      </div>

      {audio.supportsSinkId && (
        <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <span className="block">Virtual Mic mode</span>
              <span className="text-xs text-muted">Mix mic + soundboard into a cable as your in-game mic.</span>
            </div>
            <Toggle checked={audio.virtualMicMode} onChange={audio.setVirtualMicMode} label="Toggle Virtual Mic mode" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <span className="block">Monitor mic</span>
              <span className="text-xs text-muted">Hear your own mic locally on the monitor device.</span>
            </div>
            <Toggle checked={audio.monitorMic} onChange={audio.setMonitorMic} label="Toggle monitor mic" />
          </div>
          {audio.mixerError && <p className="text-xs text-red-400">Mixer error: {audio.mixerError}</p>}
          {!audio.secureContext && (
            <p className="text-xs text-red-400">Mic capture needs a secure context (HTTPS or localhost).</p>
          )}
        </div>
      )}

      {/* AI provider API keys (device-local secret). Optional — paste your own key
          to bypass the free quota. Used by the paid AI engines in the AI popover. */}
      <AiKeysSection />

      {/* Live output meter. */}
      {audio.supportsOutputMeter && (
        <PeakMeter getPeak={audio.getOutputPeak} active={audio.anyPlaying || audio.virtualMicMode} />
      )}
    </div>
  );
}

// BYO provider API keys. Stored device-local (soundboard:aiKeys via voice-ai-paid),
// never uploaded except as the per-request x-ai-key header. State updates
// immediately; the localStorage write is debounced (~300ms) with the latest value
// flushed on unmount so an interrupted edit isn't lost.
function AiKeysSection() {
  const [keys, setKeys] = useState<AiKeys>(() => readAiKeys());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<AiKeys | null>(null);

  const setKey = (provider: PaidProvider, val: string) => {
    const next = { ...keys, [provider]: val };
    setKeys(next);
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { writeAiKeys(next); pending.current = null; }, 300);
  };
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
      if (pending.current) writeAiKeys(pending.current);
    }
  }, []);

  const providers: PaidProvider[] = ["elevenlabs", "respeecher"];

  return (
    <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.02] p-3">
      <span className="flex items-center gap-1.5 text-sm"><KeyRound size={13} className="text-accent" /> AI provider keys</span>
      {providers.map((p) => (
        <label key={p} className="block">
          <span className="text-xs text-muted mb-1 block">{PROVIDER_LABEL[p]} API key</span>
          <input
            className="input !py-1.5 text-xs w-full"
            type="password"
            autoComplete="off"
            placeholder="Optional — paste to bypass the free quota"
            value={keys[p] ?? ""}
            onChange={(e) => setKey(p, e.target.value)}
          />
        </label>
      ))}
      <p className="text-[11px] text-muted">Stored only on this device, never uploaded except to call the provider.</p>
    </div>
  );
}
