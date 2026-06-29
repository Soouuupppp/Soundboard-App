const { contextBridge, ipcRenderer } = require("electron");

// Bridge between the web app and the Electron main process.
// The web Dashboard component calls window.soundboard.registerKeybinds(combos)
// and listens for the "soundboard:globalKey" custom event.

contextBridge.exposeInMainWorld("soundboard", {
  registerKeybinds: (combos) => ipcRenderer.invoke("soundboard:registerKeybinds", combos),
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
