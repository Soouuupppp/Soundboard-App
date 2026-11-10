const { contextBridge, ipcRenderer } = require("electron");

// Bridge between the web app and the Electron main process.
// The web Dashboard component calls window.soundboard.registerKeybinds(combos)
// and listens for the "soundboard:globalKey" custom event.

contextBridge.exposeInMainWorld("soundboard", {
  registerKeybinds: (combos) => ipcRenderer.invoke("soundboard:registerKeybinds", combos),
  // Livepad: async cleanup to run before the window closes. Returns an unsubscribe.
  onAppClosing: (fn) => {
    appClosingHandler = fn;
    return () => {
      if (appClosingHandler === fn) appClosingHandler = null;
    };
  },
  // Livepad per-app and playback-device capture. main.js rejects these calls unless
  // they come from the configured server, since this preload also runs on Discord's
  // login pages.
  nativeCapture: {
    open: () => ipcRenderer.invoke("soundboard:nativeCapture:open"),
    close: () => ipcRenderer.invoke("soundboard:nativeCapture:close"),
    arm: (key) => ipcRenderer.invoke("soundboard:nativeCapture:arm", key),
    disarm: () => ipcRenderer.invoke("soundboard:nativeCapture:disarm"),
    onEvent: (fn) => {
      nativeEventHandler = fn;
      return () => {
        if (nativeEventHandler === fn) nativeEventHandler = null;
      };
    },
    onPcm: (fn) => {
      nativePcmHandler = fn;
      return () => {
        if (nativePcmHandler === fn) nativePcmHandler = null;
      };
    },
  },
});

// Delivered through callbacks, not window events, so captured audio is only visible
// to the code that asked for it.
let nativeEventHandler = null;
let nativePcmHandler = null;
ipcRenderer.on("soundboard:nativeCapture:event", (_evt, detail) => {
  if (nativeEventHandler) nativeEventHandler(detail);
});
ipcRenderer.on("soundboard:nativeCapture:pcm", (_evt, pcm) => {
  if (nativePcmHandler) nativePcmHandler(pcm);
});

// Discord's login page starts a WebAuthn "conditional" (autofill) request on load.
// Electron has no autofill UI for it, so Windows opens its full security-key dialog
// unprompted. Only that background request is refused: the "Sign in with a passkey"
// button and security-key 2FA make ordinary requests, which still go through.
if (location.hostname === "discord.com" || location.hostname === "discordapp.com") {
  contextBridge.executeInMainWorld({
    func: () => {
      const credentials = navigator.credentials;
      const originalGet = credentials.get.bind(credentials);
      credentials.get = (options) =>
        options && options.mediation === "conditional"
          ? Promise.reject(new DOMException("Conditional mediation is unavailable.", "NotAllowedError"))
          : originalGet(options);
      if (window.PublicKeyCredential) {
        window.PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
      }
    },
  });
}

// main.js holds the window closed until this reports back (or times out). Replying
// from here means a page with nothing to clean up doesn't delay the close.
let appClosingHandler = null;
ipcRenderer.on("soundboard:appClosing", async () => {
  try {
    if (appClosingHandler) await appClosingHandler();
  } finally {
    ipcRenderer.send("soundboard:closingDone");
  }
});

ipcRenderer.on("soundboard:globalKey", (_evt, detail) => {
  window.dispatchEvent(new CustomEvent("soundboard:globalKey", { detail }));
});

// Up edge of a global combo (release) — used for hold-to-X like AI push-to-talk.
ipcRenderer.on("soundboard:globalKeyUp", (_evt, detail) => {
  window.dispatchEvent(new CustomEvent("soundboard:globalKeyUp", { detail }));
});

// VR controller (Valve Index) events from the native bridge:
//   soundboard:vrInput  -> { token }   a button was pressed
//   soundboard:vrStatus -> { steamvr } SteamVR connection state changed
ipcRenderer.on("soundboard:vrInput", (_evt, detail) => {
  window.dispatchEvent(new CustomEvent("soundboard:vrInput", { detail }));
});
ipcRenderer.on("soundboard:vrStatus", (_evt, detail) => {
  window.dispatchEvent(new CustomEvent("soundboard:vrStatus", { detail }));
});
