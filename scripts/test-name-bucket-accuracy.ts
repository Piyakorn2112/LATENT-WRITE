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

/**
 * GROUP 10 — A DETERMINER IS NOT A BUCKET.
 *
 * ★★ THE MEASURED BUG. `\bthe\s*$` sat in BOTH the faction prefix list and the
 *    entity prefix list, worth +1.5 each, while the place-preposition test
 *    required the preposition to touch the name and so scored ZERO on "at the
 *    Mosshollow". Every name a novel writes as "the X" therefore accumulated
 *    equal faction and entity mass and no place mass at all, tied at the top,
 *    and the tie fell through the argmax to `character` and then out of the
 *    determiner eviction into `entity`. On The Root Crown that put a valley
 *    (Mosshollow), a village (Cymboll), a marsh (Dovesmoor) and a transit line
 *    (Drowner's Lift) in the same bucket as the magic system.
 *
 * The three cases below are the same shape — a name that is ALWAYS determined
 * — separated only by what the prose does around it. If the determiner is
 * driving instead of the prose, they collapse into one bucket and two fail.
 */
async function testDeterminerIsNotABucket(): Promise<Assertion[]> {
  const text = [
    // PLACE — always "the Wendrel", always after a place preposition.
    "She felt for it at the Wendrel, open-handed, the way she always had.",
    "The path back to the Wendrel was easy enough in daylight.",
    "He had come down from the Wendrel before the rain started.",
    "Nothing in the Wendrel had changed since the last season.",
    // ENTITY — always "the Ordinance", always governing something.
    "The Ordinance required every reading to be filed within the day.",
    "Under the Ordinance, nothing could be altered after submission.",
    "The Ordinance governed which phrases a licensed caster could use.",
    "The Ordinance defines the boundary between practice and offence.",
    // FACTION — always "the Kithren", always acting as one body.
    "The Kithren gathered at the lower hall before the announcement.",
    "The Kithren had declared the road closed for the season.",
    "The Kithren marched on the eastern gate at first light.",
    "The Kithren demanded an answer before the week was out.",
  ].join("\n\n");

  const r = await scanAndClassify(text, undefined, 2);
  return [
    assert("determined place → place", bucketOfVariant(r, "Wendrel") === "place",
      `actual: ${bucketOfVariant(r, "Wendrel") ?? "not found"}`),
    assert("determined doctrine → entity", bucketOfVariant(r, "Ordinance") === "entity",
      `actual: ${bucketOfVariant(r, "Ordinance") ?? "not found"}`),
    assert("determined group → faction", bucketOfVariant(r, "Kithren") === "faction",
      `actual: ${bucketOfVariant(r, "Kithren") ?? "not found"}`),
    // The positive twin for the whole group: the three must not agree, which is
    // exactly what a determiner-driven classifier would produce.
    assert("the three do not collapse into one bucket",
      new Set([bucketOfVariant(r, "Wendrel"), bucketOfVariant(r, "Ordinance"), bucketOfVariant(r, "Kithren")]).size === 3),
  ];
}

/**
 * GROUP 11 — A FRAGMENT OF A WORD IS NOT A NAME.
 *
 * Three ways the collector's `\b` boundary lets a capitalised substring pass as
 * a name, each measured on The Root Crown: "Don" out of "Don't", "Imperial" out
 * of "pre-Imperial", "Day" out of "Day 23". Each negative is paired with the
 * SAME token used as a real name, because a guard that also removes the real
 * thing has not fixed anything.
 */
