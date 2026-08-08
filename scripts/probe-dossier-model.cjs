/**
 * probe-dossier-model.cjs — can either shipping tier actually WRITE the
 * character panel from the evidence the harness found?
 *
 * probe-character-dossier.ts answered the first question: the manuscript does
 * contain retrievable description, but the candidate pool it produces is about
 * one-in-seven useful — the same raw precision the knowledge ledger measured
 * before the adjudicator was built. So the pool is not the product. The
 * question this probe answers is whether a 1.7B and a 4B can pick the right
 * span out of fourteen and write a line that is TRUE, or whether they write a
 * plausible line that the manuscript does not support.
 *
 * ★★ THE ABSTENTION CASES DECIDE, NOT THE RICH ONES.
 *    Anything can write a paragraph about Elizabeth Bennet — the model knows
 *    the book. The cases that decide whether this feature can ship are the ones
 *    where the evidence is THIN or ABSENT, because that is the state a real
 *    draft is in, and a confident invented description is strictly worse for a
 *    writer than an empty field. Two are included and they are graded hardest.
 *
 * ★★ EVERY CLAIM IS GROUNDING-CHECKED IN CODE, NOT BY READING IT.
 *    The model must cite span numbers. `groundClaim` then requires each content
 *    word of the written line to appear in a cited span. A line that reads
 *    beautifully and cites nothing is UNGROUNDED and would not ship. This is
 *    what "verifiable" has to mean if it is to mean anything.
 *
 * Run: ./node_modules/.bin/electron scripts/probe-dossier-model.cjs
 *      TIERS=max ./node_modules/.bin/electron scripts/probe-dossier-model.cjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

app.setName('Latent Write');

const ROOT = path.join(__dirname, '..');
const NODE = '/opt/homebrew/bin/node';
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

const TIERS = (process.env.TIERS || 'small,max').split(',');
/** ★ THE GATE MUST BE CANARIED. A run with GATE=off reproduces the fabrications
 *  it exists to stop; if both runs look the same, the gate is not firing. */
const GATE_OFF = process.env.GATE === 'off';
const PICK_ONLY = process.env.PICK === '1';

/**
 * The cases. Two rich, two middling, two starved — and the starved ones are
 * the gate.
 *
 *   truth  what the manuscript actually supports, established by reading it.
 *          `null` means the manuscript supports NOTHING and the only correct
 *          answer is an empty appearance with no cited spans.
 */
const CASES = [
  { spec: 'pride:Elizabeth', kind: 'rich',
    truth: 'dark eyes, a face with hardly a good feature but made intelligent by the eyes; walks far and fast' },
  { spec: 'pride:Darcy', kind: 'rich',
    truth: 'tall, proud, clever; the pack may only support "proud/clever" and a mantel-piece posture' },
  { spec: 'anne:Anne', kind: 'rich',
    truth: 'red hair, freckles, thin, grey eyes, talkative' },
  { spec: 'dracula:Van Helsing', kind: 'middling',
    truth: 'older, broad, a strong face; speaks in broken English' },
  { spec: 'webnovel:Jonah', kind: 'starved',
    truth: null },
  { spec: 'webnovel:Elder Kang', kind: 'starved',
    truth: null },
];

// ── the ask ───────────────────────────────────────────────────────────────
//
// ★★ SPANS BEFORE PROSE, IN DECLARATION ORDER. A grammar emits properties in
//    the order they are declared, so a schema that puts the written line first
//    makes the model commit to a sentence and then hunt for citations to
//    justify it. Citing first forces the selection to happen before the
//    writing, which is the whole point.
const SCHEMA = {
  type: 'object',
  properties: {
    appearanceSpans: { type: 'array', items: { type: 'integer' }, maxItems: 3 },
    appearance: { type: 'string', maxLength: 140 },
    traitSpans: { type: 'array', items: { type: 'integer' }, maxItems: 3 },
    role: { type: 'string', maxLength: 48 },
    confidence: { type: 'number' },
  },
};

const SYSTEM = `You fill in a character card for a novel, from evidence a search has already
gathered. You cannot read the manuscript. The numbered passages are all the
evidence that exists.

Answer as JSON: {"appearanceSpans","appearance","traitSpans","role","confidence"}
in that order.

appearanceSpans: FIRST. The numbers of the passages that state what this person
  LOOKS LIKE — body, face, hair, eyes, height, age, clothing. Choose before you
  write. If no passage states any of that, answer [].
appearance: at most 20 words, built ONLY from the passages you just cited, using
  their own words where you can. If appearanceSpans is [], this MUST be "".
traitSpans: the numbers of the passages that show what this person is LIKE or
  what they DO. [] if none.
role: at most 6 words naming this person's place in the story, from the counted
  facts and the passages. Examples of the shape: "viewpoint character",
  "her closest friend", "the man she argues with". Not a genre label.
confidence: 0 to 1, how much the passages actually settle this. Never above 1.

A passage tagged (pronoun) had its subject resolved by a machine and may belong
to someone else; trust it less. A passage tagged (said) is one character SPEAKING
about another and may be unfair or wrong.

An empty answer is a correct answer. Writing something true of most people is
NOT an answer. Never use anything you know about this book from elsewhere —
only these passages.`;

