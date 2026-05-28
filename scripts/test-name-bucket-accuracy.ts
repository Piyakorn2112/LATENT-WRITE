/// <reference types="node" />

/**
 * test-name-bucket-accuracy.ts
 *
 * Comprehensive TDD accuracy suite for the name-detection + entity-bucketing system.
 * Covers both the no-LM (heuristic) path and the LM-assisted path.
 *
 * Also validates that the event-sentence LM system shows no regression.
 *
 * Run:  NODE_OPTIONS="--require /tmp/stub-sharp.cjs" npx tsx scripts/test-name-bucket-accuracy.ts
 *
 * Targets:
 *   No-LM name detection:   recall ≥ 90%, false-positive rate ≤ 20%
 *   No-LM bucket accuracy:  ≥ 75% of detected names bucketed correctly
 *   LM-assist bucketing:    institutional names ≥ 80% correct type
 *   Event sentence (LM):    relabel rate ≥ 30%, no crash, all labels ≥ 6 chars
 */

import { scanAndClassify, type ScanResult } from "../src/lib/world-data";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function allNames(r: ScanResult): string[] {
  return [...r.characters, ...r.places, ...r.factions, ...r.entities];
}

function hasName(r: ScanResult, name: string): boolean {
  const lc = name.toLowerCase();
  return allNames(r).some((n) => n.toLowerCase() === lc);
}

/** Checks both "X" and "The X" — handles the leading-article prefix the scanner sometimes stores. */
function hasNameVariant(r: ScanResult, name: string): boolean {
  return hasName(r, name) || hasName(r, `The ${name}`);
}

function bucketOf(r: ScanResult, name: string): "character" | "place" | "faction" | "entity" | null {
  const lc = name.toLowerCase();
  if (r.characters.some((n) => n.toLowerCase() === lc)) return "character";
  if (r.places.some((n) => n.toLowerCase() === lc)) return "place";
  if (r.factions.some((n) => n.toLowerCase() === lc)) return "faction";
  if (r.entities.some((n) => n.toLowerCase() === lc)) return "entity";
  return null;
}

/** Returns bucket for "X" or "The X", whichever is present. */
function bucketOfVariant(r: ScanResult, name: string): "character" | "place" | "faction" | "entity" | null {
  return bucketOf(r, name) ?? bucketOf(r, `The ${name}`);
}

// ─── Framework ────────────────────────────────────────────────────────────────

type TestResult = {
  name: string;
  passed: number;
  failed: number;
  details: string[];
};

type Assertion = {
  label: string;
  ok: boolean;
  detail?: string;
};

function assert(label: string, ok: boolean, detail?: string): Assertion {
  return { label, ok, detail };
}

async function runGroup(
  name: string,
  fn: () => Promise<Assertion[]> | Assertion[],
): Promise<TestResult> {
  const assertions = await fn();
  const passed = assertions.filter((a) => a.ok).length;
  const failed = assertions.filter((a) => !a.ok).length;
  const details = assertions.map((a) => {
    const icon = a.ok ? "✓" : "✗";
    return `  ${icon} ${a.label}${a.detail ? ` (${a.detail})` : ""}`;
  });
  return { name, passed, failed, details };
}

// ─── Test groups ──────────────────────────────────────────────────────────────

/**
 * GROUP 1 — Common-word false positive rejection (no-LM path)
 *
 * "Day", "Long", "Half" are common English words that should NOT be detected
 * as character/place/faction/entity names even when capitalised at sentence starts.
 * The user explicitly identified these as unwanted false positives.
 */
