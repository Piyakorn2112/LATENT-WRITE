/**
 * probe-dossier-model.cjs — the dossier card against the REAL shipping tiers.
 *
 * ★ EVERYTHING SHIPPED, NOTHING COPIED. Packs come from the module through
 *   probe-character-dossier.ts --pack; the per-field prompts, schemas, gates,
 *   grounding, repair and usefulness test are the module's own, reached
 *   through tsx. A probe that hand-rolls any of those measures the probe.
 *
 * ★★ ONE FIELD PER CALL IS A MEASURED REQUIREMENT, NOT A STYLE. The
 *    three-field mega-ask returned every field empty at confidence 0 on all
 *    four RICH packs while answering the starved ones; the per-field A/B on
 *    the same packs answered correctly ("dark eyes" cited [3] at 0.9). See
 *    the module's request-section comment.
 *
 * ★★ THE ABSTENTION CASES DECIDE. A starved field must produce a closed gate
 *    and zero tokens, never an invented description. GATE=off is the canary:
 *    it asks anyway (full span list as candidates) and must reproduce the
 *    fabrication class the gates exist to stop — if gate-on and gate-off look
 *    the same, the gate is dead.
 *
 * Run: TIERS=max   ./node_modules/.bin/electron scripts/probe-dossier-model.cjs
 *      GATE=off TIERS=max ./node_modules/.bin/electron scripts/probe-dossier-model.cjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

app.setName('Latent Write');

const ROOT = path.join(__dirname, '..');
const NODE = '/opt/homebrew/bin/node';
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

const TIERS = (process.env.TIERS || 'max').split(',');
const GATE_OFF = process.env.GATE === 'off';
const FIELDS = ['appearance', 'personality', 'background'];

const CASES = [
  { spec: 'pride:Elizabeth', kind: 'rich',
    truth: 'dark eyes; lively, determined; walks far and fast' },
  { spec: 'pride:Darcy', kind: 'rich',
    truth: 'proud, clever; the pack may only support manner, not looks' },
  { spec: 'anne:Anne', kind: 'rich',
    truth: 'red hair, freckles, thin, gray eyes; talkative, imaginative' },
  { spec: 'dracula:Van Helsing', kind: 'middling',
    truth: 'iron jaw, bushy brows; resolute' },
  { spec: 'webnovel:Jonah', kind: 'starved',
    truth: 'appearance NOTHING (gate must close); 2 trait spans exist' },
  { spec: 'webnovel:Elder Kang', kind: 'starved',
    truth: 'appearance NOTHING; near-nothing anywhere' },
];

let win = null;
const callBridge = (method, arg) => {
  const payload = JSON.stringify(arg === undefined ? null : arg);
  return win.webContents.executeJavaScript(
    `window.electronAPI.${method}(${payload === 'null' ? '' : payload})`, true,
  );
};

const tsxEval = (code, arg) => JSON.parse(execFileSync(NODE, [TSX, '-e', code, JSON.stringify(arg)],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim().split('\n').pop());

/** GATE=off: every span becomes a candidate for every field, so the ask is
 *  made and the accepting gate has nothing to close. */
