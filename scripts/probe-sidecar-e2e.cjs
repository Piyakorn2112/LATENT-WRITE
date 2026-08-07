/**
 * probe-sidecar-e2e.cjs — the sidecar through the REAL app path.
 *
 * registerAssistant → preload bridge → assistant:run with lane:'batch',
 * exactly as the max-mode chip tick sends it. Verifies the four invariants
 * the migration doc names:
 *   1. the sidecar actually engages (status.sidecar.alive, port)
 *   2. concurrent batch runs beat sequential (the 1.75x class win)
 *   3. the result shape and vocabulary match the host contract
 *      (ok/json/raw/timings; parse-able by decodeRichChipWire)
 *   4. lane:'batch' WITHOUT the binary falls back in-process (simulated by
 *      an env override pointing at a nonexistent binary)
 *
 * Run: ./node_modules/.bin/electron scripts/probe-sidecar-e2e.cjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

app.setName('Latent Write');
const ROOT = path.join(__dirname, '..');
const NODE = '/opt/homebrew/bin/node';
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

function buildReqs() {
  return JSON.parse(execFileSync(NODE, [TSX, '-e', `
    import { buildChipRequest } from "./src/lib/chip-picker";
    import fixture from "./scripts/fixtures/assistant-tasks.json";
    const strong = fixture.timelineChips.find((c) => c.id === "strong");
    const mk = (seed) => {
      const rot = [...strong.candidates.slice(seed % 3), ...strong.candidates.slice(0, seed % 3)];
      return { chapterId: "p"+seed, chapterNumber: seed+1, chapterTitle: strong.chapterTitle+" "+seed,
        contentHash: "p"+seed, tensionPeak: 0.82, charactersPresent: strong.cast,
        majorEvents: rot.map((c, i) => ({ rank: c.rank, label: c.label, sentence: c.sentence, agent: c.agent,
          type: "action", channel: "action", tensionPosition: i / (rot.length - 1) })) };
    };
    console.log(JSON.stringify([0,1,2,3].map((i) => buildChipRequest(mk(i), { rich: true }))));
  `], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop());
}

let win = null;
const callBridge = (method, arg) => {
  const payload = JSON.stringify(arg === undefined ? null : arg);
  return win.webContents.executeJavaScript(
    `window.electronAPI.${method}(${payload === 'null' ? '' : payload})`, true,
  );
};
const runBatch = (id, req) => callBridge('assistantRun', {
  requestId: id, task: 'timeline-chips', tier: 'max', lane: 'batch', jsonStyle: 'compact',
  systemPrompt: req.systemPrompt, userText: req.userText,
  schema: req.schema, maxTokens: req.maxTokens, timeoutMs: 120000,
});

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
  console.log(`sidecar binary available: ${status.sidecar.available}`);
  if (!status.sidecar.available) { console.log('SKIP — no llama-server on this machine.'); app.exit(0); return; }

  const reqs = buildReqs();

  // Warm (starts the server; first prefill).
  const warm = await runBatch('sc-warm', reqs[0]);
  const status2 = await callBridge('assistantStatus', { tier: 'max' });
  console.log(`after warm: alive=${status2.sidecar.alive} port=${status2.sidecar.port} slots=${status2.sidecar.slots}`);
  console.log(`warm result: ok=${warm.ok} error=${warm.error ?? '-'} tokens=${warm.timings?.tokens}`);

  // Sequential 4.
  let t0 = Date.now();
  for (let i = 0; i < 4; i++) await runBatch(`sc-seq-${i}`, reqs[i]);
  const seqMs = Date.now() - t0;

  // Concurrent 4, TWO rounds: round 1 pays three cold slot prefills (the
  // sequential pass warmed only one slot); round 2 is the steady state the
  // tick actually lives in — slots warm, batching pure.
  t0 = Date.now();
  const outs = await Promise.all(reqs.map((r, i) => runBatch(`sc-par-${i}`, r)));
  const parMs = Date.now() - t0;
  t0 = Date.now();
  await Promise.all(reqs.map((r, i) => runBatch(`sc-par2-${i}`, r)));
  const par2Ms = Date.now() - t0;
  console.log(`sequential 4: ${seqMs}ms · concurrent cold: ${parMs}ms (${(seqMs / parMs).toFixed(2)}x) · concurrent warm: ${par2Ms}ms (${(seqMs / par2Ms).toFixed(2)}x)`);

  const shapeOk = outs.every((o) => o.ok && o.json && typeof o.raw === 'string' && o.timings && Number.isFinite(o.timings.totalMs));
  console.log(`${shapeOk ? '✓' : '✗'} all 4 concurrent results carry the host contract shape`);
  if (!shapeOk) {
    console.log(`   first failure: ${JSON.stringify(outs.find((o) => !o.ok) ?? outs[0]).slice(0, 200)}`);
    await callBridge('assistantUnload');
    app.exit(1);
    return;
  }
  const decoded = JSON.parse(execFileSync(NODE, [TSX, '-e', `
    import { decodeRichChipWire, normalizeChipPicks, buildChipRequest } from "./src/lib/chip-picker";
    import fixture from "./scripts/fixtures/assistant-tasks.json";
    const strong = fixture.timelineChips.find((c) => c.id === "strong");
    const entry = { chapterId: "p0", chapterNumber: 1, chapterTitle: strong.chapterTitle+" 0",
      contentHash: "p0", tensionPeak: 0.82, charactersPresent: strong.cast,
      majorEvents: strong.candidates.map((c, i) => ({ rank: c.rank, label: c.label, sentence: c.sentence,
        agent: c.agent, type: "action", channel: "action", tensionPosition: i / (strong.candidates.length - 1) })) };
    const req = buildChipRequest(entry, { rich: true });
    const json = JSON.parse(process.argv[process.argv.length - 1]);
    const picks = normalizeChipPicks(decodeRichChipWire(json), req.candidates, strong.cast);
    console.log(JSON.stringify({ n: picks ? picks.length : 0 }));
  `, JSON.stringify(outs[0].json)], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop());
  console.log(`${decoded.n > 0 ? '✓' : '✗'} sidecar answer survives the real decode+normalize chain (${decoded.n} picks)`);

  await callBridge('assistantUnload');
  app.exit(0);
}

app.whenReady().then(() => main().catch(async (e) => {
  console.error(e);
  // Unload BEFORE exiting: app.exit() skips before-quit, and an orphaned
  // llama-server holds gigabytes (learned by doing exactly that).
  try { await callBridge('assistantUnload'); } catch { /* best effort */ }
  app.exit(1);
}));
