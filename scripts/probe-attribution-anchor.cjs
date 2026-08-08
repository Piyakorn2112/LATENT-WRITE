/**
 * probe-attribution-anchor.cjs — does the tie-break task read, or does it agree?
 *
 * The live harness caught the attribution task answering with the engine's own
 * guess on a case where both the alternation rule AND the reply rule point the
 * other way, with confidence 1.0 and a reason asserting the line "names the
 * speaker" when it names nobody. That is the shape of ANCHORING, not of
 * reasoning, and the prompt gives it two anchors at once:
 *
 *   1. the engine's answer is printed FIRST in the offered list, and
 *   2. it is annotated "(the current answer — an earlier guess)".
 *
 * This separates them. Four variants × five determinate cases, where the right
 * answer is fixed by the prose and the ONLY thing that moves is where the
 * incumbent sits and how it is labelled.
 *
 * ★★ THE ANCHORING HYPOTHESIS IS FALSIFIED, AND THAT IS THE RESULT. Removing
 *    both anchors changes nothing: the same case is right and the same cases
 *    wrong in all four presentations, and WRONG-APPLIED never drops below 3 of
 *    5. What the reasons show is a model asserting evidence that is not there
 *    and inverting the reply direction. The task was withdrawn from the sweep
 *    on this measurement — see the ★★ atop src/lib/attribution-review.ts, which
 *    also states what has to measure true to wire it back.
 *
 * ★ A PROBE, NOT A GATE. It hand-builds the USER turn, which a gate must never
 *   do. Run it against any candidate model before wiring the task back.
 *
 * ★ THE CASES ARE DETERMINATE AND FABRICATED. Each has one answer the prose
 *   fixes, so "which variant is right more often" is a real question, and no
 *   name here exists outside this file.
 *
 * Run: ./node_modules/.bin/electron scripts/probe-attribution-anchor.cjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

app.setName('Latent Write');

const ROOT = path.join(__dirname, '..');
const NODE = '/opt/homebrew/bin/node';
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

// ── cases: the prose fixes the answer, and it is never the incumbent ───────
// Each is a two-hander where the engine has guessed WRONG. If the model reads,
// it overturns; if it anchors, it agrees. A case where the incumbent happened
// to be right would not separate those at all.
const CASES = [
  {
    id: 'barge',
    before: [
      '¶2  “You signed for the second load,” she said.',
      '¶3  Ferren Ash turned a page over without looking up from it.',
    ],
    line: 'I signed for what came off the barge.',
    lastSpeaker: 'Marda Kelp',
    incumbent: 'Marda Kelp',
    other: 'Ferren Ash',
    answer: 'Ferren Ash',
  },
  {
    id: 'gate',
    before: [
      '¶8   Sefa Dray put both hands flat on the gate and would not move them.',
      '¶9   “You will open it or I will,” Sefa said.',
      '¶10  Corun Vale looked at the hinge, and then at her.',
    ],
    line: 'You will do neither, and you know why.',
    lastSpeaker: 'Sefa Dray',
    incumbent: 'Sefa Dray',
    other: 'Corun Vale',
    answer: 'Corun Vale',
  },
  {
    id: 'ledger',
    before: [
      '¶4  Iskra Bene closed the ledger and held it against her chest.',
      '¶5  “Nobody reads this but me,” Iskra said.',
      '¶6  Tolm Vare had already put his coat on.',
    ],
    line: 'Then nobody has read it in four years.',
    lastSpeaker: 'Iskra Bene',
    incumbent: 'Iskra Bene',
    other: 'Tolm Vare',
    answer: 'Tolm Vare',
  },
  // ── the other direction ────────────────────────────────────────────────
  // ★ WITHOUT THESE THE PROBE MEASURES A BIAS, NOT A SKILL. Every case above
  //   has an answer that is NOT the incumbent, so "always overturn" scores
  //   3/3 on them while being exactly as blind as "always agree". Here the
  //   prose puts the incumbent in the right, and a variant that overturns
  //   anyway is not reading either.
  {
    id: 'named+',
    before: [
      '¶3  The window had been open since morning and nobody had said anything about it.',
      '¶4  Wick Odlum put down the crate he was carrying.',
    ],
    line: 'Somebody is going to catch their death in here.',
    lastSpeaker: 'Marda Kelp',
    incumbent: 'Wick Odlum',
    other: 'Marda Kelp',
    answer: 'Wick Odlum',
    note: 'the prose names him doing the business the line comes out of',
  },
  {
    id: 'continues+',
    before: [
      '¶6  “I have read the whole of it,” Bern Halloway said, and did not put it down.',
      '¶7  He turned the page back and read the top of it again, slower.',
    ],
    line: 'And I will read it again before I put my name anywhere near it.',
    lastSpeaker: 'Bern Halloway',
    incumbent: 'Bern Halloway',
    other: 'Ivo Trace',
    answer: 'Bern Halloway',
    note: 'one speaker continuing through his own beat — alternation is WRONG here',
  },
];

/** The four ways of presenting the same two names. */
const VARIANTS = [
  {
    id: 'A-incumbent-first-annotated',
    note: 'shipping today',
    names: (c) => [
      `  - ${c.incumbent}   (the current answer — an earlier guess)`,
      `  - ${c.other}`,
    ],
  },
  {
    id: 'B-incumbent-first-plain',
    note: 'position anchor only',
    names: (c) => [`  - ${c.incumbent}`, `  - ${c.other}`],
  },
  {
    id: 'C-incumbent-last-annotated',
    note: 'label anchor only',
    names: (c) => [
      `  - ${c.other}`,
      `  - ${c.incumbent}   (the current answer — an earlier guess)`,
    ],
  },
  {
    id: 'D-alphabetical-unmarked',
    note: 'neither anchor — the engine guess is not identifiable',
    names: (c) => [c.incumbent, c.other].sort((a, b) => a.localeCompare(b)).map((n) => `  - ${n}`),
  },
];

