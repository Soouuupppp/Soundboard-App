const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("promptApi", {
  submit: (value) => ipcRenderer.invoke("soundboard:submitUrl", value),
  cancel: () => ipcRenderer.invoke("soundboard:cancelUrl"),
});
