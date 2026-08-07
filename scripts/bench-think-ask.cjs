/**
 * bench-think-ask.cjs — the ask surface's quality-per-token benchmark.
 *
 * A battery of question SHAPES on the real 4B, each with deterministic
 * expectations, run through the REAL decision ladder. Cases the ladder
 * sends to thinking run BOTH arms (control = no notes, treated = notes) so
 * every thinking token has a measured justification — "what we pay for".
 *
 * Deterministic gates per case:
 *   · decision  — the ladder chose the expected tier
 *   · mustHit   — keyword(s) the answer needs (evidence actually used)
 *   · abstain   — the honesty case must NOT invent (thinking must not
 *                 cause overreach on absent facts)
 *
 * Run: ./node_modules/.bin/electron scripts/bench-think-ask.cjs
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
const CLICKED = 4;

const CASES = [
  {
    id: 'lookup-who', question: 'who is Tim',
    expectThink: false, mustHit: [/crew|ramp|boat|shout/i],
  },
  {
    id: 'relation-arc', question: 'what did tim do to annaha in this chapter',
    expectThink: true, mustHit: [/shout/i, /loaf|bread|sat|found/i],
  },
  {
    id: 'why-single', question: 'why did annaha eat alone at midday',
    expectThink: true, mustHit: [/shout|winch|crew/i],
  },
  {
    id: 'temporal', question: 'what happened after the winch jammed the third time',
    expectThink: true, mustHit: [/shout/i],
  },
  {
    // "what did X say" is causal-shaped, so the ladder thinks — the gate
    // here is that REASONING MUST NOT CAUSE INVENTION: the fact is absent
    // and the answer must stay an abstention even after a think pass.
    id: 'honesty-absent', question: 'what did the harbourmaster say about the storm',
    expectThink: true, abstain: true,
  },
  {
    id: 'reconcile-how', question: 'how do tim and annaha make peace by the end',
    expectThink: true, mustHit: [/loaf|bread|sat|walked back/i],
  },
];

function mod(op, payload) {
  return JSON.parse(execFileSync(NODE, [TSX, '-e', `
    import { buildMaxAskPack, buildMaxAskRequest, questionEntities, normalizeMaxAsk, coerceProseAbstention, isUsefulAnswer } from "./src/lib/max-ask";
    import { decideAskThinking } from "./src/lib/think";
    const a = JSON.parse(process.argv[process.argv.length - 1]);
    const input = {
      paragraph: ${JSON.stringify(CHAPTER[CLICKED])}, paragraphIndex: ${CLICKED},
      chapterNumber: 3, kind: "question", question: a.question,
      chapterParagraphs: ${JSON.stringify(CHAPTER)}, present: [],
      worldData: { characters: [], places: [], factions: [], entities: [] },
    };
    let out;
    if (a.op === "build") {
      const entities = questionEntities(input);
      const pack = buildMaxAskPack(input);
      out = {
        entities,
        rungs: pack.rungsIncluded,
        req: buildMaxAskRequest(pack, undefined, "question"),
        decision: decideAskThinking("question", a.question, entities.length),
      };
    } else {
      const norm = normalizeMaxAsk(a.raw, a.rungs);
      const ans = norm ? coerceProseAbstention(norm, "question") : null;
      out = { answer: ans, useful: isUsefulAnswer(ans) };
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

async function askOnce(id, req, notes) {
  const t0 = Date.now();
  const res = await callBridge('assistantRun', {
    requestId: id, task: 'max-ask', tier: 'max', noThink: false, contextSize: 8192,
    systemPrompt: req.systemPrompt,
    userText: notes
      ? `${req.userText}\n\nYOUR NOTES — you already thought this through; use these conclusions:\n${notes}`
      : req.userText,
    schema: req.schema, maxTokens: req.maxTokens, timeoutMs: 150000,
  });
  return { res, ms: Date.now() - t0 };
}

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

  let pass = 0, fail = 0, thinkMs = 0, thinkCases = 0, controlAlsoPassed = 0;
  const gate = (ok, label, detail = '') => {
    console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` · ${detail}`}`);
    ok ? pass++ : fail++;
  };

  for (const c of CASES) {
    const { entities, rungs, req, decision } = mod('build', { op: 'build', question: c.question });
    console.log(`── ${c.id}  "${c.question}"`);
    console.log(`   entities=[${entities.join(',')}] think=${decision.think} budget=${decision.budget} (${decision.reason})`);
    gate(decision.think === c.expectThink, `ladder tier matches (${c.expectThink ? 'think' : 'fast'})`, decision.reason);

    let notes = null;
    if (decision.think) {
      const t0 = Date.now();
      const tp = await callBridge('assistantRun', {
        requestId: `bta-${c.id}-think`, task: 'max-ask', tier: 'max', noThink: false, contextSize: 8192,
        freeText: true, stopTexts: ['</think>'],
        systemPrompt: req.systemPrompt, userText: req.userText,
        maxTokens: decision.budget, timeoutMs: 150000,
      });
      thinkMs += Date.now() - t0; thinkCases++;
      const t = String(tp.json?.text ?? '').replace(/^[\s\S]*?<think>/, '').replace(/<\/think>[\s\S]*$/, '').trim();
      notes = t.length >= 40 ? (t.length <= 2400 ? t : t.slice(-2400)) : null;
      gate(notes !== null, 'the think pass produced usable notes', `${t.length} chars`);
    }

    // Control arm always runs (it IS the product for fast cases; for think
    // cases it measures what the thinking bought).
    const control = await askOnce(`bta-${c.id}-ctl`, req, null);
    const treatedRun = decision.think ? await askOnce(`bta-${c.id}-trt`, req, notes) : control;
    const judged = mod('judge', { op: 'judge', question: c.question, raw: treatedRun.res.json, rungs });
    const judgedCtl = mod('judge', { op: 'judge', question: c.question, raw: control.res.json, rungs });
    const answer = judged.answer?.answer ?? '';

    if (c.abstain) {
      gate(!judged.useful, 'absent facts stay absent (no invention)', `got: ${answer.slice(0, 90)}`);
    } else {
      for (const re of c.mustHit ?? []) {
        gate(re.test(answer), `answer covers ${re}`, answer.slice(0, 120));
      }
      gate(judged.useful, 'answer is useful and grounded', judged.answer?.basis ?? 'null');
    }
    if (decision.think && c.mustHit) {
      const ctlAnswer = judgedCtl.answer?.answer ?? '';
      const ctlCovers = c.mustHit.every((re) => re.test(ctlAnswer)) && judgedCtl.useful;
      if (ctlCovers) controlAlsoPassed++;
      console.log(`   [paid-for check] control ${ctlCovers ? 'ALSO passed (thinking bought nothing here)' : 'missed — thinking earned its tokens'}`);
    }
    console.log(`   answer: ${answer.slice(0, 160)}${treatedRun.ms ? ` (${treatedRun.ms}ms)` : ''}\n`);
  }

  console.log('='.repeat(70));
  console.log(`${pass} passed, ${fail} failed · think passes: ${thinkCases}, ${Math.round(thinkMs / 1000)}s total · control-also-passed: ${controlAlsoPassed}/${thinkCases}`);
  await callBridge('assistantUnload');
  app.exit(fail > 0 ? 1 : 0);
}

app.whenReady().then(() => main().catch((e) => { console.error(e); app.exit(1); }));
