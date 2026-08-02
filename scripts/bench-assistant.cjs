/**
 * bench-assistant.cjs — measure-first harness for assistant runtime work.
 *
 * Every optimisation claim in this area has to beat a number, and the number
 * has to separate the two halves of a request, because they respond to
 * completely different levers:
 *
 *   PREFILL  reading the prompt. Our system prompts are 400-900 tokens and
 *            byte-identical across every request of a task type, so this is
 *            the half that should be cacheable.
 *   GEN      writing 30-100 tokens. Bounded by memory bandwidth; the only
 *            honest way to cut it is to write fewer tokens.
 *
 * Runs each fixture task N times and reports medians (not means: a cold first
 * run would drag a mean and hide the steady state). Prints tokens/sec for both
 * halves so a change that trades one against the other cannot look like a win.
 *
 *   ./node_modules/.bin/electron scripts/bench-assistant.cjs [--runs 5]
 */
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const NODE = '/opt/homebrew/bin/node';
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const FIXTURES = path.join(ROOT, 'scripts', 'fixtures', 'assistant-tasks.json');
const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const RUNS = arg('--runs', 5);

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function main() {
  execFileSync(NODE, [TSX, path.join(ROOT, 'scripts', 'emit-assistant-task-fixtures.ts')], {
    cwd: ROOT, stdio: 'pipe',
    env: { ...process.env, ASSISTANT_MODEL_ID: assistant.assistantStatus().model.id },
  });
  const f = JSON.parse(fs.readFileSync(FIXTURES, 'utf8'));

  // One request per task TYPE — the point is the shared system prompt per type.
  const cases = [
    { task: 'continuity-adjudication', c: f.adjudication[0] },
    { task: 'entity-review', c: f.entityReview[0] },
    { task: 'timeline-chips', c: f.timelineChips[0] },
    { task: 'chapter-summary', c: f.chapterSummaries[0] },
  ].filter((x) => x.c);

  const t0 = Date.now();
  await assistant.ensureLoaded();
  console.log(`\nmodel load: ${Date.now() - t0}ms\n`);
  console.log(`${'task'.padEnd(26)} ${'sysTok'.padStart(7)} ${'prefill'.padStart(9)} ${'gen'.padStart(8)} ${'tok'.padStart(5)} ${'gen tok/s'.padStart(10)} ${'total'.padStart(8)}`);

  const totals = { prefill: [], gen: [], total: [] };
  for (const { task, c } of cases) {
    const prefill = [];
    const gen = [];
    const total = [];
    let tokens = 0;
    for (let i = 0; i < RUNS; i++) {
      const res = await assistant.run({
        requestId: `bench-${task}-${i}`, task,
        systemPrompt: c.systemPrompt, userText: c.userText,
        schema: c.schema, maxTokens: c.maxTokens, timeoutMs: 120_000,
      });
      if (!res || !res.ok || !res.timings) { console.log(`  ${task}: FAILED ${res && res.error}`); break; }
      prefill.push(res.timings.prefillMs);
      gen.push(res.timings.genMs);
      total.push(res.timings.totalMs);
      tokens = res.timings.tokens;
    }
    if (!prefill.length) continue;
    // A rough system-prompt size in tokens, for reading the prefill column.
    const sysTok = Math.round(c.systemPrompt.length / 4);
    // ★ COLD vs WARM. Run 1 of a task type prefills its system prompt for real;
    //   runs 2+ reuse the cached prefix. A median hides the difference, and the
    //   two respond to different levers (batchSize helps only the cold one).
    const mg = median(gen);
    console.log(
      `${task.padEnd(26)} ${String(sysTok).padStart(7)} ${`${prefill[0]}/${median(prefill.slice(1))}ms`.padStart(12)} ` +
      `${`${mg}ms`.padStart(8)} ${String(tokens).padStart(5)} ` +
      `${(mg > 0 ? (tokens / (mg / 1000)).toFixed(1) : '0').padStart(10)} ${`${median(total)}ms`.padStart(8)}`,
    );
    totals.prefill.push(...prefill);
    totals.gen.push(...gen);
    totals.total.push(...total);
  }

  const mp = median(totals.prefill);
  const mgen = median(totals.gen);
  console.log(
    `\nmedian over ${totals.total.length} runs — prefill ${mp}ms · gen ${mgen}ms · ` +
    `total ${median(totals.total)}ms · prefill is ${((mp / (mp + mgen)) * 100).toFixed(0)}% of the work`,
  );

  await assistant.unload();
  app.exit(0);
}

app.whenReady().then(() => main().catch((e) => { console.error(e); app.exit(1); }));
