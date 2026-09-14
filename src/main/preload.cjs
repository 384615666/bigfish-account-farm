"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("cc", {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
