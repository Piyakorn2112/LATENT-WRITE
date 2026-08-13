/**
 * bench-ask-rewrite.cjs — the ask + rewrite surfaces end to end on the real
 * 4B, against the reference set (fixtures/ask-rewrite-reference.ts): fixed
 * inputs, golden outputs written by a high-capacity model, mechanical keys.
 *
 * Mirrors the REAL flows call for call:
 *   ask      MaxAskPopover → runMaxAsk with selfReview:true, contextSize
 *            8192 — think pass (freeText, decideAskThinking budget) → ask →
 *            normalize/coerce → claim-check review → refine on flag or low
 *            confidence → re-check; widen once when not useful.
 *   rewrite  runWritingTool single-batch — decideWritingThinking → main call
 *            (jsonStyle compact) → matchQuoteStyle/fromWire → judge →
 *            bounded retries, last custom attempt sampled.
 *
 * Every deterministic step goes through the shipped modules via the helper
 * (bench-askrw-helper.ts); the runner owns only sequencing and timing.
 *
 *   MODE=both LABEL=baseline ./node_modules/.bin/electron scripts/bench-ask-rewrite.cjs
 *
 * Output: bench-results/askrw-<LABEL>.json — per case: every call's ms and
 * decode tokens, prompt chars, the final output, and key/antiKey hits vs
 * the golden. Resource proxies: decode tokens (compute) + prompt chars/4
 * (prefill) + peak contextSize.
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

const MODE = process.env.MODE || 'both';
const LABEL = process.env.LABEL || 'baseline';
const OUT = process.env.OUT || path.join(ROOT, 'bench-results', `askrw-${LABEL}.json`);
const ASK_CTX = 8192;   // MaxAskPopover's window
const RW_CTX = 8192;    // the writing runner leaves the tier default

let win = null;
const callBridge = (method, arg) => {
  const payload = JSON.stringify(arg === undefined ? null : arg);
  return win.webContents.executeJavaScript(
    `window.electronAPI.${method}(${payload === 'null' ? '' : payload})`, true,
  );
};
const helper = (step, arg) => JSON.parse(execFileSync(NODE, [
  TSX, path.join('scripts', 'bench-askrw-helper.ts'), step, JSON.stringify(arg),
], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim().split('\n').pop());

const NOTES_BLOCK = (notes) =>
  `YOUR NOTES — you already thought this through; use these conclusions:\n${notes}`;

/** One bridge call, timed; returns {res, ms, tokens, promptChars}. */
async function call(requestId, req, extra) {
  const t0 = Date.now();
  const res = await callBridge('assistantRun', {
    requestId, tier: 'max',
    systemPrompt: req.systemPrompt, userText: req.userText,
    schema: req.schema, maxTokens: req.maxTokens,
    timeoutMs: 180000,
    ...extra,
  });
  return {
    res, ms: Date.now() - t0,
    tokens: (res && res.timings && res.timings.tokens) || 0,
    promptChars: (req.systemPrompt || '').length + (req.userText || '').length,
  };
}

/** runThinkPass, mirrored: freeText to </think>, notes cleaned + tail-capped. */
async function thinkPass(requestId, req, budget, task, ctx) {
  const r = await call(requestId, { ...req, maxTokens: budget }, {
    task, noThink: false, freeText: true, stopTexts: ['</think>'], contextSize: ctx,
  });
  if (!r.res || !r.res.ok) return { notes: null, ...r };
  const raw = typeof (r.res.json && r.res.json.text) === 'string' ? r.res.json.text : '';
  const notes = raw.replace(/^[\s\S]*?<think>/, '').replace(/<\/think>[\s\S]*$/, '').trim();
  if (notes.length < 40) return { notes: null, ...r };
  return { notes: notes.length <= 2400 ? notes : notes.slice(-2400), ...r };
}

const keyHits = (text, keys) => keys.filter((k) => text.toLowerCase().includes(k.toLowerCase()));