// ── grounding ─────────────────────────────────────────────────────────────

const STOP = new Set(('a an the and or but of to in on at by for with from as is are was were be been ' +
  'his her their its he she they him them this that these those very quite more most much many some any ' +
  'who whom which what when where how not no nor than then there here also into over under about ' +
  'seems seem appears appear looks look has have had having does do did done will would could should ' +
  'man woman person character people someone thing things').split(' '));

/**
 * Is every content word of `line` present in at least one cited span?
 *
 * Deliberately crude and deliberately generous — a light stem (strip a trailing
 * s/ed/ing/ly) and substring containment, so "walks"/"walked" and
 * "intelligent"/"intelligence" both pass. A crude check that a claim FAILS is a
 * real failure; a crude check it passes is not a guarantee, which is why the
 * written lines are also printed for reading.
 */
function groundClaim(line, citedTexts) {
  const hay = citedTexts.join(' ').toLowerCase();
  const stem = (w) => w.replace(/(?:ing|ed|ly|s)$/, '');
  const words = String(line || '').toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
  const content = words.filter((w) => !STOP.has(w) && w.length >= 4);
  const missing = content.filter((w) => !hay.includes(stem(w)));
  return { checked: content.length, missing };
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

  console.log('\nassembling packs from the real corpus…');
  const packs = JSON.parse(execFileSync(NODE, [
    TSX, path.join('scripts', 'probe-character-dossier.ts'), '--pack',
    ...CASES.map((c) => c.spec),
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim().split('\n').pop());

  const byName = new Map(packs.map((p) => [`${p.book}:${p.name}`, p]));
  console.log(`  ${packs.length} packs, ${packs.map((p) => p.spans.length).join('/')} spans each\n`);

  for (const tier of TIERS) {
    const status = await callBridge('assistantStatus', { tier });
    if (!status.model.present) { console.log(`SKIP ${tier} — model not on disk.`); continue; }
    console.log(`\n${'═'.repeat(78)}\nTIER ${tier} — ${status.model.id}\n${'═'.repeat(78)}`);

    for (const c of CASES) {
      const pack = byName.get(c.spec);
      if (!pack) { console.log(`\n${c.spec}: NO PACK`); continue; }

      // ★★ THE GATE RUNS FIRST. No describable feature in the pack means no
      //    question is asked, so there is nothing for the model to invent. This
      //    is the fix for the two disqualifying cases and it lives in code, not
      //    in the prompt — the prompt already said an empty answer was correct
      //    and both tiers ignored it.
      if (!GATE_OFF && pack.visualCandidates.length === 0) {
        console.log(`\n── ${c.spec}  [${c.kind}]  GATED — 0 spans carry a describable feature`);
        console.log(`   truth: ${c.truth === null ? 'NOTHING — the only correct answer is an empty appearance' : c.truth}`);
        console.log(`   VERDICT: ${c.truth === null ? 'ABSTAINED — correct, and no tokens spent' : 'GATE COST A REAL ANSWER'}`);
        continue;
      }
      // ★★ THE NARROWER JOB, and it is the one that decides what "on" mode is.
      //    chip-picker.ts already proves the shape: the model may PICK from
      //    numbered options and may not compose. If the 1.7B can point at the
      //    span that describes the character, the conservative tier can ship an
      //    EXTRACTIVE card — the writer's own sentence, quoted — with zero
      //    fabrication surface. If it cannot even point, the model has no part
      //    in that tier at all and the card is built from counted facts alone.
      if (PICK_ONLY) {
        const t1 = Date.now();
        const r = await callBridge('assistantRun', {
          requestId: `pick-${tier}-${c.spec}`.replace(/[^a-z0-9-]/gi, '-'),
          task: 'character-dossier-pick', tier,
          ...(tier === 'max' ? { noThink: false } : {}),
          systemPrompt:
            'You are given numbered passages from a novel and one character name. '
            + 'Answer as JSON {"reason","spans"} in that order.\n'
            + 'reason: FIRST, at most 12 words naming what the passage shows.\n'
            + 'spans: the numbers of the passages that state what THIS NAMED PERSON '
            + 'looks like — body, face, hair, eyes, height, age, clothing. Many '
            + 'passages describe SOMEBODY ELSE while mentioning this person; those '
            + 'do not count. If none qualify, answer [].\n'
            + 'Do not write a description. Only choose.',
          userText: `${pack.text}\n\nWhich passages state what ${pack.name} looks like?`,
          schema: { type: 'object', properties: {
            reason: { type: 'string', maxLength: 90 },
            spans: { type: 'array', items: { type: 'integer' }, maxItems: 4 },
          } },
          maxTokens: tier === 'max' ? 512 : 128,
          timeoutMs: 180000,
        });
        const picked = (r && r.ok && r.json && r.json.spans) || [];
        const legal = picked.filter((n) => pack.spans.some((s) => s.n === n));
        console.log(`\n── ${c.spec}  [${c.kind}]  PICK  ${Date.now() - t1}ms`);
        console.log(`   gate-eligible: [${pack.visualCandidates.join(', ')}]`);
        console.log(`   picked:        [${picked.join(', ')}]${picked.length !== legal.length ? '  ✗ includes a span that does not exist' : ''}`);
        console.log(`   reason:        ${JSON.stringify(r && r.ok && r.json ? r.json.reason : null)}`);
        for (const n of legal.slice(0, 3)) {
          const s = pack.spans.find((x) => x.n === n);
          console.log(`     [${n}] ${s.text.slice(0, 130)}`);
        }
        continue;
      }

      const t0 = Date.now();
      const res = await callBridge('assistantRun', {
        requestId: `dossier-${tier}-${c.spec}`.replace(/[^a-z0-9-]/gi, '-'),
        task: 'character-dossier', tier,
        // ★ /no_think is a Qwen token the runtime appends by default. Right for
        //   the 1.7B, wrong for the 4B thinking tier.
        ...(tier === 'max' ? { noThink: false } : {}),
        systemPrompt: SYSTEM,
        userText: `${pack.text}\n\nFill in the card for ${pack.name}.`,
        schema: SCHEMA,
        maxTokens: tier === 'max' ? 1024 : 256,
        timeoutMs: 180000,
      });
      const ms = Date.now() - t0;
      console.log(`\n── ${c.spec}  [${c.kind}]  ${ms}ms`);
      console.log(`   truth: ${c.truth === null ? 'NOTHING — the only correct answer is an empty appearance' : c.truth}`);
      if (!res || !res.ok) { console.log(`   NO ANSWER (${res && res.error})`); continue; }
      const j = res.json || {};
      const cited = (j.appearanceSpans || [])
        .map((n) => pack.spans.find((s) => s.n === n))
        .filter(Boolean);
      const badRefs = (j.appearanceSpans || []).filter((n) => !pack.spans.some((s) => s.n === n));
      const g = groundClaim(j.appearance, cited.map((s) => s.text));

      console.log(`   spans:  [${(j.appearanceSpans || []).join(', ')}]${badRefs.length ? `  ✗ ${badRefs.length} DO NOT EXIST` : ''}`);
      console.log(`   appear: ${JSON.stringify(j.appearance)}`);
      console.log(`   role:   ${JSON.stringify(j.role)}   conf ${j.confidence}`);

      // ★★ REPAIR BEFORE REJECT, AND THE ANNE CASE IS WHY.
      //    Both tiers wrote "freckled face, solemn gray eyes" for Anne Shirley
      //    and cited spans that do not contain those words — so the grounding
      //    check failed it. But the words are in span 9, which the model read
      //    and simply failed to number. The retrieval was right, the writing was
      //    right, only the citation was wrong; rejecting there would throw away
      //    the single best description in the pack. So a claim that fails
      //    against its own citations is re-checked against the WHOLE pack, and
      //    only a claim that locates nowhere is refused.
      const whole = groundClaim(j.appearance, pack.spans.map((s) => s.text));
      const repaired = g.missing.length && !whole.missing.length
        ? pack.spans.filter((s) => g.missing.some((w) => s.text.toLowerCase().includes(w.replace(/(?:ing|ed|ly|s)$/, ''))))
            .map((s) => s.n)
        : [];

      const verdict = c.truth === null
        ? ((j.appearance || '').trim() === '' && (j.appearanceSpans || []).length === 0
            ? 'ABSTAINED — correct' : 'INVENTED — disqualifying')
        : (!(j.appearance || '').trim()
            ? 'abstained (evidence existed)'
            : !g.missing.length && !badRefs.length
              ? `grounded as cited (${g.checked} content words located)`
            : !whole.missing.length
              ? `REPAIRABLE — every word is in the pack; citation corrected to [${repaired.join(', ')}]`
            : `REFUSED — ${whole.missing.join(', ')} appear nowhere in the pack`);
      console.log(`   VERDICT: ${verdict}`);
    }
  }
  console.log('');
  app.exit(0);
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
