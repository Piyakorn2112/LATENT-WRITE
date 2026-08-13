/**
 * bench-dossier-quality.cjs — the dossier card end to end, real models, per
 * benchmark character, with wall-clock per card. Mirrors
 * WorldDataView.generateDossier exactly (the on-mode appearance call, the
 * max-mode think pass + three field calls + one licensed retry, the same
 * composition), so a variant measured here is the product measured.
 *
 *   MODE=on  ./node_modules/.bin/electron scripts/bench-dossier-quality.cjs
 *   MODE=max ./node_modules/.bin/electron scripts/bench-dossier-quality.cjs
 *
 * Env:
 *   MODE   on | max                              (required)
 *   CHARS  comma list of book:Name to run        (default: FAST set)
 *   OUT    output JSON path                      (default: bench-results/dossier-<MODE>-<label>.json)
 *   LABEL  variant label stored in every row     (default: baseline)
 *
 * The tiers do not both fit in memory — run modes in separate processes.
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

const MODE = process.env.MODE;
if (MODE !== 'on' && MODE !== 'max') {
  console.error('MODE=on or MODE=max is required');
  process.exit(1);
}
/** baseline — the shipped flow.
 *  skeleton — shipped models, richer deterministic backing text.
 *  fusion   — skeleton + a containment-gated rewrite pass on the tier model.
 *  deep     — max only: wider evidence, deeper caps, reason-first
 *             personality instead of the think pass, then fusion. */
const VARIANT = process.env.VARIANT || 'baseline';
const LABEL = process.env.LABEL || VARIANT;

const FAST_SET = [
  'pride:Elizabeth', 'pride:Darcy', 'pride:Jane',
  'anne:Anne', 'anne:Marilla',
  'carol:Scrooge',
  'dracula:Van Helsing',
  'sherlock:Holmes',
  'webnovel:Jonah', 'webnovel:Elder Kang',
  'root-crown:Mira', 'root-crown:Kinoko', 'root-crown:Vey', 'root-crown:Gareth',
];
const CHARS = (process.env.CHARS ? process.env.CHARS.split(',') : FAST_SET).map((s) => s.trim());
const OUT = process.env.OUT
  || path.join(ROOT, 'bench-results', `dossier-${MODE}-${LABEL}.json`);

let win = null;
const callBridge = (method, arg) => {
  const payload = JSON.stringify(arg === undefined ? null : arg);
  return win.webContents.executeJavaScript(
    `window.electronAPI.${method}(${payload === 'null' ? '' : payload})`, true,
  );
};

