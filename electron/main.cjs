// .cjs extension forces CommonJS regardless of the root "type":"module" so
// Electron's built-in require('electron') hook fires correctly.
const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

const draftGuardStateByContentsId = new Map();

// ── sharp stub ────────────────────────────────────────────────────────────────
// @xenova/transformers/src/utils/image.js has a TOP-LEVEL STATIC ESM import:
//   import sharp from 'sharp'
// Node.js loads CJS modules for ESM callers via Module._load, passing the FULL
// resolved path (/…/sharp/lib/index.js), not the bare 'sharp' specifier. We
// must check for both. Returning a no-op Proxy prevents any sharp initialization
// code from running. Text embedding never calls image methods so it's safe.
;(function stubSharp() {
  const Module = require('module');
  const _orig  = Module._load;
  const noop   = function() {};
  const mock   = new Proxy(noop, {
    get:       (_, k) => k === 'then' ? undefined : mock,
    apply:     ()     => mock,
    construct: ()     => ({}),
  });
  Module._load = function(id, parent, isMain) {
    if (id === 'sharp' ||
        (typeof id === 'string' && id.includes('node_modules/sharp/lib/index.js'))) {
      return mock;
    }
    return _orig.call(this, id, parent, isMain);
  };
})();

// ── Project filesystem + Claude Code integration ─────────────────────────
const { registerProjectFS } = require('./project-fs.cjs');
const { registerClaudeCode } = require('./claude-code.cjs');

// Force Display P3 with D65 white-point so colours render the way Safari
// does on macOS (warmer, slightly less saturated). Chromium otherwise picks
// sRGB, which gave the editor a colder, punchier look on this user's monitor.
app.commandLine.appendSwitch('force-color-profile', 'display-p3-d65');

// GPU compositor tuning — tile-based rasterization on the GPU instead of
// software raster, zero-copy texture uploads (avoids an extra memcpy per
// tile on Apple Silicon), and bypass the Chromium GPU blocklist so Metal
// acceleration is always used even on hardware Chromium hasn't certified.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

app.setName('Latent Write');

// ── App menu (macOS-conventional) ─────────────────────────────────────────
// Menu items that act on document state forward to the renderer via IPC.
// Undo/redo forward to the renderer for app-level history.
// Roles like cut/copy/paste are handled natively by Chromium.

const isMac = process.platform === 'darwin';

function sendMenuCommand(cmd) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win) win.webContents.send('menu-command', cmd);
}