// ── ask: the runMaxAsk mirror ───────────────────────────────────────────────
async function runAskCase(c) {
  const calls = [];
  const track = (label, r) => {
    calls.push({ label, ms: r.ms, tokens: r.tokens, promptChars: r.promptChars, ok: !!(r.res && r.res.ok) });
    return r;
  };
  const rid = (label) => `arw-ask-${c.id}-${label}`.replace(/[^a-z0-9-]/gi, '-');
  const t0 = Date.now();

  let budget = c.budget;
  let prep = helper('ask-prep', { input: c.input, budget });
  let notes = null;
  let final = null;
  let review = null;
  let refined = false;
  let stopped = 'answered';

  for (let step = 1; step <= 2; step++) {
    if (step === 1 && prep.decision.think) {
      const t = track('think', await thinkPass(rid(`think`), prep.req, prep.decision.budget, 'max-ask', ASK_CTX));
      notes = t.notes;
    }
    const askReq = notes
      ? { ...prep.req, userText: `${prep.req.userText}\n\n${NOTES_BLOCK(notes)}` }
      : prep.req;
    const first = track(`ask${step}`, await call(rid(`ask${step}`), askReq, {
      task: 'max-ask', noThink: false, contextSize: ASK_CTX,
    }));
    if (!first.res || !first.res.ok) { stopped = 'failed'; break; }

    const norm = helper('ask-norm', { json: first.res.json, rungs: prep.rungs, kind: c.input.kind });
    if (norm.answer) final = norm.answer;

    if (norm.useful) {
      // review → flag → refine → re-check, the popover's selfReview path.
      const rb = helper('ask-review-build', { input: c.input, budget, answer: norm.answer });
      const rev = track('review', await call(rid('review'), rb.req, {
        task: 'max-ask', noThink: false, contextSize: ASK_CTX,
      }));
      if (rev.res && rev.res.ok) {
        review = helper('ask-review-verdict', { json: rev.res.json, packText: rb.packText }).review;
      }
      const flag = review && review.verdict === 'overreaches' && review.note
        ? { kind: 'overreach', note: review.note }
        : norm.needsRefineOnLowConf ? { kind: 'low-confidence' } : null;
      if (flag) {
        const fb = helper('ask-refine-build', { input: c.input, budget, answer: norm.answer, flag, kind: c.input.kind });
        const ref = track('refine', await call(rid('refine'), fb.req, {
          task: 'max-ask', noThink: false, contextSize: ASK_CTX,
        }));
        if (ref.res && ref.res.ok) {
          const rn = helper('ask-norm', { json: ref.res.json, rungs: prep.rungs, kind: c.input.kind });
          if (rn.answer && rn.useful) {
            const rb2 = helper('ask-review-build', { input: c.input, budget, answer: rn.answer });
            const rev2 = track('recheck', await call(rid('recheck'), rb2.req, {
              task: 'max-ask', noThink: false, contextSize: ASK_CTX,
            }));
            if (rev2.res && rev2.res.ok) {
              const v2 = helper('ask-review-verdict', { json: rev2.res.json, packText: rb2.packText }).review;
              if (v2 && v2.verdict === 'supported') { final = rn.answer; review = v2; refined = true; }
            }
          }
        }
      }
      stopped = 'answered';
      break;
    }
    if (step === 2 || prep.dropped.length === 0) { stopped = 'rungs-exhausted'; break; }
    budget = prep.widened;
    const wider = helper('ask-prep', { input: c.input, budget });
    if (wider.rungs.length === prep.rungs.length) { stopped = 'rungs-exhausted'; break; }
    prep = wider;
  }

  const answerText = final ? final.answer : '';
  return {
    id: c.id, surface: 'ask', kind: c.input.kind,
    output: final, review: review ? { verdict: review.verdict, note: review.note } : null,
    refined, stopped,
    golden: c.golden,
    keysHit: keyHits(`${answerText} ${final ? final.basis : ''}`, c.keys),
    keysTotal: c.keys.length,
    antiHit: keyHits(answerText, c.antiKeys),
    calls,
    wallMs: Date.now() - t0,
    decodeTokens: calls.reduce((a, x) => a + x.tokens, 0),
    promptChars: calls.reduce((a, x) => a + x.promptChars, 0),
  };
}

