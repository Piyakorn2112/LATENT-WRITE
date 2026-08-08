/**
 * probe-presence-review.cjs — can the model actually tell "in the room" from
 * "being talked about", and does it earn its place on the ledger?
 *
 * character-presence.ts decides 87% of marks and declares the rest uncertain.
 * presence-review.ts asks the model about those. Whether that is worth shipping
 * is a measurement, not an opinion — the attribution task looked just as
 * reasonable and was withdrawn when measured.
 *
 * ★★ BOTH DIRECTIONS ARE REPRESENTED, AND THAT IS THE POINT. A set made only of
 *    "actually absent" cases is passed perfectly by a model that always answers
 *    "talked-about", which is exactly as blind as always answering the other
 *    way. Four names appear TWICE — once in the scene, once discussed — so a
 *    per-name bias cannot score. This is the single most common way a probe
 *    lies, and it is why the pairs share their nouns and differ in their verbs.
 *
 * ★ NONE OF THESE SENTENCES IS IN THE PROMPT. PRESENCE_SYSTEM uses "danced with
 *   Miss Bingley" / "thought of poor Miss Bingley" as its worked example, so
 *   testing on that pair would measure whether the model can copy an example.
 *   Different names, different verbs, deliberately.
 *
 * ★ THE NUMBER THAT DECIDES IS WRONG-AND-APPLIED, not accuracy. An `unsure` or
 *   a low-confidence answer changes nothing — the deterministic engine already
 *   has a call and keeps it. Only a confident wrong answer reaches the writer.
 *
 * Run: ./node_modules/.bin/electron scripts/probe-presence-review.cjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

app.setName('Latent Write');

const ROOT = path.join(__dirname, '..');
const NODE = '/opt/homebrew/bin/node';
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

const CASES = [
  // ── in the room. Someone acts on them, beside them, or they arrive ────────
  { id: 'hand',    name: 'Wickham',         expect: 'in-the-scene',
    snippet: 'He handed the letter to Wickham without a word, and watched him read it to the end.' },
  { id: 'beside',  name: 'Marianne',        expect: 'in-the-scene',
    snippet: 'Elinor sat beside Marianne through the whole of it, saying nothing at all.' },
  { id: 'arrive',  name: 'Colonel Brandon', expect: 'in-the-scene',
    snippet: 'The door opened and Colonel Brandon came in, still in his riding coat, bringing the cold with him.' },
  { id: 'act',     name: 'Harriet',         expect: 'in-the-scene',
    snippet: 'Nobody spoke until Harriet set down her cup and looked up at the two of them.' },

  // ── the same four names, elsewhere. Remembered, reported, possessive ──────
  { id: 'wonder',  name: 'Wickham',         expect: 'talked-about',
    snippet: 'He could not stop wondering what Wickham would have made of it, had he been there to see.' },
  { id: 'letter',  name: 'Marianne',        expect: 'talked-about',
    snippet: 'Her aunt wrote that Marianne had been ill again, and was not to travel until the spring.' },
  { id: 'agreed',  name: 'Colonel Brandon', expect: 'talked-about',
    snippet: 'They had all agreed, long before, that Colonel Brandon was the steadiest man in the county.' },
  { id: 'posses',  name: 'Harriet',         expect: 'talked-about',
    snippet: 'The room had been Harriet’s once, though nobody in the house said so now.' },

  // ── MORE OF THE CLASS THE ENGINE ACTUALLY DEFERS. The pairs above mostly
  //    get decided, which is the engine working — but it left only three cases
  //    to score the model on. These are all object-of-a-verb with no predicate
  //    of the character's own, which is precisely the deferred shape, and they
  //    pair present against absent on the same construction.
  { id: 'sleeve',  name: 'Anselm',          expect: 'in-the-scene',
    snippet: 'She caught Anselm by the sleeve before he could turn away from the table.' },
  { id: 'knee',    name: 'Prosper',         expect: 'in-the-scene',
    snippet: 'The dog went straight to Prosper and put its head down on his knee.' },
  { id: 'pitied',  name: 'Anselm',          expect: 'talked-about',
    snippet: 'The whole village pitied Anselm, though not one of them had seen him in years.' },
  { id: 'dead',    name: 'Prosper',         expect: 'talked-about',
    snippet: 'He had inherited the mill from Prosper, who was twenty years dead by then.' },

  // ── "unsure" REACHABILITY. A grammar enum label can be unreachable for a
  //    small model — measured before in this repo, on a different task, across
  //    seven prompt variants. If nothing here returns "unsure", the abstention
  //    is decorative and the confidence floor is doing all the work.
  { id: 'noinfo',  name: 'Ferrars',         expect: null,
    snippet: 'The Ferrars question came up again, as it always did, and then it was dropped.' },
  { id: 'frag',    name: 'Elinor',          expect: null,
    snippet: 'Elinor. The word had a weight to it that nothing else in the letter had.' },

  // ── genuinely arguable: no expected answer, they show where "unsure" lands
  { id: 'visited', name: 'Bingley',         expect: null,
    snippet: 'Mr. Bennet was among the earliest of those who waited on Mr. Bingley.' },
  { id: 'recomm',  name: 'Lady Catherine',  expect: null,
    snippet: 'A fortunate chance had recommended him to Lady Catherine de Bourgh when the living fell vacant.' },
  { id: 'except',  name: 'Mary',            expect: null,
    snippet: 'Every sister except Mary agreed to go with her as far as Meryton.' },
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
  const status = await callBridge('assistantStatus');
  if (!status.model.present) { console.log('SKIP — no model on disk.'); app.exit(0); return; }
  console.log(`model: ${status.model.id}\n`);

  // ★ Prompt, schema and floor come from the MODULE, never a copy here — and
  //   so does the ENGINE's own call, because that is what decides whether a
  //   case is ever sent to the model at all.
  const dumped = execFileSync(NODE, [TSX, '-e',
    'import {buildPresenceRequest, PRESENCE_MIN_CONFIDENCE} from "./src/lib/presence-review";' +
    'import {classifyChapterPresence} from "./src/lib/character-presence";' +
    'const cases = JSON.parse(process.argv[process.argv.length-1]);' +
    'console.log(JSON.stringify({floor: PRESENCE_MIN_CONFIDENCE, built: cases.map((c)=>' +
    'buildPresenceRequest({name:c.name,snippets:[c.snippet],mentions:1,chapterNumber:4})),' +
    'engine: cases.map((c)=>{const p=classifyChapterPresence(c.snippet,[{name:c.name,variants:[]}])[0];' +
    'return {klass:p.klass, uncertain:p.uncertain};})}))',
    JSON.stringify(CASES),
  ], { cwd: ROOT, encoding: 'utf8' });
  const mod = JSON.parse(dumped.trim().split('\n').pop());
  const FLOOR = mod.floor;
  CASES.forEach((c, i) => { c.engine = mod.engine[i]; });

  // ★ TIER IS AN INPUT. The "unsure" reachability claim in presence-review.ts
  //   is explicitly a property of the MODEL, not of the prompt, so re-running
  //   this against a candidate is the documented procedure. PROBE_TIER=max
  //   uses the registry's max config rather than applying the small tier's
  //   settings (noThink true, 4k) to different weights.
  const TIER = process.env.PROBE_TIER === 'max' ? 'max' : undefined;
  // ★ `/no_think` is a Qwen token; it is literal junk in a Granite or Gemma
  //   prompt. Run any non-Qwen candidate with PROBE_NOTHINK=0.
  const NO_THINK = process.env.PROBE_NOTHINK === '0' ? { noThink: false } : {};
  console.log(`  model tier: ${TIER || 'small (default)'}${process.env.PROBE_NOTHINK === '0' ? ' · noThink OFF' : ''}`);

  const rows = [];
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const req = mod.built[i];
    const res = await callBridge('assistantRun', {
      requestId: `presrev-${c.id}`, task: 'presence-review',
      systemPrompt: req.systemPrompt, userText: req.userText,
      schema: req.schema,
      // A thinking model spends tokens before it emits.
      maxTokens: TIER === 'max' ? Math.max(req.maxTokens, 1024) : req.maxTokens,
      timeoutMs: TIER === 'max' ? 180_000 : 60_000,
      ...(TIER ? { tier: TIER } : {}), ...NO_THINK,
    });
    const j = res && res.ok ? res.json : null;
    rows.push({ c, j });
  }

  // ── run every answer through the SHIPPED validator, not a copy ───────────
  const shipped = JSON.parse(execFileSync(NODE, [TSX, '-e',
    'import {normalizePresence, appliedPresenceClass} from "./src/lib/presence-review";' +
    'const rows = JSON.parse(process.argv[process.argv.length-1]);' +
    'console.log(JSON.stringify(rows.map((r)=>{' +
    'const a = normalizePresence(r.json, [r.snippet]);' +
    'return {answer: a, applied: appliedPresenceClass(a)};})))',
    JSON.stringify(rows.map((r) => ({ json: r.j, snippet: r.c.snippet }))),
  ], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop());
  rows.forEach((r, i) => { r.shipped = shipped[i].answer; r.applied = shipped[i].applied; });

  const GOLD_CLASS = { 'in-the-scene': 'present', 'talked-about': 'mentioned' };

  // ★★ SCORE AT THE CUT THE PRODUCT USES. The first run of this probe fed the
  //    model every case and reported 2 right / 1 wrong-applied — but three of
  //    those cases are ones the ENGINE decides on its own and never sends. A
  //    task can only be judged on the inputs it actually receives, and asking
  //    it about questions it will never be asked measures nothing. (Those three
  //    were not wasted: running them through the engine is what exposed the
  //    three engine bugs fixed in the previous commit.)
  console.log('raw verdict → what the shipped path does with it\n');
  let right = 0, wrongApplied = 0, declined = 0, dropped = 0, scored = 0;
  let engineOnly = 0, engineWrong = 0;
  for (const r of rows) {
    const raw = r.j ? `${r.j.verdict}@${r.j.confidence}` : 'none';
    const gold = r.c.expect ? GOLD_CLASS[r.c.expect] : null;
    const asked = r.c.engine.uncertain;
    let mark = ' ';
    if (gold && asked) {
      scored++;
      if (r.applied === gold) { mark = '✓'; right++; }
      else if (r.applied === null) { mark = '·'; declined++; }
      else { mark = '✗'; wrongApplied++; }
      if (r.j && !r.shipped) dropped++;
    } else if (gold) {
      engineOnly++;
      if (r.c.engine.klass !== gold) { mark = '!'; engineWrong++; } else { mark = '—'; }
    } else {
      mark = '?';
    }
    console.log(`  ${mark} ${r.c.id.padEnd(8)} ${r.c.name.padEnd(16)} ` +
      `expect=${String(r.c.expect ?? '—').padEnd(13)} ` +
      `engine=${(r.c.engine.klass + (asked ? '/ASK' : '')).padEnd(15)} ` +
      `raw=${raw.padEnd(20)} applied=${String(r.applied ?? 'nothing')}` +
      `${r.j && !r.shipped ? '  ← DROPPED by the validator' : ''}`);
    console.log(`      ${r.j ? r.j.reason : 'no answer'}`);
  }

  console.log(`\n  — = the engine decided it correctly and never asks (${engineOnly - engineWrong} cases)`);
  console.log(`  ! = the engine decided it WRONG without asking (${engineWrong}) — an ENGINE bug, not a model one`);

  console.log(`\n── scored on the ${scored} cases the engine actually DEFERS ──────────`);
  console.log(`  right, and applied      ${right}`);
  console.log(`  WRONG, and applied      ${wrongApplied}   ← the only ones a writer ever sees`);
  console.log(`  declined (unsure / below the ${FLOOR} floor)  ${declined}`);
  console.log(`  answers dropped by the validator  ${dropped}`);

  // ── is the floor a lever, or does confidence interleave? ─────────────────
  // ★ A MISSING ANSWER IS NOT A CORRECT ANSWER AT CONFIDENCE ZERO. The first
  //   version mapped `r.j == null` to 0 and then reported "no threshold
  //   separates them" because a wrong answer at 0.5 outranked that phantom.
  //   Only rows the model actually answered belong in a confidence comparison.
  const conf = (pred) => rows.filter((r) => r.c.engine.uncertain && r.j && pred(r))
    .map((r) => r.j.confidence);
  const rightC = conf((r) => r.c.expect && r.j && r.j.verdict === r.c.expect);
  const wrongC = conf((r) => r.c.expect && r.j && r.j.verdict !== r.c.expect && r.j.verdict !== 'unsure');
  console.log(`\n  confidence on CORRECT verdicts : [${rightC.join(', ') || '—'}]`);
  console.log(`  confidence on WRONG verdicts   : [${wrongC.join(', ') || '—'}]`);
  const minRight = rightC.length ? Math.min(...rightC) : null;
  const maxWrong = wrongC.length ? Math.max(...wrongC) : null;
  const rightBelow = rightC.filter((c) => c < FLOOR).length;
  const wrongBelow = wrongC.filter((c) => c < FLOOR).length;
  console.log('');
  if (maxWrong === null) {
    console.log('  ✓ nothing was answered wrongly at all; the floor is not doing work here.');
  } else if (minRight !== null && maxWrong < minRight) {
    console.log(`  ★ A THRESHOLD SEPARATES THEM: wrong ≤ ${maxWrong} < ${minRight} ≤ right.`);
  } else {
    // ★ THE OLD MESSAGE HERE SAID "withdraw the task", AND THAT IS THE WRONG
    //   ADVICE WHEN WRONG-AND-APPLIED IS ZERO. Interleaving means the floor is
    //   not a SEPARATOR — it is a conservative gate, and what it costs is
    //   declined answers, which are free: the deterministic engine already has
    //   a call for every one of them. Withdrawal is warranted when wrong
    //   answers SURVIVE the floor, not merely when confidence is uninformative.
    console.log(`  ★ CONFIDENCE DOES NOT SEPARATE RIGHT FROM WRONG (wrong up to ${maxWrong},`);
    console.log(`    right down to ${minRight}). So the ${FLOOR} floor is a conservative gate, not a`);
    console.log(`    discriminator: it declines ${rightBelow} correct answer(s) to block ${wrongBelow} wrong one(s).`);
    console.log('    That trade is only acceptable because declining is FREE — the engine');
    console.log('    keeps its own call. It would not be acceptable for a feature that had');
    console.log('    nothing to fall back on.');
  }

  // ── the abstention has to be REACHABLE, or it is decorative ──────────────
  const unsures = rows.filter((r) => r.j && r.j.verdict === 'unsure');
  console.log(`\n  "unsure" returned ${unsures.length} time(s)` +
    `${unsures.length ? ` (${unsures.map((r) => r.c.id).join(', ')})` : ' — CHECK IT IS REACHABLE AT ALL'}`);
  const verdicts = new Set(rows.filter((r) => r.j).map((r) => r.j.verdict));
  console.log(`  verdicts actually produced: ${[...verdicts].join(', ') || 'none'}`);

  console.log(`\n★ SHIP CONDITION: wrong-and-applied = 0. A better "right" does not pay for`);
  console.log('  a confident wrong mark, because the engine already had an answer.');

  await callBridge('assistantUnload');
  app.exit(0);
}

app.whenReady().then(() => main().catch((e) => { console.error(e); app.exit(1); }));
