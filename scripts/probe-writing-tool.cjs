/**
 * probe-writing-tool.cjs — the writing tool's prompts on the real 4B.
 *
 * Six deliberately different cases through the REAL buildWritingRequest and
 * the real host (tier max, compact grammar), each judged two ways: the
 * module's own acceptance gate, and a hand-readable before/after print.
 *
 * ★ THIS PROBE DOES NOT AUTO-GRADE PROSE. The gate says "safe to ship";
 *   whether the revision is GOOD is judged by reading the output.
 *
 * Run: ./node_modules/.bin/electron scripts/probe-writing-tool.cjs
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
  {
    id: 'proofread-typos', op: 'proofread',
    before: 'The harbour was quiet that morning.',
    text: 'Mara walked to teh boathouse and and found the the door unlocked. She new the lock had been changed last week, and it made her uneasy. the key was still hanging were it always hung.',
  },
  {
    id: 'proofread-clean', op: 'proofread',
    before: 'The harbour was quiet that morning.',
    text: 'Mara walked to the boathouse and found the door unlocked. She knew the lock had been changed last week, and it made her uneasy.',
  },
  {
    id: 'proofread-dialect', op: 'proofread',
    before: 'Teo leaned against the rail.',
    text: '"I ain\'t got nothin\' to say about that paper," Teo said. "Renner can come ask me hisself." Mara watched him go, and the gulls wheeled over teh empty deck.',
  },
  {
    id: 'rewrite-clumsy', op: 'rewrite',
    before: 'The estate agent had already called twice.',
    text: 'The house was big and it was old and it was also very cold inside of it. Mara walked into the house and she looked around the house and she thought about how the house had been her aunt\'s house for forty years.',
  },
  {
    id: 'custom-tense', op: 'custom', instruction: 'make this moment feel more tense and urgent',
    before: 'The tide had turned an hour ago.',
    text: 'Mara heard a noise from the wheelhouse. She went up the steps and opened the door. The logbook was on the floor and the window was open.',
  },
  {
    id: 'rewrite-2para', op: 'rewrite',
    before: '',
    text: 'The morning was grey and the rain was falling down from the sky above. Mara stood on the deck and she was drinking her coffee while she was standing there.\n\nTeo arrived at the dock at nine. He was late again and he had been late the day before as well and also the day before that.',
  },
];

function mod(op, payload) {
  return JSON.parse(execFileSync(NODE, [TSX, '-e', `
    import { planWritingBatches, buildWritingRequest, revisionAcceptable, hardErrorCount, fromWire, matchQuoteStyle } from "./src/lib/writing-tool";
    const a = JSON.parse(process.argv[process.argv.length - 1]);
    let out;
    if (a.op === "build") {
      const [batch] = planWritingBatches(a.text);
      out = buildWritingRequest(a.wop, batch, { before: a.before, revisedTail: "", instruction: a.instruction });
    } else if (a.op === "judge") {
      // Decode exactly as the run loop does: wire restore, then style match.
      const restored = matchQuoteStyle(a.original, fromWire(a.revised));
      out = { restored, acceptable: revisionAcceptable(a.original, restored),
        errBefore: hardErrorCount(a.original), errAfter: hardErrorCount(restored) };
    }
    console.log(JSON.stringify(out ?? null));
  `, JSON.stringify(payload ? { op, ...payload } : { op })], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop());
}

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

  for (const c of CASES) {
    const req = mod('build', { text: c.text, before: c.before, wop: c.op, instruction: c.instruction ?? null });
    const t0 = Date.now();
    const res = await callBridge('assistantRun', {
      requestId: `wt-${c.id}`, task: 'writing-tool', tier: 'max', jsonStyle: 'compact',
      systemPrompt: req.systemPrompt, userText: req.userText,
      schema: req.schema, maxTokens: req.maxTokens, timeoutMs: 120000,
    });
    const ms = Date.now() - t0;
    console.log(`── ${c.id}  (${c.op}${c.instruction ? `: "${c.instruction}"` : ''})  ${ms}ms`);
    if (!res.ok) { console.log(`   FAILED: ${res.error}\n`); continue; }
    const revised = typeof res.json?.text === 'string' ? res.json.text : '';
    const judge = mod('judge', { original: c.text, revised });
    console.log(`   gate=${judge.acceptable ? 'ACCEPT' : 'REFUSE'} hardErrors ${judge.errBefore} -> ${judge.errAfter} · ${res.timings?.tokens} tok · ${res.timings?.genMs}ms gen · stop=${res.stopReason} rawHead=${JSON.stringify(String(res.raw || '').slice(0, 90))}`);
    console.log(`   BEFORE: ${c.text.replace(/\n/g, '\\n')}`);
    console.log(`   AFTER:  ${judge.restored.replace(/\n/g, '\\n')}\n`);
  }
  await callBridge('assistantUnload');
  app.exit(0);
}

app.whenReady().then(() => main().catch((e) => { console.error(e); app.exit(1); }));
