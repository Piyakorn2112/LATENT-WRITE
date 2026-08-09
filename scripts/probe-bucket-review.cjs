/**
 * probe-bucket-review.cjs — does the review pass actually fix the buckets the
 * scan could not decide?
 *
 * The deterministic classifier now says "undecided" out loud instead of
 * laundering a coin flip into a label, and `selectReviewable` ranks on exactly
 * that. This is the other half of the claim: it runs the SHIPPED review pass
 * against the REAL model on the real book, applies the proposals through the
 * shipped acceptance bars, and re-scores the result against the same gold the
 * deterministic harness uses.
 *
 * ★ EVERYTHING SHIPPED, NOTHING COPIED. The scan, `selectReviewable`, the
 *   snippets, the prompt, `reviewEntities` itself and
 *   `applyProposalsToScanResult` are the modules' own, reached through tsx.
 *   Only the transport is replayed: the model answers are collected here and
 *   handed back to the real `reviewEntities` through its `run` hook, so the
 *   selection, normalisation and overturn bars all execute for real.
 *
 * ★ BOTH TIERS, BECAUSE THE APP SHIPS ONE. `assistantRunJSON` is called
 *   without a tier in WorldDataView, so the review runs on the DEFAULT (1.7B)
 *   whether the user is on "on" or "max". Whether the 4B would do better is a
 *   product question that needs a number, not an assumption.
 *
 * Run: ./node_modules/.bin/electron scripts/probe-bucket-review.cjs
 *      TIERS=small,max ./node_modules/.bin/electron scripts/probe-bucket-review.cjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

app.setName('Latent Write');

const ROOT = path.join(__dirname, '..');
const NODE = '/opt/homebrew/bin/node';
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SCRATCH = path.join(ROOT, '.probe-bucket-review');
const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

const TIERS = (process.env.TIERS || 'small,max').split(',');

let win = null;
const callBridge = (method, arg) => {
  const payload = JSON.stringify(arg === undefined ? null : arg);
  return win.webContents.executeJavaScript(
    `window.electronAPI.${method}(${payload === 'null' ? '' : payload})`, true,
  );
};

const runTsx = (script, args = []) => JSON.parse(
  execFileSync(NODE, [TSX, path.join(ROOT, 'scripts', script), ...args],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).trim().split('\n').pop(),
);

async function main() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  assistant.registerAssistant();
  win = new BrowserWindow({
    show: false, width: 480, height: 320,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
    },
  });
  await win.loadURL('about:blank');

  console.log('\nscanning The Root Crown through the shipped classifier…');
  const prep = runTsx('probe-bucket-review-prep.ts');
  console.log(`${prep.asks.length} names selected for review out of ${prep.entries.length}\n`);

  for (const tier of TIERS) {
    const status = await callBridge('assistantStatus', { tier });
    if (!status.model.present) { console.log(`SKIP ${tier} — model not on disk.`); continue; }
    console.log(`${'═'.repeat(74)}\nTIER ${tier} — ${status.model.id}\n${'═'.repeat(74)}`);

    const answers = {};
    for (const ask of prep.asks) {
      const t0 = Date.now();
      const res = await callBridge('assistantRun', {
        requestId: `rev-${tier}-${ask.name}`.replace(/[^a-z0-9-]/gi, '-'),
        task: 'entity-review', tier,
        systemPrompt: ask.systemPrompt, userText: ask.userText,
        schema: ask.schema, maxTokens: ask.maxTokens, timeoutMs: 60000,
      });
      const ms = Date.now() - t0;
      answers[ask.name] = res && res.ok ? res.json : null;
      const a = answers[ask.name];
      console.log(
        `  ${ask.name.padEnd(30)} ${String(ask.currentType).padEnd(10)} -> `
        + `${a ? String(a.type).padEnd(11) : 'NO ANSWER  '} ${a ? Number(a.confidence).toFixed(2) : '    '}`
        + `  ${String(ms).padStart(5)}ms  ${a && a.reason ? a.reason.slice(0, 46) : ''}`,
      );
    }

    const file = path.join(SCRATCH, `answers-${tier}.json`);
    fs.writeFileSync(file, JSON.stringify(answers));
    console.log('');
    const scored = runTsx('probe-bucket-review-score.ts', [file]);
    for (const line of scored.lines) console.log(line);
    console.log('');
  }

  win.destroy();
  app.quit();
}

app.whenReady().then(main).catch((err) => { console.error(err); app.exit(1); });
