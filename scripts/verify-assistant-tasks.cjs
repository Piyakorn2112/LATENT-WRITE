/**
 * verify-assistant-tasks.cjs — the three renderer task engines, against the real model.
 *
 * `verify-assistant-runtime.cjs` proves the RUNTIME works with a generic
 * payload. This proves the TASKS work: the adjudicator's evidence pack and
 * frozen prompt, the entity-review pass, and the timeline chip picker, all
 * driven through registerAssistant() → preload → ipcMain → utilityProcess →
 * node-llama-cpp. One harness, one model load, every task.
 *
 * ★ THE HARNESS NEVER HAND-COPIES THE THING UNDER TEST. Electron cannot import
 *   TypeScript, so every run first shells out to tsx and regenerates
 *   scripts/fixtures/assistant-tasks.json from the REAL modules
 *   (buildEvidencePack, buildAdjudicationRequest, usageSnippets,
 *   buildEntityReviewRequest, buildChipRequest). A prompt edit that breaks the
 *   model shows up here; a prompt edit copied into a harness would not.
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
 *   8. every chip response is schema-valid, and every rank it returns was
 *      OFFERED — the model may pick and relabel, never invent
 *   9. every chip label is non-empty and single line (the label CAP is reported
 *      instead — see the ★ on labelOverruns for why that one is not a gate)
 *  10. the chapter with three unmistakable turns is not answered with silence
 *
 * ★ THE CHIP GATES DO NOT JUDGE PROSE OR CHOICE. Which ranks come back and how
 *   well the labels read is printed verbatim for a human. A gate on taste would
 *   be a gate the prompt could be tuned against, which is worth nothing.
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

/** Shape only. Rank membership and label quality are separate, named gates. */
function validChips(json, schema) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.picks)) return false;
  if (json.picks.length > schema.properties.picks.maxItems) return false;
  return json.picks.every(
    (p) => !!p && typeof p === 'object' && Number.isInteger(p.rank) && typeof p.label === 'string',
  );
}

const picksOf = (json) => (json && Array.isArray(json.picks) ? json.picks : []);
const labelOf = (p) => (typeof p.label === 'string' ? p.label.trim() : '');

/**
 * Label defects the DESIGN has no answer for: a chip with no text, or one
 * carrying a newline the SVG would render as a box. Gated.
 */
const labelBlockers = (json) =>
  picksOf(json).flatMap((p) => {
    const label = labelOf(p);
    if (label === '') return [`rank ${p.rank}: blank label`];
    if (/[\r\n]/.test(label)) return [`rank ${p.rank}: multi-line label`];
    return [];
  });

/**
 * Labels over the module's cap. REPORTED, NOT GATED, and that is a measured
 * decision rather than a soft one.
 *
 * ★ THE 44-CHARACTER RULE IS NOT RELIABLY REACHABLE AT 1.7B. Seven prompt
 *   variants were measured against these two fixtures (character cap alone;
 *   + a 6-word budget; + "a two-word name spends two"; + the limit repeated in
 *   the JSON contract line; a two-word exemplar name; a WHO-does-WHAT shape
 *   rule; a 5-word budget). Naming a WORD budget cut overruns from 3-of-6 to
 *   1-of-4 and is why the prompt carries one — but ONE label came back
 *   byte-identical and one character over in ALL SEVEN, including the two
 *   variants that fixed everything else. It is a lexical attractor for that
 *   sentence, not a wording problem, and gating on it would mean either a
 *   permanently red harness or a threshold fitted to one model.
 *
 *   What the product actually promises is covered by the gates above and by
 *   `normalizeChipPicks`: an over-long label costs the model's PROSE and keeps
 *   its PICK, falling back to the heuristic label printed beside it. So the
 *   overrun is printed with its fallback and counted, and the writer never sees
 *   a chip cut mid-word.
 */
