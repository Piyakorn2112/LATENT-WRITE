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

  // ★ Prompt, schema and floor come from the MODULE, never a copy here.
  const dumped = execFileSync(NODE, [TSX, '-e',
    'import {buildPresenceRequest, PRESENCE_MIN_CONFIDENCE} from "./src/lib/presence-review";' +
    'const cases = JSON.parse(process.argv[process.argv.length-1]);' +
    'console.log(JSON.stringify({floor: PRESENCE_MIN_CONFIDENCE, built: cases.map((c)=>' +
    'buildPresenceRequest({name:c.name,snippets:[c.snippet],mentions:1,chapterNumber:4}))}))',
    JSON.stringify(CASES),
  ], { cwd: ROOT, encoding: 'utf8' });
  const mod = JSON.parse(dumped.trim().split('\n').pop());
  const FLOOR = mod.floor;

  const rows = [];
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const req = mod.built[i];
    const res = await callBridge('assistantRun', {
      requestId: `presrev-${c.id}`, task: 'presence-review',
      systemPrompt: req.systemPrompt, userText: req.userText,
      schema: req.schema, maxTokens: req.maxTokens, timeoutMs: 60_000,
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

  console.log('raw verdict → what the shipped path does with it\n');
  let right = 0, wrongApplied = 0, declined = 0, dropped = 0, scored = 0;
  for (const r of rows) {
    const raw = r.j ? `${r.j.verdict}@${r.j.confidence}` : 'none';
    const gold = r.c.expect ? GOLD_CLASS[r.c.expect] : null;
    let mark = ' ';
    if (gold) {
      scored++;
      if (r.applied === gold) { mark = '✓'; right++; }
      else if (r.applied === null) { mark = '·'; declined++; }
      else { mark = '✗'; wrongApplied++; }
    } else {
      mark = '?';
    }
    if (r.j && !r.shipped) dropped++;
    console.log(`  ${mark} ${r.c.id.padEnd(8)} ${r.c.name.padEnd(16)} ` +
      `expect=${String(r.c.expect ?? '—').padEnd(13)} raw=${raw.padEnd(20)} ` +
      `applied=${String(r.applied ?? 'nothing')}${r.j && !r.shipped ? '  ← DROPPED by the validator' : ''}`);
    console.log(`      ${r.j ? r.j.reason : 'no answer'}`);
  }

  console.log(`\n── scored on the ${scored} cases with a gold answer ──────────────────`);
  console.log(`  right, and applied      ${right}`);
  console.log(`  WRONG, and applied      ${wrongApplied}   ← the only ones a writer ever sees`);
  console.log(`  declined (unsure / below the ${FLOOR} floor)  ${declined}`);
  console.log(`  answers dropped by the validator  ${dropped}`);

  // ── is the floor a lever, or does confidence interleave? ─────────────────
  const conf = (pred) => rows.filter(pred).map((r) => (r.j ? r.j.confidence : 0));
  const rightC = conf((r) => r.c.expect && r.j && r.j.verdict === r.c.expect);
  const wrongC = conf((r) => r.c.expect && r.j && r.j.verdict !== r.c.expect && r.j.verdict !== 'unsure');
  console.log(`\n  confidence on CORRECT verdicts : [${rightC.join(', ') || '—'}]`);
  console.log(`  confidence on WRONG verdicts   : [${wrongC.join(', ') || '—'}]`);
  const minRight = rightC.length ? Math.min(...rightC) : null;
  const maxWrong = wrongC.length ? Math.max(...wrongC) : null;
  console.log('');
  if (maxWrong === null) {
    console.log(`  ✓ nothing was answered wrongly at all; the floor is not doing work.`);
  } else if (minRight !== null && maxWrong < minRight) {
    console.log(`  ★ A THRESHOLD SEPARATES THEM: wrong ≤ ${maxWrong} < ${minRight} ≤ right.`);
  } else {
    console.log(`  ★★ NO THRESHOLD SEPARATES THEM: a wrong answer at ${maxWrong} sits at or`);
    console.log(`     above a right one at ${minRight}. The floor is not the lever — find a`);
    console.log('     mechanical feature or withdraw the task.');
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
