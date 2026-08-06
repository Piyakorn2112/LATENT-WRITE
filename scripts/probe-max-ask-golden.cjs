/**
 * probe-max-ask-golden.cjs — the golden set through the FULL shipped chain.
 *
 * ask → prose-abstention coercion → claim-check → (refine on flag/low-conf →
 * re-check) — the same stages runMaxAsk runs, each artifact built by the REAL
 * module via tsx. The control flow is mirrored here because the loop lives in
 * the renderer and the model behind an IPC bridge; every prompt, schema,
 * coercion and verdict is module code, so what can drift is the plumbing this
 * probe exists to exercise anyway.
 *
 * ★ THIS PROBE DOES NOT GRADE. Human verdicts under each case; the probe
 *   records the chain (refined? caution? fits?) and the mechanical layer.
 *
 * Run: ./node_modules/.bin/electron scripts/probe-max-ask-golden.cjs
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

/** One generic module-side helper: every stage's artifacts come from src/lib. */
function mod(op, payload) {
  return JSON.parse(execFileSync(NODE, [TSX, '-e', `
    import {GOLDEN_CASES} from "./scripts/fixtures/max-ask-golden";
    import {buildMaxAskPack, buildMaxAskRequest, normalizeMaxAsk, coerceProseAbstention,
      isUsefulAnswer, buildReviewRequest, normalizeClaimCheck, computeReviewVerdict,
      buildRefineRequest, REFINE_CONF_FLOOR} from "./src/lib/max-ask";
    const a = JSON.parse(process.argv[process.argv.length-1]);
    let out;
    if (a.op === "build") {
      out = GOLDEN_CASES.map((c) => {
        const pack = buildMaxAskPack(c.input);
        const req = buildMaxAskRequest(pack, undefined, c.input.kind);
        return { id: c.id, kind: c.input.kind, question: c.input.question ?? null,
          expectDirection: c.expectDirection, mustTouch: c.mustTouch,
          mustNotClaim: c.mustNotClaim, expectedSource: c.expectedSource,
          rungs: pack.rungsIncluded, tokens: pack.tokensEstimate,
          packText: pack.text, req };
      });
    } else if (a.op === "answer") {
      const raw = normalizeMaxAsk(a.json, a.rungs);
      const ans = raw ? coerceProseAbstention(raw, a.kind) : null;
      out = { ans, useful: isUsefulAnswer(ans) };
    } else if (a.op === "review-req") {
      out = buildReviewRequest({ text: a.packText, rungsIncluded: a.rungs,
        rungsDropped: [], tokensEstimate: 0, tokensIfComplete: 0, packHash: "x" }, a.ans);
    } else if (a.op === "verdict") {
      const claims = normalizeClaimCheck(a.json);
      out = claims ? computeReviewVerdict(claims, a.packText) : null;
    } else if (a.op === "refine-req") {
      out = buildRefineRequest({ text: a.packText, rungsIncluded: a.rungs,
        rungsDropped: [], tokensEstimate: 0, tokensIfComplete: 0, packHash: "x" },
        a.ans, a.flag, a.kind);
    } else if (a.op === "floor") {
      out = REFINE_CONF_FLOOR;
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
const runModel = (id, req) => callBridge('assistantRun', {
  requestId: id, task: 'max-ask', tier: 'max', contextSize: 8192, noThink: false,
  systemPrompt: req.systemPrompt, userText: req.userText,
  schema: req.schema, maxTokens: req.maxTokens, timeoutMs: 180000,
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
  const status = await callBridge('assistantStatus', { tier: 'max' });
  if (!status.model.present) { console.log('SKIP — max model not on disk.'); app.exit(0); return; }

  const built = mod('build', {});
  const floor = mod('floor', {});
  console.log(`model: ${status.model.id} · ${built.length} cases · full chain (refine floor ${floor})\n`);

  const lines = [];
  lines.push(`# max-ask golden — ROUND 2, full shipped chain — ${status.model.id}`);
  lines.push(`_ask -> coerce -> claim-check -> (refine -> re-check). Hand-graded below._\n`);

  for (const b of built) {
    const t0 = Date.now();
    const res = await runModel(`g2-${b.id}`, b.req);
    let chain = [];
    let ans = null, review = null, refined = false;
    if (res && res.ok) {
      const n = mod('answer', { json: res.json, rungs: b.rungs, kind: b.kind });
      ans = n.ans;
      if (ans && n.useful) {
        const rr = mod('review-req', { packText: b.packText, rungs: b.rungs, ans });
        const rev = await runModel(`g2r-${b.id}`, rr);
        if (rev && rev.ok) review = mod('verdict', { json: rev.json, packText: b.packText });
        const flag = review && review.verdict === 'overreaches' && review.note
          ? { kind: 'overreach', note: review.note }
          : ans.confidence < floor ? { kind: 'low-confidence' } : null;
        if (flag) {
          chain.push(`flagged:${flag.kind === 'overreach' ? `"${flag.note}"` : 'low-conf'}`);
          const fr = mod('refine-req', { packText: b.packText, rungs: b.rungs, ans, flag, kind: b.kind });
          const ref = await runModel(`g2f-${b.id}`, fr);
          if (ref && ref.ok) {
            const n2 = mod('answer', { json: ref.json, rungs: b.rungs, kind: b.kind });
            if (n2.ans && n2.useful) {
              const rr2 = mod('review-req', { packText: b.packText, rungs: b.rungs, ans: n2.ans });
              const rev2 = await runModel(`g2c-${b.id}`, rr2);
              const v2 = rev2 && rev2.ok ? mod('verdict', { json: rev2.json, packText: b.packText }) : null;
              if (v2 && v2.verdict === 'supported') { ans = n2.ans; review = v2; refined = true; }
            }
          }
        }
      }
    }
    const ms = Date.now() - t0;
    console.log(`  ${b.id.padEnd(26)} ${ans ? (refined ? 'REFINED' : 'answered') : 'FAILED'}${chain.length ? '  [' + chain.join(' ') + ']' : ''}  ${ms}ms`);
    lines.push(`## ${b.id}  (${b.kind}${b.question ? ` — "${b.question}"` : ''})`);
    lines.push(`- expect: ${b.expectDirection}`);
    lines.push(`- mustTouch: ${b.mustTouch.join(' · ')}   mustNotClaim: ${b.mustNotClaim.join(' · ')}`);
    lines.push(`- chain: ${chain.length ? chain.join(' ') : 'clean'} · refined=${refined} · review=${review ? review.verdict : '-'} · basis=${ans ? ans.basis : '-'} · ${ms}ms`);
    lines.push(`- ANSWER: ${ans ? ans.answer : `(failed: ${res && res.error})`}`);
    lines.push(`- VERDICT: _(hand)_`);
    lines.push('');
  }
  const out = path.join(ROOT, 'scripts', 'fixtures', 'max-ask-golden-results-r2.md');
  fs.writeFileSync(out, lines.join('\n'), 'utf8');
  console.log(`\ntranscript -> ${out}`);
  await callBridge('assistantUnload');
  app.exit(0);
}

app.whenReady().then(() => main().catch((e) => { console.error(e); app.exit(1); }));
