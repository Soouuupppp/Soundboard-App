import {
  action,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type PropertyInspectorDidAppearEvent,
  type WillAppearEvent,
} from "@elgato/streamdeck";

import { bridge, type BridgeState } from "../bridge";
import type { KeyLook } from "../keys";
import { SoundboardAction, type DataSourceItem } from "./base";

type Mode = "cycle" | "specific";
type Settings = { mode?: Mode; profileId?: string; profileName?: string };

// A key saved before modes existed has no `mode` and keeps targeting its profile.
// The settings panel's "Cycle" default is display-only in sdpi-components (never
// saved), so a key with no mode is resolved here and written back once: a chosen
// profile = an old key → specific; nothing chosen = a new key → cycle.
function modeOf(s: Settings): Mode {
  if (s.mode === "cycle" || s.mode === "specific") return s.mode;
  return s.profileId ? "specific" : "cycle";
}

/** Makes one Soundboard profile active, or cycles to the next; highlighted while active. */
@action({ UUID: "com.soouuupppp.soundboard.profile" })
export class SwitchProfile extends SoundboardAction<Settings> {
  override onWillAppear(ev: WillAppearEvent<Settings>): void {
    const s = ev.payload.settings;
    if (s.mode !== "cycle" && s.mode !== "specific") {
      const next = { ...s, mode: modeOf(s) };
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

  /** The panel shows the profile list only in specific mode. */
  private sendMode(mode: Mode): Promise<void> {
    return this.sendToOpenInspector({ event: "mode", mode });
  }

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const settings = ev.payload.settings;
    if (modeOf(settings) === "cycle") {
      await this.report(ev.action, bridge.press("profileCycle", "down"));
      return;
    }
    const { profileId } = settings;
    if (!profileId) {
      await ev.action.showAlert();
      return;
    }
    await this.report(ev.action, bridge.press("profile", "down", { profileId }));
  }

  protected look(settings: Settings, state: BridgeState): KeyLook {
    if (modeOf(settings) === "cycle") {
      // Shows whichever profile is active now; there always is one, so always lit.
      const active = state.profiles.find((p) => p.id === state.activeProfileId);
      return { glyph: "profile", label: active?.name || "Next profile", active: true, accent: "#3e9b4f" };
    }
    const profile = settings.profileId ? state.profiles.find((p) => p.id === settings.profileId) : undefined;
    return {
      glyph: "profile",
      label: profile?.name || settings.profileName || "Choose a profile",
      active: !!settings.profileId && state.activeProfileId === settings.profileId,
      offline: state.connected && state.available && !!settings.profileId && !profile,
      accent: "#3e9b4f",
    };
  }

  protected override onBridgeChange(state: BridgeState): void {
    if (!state.connected || !state.available) return;
    for (const a of this.actions) {
      const s = this.settingsById.get(a.id);
      if (!s?.profileId) continue;
      const name = state.profiles.find((p) => p.id === s.profileId)?.name;
      if (name && name !== s.profileName) {
        const next = { ...s, profileName: name };
        this.settingsById.set(a.id, next);
        void a.setSettings(next);
      }
    }
  }

  protected override listItems(settings: Settings, state: BridgeState): { event: string; items: DataSourceItem[] } {
    const items: DataSourceItem[] = [];
    if (!state.connected || !state.available) {
      items.push({ label: "Open Soundboard to load your profiles", value: "", disabled: true });
      if (settings.profileId) items.push({ label: settings.profileName || "Current profile", value: settings.profileId });
      return { event: "getProfiles", items };
    }
    for (const p of state.profiles) items.push({ label: p.name, value: p.id });
    if (settings.profileId && !state.profiles.some((p) => p.id === settings.profileId)) {
      items.push({ label: `${settings.profileName || "Deleted profile"} (deleted)`, value: settings.profileId });
    }
    return { event: "getProfiles", items };
  }
}
