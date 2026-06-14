/**
 * test-cast-roles.ts
 *
 * Accuracy suite for the Cast & Roles widgets:
 *   • CastWidget   — speakerCounts rollup + per-character influence role
 *                    (dominant / present / peripheral), from analyzeChapter.
 *   • RoleWidget   — chapterRole structural classification (climax / buildup /
 *                    breather / resolution / expository / pivot).
 *
 * These classifiers had NO accuracy gate before. Cast detection rides on
 * speaker attribution (separately tested ≥84%/97%), so we feed CORRECT known
 * names — exactly as the app does from its curated cast — and test the
 * classifier LOGIC, not name extraction. chapterRole is relative, so we assert
 * the robust DIRECTION (low-energy vs high-energy role) using synthetic
 * sibling context.
 *
 * Run:  npx tsx scripts/test-cast-roles.ts
 * Gate: 100% of the (deliberately clear) assertions.
 */

import { analyzeChapter, computeChapterStats, type ChapterStats, type ChapterRole } from "../src/lib/chapter-analysis";
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

function analyze(paras: string[], names: string[], siblings: ChapterStats[] = []) {
  const speech = detectSpeechInChapter(paras, names, { intelligenceLevel: "high" });
  return analyzeChapter(paras, speech, siblings, siblings.length, "high");
}
function siblingsOf(avgTensionScore: number, avgDialogueDensity: number, n = 6): ChapterStats[] {
  return Array.from({ length: n }, () => ({ paragraphCount: 30, wordCount: 1500, avgDialogueDensity, avgTensionScore }));
}
function influenceRole(a: ReturnType<typeof analyzeChapter>, name: string): string | undefined {
  const infl = (a as unknown as { highModeAnalysis?: { characterInfluence?: Array<{ name: string; role: string }> } })
    .highModeAnalysis?.characterInfluence;
  return infl?.find((c) => c.name === name)?.role;
}

// ── Cast: dominant vs peripheral ──────────────────────────────────────────
console.log("\n══ Cast: speaker rollup + influence roles ══");
{
  // Doran: one line in the calm opening, then absent from the tense action →
  // genuinely peripheral. Iris carries every high-tension beat → dominant.
  const ch = [
    '"You\'re early," Doran said mildly, sliding the ledger across the desk. Iris signed it and left without a word.',
    "Outside, the alarm began to shriek across the compound. Iris broke into a run.",
    '"They\'re inside the walls," Iris said, her voice tight, her knuckles white on the rail.',
    'Iris\'s heart pounded as the floor trembled beneath her. "We don\'t stop now," she said, plunging into the dark.',
    "The corridor shook around her. Iris ran on, refusing to stop, her breath ragged and her grip like iron.",
  ];
  const a = analyze(ch, ["Iris", "Doran"]);
  const top = a.speakerCounts[0]?.name;
  expect("dominant speaker (Iris) ranks first in cast", top === "Iris", `top=${top} counts=${JSON.stringify(a.speakerCounts)}`);
  const irisRole = influenceRole(a, "Iris");
  const doranRole = influenceRole(a, "Doran");
  expect("Iris influence role is dominant/present", irisRole === "dominant" || irisRole === "present", `iris=${irisRole}`);
  expect("Doran (one calm line, absent from action) is peripheral", doranRole === "peripheral", `doran=${doranRole}`);
}

// ── Role: low-energy (breather/resolution) ────────────────────────────────
console.log("\n══ Role: structural direction ══");
{
  const calm = [
    "The morning was quiet. Nora sat by the window with her tea, watching the mist lift slowly from the garden.",
    "She thought of nothing in particular. The house was still around her, patient and unhurried and warm.",
    "Later she walked in the orchard, the wet grass cool against her ankles, and let the long silence settle.",
    "The afternoon drifted past. She read a little, dozed a little, and watched the light move across the floor.",
  ];
  const a = analyze(calm, ["Nora"], siblingsOf(0.6, 0.25));
  const lowEnergy: ChapterRole[] = ["breather", "resolution", "expository"];
  expect("calm chapter among tense siblings → low-energy role", lowEnergy.includes(a.chapterRole), `role=${a.chapterRole}`);
  expect("calm chapter peakTension is not high", a.peakTension !== "high", `peak=${a.peakTension}`);
}

// ── Role: high-energy (climax/buildup) ────────────────────────────────────
{
  const violent = [
    "He slammed the door so hard the frame cracked. “Get out!” she screamed, hurling the lamp past his head.",
    "The blade bit deep into his shoulder. Blood sheeted down his arm as he staggered back and swung wildly.",
    "She drove her fist into his jaw. They crashed into the table, grappling, and the glass shattered beneath them.",
    "A boot drove into his ribs. He couldn’t breathe, couldn’t see, could only curl against the rain of blows.",
    "The wall came down in a roar of dust and fire. She dragged him from the rubble as the building collapsed.",
  ];
  const a = analyze(violent, [], siblingsOf(0.12, 0.1));
  const highEnergy: ChapterRole[] = ["climax", "buildup"];
  expect("violent outlier chapter → high-energy role", highEnergy.includes(a.chapterRole), `role=${a.chapterRole}`);
  expect("violent chapter peakTension is high", a.peakTension === "high", `peak=${a.peakTension}`);
}

// ── Summary ─────────────────────────────────────────────────────────────
const total = passed + failed;
const pct = total ? Math.round((passed / total) * 100) : 100;
console.log(`\n${"=".repeat(60)}`);
console.log(`cast-roles: ${passed}/${total} (${pct}%)`);
console.log("=".repeat(60));
if (failed > 0) {
  console.log("Below target.\n");
  process.exit(1);
} else {
  console.log("All assertions passed.\n");
}
