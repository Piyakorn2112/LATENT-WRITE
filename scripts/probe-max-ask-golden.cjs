/**
 * probe-max-ask-golden.cjs — the golden set against the real max tier.
 *
 * ★ THIS PROBE DOES NOT GRADE. The golden cases are graded by a HUMAN reading
 *   each answer against expectDirection / mustTouch / mustNotClaim /
 *   expectedSource — direction and sense, not string match. What IS automatic
 *   is the mechanical layer: schema-valid, validator-accepted, basis within
 *   vocabulary, 2-3 sentence format. The probe prints everything a checker
 *   needs side by side and writes a transcript for the record.
 *
 * ★ THE GOLDEN WORLD NEVER TOUCHED THE TUNING FIXTURES — scoring against the
 *   world the prompts were shaped on would be circular. See the fixture head.
 *
 * Run: ./node_modules/.bin/electron scripts/probe-max-ask-golden.cjs
 *      (writes scripts/fixtures/max-ask-golden-results.md)
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

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
  const status = await callBridge('assistantStatus', { tier: 'max' });
  if (!status.model.present) { console.log('SKIP — max model not on disk.'); app.exit(0); return; }

  // Cases + requests from the REAL modules.
  const built = JSON.parse(execFileSync(NODE, [TSX, '-e',
    'import {GOLDEN_CASES} from "./scripts/fixtures/max-ask-golden";' +
    'import {buildMaxAskPack, buildMaxAskRequest} from "./src/lib/max-ask";' +
    'console.log(JSON.stringify(GOLDEN_CASES.map((c)=>{' +
    '  const pack = buildMaxAskPack(c.input);' +
    '  const req = buildMaxAskRequest(pack);' +
    '  return { id: c.id, kind: c.input.kind, question: c.input.question ?? null,' +
    '    expectDirection: c.expectDirection, mustTouch: c.mustTouch,' +
    '    mustNotClaim: c.mustNotClaim, expectedSource: c.expectedSource,' +
    '    rungs: pack.rungsIncluded, tokens: pack.tokensEstimate, req };' +
    '})))',
  ], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop());

  console.log(`model: ${status.model.id} · ${built.length} golden cases\n`);
  const rows = [];
  for (const b of built) {
    const t0 = Date.now();
    const res = await callBridge('assistantRun', {
      requestId: `golden-${b.id}`, task: 'max-ask', tier: 'max', contextSize: 4096,
      noThink: false,
      systemPrompt: b.req.systemPrompt, userText: b.req.userText,
      schema: b.req.schema, maxTokens: b.req.maxTokens, timeoutMs: 180000,
    });
    rows.push({ b, ms: Date.now() - t0, j: res && res.ok ? res.json : null, err: res && res.error });
    process.stdout.write(`  ${b.id.padEnd(26)} ${res && res.ok ? 'answered' : `FAILED ${res && res.error}`} ${Date.now() - t0}ms\n`);
  }

  // Shipped validator for the mechanical layer.
  const shipped = JSON.parse(execFileSync(NODE, [TSX, '-e',
    'import {normalizeMaxAsk, isUsefulAnswer} from "./src/lib/max-ask";' +
    'const rows = JSON.parse(process.argv[process.argv.length-1]);' +
    'console.log(JSON.stringify(rows.map((r)=>{const a=normalizeMaxAsk(r.json, r.rungs);' +
    'return {a, useful:isUsefulAnswer(a)};})))',
    JSON.stringify(rows.map((r) => ({ json: r.j, rungs: r.b.rungs }))),
  ], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop());

  const lines = [];
  lines.push(`# max-ask golden run — ${status.model.id}`);
  lines.push(`_Hand-graded transcript. The probe grades only the mechanical layer;_`);
  lines.push(`_direction/sense verdicts are written by a human under each case._\n`);
  rows.forEach((r, i) => {
    const v = shipped[i];
    const sentences = v.a ? (v.a.answer.match(/[.!?…]+\s|[.!?…]+$/g) || []).length : 0;
    lines.push(`## ${r.b.id}  (${r.b.kind}${r.b.question ? ` — "${r.b.question}"` : ''})`);
    lines.push(`- pack: ${r.b.tokens} tok [${r.b.rungs.join(', ')}] · ${r.b.ms}ms`);
    lines.push(`- expect: ${r.b.expectDirection}`);
    lines.push(`- mustTouch: ${r.b.mustTouch.join(' · ')}   mustNotClaim: ${r.b.mustNotClaim.join(' · ')}`);
    lines.push(`- expectedSource: ${r.b.expectedSource.join(', ')}`);
    if (!r.j) { lines.push(`- ANSWER: (failed: ${r.err})`); lines.push(''); return; }
    lines.push(`- mechanical: validator=${v.a ? 'accepted' : 'REFUSED'} · surfaced=${v.useful} · basis=${v.a ? v.a.basis : '-'} · ~${sentences} sentences · conf=${r.j.confidence}`);
    lines.push(`- ANSWER: ${r.j.answer}`);
    lines.push(`- VERDICT: _(hand)_`);
    lines.push('');
  });
  const out = path.join(ROOT, 'scripts', 'fixtures', 'max-ask-golden-results.md');
  fs.writeFileSync(out, lines.join('\n'), 'utf8');
  console.log(`\ntranscript -> ${out}`);
  await callBridge('assistantUnload');
  app.exit(0);
}

app.whenReady().then(() => main().catch((e) => { console.error(e); app.exit(1); }));
