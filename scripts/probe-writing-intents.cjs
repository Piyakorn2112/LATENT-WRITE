/**
 * probe-writing-intents.cjs — the NEW intent prompts on the real 4B.
 *
 * Structural (STRUCTURE_SYSTEM), insert (INSERT_SYSTEM) and the retuned tone
 * gate, driven through the REAL classifyInstruction → buildWritingRequest →
 * judgeRevision chain. When attempt 0 fails its gate, the probe performs ONE
 * diagnosed retry exactly as runWritingTool would (the failure detail on the
 * user turn) — so what is measured includes whether verifier feedback
 * actually repairs the answer on this model.
 *
 * ★ THIS PROBE DOES NOT AUTO-GRADE PROSE. The gate says "safe to ship";
 *   whether the revision is GOOD is judged by reading the output.
 *
 * Run: ./node_modules/.bin/electron scripts/probe-writing-intents.cjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

app.setName('Latent Write');
const ROOT = path.join(__dirname, '..');
const NODE = '/opt/homebrew/bin/node';
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

const TWO_PARA =
  'The morning was grey and the rain was falling from the sky. Mara stood on the deck drinking her coffee and watching the water move under the hull.\n\n' +
  'Teo arrived at the dock at nine. He was late again, and he did not apologise, and Mara decided not to mention it this time.';

const ONE_LONG =
  'Mara went down into the hold with the lamp held high, and the light moved over the crates and the coiled rope and the old nets, and she counted the boxes twice because the number felt wrong, and when she came back up the ladder Teo was waiting at the hatch with the manifest in his hand and a question already forming, and she told him the count before he could ask it, and neither of them said what they were both thinking about the missing crate.';

// A realistic split target: multiple sentences with a clear turn. (The
// run-on above stays as the CONDENSE fixture — one sentence with no seam is
// a restructuring ask, not a split.)
const SPLITTABLE =
  'Mara went down into the hold with the lamp held high. The light moved over the crates and the coiled rope, and she counted the boxes twice because the number felt wrong. When she came back up the ladder, Teo was waiting at the hatch with the manifest in his hand. She told him the count before he could ask, and neither of them said what they were both thinking.';

const JOHN_PARA =
  'John pushed the boat off the ramp and watched the tide take it. When the rope went taut, John waded in after it up to his knees. By the time the sail caught, John was laughing, and Mara had never once seen John laugh on the water.';

const SWORD_PARA =
  'Teo lifted the sword from the crate and turned it in the light. The sword was older than the manifest said, and the grip had been rewrapped twice. He set the sword down carefully and did not mention it to Mara.';

const SUDDEN_PARA =
  'Suddenly the wind died. Mara looked up suddenly from the chart, and the lamp guttered suddenly in the still air.';

const CASES = [
  { id: 'pronounize', instruction: 'replace John with a pronoun', text: JOHN_PARA },
  { id: 'substitute', instruction: 'replace the sword with a dagger', text: SWORD_PARA },
  { id: 'reduce', instruction: 'stop repeating the word suddenly', text: SUDDEN_PARA },
  { id: 'merge', instruction: 'merge these two paragraphs into one', text: TWO_PARA },
  { id: 'merge-shorter', instruction: 'merge these two paragraphs and make them shorter', text: TWO_PARA },
  { id: 'split', instruction: 'split this into two paragraphs', text: SPLITTABLE },
  { id: 'split-runon', instruction: 'split this into two paragraphs', text: ONE_LONG },
  { id: 'condense-half', instruction: 'make it half as long', text: ONE_LONG },
  { id: 'insert-action', instruction: 'add a short action scene where Mara nearly falls from the ladder', text: TWO_PARA },
  { id: 'tone-funny', instruction: 'make it funny', text: TWO_PARA.split('\n\n')[1] },
];

/** Module-side helpers: requests, classification and judging are REAL code. */
function mod(op, payload) {
  return JSON.parse(execFileSync(NODE, [TSX, '-e', `
    import { buildWritingRequest, gateProfileFor, judgeRevision, fromWire, matchQuoteStyle, unchangedRetryNote } from "./src/lib/writing-tool";
    import { classifyInstruction } from "./src/lib/writing-intent";
    const a = JSON.parse(process.argv[process.argv.length - 1]);
    const reading = classifyInstruction(a.instruction);
    let out;
    if (a.op === "build") {
      const structural = ["merge", "split", "insert"].includes(reading.intent) ||
        (reading.intent === "condense" && reading.targetParas !== undefined);
      const batch = { index: 0, text: a.text, sep: "" };
      out = {
        reading, structural,
        req: buildWritingRequest("custom", batch, {
          before: a.before ?? "", revisedTail: "", instruction: a.instruction,
          reading, retryNote: a.retryNote ?? undefined,
        }),
      };
    } else {
      const restored = matchQuoteStyle(a.original, fromWire(a.revised));
      const verdict = judgeRevision(a.original, restored, gateProfileFor("custom", reading));
      out = { restored, verdict, unchangedNote: unchangedRetryNote(reading) };
    }
    console.log(JSON.stringify(out ?? null));
  `, JSON.stringify({ op, ...payload })], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop());
}

let win = null;
const callBridge = (method, arg) => {
  const payload = JSON.stringify(arg === undefined ? null : arg);
  return win.webContents.executeJavaScript(
    `window.electronAPI.${method}(${payload === 'null' ? '' : payload})`, true,
  );
};

async function runCase(c) {
  let retryNote;
  // Three attempts, the LAST sampled — the exact ladder runWritingTool runs
  // (greedy is deterministic: a diagnosed retry alone can reproduce the same
  // refusal byte-for-byte, which is what the sampled attempt exists to break).
  for (let attempt = 0; attempt < 3; attempt++) {
    const { reading, req } = mod('build', { text: c.text, instruction: c.instruction, retryNote });
    const sampled = attempt === 2;
    const t0 = Date.now();
    const res = await callBridge('assistantRun', {
      requestId: `wi-${c.id}-a${attempt}`, task: 'writing-tool', tier: 'max', jsonStyle: 'compact',
      systemPrompt: req.systemPrompt, userText: req.userText,
      schema: req.schema, maxTokens: req.maxTokens, timeoutMs: 150000,
      ...(sampled ? { temperature: 0.7, minP: 0.05 } : {}),
    });
    const ms = Date.now() - t0;
    if (attempt === 0) console.log(`── ${c.id}  ("${c.instruction}")  intent=${reading.intent}${reading.targetParas ? ` target=${reading.targetParas}` : ''}`);
    if (!res.ok) { console.log(`   a${attempt}: FAILED ${res.error} (${ms}ms)\n`); return { shipped: false }; }
    const revised = typeof res.json?.text === 'string' ? res.json.text : '';
    const { restored, verdict, unchangedNote } = mod('judge', { original: c.text, revised, instruction: c.instruction });
    const unchanged = restored.trim() === c.text.trim() || restored.trim() === '';
    console.log(`   a${attempt}${sampled ? ' (sampled)' : ''}: ${ms}ms · ${res.timings?.tokens} tok · gate=${unchanged ? 'UNCHANGED' : verdict.ok ? 'ACCEPT' : `REFUSE(${verdict.failure.code})`}${retryNote ? ' [diagnosed retry]' : ''}`);
    if (!unchanged && verdict.ok) {
      console.log(`   BEFORE: ${c.text.replace(/\n/g, '\\n')}`);
      console.log(`   AFTER:  ${restored.replace(/\n/g, '\\n')}\n`);
      return { shipped: true, repaired: attempt > 0 };
    }
    retryNote = unchanged ? unchangedNote : verdict.failure.detail;
    console.log(`   diagnosis: ${retryNote}`);
  }
  console.log('   NOT SHIPPED after diagnosed retry\n');
  return { shipped: false };
}

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

  let shipped = 0, repaired = 0;
  for (const c of CASES) {
    const r = await runCase(c);
    if (r.shipped) shipped++;
    if (r.repaired) repaired++;
  }
  console.log(`SUMMARY: ${shipped}/${CASES.length} shipped (${repaired} via diagnosed retry)`);
  await callBridge('assistantUnload');
  app.exit(0);
}

app.whenReady().then(() => main().catch((e) => { console.error(e); app.exit(1); }));