function buildMenu() {
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Project…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => sendMenuCommand('open-project'),
        },
        {
          label: 'New Chapter',
          accelerator: 'CmdOrCtrl+Enter',
          click: () => sendMenuCommand('new-chapter'),
        },
        { type: 'separator' },
        {
          label: 'Open Chapter Index',
          accelerator: 'CmdOrCtrl+I',
          click: () => sendMenuCommand('open-index'),
        },
        {
          label: 'Open World Data',
          accelerator: 'CmdOrCtrl+J',
          click: () => sendMenuCommand('open-world'),
        },
        { type: 'separator' },
        {
          label: 'Import .txt…',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendMenuCommand('import-txt'),
        },
        {
          label: 'Export as .txt…',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => sendMenuCommand('export-txt'),
        },
        {
          label: 'Export as PDF…',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => sendMenuCommand('export-pdf'),
        },
        {
          label: 'Export as Markdown…',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => sendMenuCommand('export-markdown'),
        },
        {
          label: 'Export as Word (.docx)…',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => sendMenuCommand('export-docx'),
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendMenuCommand('save'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          click: () => sendMenuCommand('undo'),
        },
        {
          label: 'Redo',
          accelerator: 'CmdOrCtrl+Shift+Z',
          click: () => sendMenuCommand('redo'),
        },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Find…',
          accelerator: 'CmdOrCtrl+F',
          click: () => sendMenuCommand('find'),
        },
        {
          label: 'Find in Project…',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => sendMenuCommand('project-search'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Focus Mode',
          accelerator: 'CmdOrCtrl+.',
          click: () => sendMenuCommand('focus-mode'),
        },
        {
          label: 'Cycle Intelligence',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => sendMenuCommand('cycle-intel'),
        },
        {
          label: 'Toggle Split View',
          accelerator: 'CmdOrCtrl+\\',
          click: () => sendMenuCommand('split-view'),
        },
        { type: 'separator' },
        {
          label: 'Previous Chapter',
          accelerator: 'Alt+Left',
          click: () => sendMenuCommand('prev-chapter'),
        },
        {
          label: 'Next Chapter',
          accelerator: 'Alt+Right',
          click: () => sendMenuCommand('next-chapter'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        {
          label: 'Open Renderer Workspace Window',
          click: () => createWorkspaceWindow(),
        },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [
              { type: 'separator' },
              { role: 'front' },
              { type: 'separator' },
              { role: 'window' },
            ]
          : [{ role: 'close' }]),
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Welcome to Latent Write',
          click: () => sendMenuCommand('show-welcome'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {

  const win = new BrowserWindow({
    title: 'Latent Write',
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    // Modern macOS Tahoe (26) chrome: vibrancy provides the liquid-glass
    // backdrop where the app body is transparent; the new Electron SDK
    // build picks up Tahoe's corner radius automatically.
    vibrancy: 'under-window',
    visualEffectState: 'followWindow',
    roundedCorners: true,
    // Transparent alpha — the previous opaque hex was painted UNDER the
    // renderer and clipped the macOS Tahoe-sized rounded-corner cutout
    // visually short. With #00000000 the only visible chrome is the
    // OS-drawn vibrancy frame, which gets its full system-standard
    // corner radius (Tahoe's larger ~16-18px curve, not Sequoia's).
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  const webContentsId = win.webContents.id;

  win.on('close', (event) => {
    const draftState = draftGuardStateByContentsId.get(webContentsId);
    if (!draftState?.hasUnsavedLocalDraft) return;

    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Choose Folder', 'Close Without Saving', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      message: 'This draft has no project folder yet.',
      detail:
        'Latent Write lets you start writing immediately, but this desktop draft is only temporary until you open or create a project folder. Choose a folder now to save it as novel.txt before quitting.',
    });

    if (choice === 0) {
      event.preventDefault();
      win.focus();
      win.webContents.send('menu-command', 'open-project');
      return;
    }

    if (choice === 2) {
      event.preventDefault();
    }
  });

  win.on('closed', () => {
    draftGuardStateByContentsId.delete(webContentsId);
  });

  win.loadFile(path.join(__dirname, '../dist/index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // DevTools — auto-open in development + F12 / Cmd+Option+I shortcut
  if (!app.isPackaged) {
    win.webContents.on('did-finish-load', () => {
      win.webContents.openDevTools({ mode: 'detach' });
    });
    win.webContents.on('before-input-event', (_e, input) => {
      // F12  or  Cmd+Option+I  or  Ctrl+Shift+I
      const devToolsKey =
        input.key === 'F12' ||
        (input.meta  && input.alt   && input.key === 'i') ||
        (input.control && input.shift && input.key === 'I');
      if (devToolsKey && input.type === 'keyDown') {
        win.webContents.toggleDevTools();
      }
    });
  }
}

// ── Renderer workspace pop-out window ───────────────────────────────────────
// A single secondary window that hosts ONLY the renderer workspace, loaded from
// the same bundle via the #workspace hash route. Claude streams already
// broadcast to every window (see claude-code.cjs sendToRenderer), so the
// workspace window stays in sync with the project + active session. The main
// window listens for `workspace:window-state` to detach its side panel while
// this window is open (single chat owner).
let _workspaceWindow = null;

function broadcastWorkspaceWindowState(open) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('workspace:window-state', { open });
  }
}

function createWorkspaceWindow() {
  if (_workspaceWindow && !_workspaceWindow.isDestroyed()) {
    if (_workspaceWindow.isMinimized()) _workspaceWindow.restore();
    _workspaceWindow.focus();
    return _workspaceWindow;
  }

  const win = new BrowserWindow({
    title: 'Renderer Workspace',
    width: 1320,
    height: 880,
    minWidth: 760,
    minHeight: 540,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'under-window',
    visualEffectState: 'followWindow',
    roundedCorners: true,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  _workspaceWindow = win;
  win.loadFile(path.join(__dirname, '../dist/index.html'), { hash: 'workspace' });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (_e, input) => {
      const devToolsKey =
        input.key === 'F12' ||
        (input.meta && input.alt && input.key === 'i') ||
        (input.control && input.shift && input.key === 'I');
      if (devToolsKey && input.type === 'keyDown') win.webContents.toggleDevTools();
    });
  }

  win.once('ready-to-show', () => broadcastWorkspaceWindowState(true));
  win.on('closed', () => {
    _workspaceWindow = null;
    broadcastWorkspaceWindowState(false);
  });

  return win;
}

function registerWorkspaceWindow() {
  ipcMain.handle('workspace:open', () => {
    createWorkspaceWindow();
    return { ok: true };
  });
  ipcMain.handle('workspace:focus', () => {
    if (_workspaceWindow && !_workspaceWindow.isDestroyed()) {
      if (_workspaceWindow.isMinimized()) _workspaceWindow.restore();
      _workspaceWindow.focus();
      return { ok: true };
    }
    return { ok: false };
  });
  ipcMain.handle('workspace:isOpen', () => !!(_workspaceWindow && !_workspaceWindow.isDestroyed()));
}

// ── Narrative LM — sentence embedding (MiniLM via onnxruntime-node) ──────────
// Runs in the Node.js main process via onnxruntime-node (native binaries).
// This sidesteps all browser WASM / web-worker restrictions in the renderer.
// The model lives in dist/models/ (bundled) or public/models/ (dev).
//
// Preference order: L12 (better quality, 32MB) → L6 (fallback, 22MB).
// Both models use the same 384-dim output so no downstream changes are needed.
const PREFERRED_MODEL_IDS = [
  'Xenova/all-MiniLM-L12-v2',
  'Xenova/all-MiniLM-L6-v2',
];

let _lmPipe    = null;
let _lmLoading = null;
let _lmStatus  = 'idle'; // 'idle' | 'loading' | 'ready' | 'offline'

async function getLMPipeline() {
  if (_lmPipe)    return _lmPipe;
  if (_lmLoading) return _lmLoading;
  _lmStatus  = 'loading';
  _lmLoading = (async () => {
    const modelBase = app.isPackaged
      ? path.join(app.getAppPath(), 'dist',   'models') + path.sep
      : path.join(app.getAppPath(), 'public', 'models') + path.sep;
    const { pipeline, env } = await import('@xenova/transformers');
    env.localModelPath   = modelBase;
    env.allowLocalModels = true;
    env.useBrowserCache  = false;

    for (const modelId of PREFERRED_MODEL_IDS) {
      try {
        console.log('[NarrativeLM main] Trying model:', modelId);
        const pipe = await pipeline('feature-extraction', modelId);
        _lmPipe   = pipe;
        _lmStatus = 'ready';
        console.log('[NarrativeLM main] ✓ Model ready:', modelId);
        return pipe;
      } catch (err) {
        console.log('[NarrativeLM main] Model unavailable, trying next:', err.message);
      }
    }
    throw new Error('No MiniLM model available in models directory');
  })().catch((err) => {
    _lmStatus  = 'offline';
    _lmLoading = null; // allow retry
    console.error('[NarrativeLM main] Failed to load any model:', err.message);
    throw err;
  });
  return _lmLoading;
}

// Warm as soon as ready — first embed is instant instead of blocking
app.whenReady().then(() => getLMPipeline().catch(() => {}));

ipcMain.handle('narrative-lm-embed', async (_event, text) => {
  try {
    const pipe = await getLMPipeline();
    const out  = await pipe(String(text).slice(0, 500), { pooling: 'mean', normalize: true });
    return Array.from(out.data.slice(0, 384));
  } catch { return null; }
});

ipcMain.handle('narrative-lm-status', () => _lmStatus);

// ── Renderer review — Anthropic API proxy ─────────────────────────────────
// Makes the HTTPS call from the main process so the renderer's sandbox never
// needs a direct network connection to api.anthropic.com (avoids CORS issues
// and keeps the API key out of the renderer's memory).
ipcMain.handle('renderer-review', (_event, { apiKey, model, systemPrompt, userMessage }) => {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ ok: false, status: res.statusCode, body: { error: { message: data } } });
        }
      });
    });
    req.on('error', (err) => {
      resolve({ ok: false, status: 0, body: { error: { message: err.message } } });
    });
    req.write(body);
    req.end();
  });
});

