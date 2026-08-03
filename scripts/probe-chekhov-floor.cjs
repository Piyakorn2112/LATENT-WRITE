/**
 * probe-chekhov-floor.cjs — where does the model actually put its confidence?
 *
 * The review-sweep e2e produced a phrase whose REASON ended "but not a promise"
 * and whose VERDICT was `promise`, at exactly 0.7 — the floor — so it surfaced.
 * The tempting fix is to nudge CHEKHOV_MIN_CONFIDENCE up. A threshold picked
 * from one observation is a tuned number, not a measured one, so this measures
 * the distribution first.
 *
 * Nine fabricated sentences with a known character: three that hide, load or
 * dwell on a thing (PROMISE), three that put a vivid thing in a room and leave
 * it there (FURNITURE), and three genuinely arguable (MARGINAL — no expected
 * answer, they exist to show where "I am not sure" lands numerically).
 *
 * ★ WHAT WOULD JUSTIFY MOVING THE FLOOR: promises clustering ABOVE a value that
 *   furniture and marginals sit below. If they interleave, no threshold
 *   separates them and the floor is not the lever — the same shape of finding
 *   that withdrew the attribution task.
 *
 * ★ A PROBE, NOT A GATE. The prompt and schema come from the module.
 *
 * Run: ./node_modules/.bin/electron scripts/probe-chekhov-floor.cjs
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
  // ── the prose makes the story owe the reader something ──────────────────
  { id: 'hidden', expect: 'promise', phrase: 'sealed letter',
    sentence: 'She put the sealed letter under the ledger where nobody would look for it, and told no one it had come.' },
  { id: 'loaded', expect: 'promise', phrase: 'oiled revolver',
    sentence: 'He loaded the oiled revolver, set the safety, and put it in the drawer nearest the door.' },
  { id: 'warned', expect: 'promise', phrase: 'green bottle',
    sentence: 'Whatever else you do, her mother said, do not touch the green bottle on the top shelf.' },
  // ── vivid, specific, and a promise of nothing ───────────────────────────
  { id: 'bowl', expect: 'furniture', phrase: 'chipped bowl',
    sentence: 'A chipped bowl sat on the sill where the afternoon light got at it, throwing a thin ring of white onto the wall.' },
  { id: 'coat', expect: 'furniture', phrase: 'folded coat',
    sentence: 'There was a folded coat over the back of the chair and a pair of boots underneath it, drying.' },
  { id: 'lamp', expect: 'furniture', phrase: 'cracked shade',
    sentence: 'The lamp had a cracked shade that threw the light unevenly across the ceiling of the little room.' },
  // ── NOT THINGS AT ALL. The extractor emits these constantly; the model is
  //    the only layer that can say so. ★ ALSO A REACHABILITY TEST: a grammar
  //    enum label can be UNREACHABLE for a small model (measured before, on
  //    "break" in the adjudicator, across 7 prompt variants). If none of these
  //    three comes back "not-a-thing", the label is decorative.
  { id: 'assent', expect: 'not-a-thing', phrase: 'hearty assent',
    sentence: 'She gave her hearty assent to the plan and the matter was considered settled.' },
  { id: 'languages', expect: 'not-a-thing', phrase: 'modern languages',
    sentence: 'He had a good deal to say about modern languages and the teaching of them.' },
  { id: 'victory', expect: 'not-a-thing', phrase: 'complete victory',
    sentence: 'It was a complete victory, and she allowed herself to feel it for a moment.' },
  // ── genuinely arguable: no expected answer ──────────────────────────────
  { id: 'drawer', expect: null, phrase: 'locked drawer',
    sentence: 'The yard kept its register in a locked drawer, and Teva had the only key that turned it.' },
  { id: 'scar', expect: null, phrase: 'white scar',
    sentence: 'He had a white scar across the back of one hand that he did not explain and she did not ask about.' },
  { id: 'ledger', expect: null, phrase: 'second ledger',
    sentence: 'The office kept a second ledger, and had done for as long as anyone there could remember.' },
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
    'import {buildChekhovRequest, CHEKHOV_MIN_CONFIDENCE} from "./src/lib/chekhov-review";' +
    'const cases = JSON.parse(process.argv[process.argv.length-1]);' +
    'console.log(JSON.stringify({floor: CHEKHOV_MIN_CONFIDENCE, built: cases.map((c)=>' +
    'buildChekhovRequest({phrase:c.phrase,mentions:1,sentence:c.sentence,chapterNumber:4,chaptersSince:6}))}))',
    JSON.stringify(CASES),
  ], { cwd: ROOT, encoding: 'utf8' });
  const mod = JSON.parse(dumped.trim().split('\n').pop());
  const FLOOR = mod.floor;

  const rows = [];
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const req = mod.built[i];
    const res = await callBridge('assistantRun', {
      requestId: `chkfloor-${c.id}`, task: 'chekhov-review',
      systemPrompt: req.systemPrompt, userText: req.userText,
      schema: req.schema, maxTokens: req.maxTokens, timeoutMs: 60_000,
    });
    const j = res && res.ok ? res.json : null;
    const surfaced = !!j && j.verdict === 'promise' && j.confidence >= FLOOR;
    rows.push({ c, j, surfaced });
    const mark = c.expect === null ? '?' : (j && j.verdict === c.expect) ? '✓' : '✗';
    console.log(`  ${mark} ${c.id.padEnd(8)} expect=${String(c.expect).padEnd(9)} ` +
      `verdict=${(j ? j.verdict : 'none').padEnd(9)} @${j ? j.confidence : '—'}` +
      `${surfaced ? '   ← SURFACES' : ''}`);
    console.log(`      ${j ? j.reason : (res && res.error)}`);
  }

  // ── the transcription guard, applied to what actually came back ─────────
  // Computed by the MODULE, on the real reasons, after the fact — so the probe
  // measures the shipped predicate rather than a copy of it.
  const echoIn = rows.map((r) => ({ reason: (r.j && r.j.reason) || '', sentence: r.c.sentence }));
  const echoOut = JSON.parse(execFileSync(NODE, [TSX, '-e',
    'import {reasonEchoesSentence} from "./src/lib/chekhov-review";' +
    'const rows = JSON.parse(process.argv[process.argv.length-1]);' +
    'console.log(JSON.stringify(rows.map((r)=>reasonEchoesSentence(r.reason, r.sentence))))',
    JSON.stringify(echoIn),
  ], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop());
  rows.forEach((r, i) => { r.echo = echoOut[i]; r.surfacedAfter = r.surfaced && !echoOut[i]; });

  console.log('\n── the transcription guard ───────────────────────────────────');
  for (const r of rows) {
    if (!r.echo) continue;
    console.log(`  dropped ${r.c.id.padEnd(8)} (${r.j.verdict} @${r.j.confidence}) — the reason restates the sentence`);
  }
  const before = rows.filter((r) => r.surfaced);
  const after = rows.filter((r) => r.surfacedAfter);
  const good = (rs) => rs.filter((r) => r.c.expect === 'promise').length;
  console.log(`  surfaced: ${before.length} → ${after.length}   ` +
    `(real promises kept: ${good(before)} → ${good(after)})`);

  const conf = (pred) => rows.filter(pred).map((r) => (r.j ? r.j.confidence : 0));
  const truePromise = conf((r) => r.c.expect === 'promise' && r.j && r.j.verdict === 'promise');
  const asPromise = conf((r) => r.c.expect !== 'promise' && r.j && r.j.verdict === 'promise');

  console.log(`\n── confidence, current floor ${FLOOR} ─────────────────────────`);
  console.log(`  true promises answered "promise" : [${truePromise.join(', ') || '—'}]`);
  console.log(`  non-promises answered "promise"  : [${asPromise.join(', ') || '—'}]`);

  const minTrue = truePromise.length ? Math.min(...truePromise) : null;
  const maxFalse = asPromise.length ? Math.max(...asPromise) : null;
  console.log('');
  if (minTrue === null) {
    console.log('  ✗ the model never confirmed a real promise — the floor is not the problem.');
  } else if (maxFalse === null) {
    console.log(`  ✓ nothing false was called a promise. The floor is not doing work; ${FLOOR} is fine.`);
  } else if (maxFalse < minTrue) {
    console.log(`  ★ A THRESHOLD SEPARATES THEM: false ≤ ${maxFalse} < ${minTrue} ≤ true.`);
    console.log(`    A floor in (${maxFalse}, ${minTrue}] would drop the false ones and keep the real ones.`);
  } else {
    console.log(`  ★★ NO THRESHOLD SEPARATES THEM: a false promise at ${maxFalse} sits at or above`);
    console.log(`     a true one at ${minTrue}. Raising the floor would cost real findings to`);
    console.log('     remove false ones, which is not a trade a marking feature should make.');
  }

  await callBridge('assistantUnload');
  app.exit(0);
}

app.whenReady().then(() => main().catch((e) => { console.error(e); app.exit(1); }));
