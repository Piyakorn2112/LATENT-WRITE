// Exposes a minimal Electron API surface to the renderer via contextBridge.
// sandbox:true is retained; only electron IPC modules are used (no Node built-ins).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  exportPdf: (html, filename) => ipcRenderer.invoke('export-pdf', html, filename),
  isElectron: true,
  onMenuCommand: (cb) => {
    const listener = (_e, cmd) => cb(cmd);
    ipcRenderer.on('menu-command', listener);
    return () => ipcRenderer.removeListener('menu-command', listener);
  },
  rendererReview:     (params) => ipcRenderer.invoke('renderer-review', params),
  narrativeLMEmbed:   (text)   => ipcRenderer.invoke('narrative-lm-embed', text),
  narrativeLMStatus:  ()       => ipcRenderer.invoke('narrative-lm-status'),
});