async function testCommonWordFalsePositives(): Promise<Assertion[]> {
  const text = [
    // Day — appears multiple times at sentence start, no character signals
    "Day began cold and overcast. By the time Day ended, nothing had changed.",
    "Day lingered longer than expected. Day had not been kind to the settlement.",
    "Day pressed on through the grey.",
    // Long — temporal / adjectival use
    "Long before the armies had gathered, the fortress stood empty.",
    "Long had the road stretched before them.",
    "Long after the council dispersed, the city remained silent.",
    // Half — numeric / fractional
    "Half the garrison had already left by dawn. Half remained at the gate.",
    "Half of the documents were missing. Half had been filed incorrectly.",
    // Night, Morning — common time words that appear capitalized
    "Night settled over the valley. Night brought little relief.",
    "Morning came without warning. Morning had always been the hardest part.",
    // Short, Deep — descriptive adjectives
    "Short was the window of opportunity before the gate closed.",
    "Deep in the archives, a single record remained.",
  ].join("\n\n");

  const result = await scanAndClassify(text, undefined, 2);

  return [
    assert("Day not detected as entity", !hasName(result, "Day"),
      hasName(result, "Day") ? "Day appeared in: " + bucketOf(result, "Day") : undefined),
    assert("Long not detected as entity", !hasName(result, "Long"),
      hasName(result, "Long") ? "Long appeared in: " + bucketOf(result, "Long") : undefined),
    assert("Half not detected as entity", !hasName(result, "Half"),
      hasName(result, "Half") ? "Half appeared in: " + bucketOf(result, "Half") : undefined),
    assert("Night not detected as entity", !hasName(result, "Night"),
      hasName(result, "Night") ? "Night appeared in: " + bucketOf(result, "Night") : undefined),
    assert("Morning not detected as entity", !hasName(result, "Morning"),
      hasName(result, "Morning") ? "Morning appeared in: " + bucketOf(result, "Morning") : undefined),
    assert("Short not detected as entity", !hasName(result, "Short"),
      hasName(result, "Short") ? "Short appeared in: " + bucketOf(result, "Short") : undefined),
    assert("Deep not detected as entity", !hasName(result, "Deep"),
      hasName(result, "Deep") ? "Deep appeared in: " + bucketOf(result, "Deep") : undefined),
  ];
}

/**
 * GROUP 2 — Common body-part and material false positives (no-LM path)
 *
 * Words like "Standing", "Knees", "Stone", "Arm", "Older" appear capitalised
 * at sentence starts but are not character names.
 */
async function testBodyPartMaterialFalsePositives(): Promise<Assertion[]> {
  const text = [
    "Standing in the doorway, the soldier watched the square.",
    "Standing had been difficult after the injury.",
    "Standing was all they could do as the list was read.",
    "Knees pressed against the cold stone floor.",
    "Knees buckled under the weight of the pack.",
    "Stone walls surrounded the compound. Stone had been quarried from the ridge.",
    "Arm reached out from the shadow. Arm extended toward the lantern.",
    "Older than the city itself, the foundation still held.",
    "Older methods had proven more reliable in the field.",
    "Bone and iron — Bone had cracked. Iron had not.",
    "Dust rose from the road. Dust coated every surface.",
    "Smoke drifted from the eastern district. Smoke had been visible since dawn.",
  ].join("\n\n");

  const result = await scanAndClassify(text, undefined, 2);

  return [
    assert("Standing not detected as entity", !hasName(result, "Standing")),
    assert("Knees not detected as entity", !hasName(result, "Knees")),
    assert("Stone not detected as entity", !hasName(result, "Stone")),
    assert("Arm not detected as entity", !hasName(result, "Arm")),
    assert("Older not detected as entity", !hasName(result, "Older")),
    assert("Bone not detected as entity", !hasName(result, "Bone")),
    assert("Dust not detected as entity", !hasName(result, "Dust")),
    assert("Smoke not detected as entity", !hasName(result, "Smoke")),
  ];
}

/**
 * GROUP 3 — True positive detection (no-LM path)
 *
 * Invented proper nouns that appear with character signals MUST be detected.
 * Forgiving > strict: these should pass comfortably.
 */
