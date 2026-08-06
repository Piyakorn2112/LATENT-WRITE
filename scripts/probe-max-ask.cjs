/**
 * probe-max-ask.cjs — the max harness against the REAL 4B thinking model.
 *
 * scripts/test-max-ask.ts proves the LOOP cannot spin, using hostile fakes.
 * This asks the other question: is the model, fed a pack the harness built,
 * actually WORTH the download? Four shapes:
 *
 *   explain     rich pack, open question        → grounded, specific, cited
 *   flag        paragraph contradicts the       → the contradiction found,
 *               story-so-far rung                 basis names that rung
 *   control     same ask, consistent paragraph  → NO invented problem
 *   widen       answer lives in a rung the      → step 1 abstains, step 2
 *               tiny budget dropped               (widened) answers
 *
 * ★★ THE CONTROL IS THE CASE THAT DECIDES. A "check" surface that reports a
 *    problem on clean prose trains the writer to ignore it — same failure
 *    class as a linter that always warns. An invented problem on the control
 *    is disqualifying regardless of how good `flag` looks.
 *
 * ★ Prompt, schema, budgets all come from the MODULE via tsx — a probe that
 *   hand-rolls the prompt measures the probe. Raw answers are then routed
 *   back through the module's own validator.
 *
 * Run: ./node_modules/.bin/electron scripts/probe-max-ask.cjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

app.setName('Latent Write');

const ROOT = path.join(__dirname, '..');
const NODE = '/opt/homebrew/bin/node';
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

// ── the world: the alias-scan stress chapter's cast and threads ────────────
const WORLD = {
  characters: [
    { name: 'Elena', aliases: ['Ash Marshal'], role: 'Protagonist',
      description: 'Clears the road. Wanted in three parishes.' },
    { name: 'Kestrel', aliases: ['Kes'], role: '',
      description: 'Runs ahead. Does not explain herself.' },
    { name: 'Vale', aliases: ['Corin Vale', 'Captain Vale'], role: '',
      description: 'Signs nothing he has not read twice.' },
  ],
  places: [], factions: [], entities: [],
};
const SUMMARIES = [
  { chapterNumber: 7, summary: 'The muster list at Fen Cross is wrong and nobody will say who wrote it.' },
  { chapterNumber: 8, summary: 'Elena refuses the short way past the burn and will not say why.' },
];
const THREADS = [
  { chapterNumber: 6, text: 'A notice at the post office names Elena Vasquez, known as the Ash Marshal, and offers forty marks to anyone who can say where she sleeps.' },
];
const RELATED = [
  { chapterNumber: 2, text: 'Elena had not been called the Ash Marshal to her face in nine years, and the last man who tried it lost the use of the road for a season.' },
];

const PARA_CLEAN =
  'The fire had been out since midnight, but the smell of it stayed in the walls. ' +
  'Elena Vasquez sat with her back to the cold stove and counted what was left in the tin, ' +
  'and then counted it again because the first answer had not improved anything.';

const PARA_CONTRA =
  'Elena took the short way past the burn, whistling, and was at Fen Cross before the ' +
  'others had finished their tea. She liked the burn road; she always had.';

const baseInput = (paragraph, kind, question) => ({
  paragraph, paragraphIndex: 4, chapterNumber: 9, chapterTitle: 'The Ash Road',
  kind, question,
  chapterParagraphs: ['', '', '', 'Kestrel came in from the yard with ash on both sleeves.', paragraph,
    '"You are going to get us both killed, Kes," Elena said, without looking up.'],
  present: ['Elena', 'Kestrel'],
  worldData: WORLD,
  chapterSummaries: SUMMARIES,
  openThreads: THREADS,
  related: RELATED,
});

const CASES = [
  { id: 'explain', budget: undefined, expect: 'a grounded answer',
    input: baseInput(PARA_CLEAN, 'explain') },
  { id: 'flag', budget: undefined, expect: 'the short-way contradiction, basis story-so-far',
    input: baseInput(PARA_CONTRA, 'check') },
  { id: 'control', budget: undefined, expect: 'NO invented problem',
    input: baseInput(PARA_CLEAN, 'check') },
  { id: 'widen-step1', budget: 130, expect: 'abstains — the notice lives in a dropped rung',
    input: baseInput(PARA_CLEAN, 'question', 'How much is the reward on the notice about Elena, and what name does the notice use for her?') },
  // step 2 = the same input at the widened budget the loop would choose.
  { id: 'widen-step2', budget: 3200, expect: 'forty marks / Ash Marshal, basis open-threads',
    input: baseInput(PARA_CLEAN, 'question', 'How much is the reward on the notice about Elena, and what name does the notice use for her?') },
];

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
  console.log(`model: ${status.model.id}\n`);

  // ★ The REAL builders, never a copy.
  const built = JSON.parse(execFileSync(NODE, [TSX, '-e',
    'import {buildMaxAskPack, buildMaxAskRequest} from "./src/lib/max-ask";' +
    'const cs = JSON.parse(process.argv[process.argv.length-1]);' +
    'console.log(JSON.stringify(cs.map((c)=>{' +
    '  const pack = buildMaxAskPack(c.input, c.budget);' +
    '  const req = buildMaxAskRequest(pack, undefined, c.input.kind);' +
    '  return { rungs: pack.rungsIncluded, dropped: pack.rungsDropped,' +
    '           tokens: pack.tokensEstimate, req };' +
    '})))',
    JSON.stringify(CASES),
  ], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop());

  const rows = [];
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i], b = built[i];
    const t0 = Date.now();
    const res = await callBridge('assistantRun', {
      requestId: `maxask-${c.id}`, task: 'max-ask', tier: 'max', contextSize: 4096,
      // ★ A THINKING model: /no_think must NOT be appended.
      noThink: false,
      systemPrompt: b.req.systemPrompt, userText: b.req.userText,
      schema: b.req.schema, maxTokens: b.req.maxTokens, timeoutMs: 180000,
    });
    rows.push({ c, b, ms: Date.now() - t0, j: res && res.ok ? res.json : null, err: res && res.error });
  }

  // Route through the shipped validator.
  const shipped = JSON.parse(execFileSync(NODE, [TSX, '-e',
    'import {normalizeMaxAsk, isUsefulAnswer} from "./src/lib/max-ask";' +
    'const rows = JSON.parse(process.argv[process.argv.length-1]);' +
    'console.log(JSON.stringify(rows.map((r)=>{const a=normalizeMaxAsk(r.json, r.rungs);' +
    'return {a, useful:isUsefulAnswer(a)};})))',
    JSON.stringify(rows.map((r) => ({ json: r.j, rungs: r.b.rungs }))),
  ], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop());

  console.log('case          pack                                    -> answer\n');
  rows.forEach((r, i) => {
    const v = shipped[i];
    console.log(`${r.c.id.padEnd(13)} ${r.b.tokens} tok [${r.b.rungs.join(',')}]${r.b.dropped.length ? ` dropped [${r.b.dropped.join(',')}]` : ''}`);
    console.log(`  expect: ${r.c.expect}`);
    if (!r.j) { console.log(`  NO ANSWER (${r.err})   ${r.ms}ms\n`); return; }
    console.log(`  raw:    basis=${r.j.basis} conf=${r.j.confidence}  ${r.ms}ms`);
    console.log(`  answer: ${String(r.j.answer).slice(0, 220)}`);
    console.log(`  shipped: ${v.a ? (v.useful ? 'REACHES THE WRITER' : 'held (abstention)') : 'REFUSED by validator'}\n`);
  });
  // ── the self-reviewer: claim decomposition on real answers + one poisoned ─
  //
  // ★ THE POISONED CASE DECIDES, and the EXPLAIN case is its control from the
  //   other side: the old monolithic judge flagged fair interpretation as
  //   overreach, which is the failure the claim/reading split exists to fix.
  console.log('self-review by claim decomposition:\n');
  const reviewCases = [
    { id: 'rev-explain', packIdx: 0, expect: 'supported — readings exempt by type',
      answer: rows[0] && rows[0].j ? rows[0].j.answer
        : 'Elena counts the tin twice, indicating her meticulous nature.' },
    { id: 'rev-flag', packIdx: 1, expect: 'supported — both facts locate',
      answer: rows[1] && rows[1].j ? rows[1].j.answer
        : 'Elena taking the short way conflicts with her refusal in chapter 8.' },
    { id: 'rev-poisoned', packIdx: 0, expect: 'overreaches — blackmail is stated nowhere',
      answer: 'Elena is counting the coins to pay off Captain Vale, who has been '
        + 'blackmailing her since the fire she started at Fen Cross.' },
  ];
  const builtReviews = JSON.parse(execFileSync(NODE, [TSX, '-e',
    'import {buildMaxAskPack, buildReviewRequest} from "./src/lib/max-ask";' +
    'const a = JSON.parse(process.argv[process.argv.length-1]);' +
    'console.log(JSON.stringify(a.cases.map((c)=>{' +
    '  const pack = buildMaxAskPack(a.inputs[c.packIdx].input, a.inputs[c.packIdx].budget);' +
    '  return { packText: pack.text,' +
    '           req: buildReviewRequest(pack, {answer:c.answer, basis:"passage", confidence:0.9}) };' +
    '})))',
    JSON.stringify({ cases: reviewCases, inputs: CASES }),
  ], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop());

  const reviewRows = [];
  for (let i = 0; i < reviewCases.length; i++) {
    const rc = reviewCases[i], b = builtReviews[i];
    const t0 = Date.now();
    const res = await callBridge('assistantRun', {
      requestId: `maxrev-${rc.id}`, task: 'max-ask', tier: 'max', contextSize: 4096,
      noThink: false,
      systemPrompt: b.req.systemPrompt, userText: b.req.userText,
      schema: b.req.schema, maxTokens: b.req.maxTokens, timeoutMs: 120000,
    });
    reviewRows.push({ rc, packText: b.packText, ms: Date.now() - t0, j: res && res.ok ? res.json : null });
  }

  // The SHIPPED normalize + computed verdict, never a re-implementation.
  const verdicts = JSON.parse(execFileSync(NODE, [TSX, '-e',
    'import {normalizeClaimCheck, computeReviewVerdict} from "./src/lib/max-ask";' +
    'const rows = JSON.parse(process.argv[process.argv.length-1]);' +
    'console.log(JSON.stringify(rows.map((r)=>{' +
    '  const claims = normalizeClaimCheck(r.json);' +
    '  return claims ? { claims, verdict: computeReviewVerdict(claims, r.packText) } : null;})))',
    JSON.stringify(reviewRows.map((r) => ({ json: r.j, packText: r.packText }))),
  ], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop());

  reviewRows.forEach((r, i) => {
    const v = verdicts[i];
    console.log(`${r.rc.id.padEnd(13)} expect: ${r.rc.expect}`);
    if (!v) { console.log(`  NO PARSE   ${r.ms}ms\n`); return; }
    console.log(`  verdict: ${v.verdict.verdict}  facts=${v.verdict.facts} readings=${v.verdict.readings}`
      + `${v.verdict.note ? `  note="${v.verdict.note}"` : ''}   ${r.ms}ms`);
    for (const c of v.claims) console.log(`    [${c.kind}] "${c.claim}" <- "${(c.quote || '').slice(0, 60)}"`);
    console.log('');
  });

  await callBridge('assistantUnload');
  app.exit(0);
}

app.whenReady().then(() => main().catch((e) => { console.error(e); app.exit(1); }));
