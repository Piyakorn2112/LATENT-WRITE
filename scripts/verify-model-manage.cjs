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

  // ★ A DIFFERENT MODEL, NOT A DIFFERENT URL. The custom entry must carry its
  //   own context window and chat-template flag, or a 4B model would be loaded
  //   with the 1.7B's settings and told '/no_think', which Granite reads as prose.
  assistant.setCustomModel({
    url: 'https://mirror.example/granite-4.0-micro-Q4_K_M.gguf',
    label: 'Granite 4.0 Micro', contextSize: 8192, noThink: false,
  });
  const custom = assistant.activeEntry();
  gate('a custom model replaces the URL', assistant.resolvedModelUrl(custom).startsWith('https://mirror.example/'), custom.url);
  gate('…and carries its own context size', custom.contextSize === 8192, String(custom.contextSize));
  gate('…and its own chat-template flag', custom.noThink === false, 'noThink=false');
  gate('…and has no inherited sha256 to check against', !custom.sha256, 'unpinned, validated by GGUF + load');

  // ★ IT MUST NOT OVERWRITE THE PINNED DOWNLOAD. Swapping models is reversible
  //   only if each keeps its own file.
  gate('…and gets its own filename',
    assistant.customFileName('https://mirror.example/granite-4.0-micro-Q4_K_M.gguf') !== entry.file,
    assistant.customFileName('https://mirror.example/granite-4.0-micro-Q4_K_M.gguf'));
  gate('a URL with no filename still yields a stable name',
    /^custom-[0-9a-f]{12}\.gguf$/.test(assistant.customFileName('https://x.example/download?id=7')),
    assistant.customFileName('https://x.example/download?id=7'));

  // ★★ THE DEFAULT FOR AN UNSPECIFIED MODEL. The panel's picker (which carried
  //    a per-model noThink) is hidden, so every custom model now arrives as a
  //    bare URL — and a bare URL must not be assumed to be a Qwen3. `/no_think`
  //    is a Qwen3 control token and literal junk anywhere else.
  assistant.setCustomModel({ url: 'https://mirror.example/some-unknown-model.gguf' });
  gate('★ a bare URL is not assumed to want /no_think',
    assistant.activeEntry().noThink === false, 'noThink defaults false');
  assistant.setCustomModel({ url: 'https://mirror.example/qwen3.gguf', noThink: true });
  gate('…and an explicit noThink still wins',
    assistant.activeEntry().noThink === true, 'noThink=true honoured');

  assistant.setCustomModel(null);
  gate('clearing restores the pinned revision',
    assistant.resolvedModelUrl(assistant.activeEntry()) === pinned, 'back to default');

  // ★★ THE PICKER IS HIDDEN IN THE PANEL, SO THIS GATE NO LONGER CLAIMS IT IS
  //    "OFFERED". It used to, and leaving it that way would have been a gate
  //    asserting something the product stopped doing — green, and a lie. What
  //    is still true, and worth holding, is that the list survives intact in
  //    main so un-hiding it is a render change and not a rebuild.
  gate('the preset list is still intact behind the hidden picker',
    assistant.MODEL_PRESETS.length >= 2 && assistant.MODEL_PRESETS[0].builtin === true,
    assistant.MODEL_PRESETS.map((p) => p.label).join(' · '));

  // ── robustness: what a wrong URL actually returns ──────────────────────
  console.log('\n[model-manage] robustness');
  const tmpDir = assistant.modelsDir();
  fs.mkdirSync(tmpDir, { recursive: true });
  const htmlPath = path.join(tmpDir, 'not-a-model.gguf');
  fs.writeFileSync(htmlPath, '<!DOCTYPE html><title>404 Not Found</title>');
  gate('★ an HTML error page is not mistaken for a model', !assistant.isGgufFile(htmlPath), 'GGUF magic rejects it');
  const ggufPath = path.join(tmpDir, 'looks-real.gguf');
  fs.writeFileSync(ggufPath, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(2048, 3)]));
  gate('a real GGUF header passes', assistant.isGgufFile(ggufPath), 'magic bytes match');
  fs.rmSync(htmlPath, { force: true }); fs.rmSync(ggufPath, { force: true });

  // ── deletion, on a decoy file in this run's own userData ────────────────
  console.log('\n[model-manage] deletion');
  const dir = assistant.modelsDir();
  fs.mkdirSync(dir, { recursive: true });
  const modelPath = path.join(dir, entry.file);
  // A stand-in of the right NAME; deletion must not care what is inside.
  fs.writeFileSync(modelPath, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(4092, 7)]));
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