const labelOverruns = (json, labelMax) =>
  picksOf(json).flatMap((p) => {
    const label = labelOf(p);
    return label.length > labelMax ? [`rank ${p.rank}: ${label.length} > ${labelMax} — "${label}"`] : [];
  });

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
    ` · entityReviewPrompt=v${fixtures.entityReviewPromptVersion} · chipPrompt=v${fixtures.chipPromptVersion}` +
    ` · modelId=${fixtures.modelId}`,
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

  // ── timeline chips ────────────────────────────────────────────────────────
  console.log('\n[3] timeline chips — which beats does this chapter show?');
  const chipResponses = [];
  for (const c of fixtures.timelineChips) {
    const res = await callBridge('assistantRun', {
      requestId: `chip-${c.id}`,
      task: 'timeline-chips',
      systemPrompt: c.systemPrompt,
      userText: c.userText,
      schema: c.schema,
      maxTokens: c.maxTokens,
      timeoutMs: 60000,
    });
    const ok = res.ok && validChips(res.json, c.schema);
    chipResponses.push({ kind: 'timeline-chips', id: c.id, ok, json: res.json, error: res.error, raw: res.raw, timings: res.timings, case: c });

    const picks = ok ? res.json.picks : [];
    console.log(`\n  ${c.id}  (ch.${c.chapterNumber} "${c.chapterTitle}", offered ranks [${c.offeredRanks.join(', ')}]` +
      `${c.minPicks === null ? ', ungated on count' : `, expect ≥${c.minPicks} picks`})`);
    if (!ok) console.log(`    response: ${JSON.stringify(res.json ?? res.error)}`);
    if (!res.ok) console.log(`    raw: ${JSON.stringify(res.raw)}`);
    // ★ Verbatim, beside the heuristic label it replaces and the sentence it
    //   must be grounded in. This block is the deliverable a human reads; no
    //   gate below scores it.
    console.log(`    ${picks.length} pick(s)${picks.length === 0 ? '  — the model declined to promote anything' : ''}`);
    // Same reasoning as capNote(): a label sitting exactly on the grammar's cap
    // was cut mid-word, and that defect must not read as a strange model.
    const schemaCap = c.schema.properties.picks.items.properties.label.maxLength;
    for (const p of picks) {
      const cand = c.candidates.find((x) => x.rank === p.rank);
      const len = String(p.label ?? '').length;
      console.log(`      [${p.rank}] "${p.label}"  (${len} chars)` +
        (len >= schemaCap ? `  ⚠ hit the ${schemaCap}-char grammar cap and was cut mid-word` : ''));
      console.log(`           heuristic: "${cand ? cand.label : 'RANK NOT OFFERED'}"`);
      if (cand) console.log(`           source:    ${cand.sentence}`);
    }
    console.log(`    ${timingLine(res.timings)}`);
  }

  // ── gates ─────────────────────────────────────────────────────────────────
  console.log('\n[4] gates');
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

  // ── chip gates. Membership and mechanics only; see the header note. ───────
  const badChips = chipResponses.filter((r) => !r.ok);
  gate(`all ${chipResponses.length} chip responses are schema-valid`, badChips.length === 0,
    badChips.map((r) => `${r.id}: ${r.error ?? JSON.stringify(r.json)}`).join(' | '));

  const invented = chipResponses.flatMap((r) =>
    (r.ok ? r.json.picks : []).filter((p) => !r.case.offeredRanks.includes(p.rank))
      .map((p) => `${r.id}: rank ${p.rank} was never offered`));
  gate('every returned rank was offered (the model picks, never invents)', invented.length === 0,
    invented.join(' | '));

  const blockers = chipResponses.flatMap((r) =>
    labelBlockers(r.ok ? r.json : null).map((d) => `${r.id}/${d}`));
  gate('every label is non-empty and single-line', blockers.length === 0, blockers.join(' | '));

  // Reported, never gated — see the ★ on labelOverruns for the measurement.
  const overruns = chipResponses.flatMap((r) =>
    labelOverruns(r.ok ? r.json : null, r.case.labelMax).map((d) => `${r.id}/${d}`));
  const labelCount = chipResponses.reduce((a, r) => a + picksOf(r.ok ? r.json : null).length, 0);
  console.log(`    label overruns (reported, not gated): ${overruns.length}/${labelCount} over ` +
    `${fixtures.timelineChips[0].labelMax} chars — each keeps its pick and falls back to the heuristic label`);
  for (const o of overruns) console.log(`      · ${o}`);

  for (const r of chipResponses) {
    if (r.case.minPicks === null) {
      console.log(`    (${r.id} is ungated on count: ${r.ok ? r.json.picks.length : 'no answer'} pick(s))`);
      continue;
    }
    const picks = r.ok ? r.json.picks : [];
    gate(`${r.id}: a chapter that turns is not answered with silence (≥${r.case.minPicks})`,
      picks.length >= r.case.minPicks && picks.every((p) => r.case.offeredRanks.includes(p.rank)),
      `got ${picks.length} pick(s): [${picks.map((p) => p.rank).join(', ')}]`);
  }

  // ── chapter summaries ───────────────────────────────────────────────────
  // Prose quality is not gateable and is not gated. What IS gated: the summary
  // is grounded in the moments it was given (it names someone who is actually
  // in the chapter), it is one paragraph, and it is not a blurb. Every summary
  // prints verbatim so a person can judge the writing.
  console.log('\n[4] chapter summaries');
  const summaryResponses = [];
  for (const c of fixtures.chapterSummaries || []) {
    const res = await callBridge('assistantRun', {
      requestId: `sum-${c.id}`,
      task: 'chapter-summary',
      systemPrompt: c.systemPrompt,
      userText: c.userText,
      schema: c.schema,
      maxTokens: c.maxTokens,
      timeoutMs: 90_000,
    });
    const ok = res && res.ok && res.json && typeof res.json.summary === 'string';
    summaryResponses.push({ id: c.id, case: c, ok, json: ok ? res.json : null, timings: res && res.timings });
    console.log(`\n  ${c.id}  (ch.${c.chapterNumber} "${c.chapterTitle}")`);
    console.log(`    summary: ${ok ? JSON.stringify(res.json.summary) : `NO ANSWER (${res && res.error})`}`);
    if (ok && res.json.throughline) console.log(`    through: ${JSON.stringify(res.json.throughline)}`);
    if (res && res.timings) {
      console.log(`    prefill ${res.timings.prefillMs}ms · gen ${res.timings.genMs}ms · ` +
        `${res.timings.tokens} tok · ${res.timings.tokensPerSec} tok/s`);
    }
  }

  gate('every summary is schema-valid and non-empty',
    summaryResponses.length > 0 && summaryResponses.every((r) => r.ok && r.json.summary.trim().length >= 12),
    `${summaryResponses.filter((r) => r.ok).length}/${summaryResponses.length}`);

  gate('summaries are one paragraph, within the cap',
    summaryResponses.every((r) => !r.ok || (!r.json.summary.includes('\n') && r.json.summary.length <= r.case.summaryMax)),
    `cap ${fixtures.chapterSummaries?.[0]?.summaryMax}`);

  // Grounding: the model was given the cast, so a summary that names nobody
  // from it is describing a chapter it was not shown.
  const ungrounded = summaryResponses.filter((r) =>
    r.ok && !r.case.cast.some((name) => r.json.summary.includes(name.split(' ')[0])));
  gate('every summary names someone who is actually in the chapter',
    ungrounded.length === 0,
    ungrounded.length ? `ungrounded: ${ungrounded.map((r) => r.id).join(', ')}` : 'all grounded in the cast');

  gate('no summary opens with the blurb reflex',
    summaryResponses.every((r) => !r.ok || !/^in this chapter/i.test(r.json.summary)),
    'no "In this chapter"');

  // ★ NO CHIP MAY SHIP A PRONOUN. A chip is read with no sentence beside it, so
  //   "He admits the fault" names nobody. The pronoun fixture's every sentence
  //   leads with "He"/"She" and carries a resolved agent, which is the exact
  //   shape that put pronouns into shipped chips.
  const LEADING_PRONOUN = /^(he|she|they|it|his|her|their|its|him|them)\b/i;
  const pronounChips = chipResponses.flatMap((r) =>
    (r.ok ? r.json.picks : []).filter((p) => LEADING_PRONOUN.test(String(p.label).trim()))
      .map((p) => `${r.id}[${p.rank}] "${p.label}"`));
  gate('no chip leads with a pronoun', pronounChips.length === 0,
    pronounChips.length ? pronounChips.join(' · ') : 'every chip names its actor');

  // ── KV prefix reuse must not leak between requests ──────────────────────
  // ★★ THE PRICE OF THE 8x PREFILL WIN. The host no longer clears the context
  //    sequence between requests, so the KV cache carries the previous
  //    request's tokens and node-llama-cpp reuses the shared prefix. That is
  //    lossless ONLY if a differing prompt evicts the divergent tail. Run A,
  //    run a DIFFERENT task, then run A again: if anything from B survived
  //    into A's context, A's second answer differs from its first.
  {
    const a = fixtures.entityReview[0];
    const b = fixtures.chapterSummaries[0];
    const askA = (n) => callBridge('assistantRun', {
      requestId: `contam-a${n}`, task: 'entity-review',
      systemPrompt: a.systemPrompt, userText: a.userText,
      schema: a.schema, maxTokens: a.maxTokens, timeoutMs: 90_000,
    });
    const first = await askA(1);
    await callBridge('assistantRun', {
      requestId: 'contam-b', task: 'chapter-summary',
      systemPrompt: b.systemPrompt, userText: b.userText,
      schema: b.schema, maxTokens: b.maxTokens, timeoutMs: 90_000,
    });
    const second = await askA(2);
    const same = first && second && first.ok && second.ok &&
      JSON.stringify(first.json) === JSON.stringify(second.json);
    gate('a cached prefix does not leak between different prompts',
      !!same,
      same
        ? 'same answer before and after an unrelated task'
        : `A₁ ${JSON.stringify(first && first.json)} vs A₂ ${JSON.stringify(second && second.json)}`);
  }

  const timed = [...responses, ...chipResponses, ...summaryResponses].filter((r) => r.timings);
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