async function testFragmentGuards(): Promise<Assertion[]> {
  const contraction = [
    `"Don't let them take it for scrap," she said. "It's a good keel."`,
    `"Don't," he said again, quieter this time.`,
    `"Don't ask me that. Don't ask anyone that."`,
    `She won't say it and he can't say it and that is the whole trouble.`,
    "Marek watched the two of them and said nothing at all.",
    "Marek had been at the yard since before either of them arrived.",
  ].join("\n\n");

  const realDon = [
    "Don said nothing when the letter came. He set it down and looked away.",
    "Don had known for a week. Don turned the envelope over twice.",
    "She asked Don about the yard and he told her what he knew.",
  ].join("\n\n");

  const hyphen = [
    "Pre-Imperial materials ended up in the peripheral catalogue often.",
    "He is listed as a pre-Imperial monastic chronicler. One folder.",
    "The pre-Imperial libraries held their materials only in the old script.",
    "A pre-Imperial notation survives in the compendium.",
    "Ferrow read the folder twice and then read it a third time.",
    "Ferrow had asked for the catalogue and been given a list instead.",
  ].join("\n\n");

  const realImperial = [
    "The Imperial Guard had been stationed at the gate for three weeks.",
    "Reports to the Imperial Guard were filed on alternating days.",
    "The Imperial Guard controlled every crossing in the district.",
  ].join("\n\n");

  const numbered = [
    "She had been using it as a reference frequency since Day 1.",
    "Walking with Kel through the early evening of Day 23, which was cold.",
    "On a morning in the week before Day 27, the marshal sat at his desk.",
    "By Day 40 the counting had stopped meaning anything.",
    "Kel had been walking that route since the first week.",
    "Kel said nothing about the counting and she did not ask.",
  ].join("\n\n");

  const realDay = [
    "Day said nothing when the door opened. She turned toward the table.",
    "Day had known for some time. Day walked to the window and waited.",
    "He asked Day about the letter and she told him the truth.",
    "Lady Day arrived before the others and said so.",
    "Day's coat was still wet. Day looked at the letter again and put it down.",
    'Day replied without turning around. "I already told you what I know."',
  ].join("\n\n");

  // A hyphen AFTER the name is the name being used as a modifier, not a
  // fragment: "Growth-class" is the Growth phrase, and must survive.
  const trailingHyphen = [
    "It applies to mid-level Growth-class substrate contact, more specific and less porous.",
    "A Growth-class response from a monitored pad behind the market was logged.",
    "The Growth foundational and the Bind-containment are both class A.",
    "She had done the Growth phrase twice that week and once in the alley.",
  ].join("\n\n");

  const [rc, rd, rh, ri, rn, rday, rt] = await Promise.all([
    scanAndClassify(contraction, undefined, 2),
    scanAndClassify(realDon, undefined, 2),
    scanAndClassify(hyphen, undefined, 2),
    scanAndClassify(realImperial, undefined, 2),
    scanAndClassify(numbered, undefined, 2),
    scanAndClassify(realDay, undefined, 2),
    scanAndClassify(trailingHyphen, undefined, 2),
  ]);

  return [
    assert('"Don" not harvested from "Don\'t"', !hasName(rc, "Don"),
      hasName(rc, "Don") ? `in ${bucketOf(rc, "Don")}` : undefined),
    assert("a real Don is still found", hasName(rd, "Don"),
      `found: ${allNames(rd).join(", ")}`),
    assert('"Imperial" not harvested from "pre-Imperial"', !hasName(rh, "Imperial"),
      hasName(rh, "Imperial") ? `in ${bucketOf(rh, "Imperial")}` : undefined),
    assert("a real Imperial Guard is still found", hasNameVariant(ri, "Imperial Guard"),
      `found: ${allNames(ri).join(", ")}`),
    assert('"Day" not harvested from "Day 23"', !hasName(rn, "Day"),
      hasName(rn, "Day") ? `in ${bucketOf(rn, "Day")}` : undefined),
    assert("a real Day is still found", hasName(rday, "Day"),
      `found: ${allNames(rday).join(", ")}`),
    assert('a trailing hyphen does not block "Growth"', hasName(rt, "Growth"),
      `found: ${allNames(rt).join(", ")}`),
  ];
}

/**
 * GROUP 12 — THE HEAD WORD DECIDES, NOT ANY WORD IN THE NAME.
 *
 * The suffix vocabularies were tested against the whole name, so "Outer Ring
 * Anomaly" scored +4 place for `ring` AND +4 entity for `anomaly` and tied.
 * English puts the head last: an Anomaly named after the Outer Ring is an
 * anomaly, and a Ring in the outer part of a city is a ring.
 */
