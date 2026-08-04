/**
 * probe-alias-review.cjs — can the model tell one person from two?
 *
 * alias-propose.ts links what morphology proves and refuses the rest. This asks
 * whether the model can settle the cases it refuses — above all the cultural
 * nicknames no string test can derive (Kitty/Catherine, Jack/John).
 *
 * ★★ HALF THESE PAIRS ARE DIFFERENT PEOPLE. A set of real nicknames only is
 *    passed perfectly by a model that always answers "same-person", which is
 *    the single most common way a probe lies. The families here (father/son,
 *    two sisters, husband/wife) are the exact shape a merge destroys, and they
 *    carry the same surface similarity the true pairs do.
 *
 * ★ THE DECIDING NUMBER IS WRONG-AND-SURFACED. An "unsure" or a low-confidence
 *   answer leaves the two names separate, which is how they already are and
 *   costs nothing. Only a confident "same-person" reaches the writer as a
 *   merge proposal, and a wrong one there corrupts the cast.
 *
 * Run: ./node_modules/.bin/electron scripts/probe-alias-review.cjs
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
  // ── ONE PERSON. Cultural nicknames the morphology provably cannot derive. ──
  { id: 'kitty', a: 'Catherine', b: 'Kitty', expect: 'same-person',
    aSnip: 'Catherine had been quiet all evening, and her mother said so twice before the tea came.',
    bSnip: 'Everyone but her mother called her Kitty, and Kitty never minded it in the least.' },
  { id: 'jack', a: 'John', b: 'Jack', expect: 'same-person',
    aSnip: 'John Harrow signed the register in a hand nobody at the desk could read.',
    bSnip: 'The men on the wharf all called him Jack, and Jack answered to it without thinking.' },
  { id: 'title', a: 'Ellery', b: 'Doctor Ellery', expect: 'same-person',
    aSnip: 'Ellery set the lamp down and rolled his sleeves to the elbow before he touched her.',
    bSnip: 'Doctor Ellery has been sent for, the boy said, and will be here before the hour is out.' },
  { id: 'full', a: 'Rosalind', b: 'Rosalind Ware', expect: 'same-person',
    aSnip: 'Rosalind waited at the gate until the last of the carts had gone by.',
    bSnip: 'The letter was addressed to Rosalind Ware, of this parish, in a clerk’s careful hand.' },

  // ── TWO PEOPLE, wearing the same surface similarity. ──────────────────────
  { id: 'father', a: 'Mr. Thorn', b: 'Miss Thorn', expect: 'different-people',
    aSnip: 'Mr. Thorn had kept the mill for thirty years and meant to keep it thirty more.',
    bSnip: 'Miss Thorn played badly and knew it, and played on anyway to spite the room.' },
  { id: 'sisters', a: 'Alise Verrin', b: 'Mera Verrin', expect: 'different-people',
    aSnip: 'Alise Verrin took the north road because it was longer and she wanted the time.',
    bSnip: 'Mera Verrin had gone south that morning without telling anybody in the house.' },
  { id: 'spouses', a: 'Halloway', b: 'Mrs. Halloway', expect: 'different-people',
    aSnip: 'Halloway came in from the yard with his coat still wet and asked after the horses.',
    bSnip: 'Mrs. Halloway had opinions about the yard and was not shy about any of them.' },
  { id: 'unrelated', a: 'Bramble', b: 'Bracken', expect: 'different-people',
    aSnip: 'Bramble laughed at that, as he laughed at most things anyone said to him.',
    bSnip: 'Bracken did not laugh. Bracken had not laughed since the winter before last.' },
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
  const mod = JSON.parse(execFileSync(NODE, [TSX, '-e',
    'import {buildAliasRequest, ALIAS_MIN_CONFIDENCE} from "./src/lib/alias-review";' +
    'const cases = JSON.parse(process.argv[process.argv.length-1]);' +
    'console.log(JSON.stringify({floor: ALIAS_MIN_CONFIDENCE, built: cases.map((c)=>' +
    'buildAliasRequest({character:c.a, alias:c.b, source:"unlinked-pair",' +
    'characterSnippets:[c.aSnip], aliasSnippets:[c.bSnip], weight:5}))}))',
    JSON.stringify(CASES),
  ], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop());
  const FLOOR = mod.floor;

  const rows = [];
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const req = mod.built[i];
    const res = await callBridge('assistantRun', {
      requestId: `aliasrev-${c.id}`, task: 'alias-review',
      systemPrompt: req.systemPrompt, userText: req.userText,
      schema: req.schema, maxTokens: req.maxTokens, timeoutMs: 60_000,
    });
    rows.push({ c, j: res && res.ok ? res.json : null });
  }

  // Route every answer through the SHIPPED validator and surfacing rule.
  const shipped = JSON.parse(execFileSync(NODE, [TSX, '-e',
    'import {normalizeAlias, isSurfacedAlias} from "./src/lib/alias-review";' +
    'const rows = JSON.parse(process.argv[process.argv.length-1]);' +
    'console.log(JSON.stringify(rows.map((r)=>{const a = normalizeAlias(r.json, r.snips);' +
    'return {answer:a, surfaced:isSurfacedAlias(a)};})))',
    JSON.stringify(rows.map((r) => ({ json: r.j, snips: [r.c.aSnip, r.c.bSnip] }))),
  ], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop());
  rows.forEach((r, i) => { r.shipped = shipped[i].answer; r.surfaced = shipped[i].surfaced; });

  let rightSurfaced = 0, wrongSurfaced = 0, missed = 0, correctlyHeld = 0, dropped = 0;
  console.log('raw verdict → what the shipped path does with it\n');
  for (const r of rows) {
    const raw = r.j ? `${r.j.verdict}@${r.j.confidence}` : 'none';
    const same = r.c.expect === 'same-person';
    let mark;
    if (r.surfaced && same) { mark = '✓'; rightSurfaced++; }
    else if (r.surfaced && !same) { mark = '✗'; wrongSurfaced++; }
    else if (!r.surfaced && same) { mark = '·'; missed++; }
    else { mark = '—'; correctlyHeld++; }
    if (r.j && !r.shipped) dropped++;
    console.log(`  ${mark} ${r.c.id.padEnd(10)} ${`${r.c.a} ~ ${r.c.b}`.padEnd(30)} ` +
      `expect=${r.c.expect.padEnd(16)} raw=${raw.padEnd(24)} ` +
      `${r.surfaced ? 'MERGE PROPOSED' : 'left separate'}` +
      `${r.j && !r.shipped ? '  ← DROPPED by the validator' : ''}`);
    console.log(`      ${r.j ? r.j.reason : 'no answer'}`);
  }

  console.log(`\n── over ${rows.length} pairs, floor ${FLOOR} ──────────────────────────────`);
  console.log(`  right, and a merge proposed   ${rightSurfaced}`);
  console.log(`  WRONG, and a merge proposed   ${wrongSurfaced}   ← corrupts the cast`);
  console.log(`  real pair missed (left separate) ${missed}   ← costs a nickname, nothing more`);
  console.log(`  two people correctly left apart  ${correctlyHeld}`);
  console.log(`  answers dropped by the validator ${dropped}`);

  const conf = (pred) => rows.filter((r) => r.j && pred(r)).map((r) => r.j.confidence);
  const trueSame = conf((r) => r.c.expect === 'same-person' && r.j.verdict === 'same-person');
  const falseSame = conf((r) => r.c.expect !== 'same-person' && r.j.verdict === 'same-person');
  console.log(`\n  confidence, TRUE pairs called same  : [${trueSame.join(', ') || '—'}]`);
  console.log(`  confidence, FALSE pairs called same : [${falseSame.join(', ') || '—'}]`);
  const minT = trueSame.length ? Math.min(...trueSame) : null;
  const maxF = falseSame.length ? Math.max(...falseSame) : null;
  console.log('');
  if (maxF === null) {
    console.log('  ✓ nothing false was ever called the same person.');
  } else if (minT !== null && maxF < minT) {
    console.log(`  ★ A THRESHOLD SEPARATES THEM: false ≤ ${maxF} < ${minT} ≤ true.`);
  } else {
    console.log(`  ★★ NO THRESHOLD SEPARATES THEM: a false pair at ${maxF} sits at or above a`);
    console.log(`     true one at ${minT}. For a MERGE that is disqualifying — unlike a mark,`);
    console.log('     there is no deterministic answer underneath to fall back on.');
  }
  const verdicts = new Set(rows.filter((r) => r.j).map((r) => r.j.verdict));
  console.log(`\n  verdicts actually produced: ${[...verdicts].join(', ') || 'none'}`);
  console.log('\n★ SHIP CONDITION: wrong-and-surfaced = 0, and at least one real pair found.');
  console.log('  Zero wrong AND zero right means the task does nothing and should not ship.');

  await callBridge('assistantUnload');
  app.exit(0);
}

app.whenReady().then(() => main().catch((e) => { console.error(e); app.exit(1); }));
