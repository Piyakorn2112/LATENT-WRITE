/**
 * probe-think-ask.cjs — the two-phase think-then-constrain ask on the real 4B.
 *
 * The "what did Tim do to Annaha in this chapter" shape: entities typed
 * lowercase, evidence scattered across the chapter, none of it in the
 * clicked paragraph. Drives the REAL pack builder (mentions rung), a REAL
 * freeText reasoning pass (grammar-less, stopped at </think>), then the
 * constrained ask with the notes — plus a no-think control arm.
 *
 * Run: ./node_modules/.bin/electron scripts/probe-think-ask.cjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

app.setName('Latent Write');
const ROOT = path.join(__dirname, '..');
const NODE = '/opt/homebrew/bin/node';
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

const CHAPTER = [
  'The tide was already turning when the crew came down to the boats.',
  'Tim was the last one down the ramp, and he did not look at anyone.',
  'The morning work went slowly. The nets were stiff with salt and the winch kept slipping.',
  'When the winch jammed a third time, Tim shouted at Annaha in front of the whole crew, and she set down the line and looked at him until he stopped.',
  'Nobody spoke for a while after that. The gulls had the harbour to themselves.',
  'At midday Annaha took her bread to the far end of the quay and ate alone.',
  'Tim found her there. He sat down without asking, and after a while he put his half of the loaf on the paper between them.',
  'They walked back together when the bell went, not talking, not needing to.',
];
const CLICKED = 4; // "Nobody spoke for a while..." — the evidence is elsewhere.
const QUESTION = 'what did tim do to annaha in this chapter';

function buildPack() {
  return JSON.parse(execFileSync(NODE, [TSX, '-e', `
    import { buildMaxAskPack, buildMaxAskRequest, questionEntities } from "./src/lib/max-ask";
    import { decideAskThinking } from "./src/lib/think";
    const input = {
      paragraph: ${JSON.stringify(CHAPTER[CLICKED])},
      paragraphIndex: ${CLICKED},
      chapterNumber: 3,
      kind: "question",
      question: ${JSON.stringify(QUESTION)},
      chapterParagraphs: ${JSON.stringify(CHAPTER)},
      present: [],
      worldData: { characters: [], places: [], factions: [], entities: [] },
    };
    const entities = questionEntities(input);
    const pack = buildMaxAskPack(input);
    const req = buildMaxAskRequest(pack, undefined, "question");
    const decision = decideAskThinking("question", input.question, entities.length);
    console.log(JSON.stringify({ entities, rungs: pack.rungsIncluded, req, decision }));
  `], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop());
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
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
      preload: path.join(ROOT, 'electron', 'preload.cjs') },
  });
  await win.loadURL('about:blank');
  const status = await callBridge('assistantStatus', { tier: 'max' });
  if (!status.model.present) { console.log('SKIP — max model not on disk.'); app.exit(0); return; }
  console.log(`model: ${status.model.id}\n`);

  const { entities, rungs, req, decision } = buildPack();
  console.log(`entities: ${entities.join(', ')} · rungs: ${rungs.join(',')}`);
  console.log(`decision: think=${decision.think} budget=${decision.budget} (${decision.reason})\n`);

  // ── control arm: constrained ask, no notes ──
  const t0 = Date.now();
  const control = await callBridge('assistantRun', {
    requestId: 'ta-control', task: 'max-ask', tier: 'max', noThink: false, contextSize: 8192,
    systemPrompt: req.systemPrompt, userText: req.userText,
    schema: req.schema, maxTokens: req.maxTokens, timeoutMs: 120000,
  });
  console.log(`CONTROL (no think) ${Date.now() - t0}ms · basis=${control.json?.basis}`);
  console.log(`  ${control.json?.answer}\n`);

  // ── think pass: grammar-less, stopped at </think> ──
  const t1 = Date.now();
  const think = await callBridge('assistantRun', {
    requestId: 'ta-think', task: 'max-ask', tier: 'max', noThink: false, contextSize: 8192,
    freeText: true, stopTexts: ['</think>'],
    systemPrompt: req.systemPrompt, userText: req.userText,
    maxTokens: decision.budget, timeoutMs: 120000,
  });
  const notes = String(think.json?.text ?? '').replace(/^[\s\S]*?<think>/, '').replace(/<\/think>[\s\S]*$/, '').trim();
  console.log(`THINK ${Date.now() - t1}ms · ${think.timings?.tokens} tok · notes ${notes.length} chars`);
  console.log(`  notes head: ${notes.slice(0, 220).replace(/\n/g, ' ')}\n`);
  if (!think.ok || notes.length < 40) { console.log('THINK PASS FAILED OR EMPTY'); app.exit(1); return; }

  // ── the ask, with notes ──
  const t2 = Date.now();
  const treated = await callBridge('assistantRun', {
    requestId: 'ta-treated', task: 'max-ask', tier: 'max', noThink: false, contextSize: 8192,
    systemPrompt: req.systemPrompt,
    userText: `${req.userText}\n\nYOUR NOTES — you already thought this through; use these conclusions:\n${notes.slice(0, 2400)}`,
    schema: req.schema, maxTokens: req.maxTokens, timeoutMs: 120000,
  });
  console.log(`TREATED (with notes) ${Date.now() - t2}ms · basis=${treated.json?.basis}`);
  console.log(`  ${treated.json?.answer}\n`);

  const okBasis = ['mentions', 'passage', 'neighbours', 'opening'].includes(String(treated.json?.basis));
  const namesBoth = /shout/i.test(String(treated.json?.answer)) && /(bread|loaf|sat)/i.test(String(treated.json?.answer));
  console.log(`gates: basis-grounded=${okBasis} · covers-both-beats=${namesBoth}`);
  console.log(namesBoth && okBasis ? 'ALL GATES GREEN' : 'REVIEW BY HAND');
  await callBridge('assistantUnload');
  app.exit(0);
}

app.whenReady().then(() => main().catch((e) => { console.error(e); app.exit(1); }));
