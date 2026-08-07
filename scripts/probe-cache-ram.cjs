/**
 * probe-cache-ram.cjs — does the host-RAM prompt cache actually save
 * re-prefill when task types interleave across slots?
 *
 * Sequence per server: prompt A (cold, full prefill) → 4×B in parallel
 * (every slot now holds B's prefix; A's KV is evicted from slots) → A again.
 * With --cache-ram + idle-slot caching the final A restores its state from
 * host RAM (tiny prompt_n); without, it re-prefills the whole prompt.
 *
 * NEGATIVE CONTROL: the same sequence against a manually spawned server
 * with --cache-ram 0. If both report the same final-A prompt_n, this probe
 * is blind and proves nothing.
 *
 * Run: ./node_modules/.bin/electron scripts/probe-cache-ram.cjs
 */
const { app } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');

app.setName('Latent Write');
const ROOT = path.join(__dirname, '..');
const sidecar = require(path.join(ROOT, 'electron', 'assistant-sidecar.cjs'));

// ~900 tokens: comfortably inside a 2048-token slot WITH its answer.
const FILLER = Array.from({ length: 40 }, (_, i) =>
  `Rule ${i}: the reviewer must check clause ${i} of the manifest against the ledger before approving it.`).join('\n');
const PROMPT_A = `You are reviewer A.\n${FILLER}\nSay OK.`;
const PROMPT_B = `You are reviewer B, a different reviewer.\n${FILLER}\nSay FINE.`;

async function complete(port, prompt) {
  const res = await fetch(`http://127.0.0.1:${port}/completion`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, n_predict: 4, temperature: 0, cache_prompt: true, stream: false }),
  });
  const json = await res.json();
  if (!json.timings) throw new Error(`no timings: ${JSON.stringify(json).slice(0, 200)}`);
  // prompt_n = tokens actually prefilled; cache_n = tokens recovered from
  // cache (slot KV or the host-RAM prompt cache) instead of recomputed.
  return { prefilled: json.timings.prompt_n, cached: json.timings.cache_n ?? 0 };
}

async function sequence(port, label) {
  const coldA = await complete(port, PROMPT_A);
  await Promise.all([1, 2, 3, 4].map((i) => complete(port, `${PROMPT_B}\nSlot ${i}.`)));
  const warmA = await complete(port, PROMPT_A);
  console.log(`${label}: cold A prefilled ${coldA.prefilled} · after 4xB on all slots, A prefilled ${warmA.prefilled} (${warmA.cached} from cache)`);
  return { coldA, warmA };
}

async function main() {
  const modelPath = process.env.ASSISTANT_MODEL_MAX ||
    path.join(app.getPath('userData'), 'models', (() => {
      const fs = require('fs');
      const dir = path.join(app.getPath('userData'), 'models');
      const f = fs.readdirSync(dir).find((n) => /4b/i.test(n) && n.endsWith('.gguf'));
      if (!f) throw new Error('no 4B model in userData/models');
      return f;
    })());

  // The REAL module boots with its real args (--cache-ram 1024 among them).
  const started = await sidecar.ensureStarted({ modelPath, slots: 4, slotContext: 2048, tier: 'max' });
  if (!started.ok) { console.log(`sidecar failed: ${started.error}`); app.exit(1); return; }
  const treated = await sequence(sidecar.status().port, 'cache-ram 1024 (module args)');
  sidecar.stop('probe-done');

  // Negative control: identical server, cache OFF.
  const port = 49111;
  const child = spawn(sidecar.binaryPath(), [
    '-m', modelPath, '-c', String(4 * 2048), '-np', '4', '-fa', 'on',
    '-ctk', 'q8_0', '-ctv', 'q8_0', '--cache-ram', '0',
    '--host', '127.0.0.1', '--port', String(port), '--no-webui',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    for (let i = 0; i < 240; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch { /* boot */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    const control = await sequence(port, 'cache-ram 0    (control)   ');
    const saved = control.warmA.prefilled - treated.warmA.prefilled;
    const blind = treated.warmA.prefilled >= control.warmA.prefilled;
    console.log(blind
      ? 'GATE IS BLIND: the cache saved nothing over the control'
      : `CACHE WIN: ${saved} tokens of re-prefill avoided per task-type switch (${treated.warmA.prefilled} vs ${control.warmA.prefilled})`);
    app.exit(blind ? 1 : 0);
  } finally {
    try { child.kill(); } catch { /* gone */ }
  }
}

app.whenReady().then(() => main().catch((e) => { console.error(e); app.exit(1); }));