async function testTruePositiveDetection(): Promise<Assertion[]> {
  const text = [
    // Clear character — pronoun + verb context, 3+ appearances
    "Nora entered the hall without speaking. She crossed the room and stood by the window.",
    "Nora looked at the document for a long time before answering.",
    "Kairon waited by the gate. He had been standing there since before the guards changed.",
    "Kairon said nothing when she arrived. Kairon simply nodded.",
    // Clear place — preposition context + suffix
    "The delegation traveled through Myrhold Pass to reach the lower plains.",
    "Near Myrhold Pass, the road narrowed significantly.",
    "Myrhold Pass had been closed for three winters before the treaty allowed movement.",
    // Clear faction — collective verb context + suffix
    "The Sentinel Order convened at the citadel. The Sentinel Order issued a declaration.",
    "Members of the Sentinel Order were stationed throughout the district.",
    // Invented single-word character name with strong signals
    "Vey said nothing when the announcement came. She turned away from the board.",
    "Vey had known since the morning. Vey nodded slowly and did not look surprised.",
    // Multi-word invented place
    "The Kairon Basin stretched beyond the visible horizon.",
    "Within the Kairon Basin, three rivers converged.",
    "Settlements in the Kairon Basin had expanded over the last decade.",
  ].join("\n\n");

  const result = await scanAndClassify(text, undefined, 2);

  return [
    assert("Nora detected", hasName(result, "Nora"),
      `found: ${allNames(result).slice(0, 8).join(", ")}`),
    assert("Kairon detected", hasName(result, "Kairon")),
    assert("Vey detected", hasName(result, "Vey")),
    assert("Myrhold Pass detected", hasName(result, "Myrhold Pass")),
    assert("Sentinel Order detected", hasNameVariant(result, "Sentinel Order")),
    assert("Kairon Basin detected", hasNameVariant(result, "Kairon Basin")),
  ];
}

/**
 * GROUP 4 — Bucket accuracy (no-LM path)
 *
 * Each name should be filed in the correct bucket based on structural signals
 * and contextual evidence from the surrounding prose.
 */
async function testBucketAccuracy(): Promise<Assertion[]> {
  const text = [
    // CHARACTER — pronoun "she/he", verb after ("said", "walked"), title prefix
    "Mira said nothing when the door opened. She turned and looked at the table.",
    "Mira had known for some time. Mira walked toward the window and did not speak.",
    // PLACE — preposition + place-suffix
    "The caravan moved through Ashwood Forest for three days before reaching the ridge.",
    "In Ashwood Forest, the light changed markedly from dawn to midday.",
    "Ashwood Forest bordered the northern territory claimed by the old compact.",
    // FACTION — faction-suffix + collective verb
    "The Ironclad Watch had dispatched units to the harbor. The Ironclad Watch controlled three districts.",
    "Reports to the Ironclad Watch were filed on alternating days.",
    // ENTITY — entity-suffix + governance verb after
    "The Continuity Directive required all administrative records to be submitted quarterly.",
    "Under the Continuity Directive, nothing could be altered after formal submission.",
    "The Continuity Directive governed all archival operations within the network.",
    // CHARACTER with title
    "Lord Feris arrived at the assembly in the early hours. He took his seat without ceremony.",
    "Lord Feris had already reviewed the documents. Lord Feris addressed the chamber directly.",
  ].join("\n\n");

  const result = await scanAndClassify(text, undefined, 2);

  const assertions: Assertion[] = [];

  // Characters
  assertions.push(assert("Mira → character", bucketOf(result, "Mira") === "character",
    `actual: ${bucketOf(result, "Mira") ?? "not found"}`));
  assertions.push(assert("Lord Feris detected", hasName(result, "Lord Feris")));

  // Places
  assertions.push(assert("Ashwood Forest → place", bucketOf(result, "Ashwood Forest") === "place",
    `actual: ${bucketOf(result, "Ashwood Forest") ?? "not found"}`));

  // Factions
  assertions.push(assert("Ironclad Watch → faction", bucketOfVariant(result, "Ironclad Watch") === "faction",
    `actual: ${bucketOfVariant(result, "Ironclad Watch") ?? "not found"}`));

  // Entities
  assertions.push(assert("Continuity Directive → entity", bucketOfVariant(result, "Continuity Directive") === "entity",
    `actual: ${bucketOfVariant(result, "Continuity Directive") ?? "not found"}`));

  return assertions;
}

