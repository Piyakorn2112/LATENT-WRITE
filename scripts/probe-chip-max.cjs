/**
 * probe-chip-max.cjs — why max-mode chips fail, measured on the real 4B.
 *
 * Drives the REAL registry + host with the exact request the max-mode chip
 * tick ships (rich schema, maxTokens 160, noThink:false, contextSize 4096)
 * and then the candidate fix (noThink:true, maxTokens 320, tier default
 * context). Requests are built by the real module code via tsx, so what is
 * measured is what the app sends.
 *
 * HYPOTHESIS UNDER TEST: with noThink:false the 4B spends the whole 160-token
 * budget inside <think>, responseText is empty, grammar.parse throws, and the
 * tick writes a session-permanent skip key — chips silently never appear.
 *
 * Run: ./node_modules/.bin/electron scripts/probe-chip-max.cjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

app.setName('Latent Write');
const ROOT = path.join(__dirname, '..');
const NODE = '/opt/homebrew/bin/node';
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

/** Module-side helper: requests and normalization both come from src/lib. */
function mod(op, payload) {
  return JSON.parse(execFileSync(NODE, [TSX, '-e', `
    import { buildChipRequest, normalizeChipPicks } from "./src/lib/chip-picker";
    import { buildSummaryRequest } from "./src/lib/chapter-summary";
    import fixture from "./scripts/fixtures/assistant-tasks.json";
    const a = JSON.parse(process.argv[process.argv.length - 1]);
    const strong = fixture.timelineChips.find((c) => c.id === "strong");
    const n = strong.candidates.length;
    const entry = {
      chapterId: "probe-ch", chapterNumber: strong.chapterNumber,
      chapterTitle: strong.chapterTitle, contentHash: "probe",
      tensionPeak: 0.82, charactersPresent: strong.cast,
      majorEvents: strong.candidates.map((c, i) => ({
        rank: c.rank, label: c.label, sentence: c.sentence, agent: c.agent,
        type: "action", channel: "action",
        tensionPosition: n > 1 ? i / (n - 1) : 0.5,
      })),
    };
    let out;
    if (a.op === "build") {
      out = { rich: buildChipRequest(entry, { rich: true }), summary: buildSummaryRequest(entry) };
    } else if (a.op === "normalize") {
      const req = buildChipRequest(entry, { rich: true });
      out = normalizeChipPicks(a.json, req.candidates, strong.cast);
    }
    console.log(JSON.stringify(out ?? null));
  `, JSON.stringify({ op, ...payload })], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop());
}

let win = null;
const callBridge = (method, arg) => {
  const payload = JSON.stringify(arg === undefined ? null : arg);
  return win.webContents.executeJavaScript(
    `window.electronAPI.${method}(${payload === 'null' ? '' : payload})`, true,
  );
};

async function runCase(name, req, opts) {
  const t0 = Date.now();
  const res = await callBridge('assistantRun', {
    requestId: `probe-${name}-${Date.now()}`, task: 'timeline-chips',
    tier: 'max', systemPrompt: req.systemPrompt, userText: req.userText,
    schema: req.schema, timeoutMs: 120000, ...opts,
  });
  const wall = Date.now() - t0;
  const t = res.timings || {};
  const raw = typeof res.raw === 'string' ? res.raw : '';
  console.log(`\n── ${name}`);
  console.log(`   ok=${res.ok} error=${res.error ?? '-'} stop=${res.stopReason ?? '-'}`);
  console.log(`   wall=${wall}ms prefill=${t.prefillMs}ms gen=${t.genMs}ms tokens=${t.tokens} (${t.tokensPerSec} tok/s)`);
  console.log(`   rawLen=${raw.length} rawHead=${JSON.stringify(raw.slice(0, 120))}`);
  if (res.ok) console.log(`   json=${JSON.stringify(res.json).slice(0, 400)}`);
  return { res, wall };
}

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
  console.log(`model: ${status.model.id}`);

  const { rich, summary } = mod('build', {});
  console.log(`chip request: maxTokens=${rich.maxTokens} sys=${rich.systemPrompt.length}ch user=${rich.userText.length}ch`);

  // A — CANARY at the OLD 160 budget. Under the v2 rich prompt the model
  // copied whole sentences into `detail`, blew 160 mid-JSON (stop=maxTokens,
  // parse error) and the tick skip-keyed every chapter — the original
  // "max chips don't work". The v3 prompt asks for fragments and the same
  // answer now measures ~139 tokens, so this run passing at 160 is the proof
  // the rich answer stays SMALL. If this case ever fails again, the detail
  // rule has regressed toward sentence-copying — fix the prompt, not the cap.
  await runCase('A-canary-160-budget', rich,
    { noThink: false, contextSize: 4096, maxTokens: 160 });

  // B — the FIXED tick config: tier defaults only, RICH_MAX_TOKENS budget.
  // With the resident-credit fix this must reuse or cleanly upgrade — never
  // refuse low-memory while the same model is loaded and working.
  const b1 = await runCase('B-fix-chips-cold', rich, { maxTokens: rich.maxTokens });
  const b2 = await runCase('B2-fix-chips-warm', rich, { maxTokens: rich.maxTokens });
  await runCase('B3-fix-summary', summary, { maxTokens: summary.maxTokens });

  for (const [name, r] of [['B', b1], ['B2', b2]]) {
    if (!r.res.ok) continue;
    const picks = mod('normalize', { json: r.res.json });
    const details = (picks || []).filter((p) => p.detail);
    console.log(`\n${name} normalized: ${picks ? picks.length : 0} picks, ${details.length} details survive`);
    for (const p of picks || []) console.log(`   [${p.rank}] ${p.label}${p.detail ? `  ·  ${p.detail}` : ''}`);
  }

  await callBridge('assistantUnload');
  app.exit(0);
}

app.whenReady().then(() => main().catch((e) => { console.error(e); app.exit(1); }));
