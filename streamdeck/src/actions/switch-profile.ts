import { action, type KeyDownEvent } from "@elgato/streamdeck";

import { bridge, type BridgeState } from "../bridge";
import type { KeyLook } from "../keys";
import { SoundboardAction, type DataSourceItem } from "./base";

type Settings = { profileId?: string; profileName?: string };

/** Makes one Soundboard profile active; highlighted while it is. */
@action({ UUID: "com.soouuupppp.soundboard.profile" })
export class SwitchProfile extends SoundboardAction<Settings> {
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const { profileId } = ev.payload.settings;
    if (!profileId) {
      await ev.action.showAlert();
      return;
    }
    await this.report(ev.action, bridge.press("profile", "down", { profileId }));
  }

  protected look(settings: Settings, state: BridgeState): KeyLook {
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