const ungate = (pack) => ({
  ...pack,
  visualCandidates: pack.spans.map((s) => s.n),
  traitCandidates: pack.spans.map((s) => s.n),
  loreCandidates: pack.spans.map((s) => s.n),
});

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

  console.log('\nassembling packs from the real corpus via the shipped module…');
  const packs = JSON.parse(execFileSync(NODE, [
    TSX, path.join('scripts', 'probe-character-dossier.ts'), '--pack',
    ...CASES.map((c) => c.spec),
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim().split('\n').pop());
  const byName = new Map(packs.map((p) => [`${p.book}:${p.name}`, GATE_OFF ? ungate(p) : p]));

  // Per-field requests via the module's own builder (null = gate closed),
  // plus the extractive retry request the refusal path uses.
  const requests = tsxEval(
    'import {buildFieldRequest, buildFieldRetryRequest} from "./src/lib/character-dossier";' +
    'const a = JSON.parse(process.argv[process.argv.length-1]);' +
    'console.log(JSON.stringify(a.map(({pack}) => ' +
    '  Object.fromEntries(["appearance","personality","background"].map((f) => ' +
    '    [f, {ask: buildFieldRequest(pack, f), retry: buildFieldRetryRequest(pack, f)}])))))',
    [...byName.values()].map((pack) => ({ pack })),
  );
  const reqBySpec = new Map([...byName.keys()].map((k, i) => [k, requests[i]]));

  for (const tier of TIERS) {
    const status = await callBridge('assistantStatus', { tier });
    if (!status.model.present) { console.log(`SKIP ${tier} — model not on disk.`); continue; }
    console.log(`\n${'═'.repeat(78)}\nTIER ${tier} — ${status.model.id}${GATE_OFF ? '   [GATE OFF — canary]' : ''}\n${'═'.repeat(78)}`);

    const answers = [];
    for (const c of CASES) {
      const reqs = reqBySpec.get(c.spec);
      if (!reqs) continue;
      console.log(`\n── ${c.spec}  [${c.kind}]`);
      console.log(`   truth: ${c.truth}`);
      const perField = {};
      for (const field of FIELDS) {
        const pair = reqs[field];
        if (!pair || !pair.ask) {
          console.log(`   ${field.padEnd(12)} GATED — no eligible spans, no call`);
          perField[field] = { gated: true };
          continue;
        }
        const runOne = async (req, label) => {
          const t0 = Date.now();
          const res = await callBridge('assistantRun', {
            requestId: `dsr-${tier}-${c.spec}-${field}-${label}`.replace(/[^a-z0-9-]/gi, '-'),
            task: 'character-dossier', tier,
            ...(tier === 'max' ? { noThink: false } : {}),
            systemPrompt: req.systemPrompt, userText: req.userText,
            schema: req.schema, maxTokens: req.maxTokens,
            timeoutMs: 180000,
          });
          return { res, ms: Date.now() - t0 };
        };
        const first = await runOne(pair.ask, 'a');
        if (!first.res || !first.res.ok) {
          console.log(`   ${field.padEnd(12)} NO ANSWER (${first.res && first.res.error})  ${first.ms}ms`);
          perField[field] = { raw: null };
          continue;
        }
        const j = first.res.json || {};
        console.log(`   ${field.padEnd(12)} [${(j.spans || []).join(',')}] ${JSON.stringify(j[field])}  conf ${j.confidence}  ${first.ms}ms`);

        // ★ REFUSAL LICENSES ONE EXTRACTIVE RETRY — the module's own rule,
        //   checked with the module's own normalizer.
        const verdict = tsxEval(
          'import {normalizeFieldAnswer} from "./src/lib/character-dossier";' +
          'const a = JSON.parse(process.argv[process.argv.length-1]);' +
          'console.log(JSON.stringify(normalizeFieldAnswer(a.raw, a.pack, a.field).status))',
          { raw: j, pack: byName.get(c.spec), field },
        );
        if (verdict === 'refused' && pair.retry) {
          const second = await runOne(pair.retry, 'b');
          if (second.res && second.res.ok) {
            const k = second.res.json || {};
            console.log(`   ${''.padEnd(12)} retry → [${(k.spans || []).join(',')}] ${JSON.stringify(k[field])}  ${second.ms}ms`);
            perField[field] = { raw: k };
            continue;
          }
        }
        perField[field] = { raw: j };
      }
      answers.push({ spec: c.spec, perField });
    }

    // The SHIPPED normalize/ground/repair pass, batch, through tsx.
    const graded = tsxEval(
      'import {normalizeFieldAnswer} from "./src/lib/character-dossier";' +
      'const rows = JSON.parse(process.argv[process.argv.length-1]);' +
      'console.log(JSON.stringify(rows.map((r) => ' +
      '  Object.fromEntries(Object.entries(r.perField).map(([f, v]) => ' +
      '    [f, v.gated ? {status: "gated-before-call"} : v.raw == null ? {status: "no-answer"} ' +
      '      : normalizeFieldAnswer(v.raw, r.pack, f)])))))',
      answers.map((r) => ({ perField: r.perField, pack: byName.get(r.spec) })),
    );

    console.log(`\n${'─'.repeat(78)}\nAFTER THE SHIPPED GROUNDING AND GATES:\n`);
    answers.forEach((r, i) => {
      console.log(`── ${r.spec}`);
      for (const field of FIELDS) {
        const g = graded[i][field];
        console.log(`   ${field.padEnd(12)} [${g.status}] ${g.text ? JSON.stringify(g.text) + ' ← spans [' + g.spans.join(',') + ']' : ''}`);
      }
      console.log('');
    });
  }
  app.exit(0);
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