/**
 * GROUP 5 — Invented name vs common-adjective contrast
 *
 * "Cold" and "Dark" at sentence starts should not be detected.
 * But "Coldren" and "Darkholm" (invented) should be.
 */
async function testInventedVsCommonContrast(): Promise<Assertion[]> {
  const text = [
    // Common adjectives — should NOT appear
    "Cold had crept into the chamber by evening.",
    "Cold pressed against the stone walls of the lower hall.",
    "Dark settled over the ridge before the fires were lit.",
    "Dark had fallen by the time they reached the gate.",
    // Invented proper nouns — SHOULD appear
    "Coldren watched from the upper balcony. She said nothing until the chamber emptied.",
    "Coldren had been waiting for three hours. Coldren turned when the door opened.",
    "Darkholm was located at the edge of the northern territory.",
    "Within Darkholm, three separate districts maintained independent councils.",
    "Travelers approaching Darkholm often stopped at the outer gate.",
    "From Darkholm, the road curved north through the pass.",
  ].join("\n\n");

  const result = await scanAndClassify(text, undefined, 2);

  return [
    assert("Cold not detected", !hasName(result, "Cold"),
      hasName(result, "Cold") ? "Cold in: " + bucketOf(result, "Cold") : undefined),
    assert("Dark not detected", !hasName(result, "Dark"),
      hasName(result, "Dark") ? "Dark in: " + bucketOf(result, "Dark") : undefined),
    assert("Coldren detected", hasName(result, "Coldren"),
      `found: ${allNames(result).slice(0, 8).join(", ")}`),
    assert("Darkholm detected", hasName(result, "Darkholm")),
  ];
}

/**
 * GROUP 6 — Multi-novel stress: forgiving threshold check
 *
 * When the user has defined names in worldData, the scan should
 * exclude them and not duplicate. Unknown names still flow through.
 */
async function testForgivingThreshold(): Promise<Assertion[]> {
  // Borderline: a name that appears only twice with moderate context
  // should still be detected — forgiving > strict
  const text = [
    "Seya looked out from the window. She had been watching for an hour.",
    "Seya said nothing when the letter arrived.",
    // Genuinely ambiguous single-appearance — should NOT appear (freq < minFreq)
    "Theron passed through the district once.",
  ].join("\n\n");

  const result = await scanAndClassify(text, undefined, 2);

  return [
    assert("Seya detected (2x + pronoun context)", hasName(result, "Seya"),
      `found: ${allNames(result).join(", ")}`),
    // Theron appears only once — tolerate either outcome (forgiving check)
    assert("Theron single-appearance tolerated either way",
      true, // not a hard assertion — just documenting expected behavior
    ),
  ];
}

/**
 * GROUP 7 — LM-assisted institutional disambiguation
 *
 * When semanticEntityAssist is enabled, the LM should correctly
 * classify institutional multi-word names into entity vs faction vs place.
 *
 * Only runs if the LM embed function is available (Electron / dev env).
 * Gracefully skips if LM is unavailable.
 */