const buildUserText = (c, variant) => [
  'PARAGRAPH 4, LINE 0',
  '',
  'PROSE IMMEDIATELY BEFORE',
  ...c.before.map((l) => `  ${l}`),
  '',
  'THE LINE',
  `  ${c.line}`,
  '',
  'WHO SPOKE THE LINES BEFORE IT (dialogue alternates)',
  `  one line back: ${c.lastSpeaker}`,
  '',
  'THE NAMES YOU MAY CHOOSE BETWEEN',
  ...variant.names(c),
  '  - unsure   (say this whenever the evidence does not single out one name)',
  '',
  'Who speaks the line?',
].join('\n');

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

  // ★ THE PROMPT AND SCHEMA COME FROM THE MODULE, NEVER FROM A COPY HERE. The
  //   probe varies the USER turn only; a system-prompt edit is reflected on the
  //   next run. Electron cannot import TypeScript, so this reads them out
  //   through tsx — the same rule the fixture emitter follows.
  const dumped = execFileSync(NODE, [TSX, '-e',
    'import {ATTRIBUTION_SYSTEM, ATTRIBUTION_SCHEMA, ATTRIBUTION_MIN_CONFIDENCE} ' +
    'from "./src/lib/attribution-review";' +
    'console.log(JSON.stringify({ATTRIBUTION_SYSTEM, ATTRIBUTION_SCHEMA, ATTRIBUTION_MIN_CONFIDENCE}))',
  ], { cwd: ROOT, encoding: 'utf8' });
  const mod = JSON.parse(dumped.trim().split('\n').pop());
  const systemPrompt = mod.ATTRIBUTION_SYSTEM;
  const schema = mod.ATTRIBUTION_SCHEMA;
  // ★ TIER IS AN INPUT, because this probe's whole job is to be re-run against
  //   a candidate model. Defaulting to the small tier keeps every historical
  //   number comparable; PROBE_TIER=max runs the 4B with the REGISTRY's max
  //   config (noThink false, 8k context) rather than silently applying the
  //   small tier's settings to different weights, which is what makes an
  //   ASSISTANT_MODEL_PATH swap alone a misleading comparison.
  const TIER = process.env.PROBE_TIER === 'max' ? 'max' : undefined;
  // ★ `/no_think` IS A QWEN TOKEN, NOT A UNIVERSAL ONE. The host appends it to
  //   the system prompt whenever noThink is true, which is right for Qwen3 and
  //   is literal junk in a Granite or Gemma prompt. Any non-Qwen candidate must
  //   be run with PROBE_NOTHINK=0 or it is being handicapped, not measured.
  const NO_THINK = process.env.PROBE_NOTHINK === '0' ? { noThink: false } : {};
  // A thinking model spends tokens before it emits, so the cap has to move with
  // the tier or the budget is gone before the JSON starts.
  const maxTokens = Number(process.env.PROBE_MAX_TOKENS) || (TIER === 'max' ? 1024 : 128);
  const MIN = mod.ATTRIBUTION_MIN_CONFIDENCE;
  console.log(`  model tier: ${TIER || 'small (default)'} · maxTokens ${maxTokens}`);

  const tally = new Map(VARIANTS.map((v) => [v.id, { right: 0, wrongApplied: 0, declined: 0 }]));

  for (const variant of VARIANTS) {
    console.log(`\n══ ${variant.id}  — ${variant.note}`);
    for (const c of CASES) {
      const res = await callBridge('assistantRun', {
        requestId: `anchor-${variant.id}-${c.id}`,
        task: 'attribution-review',
        systemPrompt,
        userText: buildUserText(c, variant),
        schema, maxTokens, timeoutMs: 180_000,
        ...(TIER ? { tier: TIER } : {}), ...NO_THINK,
      });
      const json = res && res.ok ? res.json : null;
      const said = json && typeof json.speaker === 'string' ? json.speaker.trim() : '';
      const confident = !!json && typeof json.confidence === 'number' && json.confidence >= MIN;
      // What the APP would apply: an offered name at or above the floor.
      const applied = confident && (said === c.incumbent || said === c.other) ? said : null;

      const t = tally.get(variant.id);
      if (applied === c.answer) t.right++;
      else if (applied === null) t.declined++;
      else t.wrongApplied++;

      const mark = applied === c.answer ? '✓' : applied === null ? '·' : '✗';
      console.log(`  ${mark} ${c.id.padEnd(10)} answer=${c.answer.padEnd(14)} ` +
        `said=${(said || 'none').padEnd(14)} @${json ? json.confidence : '—'}` +
        `${applied === null ? '  (declined — engine keeps its guess)' : ''}`);
      console.log(`      reason: ${json ? JSON.stringify(json.reason) : (res && res.error)}`);
    }
  }

  console.log(`\n── tally over ${CASES.length} determinate cases ──────────────────────`);
  console.log(`  ${'variant'.padEnd(30)} ${'right'.padStart(6)} ${'declined'.padStart(9)} ${'WRONG-APPLIED'.padStart(14)}`);
  for (const v of VARIANTS) {
    const t = tally.get(v.id);
    console.log(`  ${v.id.padEnd(30)} ${String(t.right).padStart(6)} ${String(t.declined).padStart(9)} ${String(t.wrongApplied).padStart(14)}`);
  }
  console.log('\n  ★ WRONG-APPLIED is the column that matters. A declined answer costs');
  console.log('    nothing — the engine keeps its own attribution. A confident wrong');
  console.log('    one is offered to the writer as the model\'s reading of the line.');

  await callBridge('assistantUnload');
  app.exit(0);
}

app.whenReady().then(() => main().catch((e) => { console.error(e); app.exit(1); }));