// ── PDF export ────────────────────────────────────────────────────────────
// Renderer sends the full novel HTML string; we load it in a hidden window,
// call printToPDF, show a save dialog, and write the buffer to disk.
//
// Notes:
// • preferCSSPageSize: true — without this, @page { size: ... } is ignored.
// • Explicit window dimensions — a hidden BrowserWindow without size has a
//   degenerate viewport, which breaks layout in the print path.
// • Wait for document.fonts.ready before snapshotting so Georgia (or its
//   fallback) is fully metric-loaded; otherwise text can paint blank or
//   collapse to zero width on the first paint.
ipcMain.handle('export-pdf', async (_event, html, suggestedName) => {
  let pdfWin = null;
  let tmpPath = null;
  try {
    tmpPath = path.join(os.tmpdir(), `latentwrite-export-${Date.now()}.html`);
    fs.writeFileSync(tmpPath, html, 'utf8');

    pdfWin = new BrowserWindow({
      show: false,
      width: 800,
      height: 1200,
      backgroundColor: '#ffffff',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        offscreen: false,
      },
    });

    await pdfWin.loadFile(tmpPath);

    // Wait for the document to finish loading (DOMContentLoaded + fonts +
    // one extra rAF so layout settles). Run inside the renderer so we don't
    // race against the print snapshot.
    await pdfWin.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const ready = () => {
          const finish = () => requestAnimationFrame(() => resolve(true));
          if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(finish);
          } else {
            setTimeout(finish, 200);
          }
        };
        if (document.readyState === 'complete') ready();
        else window.addEventListener('load', ready, { once: true });
      })
    `);

    const pdfBuffer = await pdfWin.webContents.printToPDF({
      printBackground: true,
      landscape: false,
      pageSize: 'Letter',                           // 8.5 × 11 in
      margins: { marginType: 'none' },              // CSS @page owns margins
      displayHeaderFooter: false,                   // CSS @page boxes do this
      preferCSSPageSize: true,                      // honour @page { size }
      scale: 1,
    });

    const { filePath, canceled } = await dialog.showSaveDialog({
      title: 'Export Novel as PDF',
      defaultPath: path.join(os.homedir(), 'Documents', suggestedName || 'novel.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      buttonLabel: 'Export',
    });

    if (!canceled && filePath) {
      fs.writeFileSync(filePath, pdfBuffer);
      return { ok: true, path: filePath };
    }
    return { ok: false, canceled: true };
  } catch (err) {
    console.error('PDF export failed:', err);
    return { ok: false, error: String(err) };
  } finally {
    if (pdfWin && !pdfWin.isDestroyed()) pdfWin.close();
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }
});

ipcMain.on('draft-guard:update', (event, state) => {
  draftGuardStateByContentsId.set(event.sender.id, {
    hasUnsavedLocalDraft: !!state?.hasUnsavedLocalDraft,
  });
});

app.whenReady().then(() => {
  registerProjectFS();
  registerClaudeCode();
  registerWorkspaceWindow();
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
