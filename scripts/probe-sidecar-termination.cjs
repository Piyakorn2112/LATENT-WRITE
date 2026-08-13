/**
 * probe-sidecar-termination.cjs — WHY did generated-gbnf sidecar calls burn
 * the whole n_predict budget? One request, three constraint styles, raw
 * text tails printed. Diagnostic for the interactive-sidecar migration.
 *
 * Run: ./node_modules/.bin/electron scripts/probe-sidecar-termination.cjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

app.setName('Latent Write');
const ROOT = path.join(__dirname, '..');
const NODE = '/opt/homebrew/bin/node';
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

let win = null;
const callBridge = (method, arg) => {
  const payload = JSON.stringify(arg === undefined ? null : arg);
  return win.webContents.executeJavaScript(
    `window.electronAPI.${method}(${payload === 'null' ? '' : payload})`, true,
  );
};

async function main() {
  assistant.registerAssistant();
  win = new BrowserWindow({
    show: false, width: 480, height: 320,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
    },
  });
  await win.loadURL('about:blank');

  const prep = JSON.parse(execFileSync(NODE, [
    TSX, path.join('scripts', 'bench-dossier-prep.ts'), 'root-crown:Mira',
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim().split('\n').pop());
  const req = prep[0].deepFields.background.ask;

  const gbnfMod = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'node-llama-cpp',
    'dist', 'utils', 'gbnfJson', 'getGbnfGrammarForGbnfJsonSchema.js')).href);
  const gbnf = gbnfMod.getGbnfGrammarForGbnfJsonSchema(req.schema, { allowNewLines: false });
  console.log('── generated gbnf (tail):');
  console.log(gbnf.slice(-400));

  const variants = [
    { label: 'json_schema (no gbnf)', extra: {} },
    { label: 'generated gbnf', extra: { gbnf } },
  ];
  for (const v of variants) {
    const t0 = Date.now();
    const res = await callBridge('assistantRun', {
      requestId: `pst-${v.label}`.replace(/[^a-z0-9-]/gi, '-'),
      task: 'character-dossier', tier: 'max', noThink: false,
      lane: 'batch',
      systemPrompt: req.systemPrompt, userText: req.userText,
      schema: req.schema, maxTokens: 512, timeoutMs: 120000, contextSize: 4096,
      ...v.extra,
    });
    const ms = Date.now() - t0;
    console.log(`\n── ${v.label}: ${ms}ms ok=${res && res.ok} stop=${res && res.stopReason} tokens=${res && res.timings && res.timings.tokens}`);
    if (res && typeof res.raw === 'string') {
      console.log(`   raw head: ${JSON.stringify(res.raw.slice(0, 120))}`);
      console.log(`   raw tail: ${JSON.stringify(res.raw.slice(-160))}`);
      console.log(`   raw length: ${res.raw.length}`);
    }
  }
  app.exit(0);
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