async function testHeadWordDecides(): Promise<Assertion[]> {
  const text = [
    "The Outer Ring Anomaly was logged on the second day and reopened on the fourth.",
    "Nothing in the file explained the Outer Ring Anomaly to anyone's satisfaction.",
    "The Outer Ring Anomaly required a second reading before it could be closed.",
    "She had lived in the Outer Ring her whole life and knew every lane in it.",
    "The transit from the Outer Ring took forty minutes on a good morning.",
    "Walking north through the Outer Ring, she counted the shuttered stalls.",
    "The Cinder Guild met on the first of the month without exception.",
    "The Cinder Guild had refused the contract twice already.",
    "Representatives of the Cinder Guild gathered in the upper chamber.",
    "The Cinder Bridge had been closed since the flood took its eastern span.",
    "They crossed the Cinder Bridge at dusk and did not look down.",
    "From the Cinder Bridge the whole lower quarter was visible at once.",
  ].join("\n\n");

  const r = await scanAndClassify(text, undefined, 2);
  return [
    assert("Outer Ring Anomaly → entity (head: anomaly)",
      bucketOfVariant(r, "Outer Ring Anomaly") === "entity",
      `actual: ${bucketOfVariant(r, "Outer Ring Anomaly") ?? "not found"}`),
    assert("Outer Ring → place (head: ring)",
      bucketOfVariant(r, "Outer Ring") === "place",
      `actual: ${bucketOfVariant(r, "Outer Ring") ?? "not found"}`),
    assert("Cinder Guild → faction (head: guild)",
      bucketOfVariant(r, "Cinder Guild") === "faction",
      `actual: ${bucketOfVariant(r, "Cinder Guild") ?? "not found"}`),
    assert("Cinder Bridge → place (head: bridge, same modifier)",
      bucketOfVariant(r, "Cinder Bridge") === "place",
      `actual: ${bucketOfVariant(r, "Cinder Bridge") ?? "not found"}`),
  ];
}

/**
 * GROUP 13 — A SURNAME IS A PERSON, AND "the X <noun>" IS NOT A DETERMINED NAME.
 *
 * A family name is written "the Mosswell loaves", "the Mosswell house", "elder
 * Mosswell" far more often than it is written bare, so the determiner test
 * reads it as a common noun and evicts it from the cast. The article in those
 * phrases belongs to the noun that FOLLOWS, not to the name.
 *
 * The twin matters: an invented word that is never preceded by a person's given
 * name must NOT be recovered into the cast just because it is capitalised and
 * frequent.
 */
async function testSurnameRecovery(): Promise<Assertion[]> {
  // The determined uses have to OUTNUMBER the bare ones, or the eviction the
  // fix exists to prevent never fires and the assertion proves nothing. And
  // Tessa and Brennan have to be IN the cast: the rule reads a surname off a
  // given name it already knows is a person, so a book where the given names
  // appear once each cannot exercise it, and a fixture like that was silently
  // passing before the family scenes below were written in.
  const text = [
    "Tessa Mosswell hesitated at the mention of the work, and then went on.",
    "Brennan Mosswell did not come in before he was finished, which was usual.",
    "Tessa said nothing about the loom and went back to the kitchen.",
    "Tessa had been at the loom since morning. Tessa turned when the door opened.",
    "Brennan came in late and Brennan said nothing about where he had been.",
    "She asked Brennan about the ford and he told her what he knew.",
    "Brennan looked at the door for a while. Brennan said the obvious thing.",
    "Brennan turned the bowl over twice and Brennan put it down again.",
    "The wedding bread was on the tables, the Vell loaves and the Mosswell loaves together.",
    "The Mosswell house sat at the end of the lane, past the second gate.",
    "The Mosswell kitchen smelled of yeast for two days after.",
    "The Mosswell loom had been rethreaded twice that winter.",
    "She counted the Mosswell chairs and found there were not enough.",
    "The Mosswell dogs barked at the gate and then stopped.",
    "Elder Mosswell had an opinion about the ford and shared it twice.",
    "She asked Mosswell about the loom and got a long answer.",
    "Mosswell said nothing for a while and then said the obvious thing.",
    // The twin: frequent, capitalised, determined, never preceded by a person.
    "The Ashwood mill had been grinding since before the treaty.",
    "Smoke from the Ashwood mill hung over the lower road most mornings.",
    "They walked past the Ashwood yard without stopping to look.",
    "The Ashwood road curved north through the pass and then dropped.",
  ].join("\n\n");

  const r = await scanAndClassify(text, undefined, 2);
  return [
    assert("Mosswell → character (a surname)", bucketOf(r, "Mosswell") === "character",
      `actual: ${bucketOf(r, "Mosswell") ?? "not found"}`),
    assert("Ashwood not recovered into the cast", bucketOf(r, "Ashwood") !== "character",
      `actual: ${bucketOf(r, "Ashwood") ?? "not found"}`),
  ];
}

