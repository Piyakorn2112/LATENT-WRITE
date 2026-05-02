// .cjs extension forces CommonJS regardless of the root "type":"module" so
// Electron's built-in require('electron') hook fires correctly.
const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Force Display P3 with D65 white-point so colours render the way Safari
// does on macOS (warmer, slightly less saturated). Chromium otherwise picks
// sRGB, which gave the editor a colder, punchier look on this user's monitor.
app.commandLine.appendSwitch('force-color-profile', 'display-p3-d65');

app.setName('Latent Write');

// ── App menu (macOS-conventional) ─────────────────────────────────────────
// Menu items that act on document state forward to the renderer via IPC.
// Roles like undo/redo/cut/copy/paste are handled natively by Chromium.

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
        { role: 'undo' },
        { role: 'redo' },
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

  win.loadFile(path.join(__dirname, '../dist/index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

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

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