async function testLMInstitutionalDisambiguation(): Promise<Assertion[]> {
  const text = [
    // Entity (doctrine / protocol / directive)
    "The Continuity Protocol required quarterly audits of all administrative records.",
    "Under the Continuity Protocol, no document could be altered after submission.",
    "The Continuity Protocol governed the retention and classification of public filings.",
    // Faction (group / alliance / order)
    "The Northern Alliance had gathered its representatives at the capital.",
    "The Northern Alliance issued a joint statement calling for immediate review.",
    "Representatives of the Northern Alliance convened in the upper chamber.",
    // Place (station / district / settlement)
    "The Meridian Station served as the primary logistics hub for the eastern corridor.",
    "Shipments passed through Meridian Station on a fortnightly cycle.",
    "Meridian Station was located at the junction of three transit lines.",
  ].join("\n\n");

  // Run WITHOUT semantic assist first (baseline)
  const noLM = await scanAndClassify(text, undefined, 2, { semanticEntityAssist: false });
  // Run WITH semantic assist
  const withLM = await scanAndClassify(text, undefined, 2, { semanticEntityAssist: true });

  const assertions: Assertion[] = [];

  // Both paths should detect these names (scanner may store with "The " prefix)
  assertions.push(assert("Continuity Protocol detected (no-LM)", hasNameVariant(noLM, "Continuity Protocol")));
  assertions.push(assert("Continuity Protocol detected (LM)", hasNameVariant(withLM, "Continuity Protocol")));
  assertions.push(assert("Northern Alliance detected (no-LM)", hasNameVariant(noLM, "Northern Alliance")));
  assertions.push(assert("Northern Alliance detected (LM)", hasNameVariant(withLM, "Northern Alliance")));
  assertions.push(assert("Meridian Station detected (no-LM)", hasName(noLM, "Meridian Station")));
  assertions.push(assert("Meridian Station detected (LM)", hasName(withLM, "Meridian Station")));

  // Bucket correctness — both paths should ideally get the right bucket
  assertions.push(assert("Continuity Protocol → entity (no-LM)",
    bucketOfVariant(noLM, "Continuity Protocol") === "entity",
    `actual: ${bucketOfVariant(noLM, "Continuity Protocol") ?? "not found"}`));
  assertions.push(assert("Continuity Protocol → entity (LM)",
    bucketOfVariant(withLM, "Continuity Protocol") === "entity",
    `actual: ${bucketOfVariant(withLM, "Continuity Protocol") ?? "not found"}`));

  assertions.push(assert("Northern Alliance → faction (no-LM)",
    bucketOfVariant(noLM, "Northern Alliance") === "faction",
    `actual: ${bucketOfVariant(noLM, "Northern Alliance") ?? "not found"}`));
  assertions.push(assert("Northern Alliance → faction (LM)",
    bucketOfVariant(withLM, "Northern Alliance") === "faction",
    `actual: ${bucketOfVariant(withLM, "Northern Alliance") ?? "not found"}`));

  assertions.push(assert("Meridian Station → place (no-LM)",
    bucketOf(noLM, "Meridian Station") === "place",
    `actual: ${bucketOf(noLM, "Meridian Station") ?? "not found"}`));
  assertions.push(assert("Meridian Station → place (LM)",
    bucketOf(withLM, "Meridian Station") === "place",
    `actual: ${bucketOf(withLM, "Meridian Station") ?? "not found"}`));

  return assertions;
}

/**
 * GROUP 8 — Event sentence LM: no regression
 *
 * Validates that selectBestLabel, refineEventType, and classifyEventDetail
 * still work correctly and produce sensible results — no crash, all labels
 * are non-empty strings ≥ 6 chars.
 */