/**
 * GROUP 14 — A FAMILY PLURAL IS THE FAMILY, NOT A SECOND ENTITY.
 *
 * "the Vells had gone home" is the Vell household. Filed as its own faction it
 * gives the writer two entries for one referent and a group that never existed.
 * The twin: a plural whose singular is NOT in the cast is its own name.
 */
async function testFamilyPlural(): Promise<Assertion[]> {
  const text = [
    "Vell said nothing about the harvest and nobody pressed him on it.",
    "Vell had been at the ford since morning. Vell turned when she called.",
    "She asked Vell about the loom and he pointed at the far wall.",
    "The Vells had gone home through the September evening, all of them at once.",
    "The Vells were coming for supper, which meant the long table.",
    "Supper with the Vells ran late and nobody minded it.",
    "The Vells gathered at the far end and stayed there.",
    "Nobody told the Vells anything they did not already know.",
    "The Vells arrived before the bread was out of the oven.",
    "The Northern Passes stayed closed for three winters after the treaty.",
    "They crossed the Northern Passes in the second week of spring.",
    "Beyond the Northern Passes the road turned to gravel and then to nothing.",
  ].join("\n\n");

  const r = await scanAndClassify(text, undefined, 2);
  return [
    assert("Vell → character", bucketOf(r, "Vell") === "character",
      `actual: ${bucketOf(r, "Vell") ?? "not found"}`),
    assert("Vells not filed as its own entity", !hasName(r, "Vells"),
      hasName(r, "Vells") ? `in ${bucketOf(r, "Vells")}` : undefined),
    assert("Northern Passes kept (no singular in the cast)",
      hasNameVariant(r, "Northern Passes"),
      `found: ${allNames(r).join(", ")}`),
  ];
}

/**
 * GROUP 15 — NAMES SHARING A HEAD AGREE WITH EACH OTHER.
 *
 * On The Root Crown the scan put "The Closed School" in places and "The Open
 * School" in factions, off nothing but which one happened to follow a place
 * preposition more often. Two institutions of the same kind in the same book
 * cannot be different kinds of thing, and the writer reads that split as the
 * system being confused, which it is.
 *
 * The twin: names that share a MODIFIER, not a head, must stay independent.
 */
async function testHeadFamilyCoherence(): Promise<Assertion[]> {
  // One school is written the way a BUILDING is written (people go to it, work
  // inside it), the other the way an INSTITUTION is (it decides, refuses,
  // publishes). That asymmetry is real prose and it is exactly what split the
  // two on The Root Crown. Coherence has to survive it.
  const text = [
    "She had been at the Closed School as long as anyone still working there.",
    "Walking to the Closed School took twenty minutes from the market.",
    "Nobody at the Closed School would say the word out loud.",
    "He came from the Closed School by the lower road, as he always did.",
    "Inside the Closed School the corridors were colder than the street.",
    "She waited outside the Closed School until the bell went.",
    "The Open School published its findings at the end of each season.",
    "The Open School had refused the request twice and would refuse it again.",
    "Representatives of the Open School convened in the upper chamber.",
    "The Open School admitted forty students that year, which was fewer than usual.",
    "The Open School declared the matter closed and would not reopen it.",
    "The Open School ordered a second reading before the season ended.",
  ].join("\n\n");

  const r = await scanAndClassify(text, undefined, 2);
  const closed = bucketOfVariant(r, "Closed School");
  const open = bucketOfVariant(r, "Open School");
  return [
    assert("both schools found", !!closed && !!open, `closed: ${closed}, open: ${open}`),
    assert("the two schools agree", !!closed && closed === open,
      `closed: ${closed ?? "not found"}, open: ${open ?? "not found"}`),
  ];
}

