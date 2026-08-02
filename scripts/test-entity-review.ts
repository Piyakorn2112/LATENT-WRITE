/**
 * test-entity-review.ts — GATED, model-free harness for the scan-review logic.
 *
 * The complaint this guards: "some characters still get classified as
 * location". Review used to be reserved for names the scan itself flagged,
 * which by construction can never reach a name it got CONFIDENTLY wrong.
 * These gates pin the fix — usage signals, the priority queue, and the
 * asymmetric acceptance bars — without spending a token.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-entity-review.ts
 */
import {
  usageSignals,
  contradictionScore,
  reviewPriority,
  selectReviewable,
  usageSnippets,
  applyProposalsToScanResult,
  buildEntityReviewRequest,
  OVERTURN_CONFIDENT_MIN,
  OVERTURN_DOUBTED_MIN,
  type EntityReviewEntry,
  type EntityReviewProposal,
} from "../src/lib/entity-review";

let failures = 0;
const gate = (ok: boolean, label: string, detail: string) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label} — ${detail}`);
  if (!ok) failures++;
};

// A person the scan would plausibly mislabel: the name reads like a place.
const PERSON_TEXT = [
  `Halloway Reach set down the manifest and rubbed his eyes.`,
  `"The tide tables are wrong again," said Halloway Reach.`,
  `Mira turned to Halloway Reach and asked whether the inspector had called.`,
  `"You are certain, Halloway Reach?" she said, and he nodded once.`,
  `Halloway Reach's ledger stayed open on the desk all night.`,
].join("\n\n");

// A place the scan would plausibly mislabel as a person.
const PLACE_TEXT = [
  `They took the road to Corin Ashe before the fog closed in.`,
  `The streets of Corin Ashe were empty at that hour.`,
  `Nothing moved in Corin Ashe, and nothing had for a week.`,
  `She arrived at Corin Ashe with the tide still going out.`,
].join("\n\n");

console.log("═".repeat(70));
console.log("entity review — selection, signals, and the acceptance bars");
console.log("═".repeat(70));

// ── 1. Signals read the grammar, not the name ────────────────────────────
{
  const person = usageSignals(PERSON_TEXT, "Halloway Reach");
  const place = usageSignals(PLACE_TEXT, "Corin Ashe");
  gate(
    person.spoken >= 1 && person.addressed >= 1 && person.placePrep === 0,
    "person usage reads as a person",
    `speaks ${person.spoken} · spoken to ${person.addressed} · place-prep ${person.placePrep}`,
  );
  gate(
    place.placePrep >= 3 && place.spoken === 0 && place.addressed === 0,
    "place usage reads as a place",
    `place-prep ${place.placePrep} · speaks ${place.spoken} · spoken to ${place.addressed}`,
  );
}

// ── 2. A CONFIDENT wrong label is contradicted by its own text ───────────
{
  const asPlace = contradictionScore("place", usageSignals(PERSON_TEXT, "Halloway Reach"));
  const asCharacter = contradictionScore("character", usageSignals(PERSON_TEXT, "Halloway Reach"));
  const placeAsChar = contradictionScore("character", usageSignals(PLACE_TEXT, "Corin Ashe"));
  gate(asPlace > 0.5, "person labelled place is contradicted", `score ${asPlace.toFixed(2)}`);
  gate(asCharacter === 0, "a correct label is not contradicted", `score ${asCharacter.toFixed(2)}`);
  gate(placeAsChar > 0.5, "place labelled character is contradicted", `score ${placeAsChar.toFixed(2)}`);
}

