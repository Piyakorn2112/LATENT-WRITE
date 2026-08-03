/**
 * verify-model-manage.cjs — the model-management surface, against the real
 * runtime: a custom source URL, and deleting the downloaded weights.
 *
 * Deletion is the one destructive control in the app, so it gets a gate rather
 * than a hand-check. It runs on a COPY of the model in a temp userData, never
 * on the writer's real download.
 *
 *   ./node_modules/.bin/electron scripts/verify-model-manage.cjs
 */
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const results = [];
const gate = (name, cond, detail) => {
  results.push({ name, cond });
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  const ROOT = path.join(__dirname, '..');
  const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

  console.log('\n[model-manage] custom source resolution');
  const entry = assistant.MODEL_REGISTRY.small;

  const pinned = assistant.resolvedModelUrl(entry);
  gate('default resolves to the pinned revision',
    pinned.includes(entry.repo) && pinned.includes(entry.revision),
    pinned.slice(0, 78));

  assistant.setCustomSource({ url: 'https://mirror.example/Qwen3-1.7B-Q4_K_M.gguf' });
  gate('a custom source replaces it entirely',
    assistant.resolvedModelUrl(entry) === 'https://mirror.example/Qwen3-1.7B-Q4_K_M.gguf',
    assistant.resolvedModelUrl(entry));

  assistant.setCustomSource(null);
  gate('clearing restores the pinned revision',
    assistant.resolvedModelUrl(entry) === pinned, 'back to default');

  // ── deletion, on a decoy file in this run's own userData ────────────────
  console.log('\n[model-manage] deletion');
  const dir = assistant.modelsDir();
  fs.mkdirSync(dir, { recursive: true });
  const modelPath = path.join(dir, entry.file);
  // A stand-in of the right NAME; deletion must not care what is inside.
  fs.writeFileSync(modelPath, Buffer.alloc(4096, 7));
  fs.writeFileSync(`${modelPath}.sha256`, 'deadbeef  decoy\n');
  fs.writeFileSync(`${modelPath}.verified`, '4096:1\n');

  const before = ['', '.sha256', '.verified'].every((s) => fs.existsSync(`${modelPath}${s}`));
  gate('decoy model and both sidecars exist', before, path.basename(modelPath));

  const out = await assistant.deleteModel({});
  gate('delete reports success', !!(out && out.ok), JSON.stringify(out));

  const gone = ['', '.sha256', '.verified'].every((s) => !fs.existsSync(`${modelPath}${s}`));
  gate('★ the model AND both sidecars are gone', gone,
    'a stamp outliving its model would validate the next download by accident');

  gate('status returns to no-model',
    assistant.assistantStatus().state === 'no-model',
    assistant.assistantStatus().state);

  const again = await assistant.deleteModel({});
  gate('deleting twice is not an error', !!(again && again.ok), 'absent is the desired end state');

  const failed = results.filter((r) => !r.cond).length;
  console.log(`\n${failed ? `FAILED ${failed}/${results.length}` : `PASS ${results.length}/${results.length}`}`);
  app.exit(failed ? 1 : 0);
}

// A throwaway profile: this test writes and deletes model files, and must never
// touch the writer's real 1.1 GB download.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'lw-modelmanage-')));
delete process.env.ASSISTANT_MODEL_PATH; // an env pin would refuse deletion
app.whenReady().then(() => main().catch((e) => { console.error(e); app.exit(1); }));
