import streamDeck from "@elgato/streamdeck";

import { PlaySound } from "./actions/play-sound";
import { AiPushToTalk, AiReplay, CancelAll, LivepadCapture } from "./actions/simple";
import { SwitchProfile } from "./actions/switch-profile";
import { bridge } from "./bridge";

// "info", not "trace": trace would log every message, including sound and profile names.
streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new PlaySound());
streamDeck.actions.registerAction(new CancelAll());
streamDeck.actions.registerAction(new AiPushToTalk());
streamDeck.actions.registerAction(new AiReplay());
streamDeck.actions.registerAction(new LivepadCapture());
streamDeck.actions.registerAction(new SwitchProfile());

bridge.start();
streamDeck.connect();