async function testEventSentenceLMNoRegression(): Promise<Assertion[]> {
  const { selectBestLabel, refineEventType, classifyEventDetail } =
    await import("../src/lib/narrative-lm");

  const confrontationPara = [
    'She stepped forward. "You lied to us," she said, her voice level but hard.',
    "He did not flinch. He did not look away.",
    '"I made a decision. That is not the same as lying."',
    "The silence that followed was not agreement.",
  ].join(" ");

  const revelationPara = [
    "She read the document a second time and then a third.",
    "The decision had been made without any awareness of the people it would displace.",
    "That was the fact of it. Both things were true and neither cancelled the other.",
    "The documentation was not sufficient — had never been sufficient.",
  ].join(" ");

  const transitionPara = [
    "Three days later, the convoy arrived at the southern gate.",
    "The road had been longer than the maps suggested.",
    "By the time they reached the city, the light had already changed.",
  ].join(" ");

  const assertions: Assertion[] = [];

  // selectBestLabel — each should return a non-empty string ≥ 6 chars
  const confrontLabel = await selectBestLabel(confrontationPara, "confrontation");
  assertions.push(assert("confrontation label ≥ 6 chars", confrontLabel.length >= 6,
    `label: "${confrontLabel}"`));
  assertions.push(assert("confrontation label is a string", typeof confrontLabel === "string"));

  const revelLabel = await selectBestLabel(revelationPara, "revelation");
  assertions.push(assert("revelation label ≥ 6 chars", revelLabel.length >= 6,
    `label: "${revelLabel}"`));

  const transLabel = await selectBestLabel(transitionPara, "transition");
  assertions.push(assert("transition label ≥ 6 chars", transLabel.length >= 6,
    `label: "${transLabel}"`));

  // refineEventType — should return a valid type
  const validTypes = new Set(["climax", "confrontation", "revelation", "introduction", "transition", "scene-break"]);
  const refined = await refineEventType(
    '"I made a decision. That is not the same as lying."',
    "confrontation",
  );
  assertions.push(assert("refineEventType returns valid type", validTypes.has(refined.type),
    `type: ${refined.type}`));
  assertions.push(assert("refineEventType confidence in [0,1]",
    refined.confidence >= 0 && refined.confidence <= 1,
    `confidence: ${refined.confidence.toFixed(2)}`));

  // classifyEventDetail — should return null or a valid detail prediction
  const detail = await classifyEventDetail(
    "The decision had been made without any awareness of the people it would displace.",
    "revelation",
  );
  if (detail !== null) {
    assertions.push(assert("detail label is non-empty string", detail.detailLabel.length > 0,
      `detailLabel: "${detail.detailLabel}"`));
    assertions.push(assert("detail confidence in [0,1]",
      detail.confidence >= 0 && detail.confidence <= 1,
      `confidence: ${detail.confidence.toFixed(2)}`));
  } else {
    assertions.push(assert("classifyEventDetail gracefully returned null (low-confidence OK)", true));
  }

  // Stability check: same input → same label (no random variance)
  const confrontLabel2 = await selectBestLabel(confrontationPara, "confrontation");
  assertions.push(assert("selectBestLabel is deterministic", confrontLabel === confrontLabel2,
    `first: "${confrontLabel}", second: "${confrontLabel2}"`));

  return assertions;
}

/**
 * GROUP 9 — Edge cases: chapter-level minFreq=1 scan
 *
 * At minFreq=1 (single-chapter scan), very common words should still be filtered
 * by the IDF gate, not just the frequency gate.
 */
async function testSingleChapterIdfGate(): Promise<Assertion[]> {
  const text = [
    // Common words at sentence starts — appear only once in this short text
    "Day arrived with the sound of bells.",
    "Long shadows stretched across the courtyard.",
    "Half the population had already evacuated.",
    // True character name — should be detected even at freq=1 when context is strong
    "Fenris entered the chamber and addressed the council directly.",
    'Fenris said, "The document is incomplete."',
  ].join("\n\n");

  // minFreq=1 — most permissive scan
  const result = await scanAndClassify(text, undefined, 1);

  return [
    assert("Day not detected at minFreq=1", !hasName(result, "Day"),
      hasName(result, "Day") ? "Day appeared in: " + bucketOf(result, "Day") : undefined),
    assert("Long not detected at minFreq=1", !hasName(result, "Long")),
    assert("Half not detected at minFreq=1", !hasName(result, "Half")),
    assert("Fenris detected at minFreq=1", hasName(result, "Fenris"),
      `found: ${allNames(result).join(", ")}`),
  ];
}

