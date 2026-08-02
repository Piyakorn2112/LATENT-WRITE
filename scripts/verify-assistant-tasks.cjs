/**
 * verify-assistant-tasks.cjs — the two renderer task engines, against the real model.
 *
 * `verify-assistant-runtime.cjs` proves the RUNTIME works with a generic
 * payload. This proves the two TASKS work: the adjudicator's evidence pack and
 * frozen prompt, and the entity-review pass, both driven through
 * registerAssistant() → preload → ipcMain → utilityProcess → node-llama-cpp.
 *
 * ★ THE HARNESS NEVER HAND-COPIES THE THING UNDER TEST. Electron cannot import
 *   TypeScript, so every run first shells out to tsx and regenerates
 *   scripts/fixtures/assistant-tasks.json from the REAL modules
 *   (buildEvidencePack, buildAdjudicationRequest, usageSnippets,
 *   buildEntityReviewRequest). A prompt edit that breaks the model shows up
 *   here; a prompt edit copied into a harness would not.
 *
 * ★ EVERY NAME IN THE FIXTURES IS FABRICATED, so a pass measures reading of the
 *   evidence rather than recall of the world.
 *
 * Gates:
 *   1. every response is schema-valid and in range
 *   2. the clear-break case answers break
 *   3. the clearly-plausible case answers anything BUT break
 *   4. the canary case — same pack plus an author-asserted prior ruling —
 *      answers anything BUT break
 *   5. place usage → place, person usage → character, non-name → not-a-name
 *   6. every reason is non-empty (deliberately NOT guaranteed by the grammar —
 *      the schemas carry no minLength, so this stays a measured behaviour)
 *   7. the adjudication verdicts are not all the same label
 *
 * ★ GATE 7 IS WHY GATES 3 AND 4 MEAN ANYTHING. A model that answers
 *   "plausible_offscreen" to every pack passes both "must NOT be break" gates
 *   without judging anything — the same blindness as a benchmark that reports
 *   one number for every config. Discrimination is the gate; agreement with a
 *   single expected label is not.
 *
 * ★ THE BREAK LABEL IS NOT SPELLED HERE. The gate compares against the wire
 *   label the fixtures carry, which comes from `wireVerdictFor("break")` in
 *   adjudicator.ts. See the ★★ note there: the enum VALUE is prompt surface,
 *   and this harness is what measured that.
 *
 * Run: ./node_modules/.bin/electron scripts/verify-assistant-tasks.cjs
 *      ASSISTANT_MODEL_PATH=/path/to/model.gguf ./node_modules/.bin/electron scripts/verify-assistant-tasks.cjs
 *
 * Exit 0 = pass (or SKIP when no model is on disk), 1 = fail.
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

// Match the shipping app so userData — and therefore the models dir — resolves
// where the real app put the weights.
app.setName('Latent Write');

const ROOT = path.join(__dirname, '..');
// ★ Explicit interpreter path: a bad nvm shell hook makes bare `node`/`npx`
//   unusable in this environment, and a harness must not depend on the shell.
const NODE = '/opt/homebrew/bin/node';
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const EMITTER = path.join(ROOT, 'scripts', 'emit-assistant-task-fixtures.ts');
const FIXTURES = path.join(ROOT, 'scripts', 'fixtures', 'assistant-tasks.json');

const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

const results = [];
function gate(label, cond, detail) {
  results.push({ label, cond: !!cond });
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : `  — ${detail ?? ''}`}`);
}

// ★ Enum values and length caps are read from the EMITTED schema, never spelled
//   out here — the harness must not carry its own copy of the contract.
const enumOf = (schema, prop) => schema.properties[prop].enum;
const maxLenOf = (schema, prop) => schema.properties[prop].maxLength;

function validVerdict(json, schema) {
  return (
    !!json && typeof json === 'object' &&
    enumOf(schema, 'verdict').includes(json.verdict) &&
    typeof json.confidence === 'number' && Number.isFinite(json.confidence) &&
    json.confidence >= 0 && json.confidence <= 1 &&
    typeof json.reason === 'string' && json.reason.length <= maxLenOf(schema, 'reason') &&
    (json.citedChapter === null || Number.isInteger(json.citedChapter))
  );
}

function validEntity(json, schema) {
  return (
    !!json && typeof json === 'object' &&
    enumOf(schema, 'type').includes(json.type) &&
    typeof json.confidence === 'number' && Number.isFinite(json.confidence) &&
    json.confidence >= 0 && json.confidence <= 1 &&
    typeof json.reason === 'string' && json.reason.length <= maxLenOf(schema, 'reason')
  );
}

/**
 * The harness reports what the MODEL emitted, never what the module cleaned up.
 * A reason sitting exactly on the grammar's maxLength was guillotined mid-word
 * (and Qwen3 tends to code-switch in those last tokens); `tidyTruncatedText` in
 * assistant-client.ts repairs it for display. Flagged here so the raw defect
 * stays visible in the run log instead of being hidden by the repair.
 */
