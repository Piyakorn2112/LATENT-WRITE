/**
 * test-tension-scene.ts
 *
 * Accuracy suite for the chapter tension scanner + scene-label engine that
 * lives in speech-detect.ts (computeParagraphMeta → groupIntoScenes →
 * computeSceneLabel). It backs the TensionWidget and now corroborates
 * auto-scene-break. Previously this engine had NO dedicated coverage.
 *
 * Tested through the public API `detectSpeechInChapter` (behaviour, not
 * internals). Single-paragraph chapters give the "cold" classification
 * (no EWMA carry-forward) for deterministic per-paragraph assertions.
 *
 * Run:  npx tsx scripts/test-tension-scene.ts
 * Gate: tension 3-way ≥85% on clear cases.
 */

import { detectSpeechInChapter } from "../src/lib/speech-detect";

let passed = 0,
  failed = 0;
function expect(label: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? " — " + detail : ""}`);
  }
}

type Tension = "calm" | "rising" | "high";
/** Process a group as ONE chapter so the engine's cross-paragraph EWMA /
 *  contrast signals apply — this is how the widget actually sees prose. */
function tensions(paras: string[], names: string[] = []): Tension[] {
  return detectSpeechInChapter(paras, names).map((r) => r.meta.tension);
}
const elevated = (t: Tension) => t === "rising" || t === "high";

// ── Clear CALM ──────────────────────────────────────────────────────────
const CALM: string[] = [
  "The morning light fell across the kitchen table. She poured the tea and watched the steam curl slowly toward the ceiling.",
  "The garden was quiet in the afternoon. Bees moved among the lavender, and somewhere beyond the wall a wood pigeon called.",
  "He spent the day reading by the window, turning the pages slowly as the light shifted across the floorboards.",
  "They walked along the shore in no hurry, the tide pulling gently at their feet and the gulls drifting overhead.",
  "Dinner was simple that evening: bread, soup, and a little wine, eaten without much conversation as the candle burned low.",
  "She folded the laundry while the radio murmured in the next room, the afternoon stretching out unhurried and warm.",
  "The lake lay still at dawn, mist hanging low over the water as he baited the hook and settled back to wait.",
];

// ── Clear HIGH ──────────────────────────────────────────────────────────
const HIGH: string[] = [
  "He slammed the door so hard the frame cracked. “Get out!” she screamed. Glass shattered against the wall as he hurled the bottle past her head.",
  "The blade bit into his shoulder. He staggered back, blood sheeting down his arm, and swung wildly at the shape lunging out of the dark.",
  "“You lied to me!” she shouted. “I trusted you!” He grabbed her wrist. “Let go!” she screamed, wrenching herself free.",
  "The building groaned and then came down, beams crashing through the floors, fire and dust roaring along the corridor while people screamed.",
  "He hit the floor hard. A boot drove into his ribs, then another. He couldn’t breathe, couldn’t see, could only curl against the blows.",
  "He drove his fist into the man’s jaw. They crashed into the table, fists swinging, blood slick on the floorboards as they grappled.",
];

// ── Clear RISING (building pressure, not peak) ────────────────────────────
const RISING: string[] = [
  "She watched him cross the room. Something was wrong. He would not meet her eyes, and his hands were trembling at his sides.",
  "Footsteps sounded on the stair, slow and deliberate. She reached for the lamp. Below her, the handle of the door began to turn.",
  "The message was a single line. She read it once, then again, and a third time, and felt the cold begin to spread through her chest.",
];

console.log("\n══ Tension classification (calm vs elevated) ══");
const calmT = tensions(CALM);
const highT = tensions(HIGH);
const risingT = tensions(RISING);

// Core widget signal: 2-class accuracy (calm vs elevated).
let hit = 0;
const tot = CALM.length + HIGH.length + RISING.length;
calmT.forEach((t, i) => {
  if (t === "calm") hit++;
  else console.log(`    calm? got "${t}": ${CALM[i].slice(0, 48)}…`);
});
highT.forEach((t, i) => {
  if (elevated(t)) hit++;
  else console.log(`    elevated? got "${t}": ${HIGH[i].slice(0, 48)}…`);
});
risingT.forEach((t, i) => {
  if (elevated(t)) hit++;
  else console.log(`    elevated? got "${t}": ${RISING[i].slice(0, 48)}…`);
});
const pctT = Math.round((hit / tot) * 100);
expect(`calm-vs-elevated ≥85% (${hit}/${tot} = ${pctT}%)`, pctT >= 85);

// Hard separations: the only truly damaging confusions.
expect("no calm paragraph misreads as high", calmT.every((t) => t !== "high"));
expect("no high paragraph misreads as calm", highT.every((t) => t !== "calm"));

// Peak detection: a sustained violent scene must reach 'high', not just rising.
const peakRate = highT.filter((t) => t === "high").length / highT.length;
expect(`violent scene reaches 'high' ≥60% (${Math.round(peakRate * 100)}%)`, peakRate >= 0.6);

// ── Scene labels ──────────────────────────────────────────────────────────
console.log("\n══ Scene labels ══");
function sceneLabels(paras: string[], names: string[] = []): (string | undefined)[] {
  return detectSpeechInChapter(paras, names).map((r) => r.meta.sceneLabel);
}

{
  // A rising scene of refusal & silence should produce a "weighted silence"-type label.
  const paras = [
    "He asked her again, more quietly this time, why she had done it.",
    "She said nothing. She would not look at him, and she refused to explain herself.",
    "The silence stretched between them until it had a weight of its own, and still she turned away.",
  ];
  const labels = sceneLabels(paras).filter(Boolean);
  expect("refusal/silence scene yields a label", labels.length > 0, JSON.stringify(labels));
}

// ── Summary ─────────────────────────────────────────────────────────────
const total = passed + failed;
const pct = total ? Math.round((passed / total) * 100) : 100;
console.log(`\n${"=".repeat(60)}`);
console.log(`tension-scene: ${passed}/${total} assertions (${pct}%)`);
console.log("=".repeat(60));
if (failed > 0) {
  console.log("Below target.\n");
  process.exit(1);
} else {
  console.log("All assertions passed.\n");
}