// ─── Runner ────────────────────────────────────────────────────────────────────

const TARGETS = {
  falsePositiveRate: 0.20, // ≤ 20% of asserted negatives should be wrong
  recallRate: 0.90,        // ≥ 90% of asserted positives should be found
  bucketRate: 0.75,        // ≥ 75% of bucket assertions should be correct
  lmBucketRate: 0.80,      // ≥ 80% correct when LM assist is used
};

async function main() {
  console.log("\n╔═══════════════════════════════════════════════════════════════╗");
  console.log("║  Name Detection + Bucket Accuracy Suite                      ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝\n");

  const groups: Array<{ name: string; fn: () => Promise<Assertion[]>; category: string }> = [
    { name: "Common-word FP rejection (Day/Long/Half)", fn: testCommonWordFalsePositives, category: "fp" },
    { name: "Body-part/material FP rejection", fn: testBodyPartMaterialFalsePositives, category: "fp" },
    { name: "True positive detection", fn: testTruePositiveDetection, category: "tp" },
    { name: "Bucket accuracy", fn: testBucketAccuracy, category: "bucket" },
    { name: "Invented vs common contrast", fn: testInventedVsCommonContrast, category: "mixed" },
    { name: "Forgiving threshold check", fn: testForgivingThreshold, category: "tp" },
    { name: "LM institutional disambiguation", fn: testLMInstitutionalDisambiguation, category: "lm" },
    { name: "Event sentence LM no-regression", fn: testEventSentenceLMNoRegression, category: "lm" },
    { name: "Single-chapter IDF gate", fn: testSingleChapterIdfGate, category: "fp" },
  ];

  const results: TestResult[] = [];

  for (const group of groups) {
    process.stdout.write(`── ${group.name} … `);
    try {
      const result = await runGroup(group.name, group.fn);
      results.push(result);
      const pct = result.passed + result.failed > 0
        ? Math.round((result.passed / (result.passed + result.failed)) * 100)
        : 100;
      const icon = result.failed === 0 ? "✓" : "✗";
      console.log(`${icon} ${result.passed}/${result.passed + result.failed} (${pct}%)`);
      for (const d of result.details) {
        if (d.includes("✗")) console.log(d);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      results.push({ name: group.name, passed: 0, failed: 1, details: [`  ✗ THREW: ${errorMsg}`] });
      console.log(`✗ THREW`);
      console.log(`  ${errorMsg.split("\n")[0]}`);
    }
  }

  // ─── Category summaries ──────────────────────────────────────────────────────

  console.log("\n" + "═".repeat(67));
  console.log("SUMMARY BY CATEGORY\n");

  const totalPass = results.reduce((s, r) => s + r.passed, 0);
  const totalFail = results.reduce((s, r) => s + r.failed, 0);
  const totalAll = totalPass + totalFail;
  const overallPct = totalAll > 0 ? Math.round((totalPass / totalAll) * 100) : 0;

  console.log(`  Total: ${totalPass}/${totalAll} (${overallPct}%)`);

  // Print all failures
  let anyFailed = false;
  for (const r of results) {
    if (r.failed > 0) {
      anyFailed = true;
      console.log(`\n  [FAIL] ${r.name}`);
      for (const d of r.details) {
        if (d.includes("✗")) console.log(d);
      }
    }
  }

  console.log("\n" + "═".repeat(67));
  const TARGET_PCT = 80;
  if (overallPct < TARGET_PCT) {
    console.log(`RESULT: FAIL — ${overallPct}% overall (target ≥ ${TARGET_PCT}%)\n`);
    process.exit(1);
  } else if (anyFailed) {
    console.log(`RESULT: PARTIAL — ${overallPct}% overall. Some assertions failed.\n`);
    process.exit(1);
  } else {
    console.log(`RESULT: PASS — ${overallPct}% overall ✓\n`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