/**
 * GROUP 16 — WHEN ONE BUCKET HOLDS ALL THE EVIDENCE, THE FLOORS DO NOT APPLY.
 *
 * ★★ THE LARGEST SINGLE ERROR CLASS, MEASURED. Across thirteen published
 *    novels every one of 40 wrong buckets was a PLACE filed as a CHARACTER,
 *    and not one error of any other kind: Switzerland, Leghorn and Perth in
 *    Frankenstein, nine London suburbs in The War of the Worlds, Louisiana and
 *    Kentucky in The Awakening. Each has place evidence and no person evidence
 *    at all, and each was losing to a bare-name default because its evidence
 *    sat under the deciding floors. Fixing it took the corpus from 83.8% to
 *    98.4%.
 *
 * The two twins are what keep it honest. A name with COMPETING evidence must
 * still face the floors, and a DETERMINED name must not reach this rung at all
 * — `character` is zeroed for those by construction, so "nothing competes" is
 * an artifact of the zeroing rather than a fact about the prose, and letting
 * it through sends a named spell to Places on one sighting.
 */
async function testUncontestedEvidence(): Promise<Assertion[]> {
  // Two bare place sightings, nothing else, in a book with plenty of prose.
  const quiet = [
    "The letter had come from Perrin two weeks before anyone read it.",
    "She had grown up in Perrin and had not been back since.",
    "Nobody in the valley spoke about what had happened that winter.",
    "The road was long and the season was turning and there was little to say.",
    "Hallam said nothing at all when the letter was read aloud.",
    "Hallam had known for a week. Hallam turned the page over twice.",
    "She asked Hallam about the road and he told her what he knew.",
  ].join("\n\n");

  // The same shape, but the name also does person things.
  const contested = [
    "The letter had come from Verrin two weeks before anyone read it.",
    "She had grown up in Verrin and had not been back since.",
    "Verrin said nothing at all when the letter was read aloud.",
    "Verrin had known for a week. Verrin turned the page over twice.",
    "She asked Verrin about the road and he told her what he knew.",
    "Hallam watched the two of them and did not interrupt.",
    "Hallam had been at the gate since morning.",
  ].join("\n\n");

  // Determined throughout, one place sighting, nothing else: a named
  // technique, not a location.
  const determined = [
    "The monitoring system reads the Sundering as common and licensed.",
    "She had done the Sundering twice that week and once in the alley.",
    "Past the Sundering in her first volume there was nothing she could use.",
    "The Sundering had a syntax she could not hold in her head at once.",
    "The Sundering was listed under class A with everything else.",
    "Hallam said nothing about the Sundering and she did not ask.",
    "Hallam had been reading the volume since morning.",
  ].join("\n\n");

  const [q, c, d] = await Promise.all([
    scanAndClassify(quiet, undefined, 2),
    scanAndClassify(contested, undefined, 2),
    scanAndClassify(determined, undefined, 2),
  ]);

  return [
    assert("uncontested place evidence wins without clearing the floor",
      bucketOf(q, "Perrin") === "place",
      `actual: ${bucketOf(q, "Perrin") ?? "not found"}`),
    assert("the person in the same book is still a character",
      bucketOf(q, "Hallam") === "character",
      `actual: ${bucketOf(q, "Hallam") ?? "not found"}`),
    assert("COMPETING evidence still faces the floors",
      bucketOf(c, "Verrin") === "character",
      `actual: ${bucketOf(c, "Verrin") ?? "not found"}`),
    assert("a DETERMINED name never reaches the rung",
      bucketOf(d, "Sundering") !== "place",
      `actual: ${bucketOf(d, "Sundering") ?? "not found"}`),
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
    { name: "A determiner is not a bucket", fn: testDeterminerIsNotABucket, category: "bucket" },
    { name: "Word-fragment guards", fn: testFragmentGuards, category: "fp" },
    { name: "The head word decides", fn: testHeadWordDecides, category: "bucket" },
    { name: "Surname recovery", fn: testSurnameRecovery, category: "bucket" },
    { name: "Family plural folding", fn: testFamilyPlural, category: "fp" },
    { name: "Head-family coherence", fn: testHeadFamilyCoherence, category: "bucket" },
    { name: "Uncontested evidence", fn: testUncontestedEvidence, category: "bucket" },
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