// ── 3. Contradiction outranks mere doubt in the queue ────────────────────
{
  const confidentlyWrong: EntityReviewEntry = { name: "Halloway Reach", currentType: "place" };
  const merelyUnsure: EntityReviewEntry = { name: "Someone", currentType: "character", needsReview: true };
  const pWrong = reviewPriority(confidentlyWrong, usageSignals(PERSON_TEXT, "Halloway Reach"));
  const pUnsure = reviewPriority(merelyUnsure);
  gate(pWrong > pUnsure, "contradiction outranks doubt", `${pWrong.toFixed(2)} > ${pUnsure.toFixed(2)}`);

  // ★ THE REGRESSION THAT MATTERS: under the old rule this name was not
  //   reviewable at all, because the scan never doubted it.
  const order = selectReviewable([merelyUnsure, confidentlyWrong], { text: PERSON_TEXT, cap: 2 });
  gate(order[0]?.name === "Halloway Reach", "the confidently-wrong name is reviewed FIRST",
    order.map((e) => e.name).join(" → "));
  const withoutText = selectReviewable([confidentlyWrong], {});
  gate(withoutText.length === 1, "selection still works with no text (degrades to doubt)",
    `${withoutText.length} selected`);
}

// ── 4. Everything is eligible now, but the budget still holds ────────────
{
  const many: EntityReviewEntry[] = Array.from({ length: 40 }, (_, i) => ({
    name: `Name${i}`, currentType: "character",
  }));
  const picked = selectReviewable(many, { cap: 24 });
  gate(picked.length === 24, "cap holds when everything is eligible", `${picked.length} of 40`);
  const twice = selectReviewable(many, { cap: 24 }).map((e) => e.name).join(",");
  gate(twice === picked.map((e) => e.name).join(","), "selection is stable across runs", "same order twice");
}

// ── 5. The acceptance bars are asymmetric ────────────────────────────────
{
  const scan = { characters: ["Halloway Reach"], places: [], factions: [], entities: [] };
  const proposal = (confidence: number, doubted: boolean): EntityReviewProposal => ({
    name: "Halloway Reach", currentType: "character", proposedType: "place",
    confidence, reason: "the snippets show travel to it", scanDoubted: doubted,
  });

  const doubted = applyProposalsToScanResult(scan, [proposal(0.7, true)]);
  gate(doubted.changes.length === 1, "0.7 overturns a name the scan DOUBTED",
    `${doubted.changes.length} change(s), bar ${OVERTURN_DOUBTED_MIN}`);

  const confident = applyProposalsToScanResult(scan, [proposal(0.7, false)]);
  gate(confident.changes.length === 0, "0.7 does NOT overturn a CONFIDENT scan",
    `${confident.changes.length} change(s), bar ${OVERTURN_CONFIDENT_MIN}`);

  const strong = applyProposalsToScanResult(scan, [proposal(0.85, false)]);
  gate(strong.changes.length === 1 && strong.scan.places.includes("Halloway Reach"),
    "0.85 does overturn a confident scan", `places: ${strong.scan.places.join(", ") || "none"}`);

  const silent = applyProposalsToScanResult(scan, [{ ...proposal(0.95, true), reason: "  " }]);
  gate(silent.changes.length === 0, "a change with no reason is refused", "reason was whitespace");

  const dropped = applyProposalsToScanResult(scan, [
    { ...proposal(0.9, false), proposedType: "not-a-name" },
  ]);
  gate(
    dropped.scan.characters.length === 0 && dropped.scan.places.length === 0,
    "not-a-name deletes the name outright",
    `changes: ${dropped.changes.map((c) => `${c.from}→${c.to}`).join(", ")}`,
  );
}

// ── 6. The prompt actually carries the evidence ──────────────────────────
{
  const signals = usageSignals(PERSON_TEXT, "Halloway Reach");
  const request = buildEntityReviewRequest(
    { name: "Halloway Reach", currentType: "place" },
    usageSnippets(PERSON_TEXT, "Halloway Reach"),
    128,
    signals,
  );
  gate(
    request.userText.includes("COUNTS ACROSS THE CHAPTER") &&
    request.userText.includes("CURRENT LABEL: place") &&
    request.userText.includes("speaks "),
    "the request carries counts and the current label",
    `${request.userText.split("\n").length} lines`,
  );
  const withoutSignals = buildEntityReviewRequest(
    { name: "Halloway Reach", currentType: "place" },
    usageSnippets(PERSON_TEXT, "Halloway Reach"),
  );
  gate(!withoutSignals.userText.includes("COUNTS ACROSS"), "counts are omitted when absent, not faked",
    "no counts block");
}

console.log(`\n${failures === 0 ? "✓ ALL GATES GREEN" : `✗ ${failures} GATE(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
