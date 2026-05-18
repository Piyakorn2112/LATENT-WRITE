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
  setDraftGuardState: (state) => ipcRenderer.send('draft-guard:update', state),
  rendererReview:     (params) => ipcRenderer.invoke('renderer-review', params),
  narrativeLMEmbed:   (text)   => ipcRenderer.invoke('narrative-lm-embed', text),
  narrativeLMStatus:  ()       => ipcRenderer.invoke('narrative-lm-status'),

  // ── Project filesystem ──
  projectOpen:        ()                   => ipcRenderer.invoke('project:open'),
  projectCreate:      (opts)               => ipcRenderer.invoke('project:create', opts),
  projectCurrent:     ()                   => ipcRenderer.invoke('project:current'),
  projectReadFile:    (relPath)            => ipcRenderer.invoke('project:readFile', relPath),
  projectWriteFile:   (relPath, content)   => ipcRenderer.invoke('project:writeFile', relPath, content),
  projectListDrafts:  ()                   => ipcRenderer.invoke('project:listDrafts'),
  projectListAnchors: ()                   => ipcRenderer.invoke('project:listAnchors'),
  projectListCanon:   ()                   => ipcRenderer.invoke('project:listCanon'),
  projectListTree:    ()                   => ipcRenderer.invoke('project:listTree'),
  projectGetPath:     ()                   => ipcRenderer.invoke('project:getPath'),
  projectHasSystem:   ()                   => ipcRenderer.invoke('project:hasSystem'),
  projectInstallSystem: (src)              => ipcRenderer.invoke('project:installSystem', src),
  projectSaveState:   (key, data)          => ipcRenderer.invoke('project:saveState', key, data),
  projectLoadState:   (key)                => ipcRenderer.invoke('project:loadState', key),
  projectReopenLast:  ()                   => ipcRenderer.invoke('project:reopenLast'),

  // ── Claude Code ──
  claudeStatus:   ()       => ipcRenderer.invoke('claude:status'),
  claudeRun:      (opts)   => ipcRenderer.invoke('claude:run', opts),
  claudeStream:   (opts)   => ipcRenderer.invoke('claude:stream', opts),
  claudeCancel:   ()       => ipcRenderer.invoke('claude:cancel'),
  claudePipeline: (opts)   => ipcRenderer.invoke('claude:pipeline', opts),

  // Claude streaming events (renderer listens)
  onClaudeStreamStart: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('claude:stream-start', listener);
    return () => ipcRenderer.removeListener('claude:stream-start', listener);
  },
  onClaudeStreamData: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('claude:stream-data', listener);
    return () => ipcRenderer.removeListener('claude:stream-data', listener);
  },
  onClaudeStreamEnd: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('claude:stream-end', listener);
    return () => ipcRenderer.removeListener('claude:stream-end', listener);
  },
  onClaudeStreamError: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('claude:stream-error', listener);
    return () => ipcRenderer.removeListener('claude:stream-error', listener);
  },
  onClaudeStreamStderr: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('claude:stream-stderr', listener);
    return () => ipcRenderer.removeListener('claude:stream-stderr', listener);
  },
  onClaudeFileChanged: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('claude:file-changed', listener);
    return () => ipcRenderer.removeListener('claude:file-changed', listener);
  },
});