// ── rewrite: the runWritingTool single-batch mirror ─────────────────────────
async function runRewriteCase(c) {
  const calls = [];
  const track = (label, r) => {
    calls.push({ label, ms: r.ms, tokens: r.tokens, promptChars: r.promptChars, ok: !!(r.res && r.res.ok) });
    return r;
  };
  const rid = (label) => `arw-rw-${c.id}-${label}`.replace(/[^a-z0-9-]/gi, '-');
  const t0 = Date.now();

  let attempt = 0;
  let retryNote;
  let outcome = 'failed';
  let revised = c.text;
  let prep;
  for (;;) {
    prep = helper('rw-prep', {
      op: c.op, instruction: c.instruction, text: c.text, before: c.before,
      retryNote, attempt,
    });
    const sampled = c.op === 'custom' && attempt === prep.maxAttempts - 1;
    let notes = null;
    if (prep.decision.think) {
      const t = track(`think-a${attempt}`, await thinkPass(
        rid(`think-a${attempt}`), prep.request, prep.decision.budget, 'writing-tool', RW_CTX));
      notes = t.notes;
    }
    const req = notes
      ? { ...prep.request, userText: `${prep.request.userText}\n\n${NOTES_BLOCK(notes)}` }
      : prep.request;
    const main = track(`main-a${attempt}`, await call(rid(`main-a${attempt}`), req, {
      task: 'writing-tool', contextSize: RW_CTX, jsonStyle: 'compact',
      ...(sampled ? { temperature: 0.7, minP: 0.05 } : {}),
    }));
    if (!main.res || !main.res.ok) { outcome = 'failed'; break; }

    const raw = typeof (main.res.json && main.res.json.text) === 'string' ? main.res.json.text : '';
    const judged = helper('rw-judge', {
      original: prep.batchText, raw, relaxed: !!notes,
      profile: prep.profile, reading: prep.reading,
    });
    if (judged.unchanged) {
      if (c.op !== 'custom') { outcome = 'unchanged'; break; }
      if (++attempt >= prep.maxAttempts) { outcome = 'kept-original'; break; }
      retryNote = judged.unchangedNote;
      continue;
    }
    if (judged.verdict && judged.verdict.ok) { revised = judged.text; outcome = 'revised'; break; }
    if (++attempt >= prep.maxAttempts) { outcome = 'kept-original'; break; }
    retryNote = judged.verdict && judged.verdict.failure ? judged.verdict.failure.detail : 'try again';
  }

  return {
    id: c.id, surface: 'rewrite', op: c.op,
    output: revised, outcome,
    golden: c.golden,
    keysHit: keyHits(revised, c.keys), keysTotal: c.keys.length,
    mustKeepMissing: c.mustKeep.filter((k) => !revised.toLowerCase().includes(k.toLowerCase())),
    antiHit: keyHits(revised, c.antiKeys),
    calls,
    wallMs: Date.now() - t0,
    decodeTokens: calls.reduce((a, x) => a + x.tokens, 0),
    promptChars: calls.reduce((a, x) => a + x.promptChars, 0),
  };
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
  if (!status.model.present) { console.error('max model not on disk'); app.exit(1); return; }
  console.log(`MODE=${MODE} LABEL=${LABEL} model=${status.model.id}\n`);

  const fixtures = JSON.parse(execFileSync(NODE, [TSX, '-e',
    'import {ASK_CASES, REWRITE_CASES} from "./scripts/fixtures/ask-rewrite-reference";' +
    'console.log(JSON.stringify({ask: ASK_CASES, rw: REWRITE_CASES}))',
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim().split('\n').pop());

  const rows = [];
  if (MODE === 'both' || MODE === 'ask') {
    for (const c of fixtures.ask) {
      const row = await runAskCase(c);
      rows.push(row);
      console.log(`── ask ${c.id}  ${row.wallMs}ms  ${row.decodeTokens}tok  keys ${row.keysHit.length}/${row.keysTotal}${row.antiHit.length ? '  ANTI:' + row.antiHit.join(',') : ''}`);
      console.log(`   ${row.output ? JSON.stringify(row.output.answer.slice(0, 180)) : '(no answer)'} [${row.output ? row.output.basis : '-'}]`);
    }
  }
  if (MODE === 'both' || MODE === 'rewrite') {
    for (const c of fixtures.rw) {
      const row = await runRewriteCase(c);
      rows.push(row);
      console.log(`── rw ${c.id}  ${row.wallMs}ms  ${row.decodeTokens}tok  ${row.outcome}  keys ${row.keysHit.length}/${row.keysTotal}${row.mustKeepMissing.length ? '  LOST:' + row.mustKeepMissing.join('|') : ''}${row.antiHit.length ? '  ANTI:' + row.antiHit.join(',') : ''}`);
    }
  }

  const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
  const asks = rows.filter((r) => r.surface === 'ask');
  const rws = rows.filter((r) => r.surface === 'rewrite');
  const agg = (xs) => ({
    cases: xs.length,
    wallMsMean: Math.round(xs.reduce((a, r) => a + r.wallMs, 0) / Math.max(1, xs.length)),
    decodeTokens: xs.reduce((a, r) => a + r.decodeTokens, 0),
    promptTokensEst: Math.round(xs.reduce((a, r) => a + r.promptChars, 0) / 4),
    keys: `${xs.reduce((a, r) => a + r.keysHit.length, 0)}/${xs.reduce((a, r) => a + r.keysTotal, 0)}`,
    anti: xs.reduce((a, r) => a + r.antiHit.length, 0),
  });
  const summary = { ask: agg(asks), rewrite: agg(rws) };
  console.log(`\nask:     ${JSON.stringify(summary.ask)}`);
  console.log(`rewrite: ${JSON.stringify(summary.rewrite)}`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ label: LABEL, at: new Date().toISOString(), summary, rows }, null, 2));
  console.log(`\nwrote ${rows.length} rows → ${OUT}`);
  app.exit(0);
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
