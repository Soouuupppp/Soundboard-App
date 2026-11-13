import streamDeck, {
  SingletonAction,
  type Action,
  type DidReceiveSettingsEvent,
  type PropertyInspectorDidAppearEvent,
  type SendToPluginEvent,
  type TitleParametersDidChangeEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { bridge, type BridgeState, type PressResult } from "../bridge";
import { renderKey, type KeyLook } from "../keys";

// The SDK's settings constraint, without depending on @elgato/utils directly.
export type JsonObject = SingletonAction extends SingletonAction<infer T> ? T : never;

/** A live list for a property-inspector <sdpi-select datasource=…>. */
export type DataSourceItem = { label: string; value: string; disabled?: boolean } | { label: string; children: DataSourceItem[] };

export const HELP_URL = "https://github.com/Soouuupppp/Soundboard-App/releases/latest";

/**
 * Shared behaviour for every Soundboard key: one image per visible key, redrawn when
 * the bridge state or the key's settings/title change, and an alert on a failed press.
 * Settings are cached per key so a state change doesn't need a round trip per key.
 */
export abstract class SoundboardAction<T extends JsonObject> extends SingletonAction<T> {
  protected readonly settingsById = new Map<string, T>();
  private readonly userTitleById = new Map<string, string>();
  private readonly lastImageById = new Map<string, string>();
  private lastListSignature = "";

  constructor() {
    super();
    bridge.onChange((state) => {
      for (const a of this.actions) this.draw(a, state);
      this.onBridgeChange(state);
      void this.refreshInspector(state);
    });
  }

  /** How this key should look; `label` is dropped when the user typed a title. */
  protected abstract look(settings: T, state: BridgeState): KeyLook;

  /** Data source this action's settings panel asks for (if any). */
  protected listItems?(settings: T, state: BridgeState): { event: string; items: DataSourceItem[] };

  /** Optional hook, e.g. to refresh cached names in settings. */
  protected onBridgeChange(_state: BridgeState): void {}

  protected draw(action: Action<T>, state: BridgeState = bridge.state): void {
    if (!action.isKey()) return;
    const settings = this.settingsById.get(action.id) ?? ({} as T);
    const look = this.look(settings, state);
    if (this.userTitleById.get(action.id)) delete look.label;
    look.offline = look.offline || !state.connected || !state.available;
    const image = renderKey(look);
    if (this.lastImageById.get(action.id) === image) return;
    this.lastImageById.set(action.id, image);
    void action.setImage(image);
  }

  /** Alert on the key when a press didn't do anything. */
  protected async report(action: Action<T>, result: Promise<PressResult>): Promise<void> {
    const r = await result;
    if (!r.ok && action.isKey()) await action.showAlert();
  }

  override onWillAppear(ev: WillAppearEvent<T>): void {
    this.settingsById.set(ev.action.id, ev.payload.settings);
    this.lastImageById.delete(ev.action.id);
    this.draw(ev.action);
  }

  override onWillDisappear(ev: WillDisappearEvent<T>): void {
    this.settingsById.delete(ev.action.id);
    this.userTitleById.delete(ev.action.id);
    this.lastImageById.delete(ev.action.id);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<T>): void {
    this.settingsById.set(ev.action.id, ev.payload.settings);
    this.draw(ev.action);
  }

  override onTitleParametersDidChange(ev: TitleParametersDidChangeEvent<T>): void {
    // The name is drawn into the image, so a title the user typed must win over it.
    this.userTitleById.set(ev.action.id, ev.payload.title ?? "");
    this.draw(ev.action);
  }

  override onPropertyInspectorDidAppear(_ev: PropertyInspectorDidAppearEvent<T>): void {
    this.lastListSignature = "";
    void this.sendStatus();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the payload is checked below
  override async onSendToPlugin(ev: SendToPluginEvent<any, T>): Promise<void> {
    const payload = ev.payload as { event?: unknown } | null;
    const event = payload && typeof payload === "object" ? payload.event : undefined;
    if (event === "getStatus") {
      await this.sendStatus();
      return;
    }
    if (event === "openHelp") {
      await streamDeck.system.openUrl(HELP_URL);
      return;
    }
    if (this.listItems && typeof event === "string") {
      const settings = this.settingsById.get(ev.action.id) ?? ({} as T);
      const list = this.listItems(settings, bridge.state);
      if (list.event === event) {
        this.lastListSignature = JSON.stringify(list.items);
        await streamDeck.ui.sendToPropertyInspector({ event: list.event, items: list.items });
      }
    }
  }

  /** Message this action's open settings panel (no-op when another one is showing). */
  protected async sendToOpenInspector(payload: JsonObject): Promise<void> {
    if (!this.visibleInspectorIsMine()) return;
    await streamDeck.ui.sendToPropertyInspector(payload);
  }

  protected visibleInspectorIsMine(): Action<JsonObject> | undefined {
    const a = streamDeck.ui.action;
    return a && a.manifestId === this.manifestId ? a : undefined;
  }

  private async sendStatus(): Promise<void> {
    if (!this.visibleInspectorIsMine()) return;
    const s = bridge.state;
    await streamDeck.ui.sendToPropertyInspector({ event: "status", connected: s.connected, available: s.available });
  }

  /** Push fresh status + list to an open settings panel (hot-reload). */
  protected async refreshInspector(state: BridgeState): Promise<void> {
    const open = this.visibleInspectorIsMine();
    if (!open) return;
    await this.sendStatus();
    if (!this.listItems) return;
    const list = this.listItems((this.settingsById.get(open.id) ?? {}) as T, state);
    const sig = JSON.stringify(list.items);
    // Only when the list really changed, so a sound starting/stopping doesn't
    // re-render the dropdown under the user's cursor.
    if (sig === this.lastListSignature) return;
    this.lastListSignature = sig;
    await streamDeck.ui.sendToPropertyInspector({ event: list.event, items: list.items });
  }
}