function capNote(json, schema) {
  if (!json || typeof json.reason !== 'string') return '';
  const max = maxLenOf(schema, 'reason');
  if (json.reason.length < max) return '';
  return `\n    ⚠ reason hit the ${max}-char grammar cap and was cut mid-word (the module tidies this for display)`;
}

const timingLine = (t) =>
  t
    ? `prefill ${t.prefillMs}ms · gen ${t.genMs}ms · total ${t.totalMs}ms · ${t.tokens} tok · ${t.tokensPerSec} tok/s`
    : 'no timings';

let win = null;
async function callBridge(method, arg) {
  const payload = JSON.stringify(arg === undefined ? null : arg);
  return win.webContents.executeJavaScript(
    `window.electronAPI.${method}(${payload === 'null' ? '' : payload})`,
    true,
  );
}

async function main() {
  console.log('\n── assistant task engines (adjudicator + entity review) ───────');
  console.log(`electron ${process.versions.electron} · node ${process.versions.node} · ${process.platform}/${process.arch}`);

  assistant.registerAssistant();

  win = new BrowserWindow({
    show: false,
    width: 480,
    height: 320,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
    },
  });
  await win.loadURL('about:blank');

  const hasBridge = await win.webContents.executeJavaScript(
    'typeof window.electronAPI?.assistantRun === "function"', true,
  );
  if (!hasBridge) {
    gate('preload exposes the assistant bridge', false, 'window.electronAPI.assistantRun missing');
    return finish();
  }

  const status = await callBridge('assistantStatus');
  console.log(`model         : ${status.model.label}  (${status.model.id})`);
  console.log(`model path    : ${status.model.path}  present=${status.model.present}`);
  if (!status.model.present) {
    console.log('\nSKIP — no model on disk. This harness never downloads one:');
    console.log('  npm run verify:assistant-runtime      (fetches it), or');
    console.log('  ASSISTANT_MODEL_PATH=/path/to/model.gguf ./node_modules/.bin/electron scripts/verify-assistant-tasks.cjs');
    app.exit(0);
    return;
  }

  // ── regenerate the fixtures from the real modules ─────────────────────────
  console.log('\n[0] regenerating fixtures from the TypeScript modules');
  try {
    const out = execFileSync(NODE, [TSX, EMITTER], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, ASSISTANT_MODEL_ID: status.model.id },
    });
    for (const line of out.trim().split('\n')) console.log(`    ${line}`);
  } catch (err) {
    gate('fixtures regenerate from the real modules', false, String((err && err.message) || err));
    if (err && err.stdout) console.log(String(err.stdout));
    if (err && err.stderr) console.log(String(err.stderr));
    return finish();
  }
  gate('fixtures regenerate from the real modules', fs.existsSync(FIXTURES), FIXTURES);

  const fixtures = JSON.parse(fs.readFileSync(FIXTURES, 'utf8'));
  console.log(
    `    packVersion=${fixtures.packVersion} · adjudicatorPrompt=v${fixtures.adjudicatorPromptVersion}` +
    ` · entityReviewPrompt=v${fixtures.entityReviewPromptVersion} · modelId=${fixtures.modelId}`,
  );
  gate('fixture modelId is the live model id', fixtures.modelId === status.model.id,
    `${fixtures.modelId} != ${status.model.id}`);

  const responses = [];

  // ── the adjudicator ───────────────────────────────────────────────────────
  console.log('\n[1] adjudication — could SPEAKER know about ENTITY?');
  const verdicts = {};
  for (const c of fixtures.adjudication) {
    const res = await callBridge('assistantRun', {
      requestId: `adj-${c.id}`,
      task: 'continuity-adjudication',
      systemPrompt: c.systemPrompt,
      userText: c.userText,
      schema: c.schema,
      maxTokens: c.maxTokens,
      timeoutMs: 60000,
    });
    const ok = res.ok && validVerdict(res.json, c.schema);
    verdicts[c.id] = ok ? res.json : null;
    responses.push({ kind: 'adjudication', id: c.id, ok, json: res.json, error: res.error, raw: res.raw, timings: res.timings });

    console.log(`\n  ${c.id}  (${c.speaker} → ${c.entity}, ch ${c.chapterNumber}, expect ${c.expect})`);
    console.log(`    pack ${c.tokensEstimate} tok · rungs [${c.rungsIncluded.join(', ')}] · packHash ${c.packHash} · verdictKey ${c.verdictKey}`);
    console.log(`    response: ${JSON.stringify(res.json ?? res.error)}${capNote(res.json, c.schema)}`);
    if (!res.ok) console.log(`    raw: ${JSON.stringify(res.raw)}`);
    console.log(`    ${timingLine(res.timings)}`);
  }

  // ── entity review ─────────────────────────────────────────────────────────
  console.log('\n[2] entity review — how is this NAME used?');
  const proposals = {};
  for (const c of fixtures.entityReview) {
    const res = await callBridge('assistantRun', {
      requestId: `ent-${c.id}`,
      task: 'entity-review',
      systemPrompt: c.systemPrompt,
      userText: c.userText,
      schema: c.schema,
      maxTokens: c.maxTokens,
      timeoutMs: 60000,
    });
    const ok = res.ok && validEntity(res.json, c.schema);
    proposals[c.id] = ok ? res.json : null;
    responses.push({ kind: 'entity-review', id: c.id, ok, json: res.json, error: res.error, raw: res.raw, timings: res.timings });

    console.log(`\n  ${c.id}  ("${c.name}", scan said ${c.currentType}, expect ${c.expect})`);
    console.log(`    response: ${JSON.stringify(res.json ?? res.error)}${capNote(res.json, c.schema)}`);
    if (!res.ok) console.log(`    raw: ${JSON.stringify(res.raw)}`);
    console.log(`    ${timingLine(res.timings)}`);
  }

  // ── gates ─────────────────────────────────────────────────────────────────
  console.log('\n[3] gates');
  const invalid = responses.filter((r) => !r.ok);
  gate(`all ${responses.length} responses are schema-valid and in range`, invalid.length === 0,
    invalid.map((r) => `${r.kind}/${r.id}: ${r.error ?? JSON.stringify(r.json)}`).join(' | '));

  for (const c of fixtures.adjudication) {
    const got = verdicts[c.id] ? verdicts[c.id].verdict : null;
    if (c.expectVerdict) {
      gate(`${c.id}: clear break → "${c.expectVerdict}"`, got === c.expectVerdict, `got ${got}`);
    } else if (c.expectNotVerdict) {
      gate(`${c.id}: must NOT be "${c.expectNotVerdict}"`, got !== null && got !== c.expectNotVerdict, `got ${got}`);
    } else {
      console.log(`    (${c.id} is ungated: ${got})`);
    }
  }

  // The discrimination canary — see the header note on why the "must NOT be"
  // gates are worthless without it.
  const labels = fixtures.adjudication.map((c) => (verdicts[c.id] ? verdicts[c.id].verdict : 'none'));
  gate('the model discriminates (not one label for every pack)',
    new Set(labels).size > 1, `every pack answered "${labels[0]}"`);

  gate('place usage → "place"', proposals.place && proposals.place.type === 'place',
    `got ${proposals.place ? proposals.place.type : 'nothing'}`);
  gate('person usage → "character"', proposals.person && proposals.person.type === 'character',
    `got ${proposals.person ? proposals.person.type : 'nothing'}`);
  gate('non-name → "not-a-name"', proposals['not-a-name'] && proposals['not-a-name'].type === 'not-a-name',
    `got ${proposals['not-a-name'] ? proposals['not-a-name'].type : 'nothing'}`);

  const blank = responses.filter((r) => !r.json || typeof r.json.reason !== 'string' || r.json.reason.trim() === '');
  gate('every response carries a non-empty reason', blank.length === 0,
    blank.map((r) => `${r.kind}/${r.id}`).join(', '));

  const timed = responses.filter((r) => r.timings);
  const totalTok = timed.reduce((a, r) => a + r.timings.tokens, 0);
  const totalGen = timed.reduce((a, r) => a + r.timings.genMs, 0);
  console.log(
    `\n    aggregate: ${totalTok} tokens in ${totalGen}ms generation → ` +
    `${totalGen > 0 ? (totalTok / (totalGen / 1000)).toFixed(1) : '0'} tok/s`,
  );

  await callBridge('assistantUnload');
  finish();
}

function finish() {
  const failed = results.filter((r) => !r.cond).length;
  console.log(`\n${failed ? `FAILED ${failed}/${results.length}` : `PASS ${results.length}/${results.length}`}`);
  app.exit(failed ? 1 : 0);
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('\nharness error:', (err && err.stack) || err);
    app.exit(1);
  }),
);
