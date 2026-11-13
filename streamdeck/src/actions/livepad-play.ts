// The two Livepad playback keys: "Play latest capture" (no settings) and "Play
// Livepad capture" (by position, 1 = newest, or one chosen capture). Livepad
// captures are temporary (deleted when the app closes), so a key whose capture is
// gone is dimmed and alerts on press rather than being an error.

import {
  action,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type PropertyInspectorDidAppearEvent,
  type WillAppearEvent,
} from "@elgato/streamdeck";

import { bridge, type BridgeCapture, type BridgeState } from "../bridge";
import type { KeyLook } from "../keys";
import { SoundboardAction, type DataSourceItem } from "./base";

const ACCENT = "#c026d3";
const MAX_SLOT = 120;

type NoSettings = Record<string, never>;

/** Plays the newest capture; pressing again restarts it. */
@action({ UUID: "com.soouuupppp.soundboard.livepad-play-latest" })
export class LivepadPlayLatest extends SoundboardAction<NoSettings> {
  override async onKeyDown(ev: KeyDownEvent<NoSettings>): Promise<void> {
    await this.report(ev.action, bridge.press("livepadPlayLatest", "down"));
  }
  protected look(_s: NoSettings, state: BridgeState): KeyLook {
    const latest = state.captures[0];
    return {
      glyph: "capturePlay",
      label: latest?.name || "No captures",
      active: !!latest && state.playingCaptures.has(latest.id),
      offline: !latest,
      accent: ACCENT,
    };
  }
}

type Mode = "position" | "specific";
// sdpi-textfield stores the slot as a string; older/hand-edited settings may hold a number.
type Settings = { mode?: Mode; slot?: string | number; captureId?: string; captureName?: string };

// sdpi-components' `default` is display-only (never saved), so a key without a mode
// is resolved here and written back once, as for Switch profile.
function modeOf(s: Settings): Mode {
  if (s.mode === "position" || s.mode === "specific") return s.mode;
  return s.captureId ? "specific" : "position";
}

function slotOf(s: Settings): number | null {
  const raw = s.slot === undefined || s.slot === "" ? 1 : Number(s.slot);
  return Number.isInteger(raw) && raw >= 1 && raw <= MAX_SLOT ? raw : null;
}

const fmtDuration = (sec: number) =>
  sec >= 60 ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}` : `${Math.max(1, Math.round(sec))}s`;

/** Plays the Nth newest capture, or one chosen capture until it's deleted. */
@action({ UUID: "com.soouuupppp.soundboard.livepad-play" })
export class LivepadPlay extends SoundboardAction<Settings> {
  override onWillAppear(ev: WillAppearEvent<Settings>): void {
    const s = ev.payload.settings;
    if (s.mode !== "position" && s.mode !== "specific") {
      const next: Settings = { ...s, mode: modeOf(s) };
      if (next.mode === "position" && (s.slot === undefined || s.slot === "")) next.slot = "1";
      ev.payload.settings = next;
      void ev.action.setSettings(next);
    }
    super.onWillAppear(ev);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    super.onDidReceiveSettings(ev);
    void this.sendMode(modeOf(ev.payload.settings));
  }

  override onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent<Settings>): void {
    super.onPropertyInspectorDidAppear(ev);
    void this.sendMode(modeOf(this.settingsById.get(ev.action.id) ?? {}));
  }

  /** The panel shows the position field or the capture list, by mode. */
  private sendMode(mode: Mode): Promise<void> {
    return this.sendToOpenInspector({ event: "mode", mode });
  }

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const s = ev.payload.settings;
    if (modeOf(s) === "specific") {
      if (!s.captureId) {
        await ev.action.showAlert();
        return;
      }
      await this.report(ev.action, bridge.press("livepadPlay", "down", { captureId: s.captureId }));
      return;
    }
    const slot = slotOf(s);
    if (slot === null) {
      await ev.action.showAlert();
      return;
    }
    await this.report(ev.action, bridge.press("livepadPlay", "down", { slot }));
  }

  private target(s: Settings, state: BridgeState): BridgeCapture | undefined {
    if (modeOf(s) === "specific") return s.captureId ? state.captures.find((c) => c.id === s.captureId) : undefined;
    const slot = slotOf(s);
    return slot === null ? undefined : state.captures[slot - 1];
  }

  protected look(s: Settings, state: BridgeState): KeyLook {
    const c = this.target(s, state);
    const active = !!c && state.playingCaptures.has(c.id);
    if (modeOf(s) === "specific") {
      return {
        glyph: "capturePlay",
        label: c?.name || s.captureName || "Choose a capture",
        active,
        offline: !c,
        accent: ACCENT,
      };
    }
    const slot = slotOf(s);
    return {
      glyph: "capturePlay",
      label: slot === null ? "Set a position" : c ? `#${slot} ${c.name}` : `#${slot}`,
      active,
      offline: !c,
      accent: ACCENT,
    };
  }

  // Keep the cached name current so a gone capture still shows what it was.
  protected override onBridgeChange(state: BridgeState): void {
    if (!state.connected || !state.available) return;
    for (const a of this.actions) {
      const s = this.settingsById.get(a.id);
      if (!s?.captureId) continue;
      const name = state.captures.find((c) => c.id === s.captureId)?.name;
      if (name && name !== s.captureName) {
        const next = { ...s, captureName: name };
        this.settingsById.set(a.id, next);
        void a.setSettings(next);
      }
    }
  }

  protected override listItems(s: Settings, state: BridgeState): { event: string; items: DataSourceItem[] } {
    const items: DataSourceItem[] = [];
    if (!state.connected || !state.available) {
      items.push({ label: "Open Soundboard to load your captures", value: "", disabled: true });
      if (s.captureId) items.push({ label: s.captureName || "Current capture", value: s.captureId });
      return { event: "getCaptures", items };
    }
    if (state.captures.length === 0) items.push({ label: "No Livepad captures yet", value: "", disabled: true });
    for (const c of state.captures) items.push({ label: `${c.name} (${fmtDuration(c.durationSec)})`, value: c.id });
    if (s.captureId && !state.captures.some((c) => c.id === s.captureId)) {
      items.push({ label: `${s.captureName || "Capture"} (gone)`, value: s.captureId });
    }
    return { event: "getCaptures", items };
  }
}
