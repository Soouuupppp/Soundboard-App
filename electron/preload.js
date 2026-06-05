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
