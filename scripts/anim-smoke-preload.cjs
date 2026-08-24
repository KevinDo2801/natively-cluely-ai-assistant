// TEMPORARY preload for the launcher-anim smoke harness. Deleted after use.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onLauncherAnimOpen: (callback) => {
    const h = (_event, payload) => callback(payload);
    ipcRenderer.on('launcher-anim-open', h);
    return () => ipcRenderer.removeListener('launcher-anim-open', h);
  },
  onLauncherAnimClose: (callback) => {
    const h = (_event, payload) => callback(payload);
    ipcRenderer.on('launcher-anim-close', h);
    return () => ipcRenderer.removeListener('launcher-anim-close', h);
  },
  launcherAnimOpenReady: () => ipcRenderer.send('launcher-anim-open-ready'),
  launcherAnimCloseDone: () => ipcRenderer.send('launcher-anim-close-done'),
});
