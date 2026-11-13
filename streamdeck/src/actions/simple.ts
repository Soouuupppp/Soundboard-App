// The actions without options: Cancel all, AI push-to-talk (hold), AI replay,
// AI voice on/off and Livepad capture.

import { action, type KeyDownEvent, type KeyUpEvent } from "@elgato/streamdeck";

import { bridge, type BridgeState } from "../bridge";
import type { KeyLook } from "../keys";
import { SoundboardAction } from "./base";

type NoSettings = Record<string, never>;

@action({ UUID: "com.soouuupppp.soundboard.cancel-all" })
export class CancelAll extends SoundboardAction<NoSettings> {
  override async onKeyDown(ev: KeyDownEvent<NoSettings>): Promise<void> {
    await this.report(ev.action, bridge.press("cancelAll", "down"));
  }
  protected look(_s: NoSettings, state: BridgeState): KeyLook {
    return { glyph: "stop", label: "Cancel all", active: state.playing.size > 0, accent: "#c2410c" };
  }
}

/** Hold to record, release to convert (the app's AI push-to-talk). */
@action({ UUID: "com.soouuupppp.soundboard.ai-ptt" })
export class AiPushToTalk extends SoundboardAction<NoSettings> {
  override async onKeyDown(ev: KeyDownEvent<NoSettings>): Promise<void> {
    await this.report(ev.action, bridge.press("aiPtt", "down"));
  }
  override async onKeyUp(ev: KeyUpEvent<NoSettings>): Promise<void> {
    // No alert on release: a failed down already alerted, and the app stops a hold
    // on its own if the connection or dashboard goes away.
    await bridge.press("aiPtt", "up");
  }
  protected look(_s: NoSettings, state: BridgeState): KeyLook {
    return { glyph: "mic", label: "AI talk", active: state.aiPtt, accent: "#e5484d" };
  }
}

@action({ UUID: "com.soouuupppp.soundboard.ai-replay" })
export class AiReplay extends SoundboardAction<NoSettings> {
  override async onKeyDown(ev: KeyDownEvent<NoSettings>): Promise<void> {
    await this.report(ev.action, bridge.press("aiReplay", "down"));
  }
  protected look(): KeyLook {
    return { glyph: "replay", label: "AI replay" };
  }
}

/** Turns AI voice on/off for the selected mic; lit while it's on. */
@action({ UUID: "com.soouuupppp.soundboard.ai-toggle" })
export class AiToggle extends SoundboardAction<NoSettings> {
  override async onKeyDown(ev: KeyDownEvent<NoSettings>): Promise<void> {
    await this.report(ev.action, bridge.press("aiToggle", "down"));
  }
  protected look(_s: NoSettings, state: BridgeState): KeyLook {
    return { glyph: "sparkle", label: state.aiEnabled ? "AI voice on" : "AI voice off", active: state.aiEnabled, accent: "#7c3aed" };
  }
}

@action({ UUID: "com.soouuupppp.soundboard.livepad-capture" })
export class LivepadCapture extends SoundboardAction<NoSettings> {
  override async onKeyDown(ev: KeyDownEvent<NoSettings>): Promise<void> {
    await this.report(ev.action, bridge.press("livepad", "down"));
  }
  protected look(): KeyLook {
    return { glyph: "capture", label: "Livepad" };
  }
}
