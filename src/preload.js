const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('muninn', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, data) => ipcRenderer.send(channel, data),
  on: (channel, cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
});