const tsxEval = (code, arg) => JSON.parse(execFileSync(NODE, [TSX, '-e', code, JSON.stringify(arg)],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim().split('\n').pop());

/** Batched normalize through the shipped module: one tsx boot per card. */
const normalizeBatch = (items) => tsxEval(
  'import {normalizeFieldAnswer} from "./src/lib/character-dossier";' +
  'const a = JSON.parse(process.argv[process.argv.length-1]);' +
  'console.log(JSON.stringify(a.map((x) => normalizeFieldAnswer(x.raw, x.pack, x.field, ' +
  '{...(x.maxLen ? {maxLen: x.maxLen} : {}), ...(x.pronounClass ? {pronounClass: x.pronounClass} : {})}))))',
  items,
);

/** Fusion request + gate, through the variants module. */
const fusionRequest = (input) => tsxEval(
  'import {buildFusionRequest} from "./scripts/lib-dossier-variants";' +
  'const a = JSON.parse(process.argv[process.argv.length-1]);' +
  'console.log(JSON.stringify(buildFusionRequest(a)))',
  input,
);
const fusionVerdict = (raw, input) => tsxEval(
  'import {groundFusion} from "./scripts/lib-dossier-variants";' +
  'const a = JSON.parse(process.argv[process.argv.length-1]);' +
  'console.log(JSON.stringify(groundFusion(a.raw, a.input)))',
  { raw, input },
);

const sentencesOf = (text) => (text || '')
  .split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

/** One fusion attempt on the given tier; returns the fused text or null,
 *  recording timing + verdict on the row. */
async function tryFusion(c, factLines, tier, timings, fieldResults) {
  const input = {
    name: c.name, pronounClass: c.pronounClass, forms: c.forms,
    factLines: factLines.filter(Boolean),
  };
  if (input.factLines.length < 2) return null;
  const req = fusionRequest(input);
  const { res, ms } = await runModel(req, rid(c.spec, 'fusion', 'a'), tier,
    tier === 'max' ? { noThink: false } : {});
  timings.fusion = ms;
  if (!res || !res.ok) { fieldResults.fusion = { status: 'no-answer' }; return null; }
  let verdict = fusionVerdict(res.json && res.json.text, input);

  // ★ One repair retry, the offending words named — the containment gate is
  //   the external check that makes a small-model repair loop worth having.
  if (!verdict.ok && verdict.reason === 'new-content-words') {
    const retryReq = tsxEval(
      'import {buildFusionRetryRequest} from "./scripts/lib-dossier-variants";' +
      'const a = JSON.parse(process.argv[process.argv.length-1]);' +
      'console.log(JSON.stringify(buildFusionRetryRequest(a.input, a.newWords)))',
      { input, newWords: verdict.newWords },
    );
    const second = await runModel(retryReq, rid(c.spec, 'fusion', 'b'), tier,
      tier === 'max' ? { noThink: false } : {});
    timings['fusion-retry'] = second.ms;
    if (second.res && second.res.ok) {
      const repaired = fusionVerdict(second.res.json && second.res.json.text, input);
      if (repaired.ok) verdict = repaired;
      else verdict = { ...verdict, reason: `${verdict.reason};retry:${repaired.reason}` };
    }
  }

  fieldResults.fusion = {
    status: verdict.ok ? 'fused' : `rejected:${verdict.reason}`,
    newWords: verdict.newWords, droppedLines: verdict.droppedLines,
  };
  return verdict.ok ? verdict.text : null;
}

const composeProposal = (arg) => tsxEval(
  'import {composeProposalDescription, emptyProposal} from "./src/lib/character-dossier";' +
  'const a = JSON.parse(process.argv[process.argv.length-1]);' +
  'const p = {...emptyProposal(a.pack, a.role), ...a.fields};' +
  'p.role = a.role;' +
  'console.log(JSON.stringify(composeProposalDescription(p)))',
  arg,
);

async function runModel(req, requestId, tier, extra = {}) {
  const t0 = Date.now();
  const res = await callBridge('assistantRun', {
    requestId,
    task: 'character-dossier', tier,
    systemPrompt: req.systemPrompt, userText: req.userText,
    schema: req.schema, maxTokens: req.maxTokens,
    timeoutMs: 180000,
    contextSize: 4096,
    ...extra,
  });
  return { res, ms: Date.now() - t0 };
}

/** The think pass, exactly as think.ts runs it (freeText, </think> stop). */
async function runThink(req, budget, requestId) {
  const t0 = Date.now();
  const res = await callBridge('assistantRun', {
    requestId,
    task: 'character-dossier', tier: 'max',
    systemPrompt: req.systemPrompt, userText: req.userText,
    schema: req.schema,
    freeText: true, stopTexts: ['</think>'], noThink: false,
    maxTokens: budget, timeoutMs: 180000, contextSize: 4096,
  });
  const ms = Date.now() - t0;
  if (!res || !res.ok) return { notes: null, ms };
  const raw = typeof (res.json && res.json.text) === 'string' ? res.json.text : '';
  const notes = raw.replace(/^[\s\S]*?<think>/, '').replace(/<\/think>[\s\S]*$/, '').trim();
  if (notes.length < 40) return { notes: null, ms };
  return { notes: notes.length <= 2400 ? notes : notes.slice(-2400), ms };
}

const rid = (spec, field, label) =>
  `bq-${MODE}-${spec}-${field}-${label}`.replace(/[^a-z0-9-]/gi, '-');

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

  const tier = MODE === 'on' ? 'small' : 'max';
  const status = await callBridge('assistantStatus', { tier });
  if (!status.model.present) {
    console.error(`model for tier ${tier} not on disk`);
    app.exit(1);
    return;
  }
  console.log(`MODE=${MODE}  LABEL=${LABEL}  model=${status.model.id}  chars=${CHARS.length}`);

  console.log('prep: packs, requests and extractive compositions via the shipped module…');
  const prep = JSON.parse(execFileSync(NODE, [
    TSX, path.join('scripts', 'bench-dossier-prep.ts'), ...CHARS,
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim().split('\n').pop());
  console.log(`prep done: ${prep.length}/${CHARS.length} characters resolved\n`);

  const rows = [];
  for (const c of prep) {
    const t0 = Date.now();
    const timings = {};
    let description = '';
    let generated = false;
    const fieldResults = {};

    if (MODE === 'on') {
      // ── WorldDataView on-mode: one 1.7B appearance call over the pack,
      //    grounded; the deterministic composition stands behind it.
      //    Variants change WHICH deterministic text backs it (skeleton) and
      //    whether a containment-gated fusion pass rewrites the whole card.
      const backing = VARIANT === 'baseline' ? c.extractive : (c.skeleton || c.extractive);
      let lead = '';
      const ask = c.fields.appearance.ask;
      if (ask) {
        const { res, ms } = await runModel(ask, rid(c.spec, 'appearance', 'a'), 'small');
        timings.appearance = ms;
        if (res && res.ok) {
          const [answer] = normalizeBatch([{ raw: res.json, pack: c.pack, field: 'appearance', pronounClass: c.pronounClass }]);
          fieldResults.appearance = answer;
          if (answer.status === 'grounded' || answer.status === 'repaired') {
            lead = composeProposal({
              pack: c.pack, role: c.role,
              fields: { appearance: { text: answer.text, spans: answer.spans, status: answer.status } },
            });
            generated = true;
          }
        }
      }
      const concat = [lead, backing].filter(Boolean).join(' ');
      if (VARIANT === 'fusion' && concat) {
        const fused = await tryFusion(
          c, [...(lead ? [lead] : []), ...sentencesOf(backing)], 'small', timings, fieldResults,
        );
        if (fused) { description = fused; generated = true; }
      }
      if (!description) description = concat;
    } else {
      // ── WorldDataView max-mode: think pass on personality, three field
      //    calls, one licensed retry each, composed; extractive fallback.
      //    deep variant: wider evidence, deeper caps, reason-first
      //    personality in place of the unconstrained think pass.
      const deep = VARIANT === 'deep';
      const pack = deep ? c.deepPack : c.pack;
      const fieldSpecs = deep ? c.deepFields : c.fields;
      const proposal = {};
      for (const field of ['appearance', 'personality', 'background']) {
        const spec = fieldSpecs[field];
        if (!spec || !spec.ask) continue;
        let notes = null;
        if (!deep && spec.think) {
          const t = await runThink(spec.think, spec.thinkBudget, rid(c.spec, field, 'think'));
          timings[`${field}-think`] = t.ms;
          notes = t.notes;
        }
        // Re-ask the module for the request WITH notes riding the user turn.
        const [withNotes] = notes ? tsxEval(
          'import {buildFieldRequest, buildFieldRetryRequest} from "./src/lib/character-dossier";' +
          'const a = JSON.parse(process.argv[process.argv.length-1]);' +
          'console.log(JSON.stringify([{ask: buildFieldRequest(a.pack, a.field, "character", a.notes),' +
          ' retry: buildFieldRetryRequest(a.pack, a.field, "character", a.notes)}]))',
          { pack, field, notes },
        ) : [spec];

        const grade = deep ? { maxLen: spec.gradeMaxLen } : {};
        const first = await runModel(withNotes.ask, rid(c.spec, field, 'a'), 'max', { noThink: false });
        timings[field] = first.ms;
        if (!first.res || !first.res.ok) continue;
        let [answer] = normalizeBatch([{ raw: first.res.json, pack, field, pronounClass: c.pronounClass, ...grade }]);
        if (deep && first.res.json && typeof first.res.json.reason === 'string') {
          answer.reason = first.res.json.reason;
        }
        if (answer.status === 'refused' && withNotes.retry) {
          const second = await runModel(withNotes.retry, rid(c.spec, field, 'b'), 'max', { noThink: false });
          timings[`${field}-retry`] = second.ms;
          if (second.res && second.res.ok) {
            const [retried] = normalizeBatch([{ raw: second.res.json, pack, field, pronounClass: c.pronounClass, ...grade }]);
            if (retried.status === 'grounded' || retried.status === 'repaired') answer = retried;
          }
        }
        fieldResults[field] = answer;
        if (answer.text) {
          proposal[field] = { text: answer.text, spans: answer.spans, status: answer.status };
        }
      }
      const generatedText = Object.keys(proposal).length
        ? composeProposal({ pack, role: c.role, fields: proposal })
        : '';
      const backing = VARIANT === 'baseline' ? c.extractive : (c.skeleton || c.extractive);

      if (VARIANT === 'fusion' || VARIANT === 'deep') {
        const fieldLines = ['appearance', 'personality', 'background']
          .filter((f) => proposal[f])
          .map((f) => {
            const t = proposal[f].text.trim().replace(/^./, (ch) => ch.toUpperCase());
            return /[.!?…]$/.test(t) ? t : `${t}.`;
          });
        const fused = await tryFusion(
          c, [...fieldLines, ...sentencesOf(backing)], 'max', timings, fieldResults,
        );
        if (fused) {
          description = fused;
          generated = true;
        }
      }
      if (!description) {
        description = generatedText || backing;
        generated = !!generatedText;
      }
    }

    const totalMs = Date.now() - t0;
    rows.push({
      spec: c.spec, book: c.book, name: c.name, forms: c.forms,
      mode: MODE, label: LABEL,
      role: c.role, description, generated,
      extractive: c.extractive,
      fields: fieldResults,
      timings, totalMs,
    });
    console.log(`── ${c.spec}  ${totalMs}ms`);
    console.log(`   role: ${c.role}`);
    console.log(`   ${JSON.stringify(description)}\n`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ mode: MODE, label: LABEL, at: new Date().toISOString(), rows }, null, 2));
  console.log(`\nwrote ${rows.length} rows → ${OUT}`);
  app.exit(0);
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
