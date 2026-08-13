/**
 * probe-interactive-sidecar.cjs — can the INTERACTIVE constrained surfaces
 * ride the batch engine, and what does each lever actually buy?
 *
 * The sidecar (llama-server, pinned b10298) was measured faster per call
 * than the in-process binding and 1.75x under 4-way concurrency, but v1
 * scoped it to background batch work. The dossier redesign removed the last
 * freeText call from the card flow, so the whole card is now constrained
 * JSON — sidecar-shaped. This measures, with the REAL dossier request bytes
 * on the real 4B:
 *
 *   host-pretty    the shipped path (in-process, default pretty grammar)
 *   host-compact   + jsonStyle:'compact' (measured on chips: content
 *                  unchanged, ~1/3 of the whitespace tokens gone)
 *   sidecar        lane:'batch' with a precompiled compact grammar
 *   sidecar-par    one card's independent field calls fired CONCURRENTLY
 *
 * Quality is graded, not eyeballed: every answer goes through the shipped
 * normalizeFieldAnswer and the statuses/texts are compared across paths.
 *
 * Run: ./node_modules/.bin/electron scripts/probe-interactive-sidecar.cjs
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

const CHARS = ['anne:Marilla', 'sherlock:Holmes', 'root-crown:Mira'];
const FIELDS = ['appearance', 'personality', 'background'];

let win = null;
const callBridge = (method, arg) => {
  const payload = JSON.stringify(arg === undefined ? null : arg);
  return win.webContents.executeJavaScript(
    `window.electronAPI.${method}(${payload === 'null' ? '' : payload})`, true,
  );
};
const tsxEval = (code, arg) => JSON.parse(execFileSync(NODE, [TSX, '-e', code, JSON.stringify(arg)],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim().split('\n').pop());

async function compactGbnf(schema) {
  const p = path.join(ROOT, 'node_modules', 'node-llama-cpp',
    'dist', 'utils', 'gbnfJson', 'getGbnfGrammarForGbnfJsonSchema.js');
  const mod = await import(pathToFileURL(p).href);
  return mod.getGbnfGrammarForGbnfJsonSchema(schema, { allowNewLines: false });
}

const runReq = async (req, id, extra = {}) => {
  const t0 = Date.now();
  const res = await callBridge('assistantRun', {
    requestId: id, task: 'character-dossier', tier: 'max', noThink: false,
    systemPrompt: req.systemPrompt, userText: req.userText,
    schema: req.schema, maxTokens: req.maxTokens,
    timeoutMs: 180000, contextSize: 4096,
    ...extra,
  });
  return { res, ms: Date.now() - t0 };
};

const fmt = (r) => r.res && r.res.ok
  ? `${String(r.ms).padStart(6)}ms  ${(r.res.timings && r.res.timings.tokens) || '?'} tok`
  : `FAILED ${(r.res && r.res.error) || '?'} ${r.ms}ms`;

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

  console.log('prep: real dossier requests via the shipped module…');
  const prep = JSON.parse(execFileSync(NODE, [
    TSX, path.join('scripts', 'bench-dossier-prep.ts'), ...CHARS,
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim().split('\n').pop());

  // Requests: every open field per character (deep pack = the shipped max
  // shape), plus one fusion request from the skeleton lines.
  const requests = [];
  for (const c of prep) {
    for (const f of FIELDS) {
      const ask = c.deepFields[f] && c.deepFields[f].ask;
      if (ask) requests.push({ label: `${c.spec}/${f}`, char: c, field: f, req: ask });
    }
    const fusion = tsxEval(
      'import {buildFusionRequest} from "./scripts/lib-dossier-variants";' +
      'const a = JSON.parse(process.argv[process.argv.length-1]);' +
      'console.log(JSON.stringify(buildFusionRequest(a)))',
      {
        name: c.name, pronounClass: c.pronounClass, forms: c.forms,
        factLines: (c.skeleton || '').split(/(?<=[.!?])\s+/).filter(Boolean),
      },
    );
    if ((c.skeleton || '').length > 0) {
      requests.push({ label: `${c.spec}/fusion`, char: c, field: null, req: fusion });
    }
  }
  console.log(`${requests.length} real requests\n`);

  const results = {};   // label → { path → {ms, tokens, graded} }
  const grade = (r, item) => {
    if (!r.res || !r.res.ok || !item.field) return null;
    const [g] = [tsxEval(
      'import {normalizeFieldAnswer} from "./src/lib/character-dossier";' +
      'const a = JSON.parse(process.argv[process.argv.length-1]);' +
      'console.log(JSON.stringify(normalizeFieldAnswer(a.raw, a.pack, a.field, {pronounClass: a.pc})))',
      { raw: r.res.json, pack: item.char.deepPack, field: item.field, pc: item.char.pronounClass },
    )];
    return g;
  };

  // ── phase 1: host, pretty then compact (host stays warm throughout) ──
  for (const style of ['host-pretty', 'host-compact']) {
    console.log(`═══ ${style} ═══`);
    const extra = style === 'host-compact' ? { jsonStyle: 'compact' } : {};
    for (const item of requests) {
      const r = await runReq(item.req, `pis-${style}-${item.label}`.replace(/[^a-z0-9-]/gi, '-'), extra);
      (results[item.label] ??= {})[style] = { ms: r.ms, ok: !!(r.res && r.res.ok), graded: grade(r, item) };
      console.log(`  ${item.label.padEnd(34)} ${fmt(r)}`);
    }
  }

  // ── phase 2: sidecar, sequential (compact gbnf precompiled) ──
  console.log(`═══ sidecar (lane batch, compact gbnf) ═══`);
  for (const item of requests) {
    const gbnf = await compactGbnf(item.req.schema);
    const r = await runReq(item.req, `pis-sc-${item.label}`.replace(/[^a-z0-9-]/gi, '-'),
      { lane: 'batch', gbnf, jsonStyle: 'compact' });
    (results[item.label] ??= {}).sidecar = { ms: r.ms, ok: !!(r.res && r.res.ok), graded: grade(r, item) };
    console.log(`  ${item.label.padEnd(34)} ${fmt(r)}  sidecar=${(await callBridge('assistantStatus', { tier: 'max' })).sidecar.alive}`);
  }

  // ── phase 3: one card's field calls CONCURRENTLY on the sidecar ──
  console.log(`═══ sidecar concurrent (one card's fields at once) ═══`);
  for (const c of prep) {
    const items = requests.filter((r) => r.char === c && r.field);
    if (items.length < 2) continue;
    const t0 = Date.now();
    const rs = await Promise.all(items.map(async (item) => runReq(
      item.req, `pis-par-${item.label}`.replace(/[^a-z0-9-]/gi, '-'),
      { lane: 'batch', gbnf: await compactGbnf(item.req.schema), jsonStyle: 'compact' },
    )));
    const wall = Date.now() - t0;
    const sum = rs.reduce((a, r) => a + r.ms, 0);
    const allOk = rs.every((r) => r.res && r.res.ok);
    console.log(`  ${c.spec.padEnd(24)} ${items.length} fields: wall ${wall}ms vs serial-sum ${sum}ms  (${(sum / wall).toFixed(2)}x)  ok=${allOk}`);
    for (let i = 0; i < items.length; i++) {
      (results[items[i].label] ??= {})['sidecar-par'] = {
        ms: rs[i].ms, ok: !!(rs[i].res && rs[i].res.ok), graded: grade(rs[i], items[i]),
      };
    }
  }

  // ── verdicts ──
  console.log(`\n═══ per-request comparison ═══`);
  console.log(`${'request'.padEnd(34)} ${'pretty'.padStart(8)} ${'compact'.padStart(8)} ${'sidecar'.padStart(8)}   quality`);
  const agree = (a, b) => {
    if (!a || !b) return '·';
    if (a.status !== b.status) return `STATUS ${a.status}→${b.status}`;
    if ((a.text || '') === (b.text || '')) return 'same';
    return 'text-differs';
  };
  for (const [label, r] of Object.entries(results)) {
    const base = r['host-pretty'];
    console.log(
      `${label.padEnd(34)} ${String(base ? base.ms : '·').padStart(8)}`
      + ` ${String(r['host-compact'] ? r['host-compact'].ms : '·').padStart(8)}`
      + ` ${String(r.sidecar ? r.sidecar.ms : '·').padStart(8)}`
      + `   compact:${agree(base && base.graded, r['host-compact'] && r['host-compact'].graded)}`
      + ` sidecar:${agree(base && base.graded, r.sidecar && r.sidecar.graded)}`,
    );
  }
  const mean = (k) => {
    const xs = Object.values(results).map((r) => r[k]).filter((x) => x && x.ok).map((x) => x.ms);
    return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
  };
  console.log(`\nmeans: pretty ${mean('host-pretty')}ms · compact ${mean('host-compact')}ms · sidecar ${mean('sidecar')}ms · sidecar-par ${mean('sidecar-par')}ms`);
  app.exit(0);
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
