import { action, type KeyDownEvent } from "@elgato/streamdeck";

import { bridge, type BridgeState } from "../bridge";
import type { KeyLook } from "../keys";
import { SoundboardAction, type DataSourceItem } from "./base";

type Settings = { soundId?: string; soundName?: string };

/** Plays one sound from the user's Saved library (by sound id, whatever the profile). */
@action({ UUID: "com.soouuupppp.soundboard.play" })
export class PlaySound extends SoundboardAction<Settings> {
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const { soundId } = ev.payload.settings;
    if (!soundId) {
      await ev.action.showAlert();
      return;
    }
    await this.report(ev.action, bridge.press("play", "down", { soundId }));
  }

  protected look(settings: Settings, state: BridgeState): KeyLook {
    const sound = settings.soundId ? state.sounds.find((s) => s.soundId === settings.soundId) : undefined;
    return {
      glyph: "play",
      label: sound?.name || settings.soundName || "Choose a sound",
      active: !!settings.soundId && state.playing.has(settings.soundId),
      // Connected but the sound is no longer in Saved: look disabled too.
      offline: state.connected && state.available && !!settings.soundId && !sound,
      accent: "#5865F2",
    };
  }

  // Keep the cached name current (renames), so the key still reads right offline.
  protected override onBridgeChange(state: BridgeState): void {
    if (!state.connected || !state.available) return;
    for (const a of this.actions) {
      const s = this.settingsById.get(a.id);
      if (!s?.soundId) continue;
      const name = state.sounds.find((x) => x.soundId === s.soundId)?.name;
      if (name && name !== s.soundName) {
        const next = { ...s, soundName: name };
        this.settingsById.set(a.id, next);
        void a.setSettings(next);
      }
    }
  }

  protected override listItems(settings: Settings, state: BridgeState): { event: string; items: DataSourceItem[] } {
    const items: DataSourceItem[] = [];
    if (!state.connected || !state.available) {
      items.push({ label: "Open Soundboard to load your sounds", value: "", disabled: true });
      // Keep the current choice selectable so the saved value isn't lost.
      if (settings.soundId) items.push({ label: settings.soundName || "Current sound", value: settings.soundId });
      return { event: "getSounds", items };
    }
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    const toItem = (s: { soundId: string; name: string }) => ({ label: s.name, value: s.soundId });
    const board = state.sounds.filter((s) => s.onBoard).map(toItem);
    const saved = state.sounds.filter((s) => !s.onBoard).sort(byName).map(toItem);
    if (board.length) items.push({ label: "On board", children: board });
    if (saved.length) items.push({ label: "Saved", children: saved });
    if (settings.soundId && !state.sounds.some((s) => s.soundId === settings.soundId)) {
      items.push({
        label: "No longer in your Saved library",
        children: [{ label: settings.soundName || "Removed sound", value: settings.soundId }],
      });
    }
    if (!items.length) items.push({ label: "Your Saved library is empty", value: "", disabled: true });
    return { event: "getSounds", items };
  }
}
