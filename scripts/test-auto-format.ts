/**
 * test-auto-format.ts
 *
 * Gold-standard accuracy suite for the two one-shot formatting passes:
 *   • autoParagraph    (src/lib/auto-paragraph.ts)   — "respect & augment"
 *   • autoSceneBreaks  (src/lib/auto-scene-break.ts)  — corroborated scene cuts
 *
 * Cases are hand-labelled across prose styles: literary/gothic, genre,
 * dialogue-heavy, minimalist, and translated-LN (guillemets / British single
 * quotes). Each case states the professional-editor expectation.
 *
 * Run:  npx tsx scripts/test-auto-format.ts
 * Gate: ≥90% (auditor-grade).
 */

import { autoParagraph } from "../src/lib/auto-paragraph";
import { autoSceneBreaks } from "../src/lib/auto-scene-break";
import type { ChapterParaResult } from "../src/lib/speech-detect";

let passed = 0,
  failed = 0;
function expect(label: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? "\n      " + detail : ""}`);
  }
}

/** Split output the same way the app's `toParagraphs` does. */
function paras(content: string, names: string[] = []): string[] {
  return autoParagraph(content, names)
    .split(/\n{2,}|\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}
function eqArr(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
function check(label: string, content: string, names: string[], want: string[]) {
  const got = paras(content, names);
  expect(label, eqArr(got, want), `got (${got.length}): ${JSON.stringify(got)}`);
}

// ═══════════════════════════ auto-paragraph ═══════════════════════════════

console.log("\n══ auto-paragraph: RESPECT (already-formatted chapters) ══");

check(
  "formatted dialogue is left untouched",
  'Aldous knelt by the bloom.\n"What is it?" Vale asked.\n"I don\'t know yet," he said.',
  ["Aldous", "Vale"],
  ['Aldous knelt by the bloom.', '"What is it?" Vale asked.', '"I don\'t know yet," he said.'],
);

check(
  "authored long single-subject paragraph is respected (not force-split)",
  "The corridor smelled of damp earth. Aldous walked its length slowly. He trailed one hand along the wall. The plaster was cold. He did not hurry.\nVale waited at the far door.",
  ["Aldous", "Vale"],
  [
    "The corridor smelled of damp earth. Aldous walked its length slowly. He trailed one hand along the wall. The plaster was cold. He did not hurry.",
    "Vale waited at the far door.",
  ],
);

check(
  "jammed multi-speaker paragraph IS split (clearly missing breaks)",
  'Aldous knelt by the bloom.\n"What is it?" Vale asked. "I don\'t know," Aldous said. "It\'s spreading," Vale whispered.',
  ["Aldous", "Vale"],
  [
    "Aldous knelt by the bloom.",
    '"What is it?" Vale asked.',
    '"I don\'t know," Aldous said.',
    '"It\'s spreading," Vale whispered.',
  ],
);

check(
  "time jump mid-paragraph IS split",
  "He closed the door.\nShe sat by the window for a long while. The next morning she was gone.",
  [],
  ["He closed the door.", "She sat by the window for a long while.", "The next morning she was gone."],
);

console.log("\n══ auto-paragraph: RECONSTRUCT (single wall-of-text block) ══");

check(
  "dialogue turn-taking, no names → one paragraph per turn (D3 regression)",
  '"Where are we going?" "Somewhere safe." "That\'s not an answer." "It\'s the only one I have."',
  [],
  ['"Where are we going?"', '"Somewhere safe."', '"That\'s not an answer."', '"It\'s the only one I have."'],
);

check(
  "action beats attach to their speaker; actor change splits (D4 regression)",
  'He set down the cup. "You\'re late." She didn\'t answer. Instead she crossed to the window and looked out at the rain. "I said you\'re late," he repeated.',
  [],
  [
    'He set down the cup. "You\'re late."',
    "She didn't answer. Instead she crossed to the window and looked out at the rain.",
    '"I said you\'re late," he repeated.',
  ],
);

check(
  "abbreviations do not fragment paragraphs (Dr./Mrs.)",
  'Dr. Aldous Finch studied the spores. Mrs. Vale watched from the doorway. "It is spreading," Vale said.',
  ["Aldous", "Vale", "Finch"],
  [
    "Dr. Aldous Finch studied the spores.",
    'Mrs. Vale watched from the doorway. "It is spreading," Vale said.',
  ],
);

check(
  "length cap rescues a monotonous narration wall (5 + 2)",
  "Aldous opened the box. He lifted the lid. He peered inside. He found the spores. He touched one gently. He recoiled at the cold. He closed the box again.",
  ["Aldous"],
  [
    "Aldous opened the box. He lifted the lid. He peered inside. He found the spores. He touched one gently.",
    "He recoiled at the cold. He closed the box again.",
  ],
);

check(
  "narration with no actor → following dialogue starts a new paragraph",
  'The room fell silent. The lamp guttered. "Who\'s there?"',
  [],
  ["The room fell silent. The lamp guttered.", '"Who\'s there?"'],
);

console.log("\n══ auto-paragraph: DIALOGUE EXCHANGE (per-turn lines) ══");

check(
  "tagged turn → bare reply splits, even in an authored chapter",
  'Aldous frowned.\n"Get out," she said. "Why?"',
  [],
  ["Aldous frowned.", '"Get out," she said.', '"Why?"'],
);

check(
  "rapid bare exchange → one line per turn",
  '"A?" "Yes." "Sure?" "Certain."',
  [],
  ['"A?"', '"Yes."', '"Sure?"', '"Certain."'],
);

check(
  "tagged alternating exchange → one line per turn",
  '"Stay," he said. "I can\'t," she replied. "Please," he said.',
  [],
  ['"Stay," he said.', '"I can\'t," she replied.', '"Please," he said.'],
);

check(
  "a lone quoted line in narration is NOT an exchange (not all talk)",
  '"Closed," the sign read. She walked on without stopping.',
  [],
  ['"Closed," the sign read. She walked on without stopping.'],
);

console.log("\n══ auto-paragraph: HIGH-PRECISION negatives (must NOT over-split) ══");

check(
  "same speaker across two tagged lines stays together (coreference)",
  '"Hi," Aldous said. "How are you?" he asked.',
  ["Aldous"],
  ['"Hi," Aldous said. "How are you?" he asked.'],
);

check(
  "one multi-sentence quote is never split mid-utterance",
  '"I won\'t. I can\'t. I\'m staying right here."',
  [],
  ['"I won\'t. I can\'t. I\'m staying right here."'],
);

check(
  "ambiguous name→pronoun handoff with NO gender evidence is left intact",
  '"I don\'t know," Aldous said. "It\'s spreading," she whispered.',
  ["Aldous"],
  ['"I don\'t know," Aldous said. "It\'s spreading," she whispered.'],
);

console.log("\n══ auto-paragraph: gender-aware handoff (honorifics) ══");

check(
  "honorific gives gender → contradicting pronoun IS a new speaker",
  'Mr. Poole studied the bloom. "It\'s spreading," she said.',
  ["Poole"],
  ["Mr. Poole studied the bloom.", '"It\'s spreading," she said.'],
);

console.log("\n══ auto-paragraph: STYLE coverage (translated / British) ══");

check(
  "guillemet turn-taking (translated LN)",
  "«Où allons-nous?» «Quelque part de sûr.» «Ce n'est pas une réponse.»",
  [],
  ["«Où allons-nous?»", "«Quelque part de sûr.»", "«Ce n'est pas une réponse.»"],
);

check(
  "British single-quote speaker change splits",
  "‘I won't,’ she said. ‘You must,’ he replied.",
  [],
  ["‘I won't,’ she said.", "‘You must,’ he replied."],
);

console.log("\n══ auto-paragraph: structure preservation ══");

check(
  "scene-break markers are preserved verbatim",
  "He left the room.\n* * *\nShe stayed behind.",
  [],
  ["He left the room.", "* * *", "She stayed behind."],
);

expect("empty content returns unchanged", autoParagraph("") === "");
expect("whitespace-only content returns unchanged", autoParagraph("   \n  ") === "   \n  ");

// ═══════════════════════════ auto-scene-break ═════════════════════════════

type SpeechOpts = {
  densities?: number[];
  tensions?: ("calm" | "rising" | "high")[];
  sceneStarts?: boolean[];
};
function mkSpeech(paras: string[], opts: SpeechOpts = {}): ChapterParaResult[] {
  return paras.map((_, i) => ({
    segments: [],
    meta: {
      tension: opts.tensions?.[i] ?? ("calm" as const),
      dialogueDensity: opts.densities?.[i] ?? 0,
      ...(opts.sceneStarts?.[i] ? { sceneStart: true } : {}),
    },
  }));
}
function sceneBreak(paras: string[], opts: SpeechOpts = {}) {
  return autoSceneBreaks(paras.join("\n\n"), paras, mkSpeech(paras, opts));
}
function checkBreaks(label: string, paras: string[], wantPositions: number[], opts: SpeechOpts = {}) {
  const r = sceneBreak(paras, opts);
  const ok = r.inserted === wantPositions.length && eqArr(r.positions.map(String), wantPositions.map(String));
  expect(label, ok, `inserted=${r.inserted} positions=${JSON.stringify(r.positions)}`);
}

console.log("\n══ auto-scene-break: must NOT over-segment (regressions) ══");

checkBreaks(
  "single rising-action scene (tension flips) inserts NOTHING",
  [
    "Aldous knelt by the bloom, calm, cataloguing its gills.",
    "Then the floor shifted and the whole colony pulsed toward him.",
    "He steadied his breathing and waited for it to settle.",
    "It lunged and he threw himself back against the shelving.",
    "For a long moment there was only the drip of water and his heartbeat.",
  ],
  [],
);

checkBreaks(
  "within-scene 'Then…' / 'Later…' inserts NOTHING",
  [
    "She lit the lamp and sat down to wait.",
    "Then footsteps sounded on the stair, slow and deliberate.",
    "Later she would tell herself she had known all along.",
  ],
  [],
);

checkBreaks(
  "lone time jump, same place & POV, inserts NOTHING (high precision)",
  [
    "She read by candlelight until her eyes ached.",
    "The next morning she felt no better.",
    "She made tea and sat by the window.",
  ],
  [],
);

console.log("\n══ auto-scene-break: SHOULD cut on corroborated signals ══");

checkBreaks(
  "time jump + place shift → one break",
  [
    "Aldous closed the laboratory door behind him and let out a breath.",
    "The next morning, across the city, Vale stood on the harbour wall watching the tide.",
    "She had not slept, and the gulls wheeled over the grey water while she thought of nothing.",
  ],
  [1],
);

checkBreaks(
  "time jump + POV flip (he→she) → one break",
  [
    "He worked through the night without rest, bent over the slides.",
    "The next morning she woke to an empty house and a cold hearth.",
    "She dressed quickly and hurried down the stairs.",
  ],
  [1],
);

checkBreaks(
  "place shift + POV flip → one break",
  [
    "He paced the study, the lamp guttering beside him.",
    "Meanwhile, across the harbour, she watched the ships come in.",
    "The salt wind tugged at her coat as she waited.",
  ],
  [1],
);

checkBreaks(
  "time jump + tension reset (high→calm, from scanner) → one break",
  [
    "He fought through the night, blades ringing in the dark.",
    "The next morning the camp lay silent under a grey sky.",
    "Bodies were gathered and the fires built up again.",
  ],
  [1],
  { tensions: ["high", "calm", "calm"] },
);

checkBreaks(
  "time jump + engine sceneStart → one break (uses scanner's grouping)",
  [
    "The argument burned itself out and the room went quiet.",
    "The next morning nothing had been resolved between them.",
    "They ate breakfast without a word.",
  ],
  [1],
  { sceneStarts: [false, true, false] },
);

checkBreaks(
  "tension reset WITHOUT a discourse cue inserts nothing (gate holds)",
  [
    "She waited in the dark, heart steady.",
    "The blow came and the world exploded into noise.",
    "She lay still afterwards, listening to the silence.",
  ],
  [],
  { tensions: ["calm", "high", "calm"] },
);

console.log("\n══ auto-scene-break: structure & guards ══");

checkBreaks(
  "existing scene break is respected (no double-up adjacent)",
  ["Aldous shut the door.", "* * *", "The next morning, across the city, Vale waited."],
  [],
);

{
  const r = sceneBreak(["The next morning, across the city, Vale waited.", "She had not slept."]);
  expect("under 3 paragraphs inserts nothing", r.inserted === 0, `inserted=${r.inserted}`);
}

// ─── Summary ─────────────────────────────────────────────────────────────

const total = passed + failed;
const pct = total ? Math.round((passed / total) * 100) : 100;
console.log(`\n${"=".repeat(60)}`);
console.log(`auto-format accuracy: ${passed}/${total} (${pct}%)`);
console.log(`Target: ≥90% (auditor-grade)`);
console.log("=".repeat(60));
if (failed > 0 || pct < 90) {
  console.log("Below target.\n");
  process.exit(1);
} else {
  console.log("All assertions passed.\n");
}
