/**
 * probe-alias-referent.cjs — can the model name the referent of a strange name?
 *
 * alias-review.ts was measured out for asking "are these two names the same
 * person?" — an open identity judgement whose evidence for "no" (families
 * exist) is not in the passages. This asks something else: CLOSED extraction
 * over ONE passage that contains the answer. See alias-referent.ts for why
 * that is a different task and not a re-argued prompt.
 *
 * ★★ HALF THESE CASES HAVE NO ANSWER IN THE PASSAGE. A set of answerable
 *    passages is passed perfectly by a model that always names the first
 *    person on the list, which is the single most common way a probe lies.
 *    The unanswerable half carries the SAME surface shape — a capitalised
 *    name, a comma, people standing nearby — and the right answer is
 *    "unclear".
 *
 * ★ THE DECIDING NUMBER IS WRONG-AND-CONFIDENT. An "unclear" or a
 *   low-confidence answer leaves the name unattached, which is how it already
 *   is and costs nothing. Only a confident named referent becomes a row, and
 *   even that row arrives UNTICKED — so the failure mode here is a wasted
 *   glance, not a corrupted cast. That is why this may ship where a merge
 *   could not; it is not a reason to tolerate a non-zero count.
 *
 * Run: ./node_modules/.bin/electron scripts/probe-alias-referent.cjs
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
  // ── ANSWERABLE. The passage shows who answers to the name. ────────────────
  {
    id: 'sparrow', expect: 'Vale',
    alias: 'Sparrow', shortlist: ['Vale', 'Elena'],
    snippet:
      '"Sparrow," Nadia Okonkwo said, and Elena was still standing in the doorway with her coat ' +
      'on, so it was not clear who she meant it for. "You have gone very quiet on me." ' +
      '"I am always quiet before a run," Corin Vale said, and folded the list into his coat pocket, ' +
      'and did not look at Elena at all.',
  },
  {
    id: 'answers-to-it', expect: 'Halloway',
    alias: 'Tinder', shortlist: ['Halloway', 'Reece'],
    snippet:
      'Reece put his head round the door. "Tinder!" he shouted, over the noise of the press. ' +
      'Halloway did not look up from the plate, but he raised two fingers to show he had heard, ' +
      'and went on inking.',
  },
  {
    id: 'named-in-role', expect: 'Weir',
    alias: 'the Quiet Blade', shortlist: ['Weir', 'Sable'],
    snippet:
      'Everyone at the table knew what the Quiet Blade had done at Marrow Ford, and everyone at ' +
      'the table was careful not to say so while Weir was pouring. Sable asked about the weather ' +
      'instead, twice.',
  },
  {
    id: 'signed-for', expect: 'Ottoline',
    alias: 'Ott', shortlist: ['Ottoline', 'Bram'],
    snippet:
      'The ledger had one signature on it and the signature said Ott, in a round hand with the ' +
      'stem of the t crossed twice. Bram had never learned to write at all. Ottoline took the pen ' +
      'back and blotted it.',
  },

  // ── UNANSWERABLE. Same shape, no evidence. "unclear" is the right answer. ──
  {
    id: 'mere-proximity', expect: 'unclear',
    alias: 'Coldwater', shortlist: ['Merrin', 'Anse'],
    snippet:
      'Coldwater had been quiet for a week. Merrin walked the length of the yard and back, and ' +
      'Anse sat on the wall with the dog, and neither of them said anything about it.',
  },
  {
    id: 'third-party', expect: 'unclear',
    alias: 'Wick', shortlist: ['Ferro', 'Dell'],
    snippet:
      '"Wick will not wait past Thursday," Ferro said. "You know what he is like." Dell shrugged, ' +
      'and went on cleaning the barrel, and did not seem to think Thursday was much of a threat.',
  },
  {
    id: 'both-fit', expect: 'unclear',
    alias: 'Redcap', shortlist: ['Ivet', 'Sorrel'],
    snippet:
      'One of them had been called Redcap since the siege and neither of them would say which. ' +
      'Ivet laughed. Sorrel did not. They had been doing this to strangers for eleven years.',
  },
  {
    id: 'place-not-person', expect: 'unclear',
    alias: 'Ashfell', shortlist: ['Corun', 'Maddox'],
    snippet:
      'They came down out of Ashfell in the last of the light, Corun leading and Maddox a long way ' +
      'behind, and the road was worse than either of them had been promised.',
  },

  // ── NOT NAMES AT ALL. Every one is a REAL row the vocative layer shipped on
  //    a real novel, and the whole reason `not-a-name` was added. They sit in
  //    the vocative slot exactly like a nickname does.
  {
    id: 'yeah', expect: 'not-a-name',
    alias: 'Yeah', shortlist: ['Gatsby', 'Jordan'],
    snippet:
      '"Yeah," said Gatsby, and turned the wheel a little, and Jordan looked out of the window at '
      + 'the ash-heaps going by. "Yeah, that is what I heard too."',
  },
  {
    id: 'bah', expect: 'not-a-name',
    alias: 'Bah', shortlist: ['Scrooge', 'Cratchit'],
    snippet:
      '"Bah!" said Scrooge. "Humbug!" Cratchit did not answer him, and went on copying letters '
      + 'with his fingers half frozen.',
  },
  {
    id: 'hullo-again', expect: 'not-a-name',
    alias: 'Hullo', shortlist: ['Watson', 'Lestrade'],
    snippet:
      '"Hullo, Watson," said Lestrade from the doorway, shaking the rain from his hat. "You are '
      + 'early for once."',
  },
  // ── AND ONE THAT IS a name, in the same slot, to prove the option is not
  //    simply swallowing the whole class.
  {
    id: 'kes', expect: 'Kestrel',
    alias: 'Kes', shortlist: ['Kestrel', 'Elena'],
    snippet:
      '"You are going to get us both killed, Kes," Elena said, without looking up. "You know that." '
      + '"So don\'t come," Kestrel said. "It is a long walk and I would rather do it without the lecture."',
  },
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

  // ★ Prompt, schema and floor come from the MODULE, never a copy here. A probe
  //   that hand-rolls the prompt measures the probe.
  const mod = JSON.parse(execFileSync(NODE, [TSX, '-e',
    'import {buildReferentRequest, REFERENT_MIN_CONFIDENCE} from "./src/lib/alias-referent";' +
    'const cases = JSON.parse(process.argv[process.argv.length-1]);' +
    'console.log(JSON.stringify({floor: REFERENT_MIN_CONFIDENCE, built: cases.map((c)=>' +
    'buildReferentRequest({alias:c.alias, occurrences:4, fromVocative:true, snippets:[c.snippet],' +
    'shortlist:c.shortlist.map((s)=>({character:s, complementary:0.5}))}))}))',
    JSON.stringify(CASES),
  ], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop());
  const FLOOR = mod.floor;

  const rows = [];
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const req = mod.built[i];
    const res = await callBridge('assistantRun', {
      requestId: `aliasref-${c.id}`, task: 'alias-referent',
      systemPrompt: req.systemPrompt, userText: req.userText,
      schema: req.schema, maxTokens: req.maxTokens, timeoutMs: 60_000,
    });
    rows.push({ c, j: res && res.ok ? res.json : null });
  }

  // Route every answer through the SHIPPED validator and surfacing rule.
  const shipped = JSON.parse(execFileSync(NODE, [TSX, '-e',
    'import {normalizeReferent, isSurfacedReferent} from "./src/lib/alias-referent";' +
    'const rows = JSON.parse(process.argv[process.argv.length-1]);' +
    'console.log(JSON.stringify(rows.map((r)=>{const a = normalizeReferent(r.json, r.shortlist);' +
    'return {answer:a, surfaced:isSurfacedReferent(a)};})))',
    JSON.stringify(rows.map((r) => ({ json: r.j, shortlist: r.c.shortlist }))),
  ], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop());
  rows.forEach((r, i) => { r.shipped = shipped[i].answer; r.surfaced = shipped[i].surfaced; });

  let right = 0, wrong = 0, missed = 0, held = 0, dropped = 0;
  console.log('raw answer → what the shipped path does with it\n');
  for (const r of rows) {
    const raw = r.j ? `${r.j.referent}@${r.j.confidence}` : 'none';
    const answerable = r.c.expect !== 'unclear';
    const named = r.surfaced ? r.shipped.referent : null;
    let mark;
    if (named && named === r.c.expect) { mark = '✓'; right++; }
    else if (named) { mark = '✗'; wrong++; }
    else if (answerable) { mark = '·'; missed++; }
    else { mark = '—'; held++; }
    if (r.j && !r.shipped) dropped++;
    console.log(`  ${mark} ${r.c.id.padEnd(16)} "${r.c.alias}" of [${r.c.shortlist.join(', ')}]`);
    console.log(`      expect=${String(r.c.expect).padEnd(10)} raw=${raw.padEnd(22)} ` +
      `${named ? `ROW PROPOSED → ${named}` : 'left unattached'}` +
      `${r.j && !r.shipped ? '  ← DROPPED by the validator' : ''}`);
    console.log(`      ${r.j ? r.j.reason : 'no answer'}`);
  }

  console.log(`\n-- over ${rows.length} passages, floor ${FLOOR} --------------------------`);
  console.log(`  right, and a row proposed        ${right}`);
  console.log(`  WRONG, and a row proposed        ${wrong}   <- the deciding number`);
  console.log(`  answerable, left unattached      ${missed}   <- costs a nickname, nothing more`);
  console.log(`  unanswerable, correctly held     ${held}`);
  console.log(`  answers dropped by the validator ${dropped}`);

  const conf = (pred) => rows.filter((r) => r.j && r.j.referent !== 'unclear' && pred(r))
    .map((r) => r.j.confidence);
  const trueNamed = conf((r) => r.j.referent === r.c.expect);
  const falseNamed = conf((r) => r.j.referent !== r.c.expect);
  console.log(`\n  confidence, CORRECT referents : [${trueNamed.join(', ') || '-'}]`);
  console.log(`  confidence, WRONG referents   : [${falseNamed.join(', ') || '-'}]`);
  const minT = trueNamed.length ? Math.min(...trueNamed) : null;
  const maxF = falseNamed.length ? Math.max(...falseNamed) : null;
  console.log('');
  if (maxF === null) console.log('  OK  nothing wrong was ever named.');
  else if (minT !== null && maxF < minT) console.log(`  ** A THRESHOLD SEPARATES THEM: wrong <= ${maxF} < ${minT} <= right.`);
  else console.log(`  ** NO THRESHOLD SEPARATES THEM: a wrong answer at ${maxF} sits at or above a right one at ${minT}.`);

  const answers = new Set(rows.filter((r) => r.j).map((r) => r.j.referent));
  console.log(`\n  distinct answers produced: ${[...answers].join(', ') || 'none'}`);
  console.log('  (one distinct answer means the model is not reading, it is defaulting)');
  console.log('\n* SHIP CONDITION: wrong-and-proposed = 0, at least two right, and "unclear"');
  console.log('  among the answers produced. Zero wrong with zero right means the layer does');
  console.log('  nothing and should be dropped rather than shipped as decoration.');

  await callBridge('assistantUnload');
  app.exit(0);
}

app.whenReady().then(() => main().catch((e) => { console.error(e); app.exit(1); }));
