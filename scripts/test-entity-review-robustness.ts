/// <reference types="node" />

/**
 * test-entity-review-robustness.ts — what the review pass does when the model,
 * or the manuscript, misbehaves.
 *
 * ★ THE GATES ABOVE THIS ONE CHECK THAT IT IS RIGHT. These check that it never
 *   makes things WORSE — that a malformed answer, a duplicate answer, a name
 *   the scan filed twice, a name full of regex metacharacters or a runner that
 *   throws costs at most that one name, and never the pass, the cast, or a
 *   correct label.
 *
 * ★ MODEL-FREE ON PURPOSE. Every adversarial answer here is one a real run
 *   could produce; making them deterministic is what lets this gate every
 *   commit instead of every model download.
 *
 *   ./node_modules/.bin/tsx scripts/test-entity-review-robustness.ts
 */
import {
  reviewEntities,
  applyProposalsToScanResult,
  usageSignals,
  usageSnippets,
  selectReviewable,
  type EntityReviewEntry,
  type EntityReviewProposal,
} from "../src/lib/entity-review";

let failures = 0;
const gate = (ok: boolean, label: string, detail: string) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label} — ${detail}`);
  if (!ok) failures++;
};

const TEXT = [
  `Halloway Reach set down the manifest and rubbed his eyes.`,
  `"The tide tables are wrong again," said Halloway Reach.`,
  `Mira turned to Halloway Reach and asked whether the inspector had called.`,
  `They took the road to Corin Ashe before the fog closed in.`,
  `The streets of Corin Ashe were empty at that hour.`,
  `Nothing moved in Corin Ashe, and nothing had for a week.`,
  `Ántonia said nothing when the letter came. She turned toward the window.`,
  `He asked Ántonia about the road and she told her what she knew.`,
  `Ántonia had known for a week, and Ántonia had said nothing about it.`,
  `O'Rourke (the elder) kept the ledger. O'Rourke never spoke of it.`,
  `She asked O'Rourke about the ledger and he shrugged at her.`,
].join("\n\n");

const entries: EntityReviewEntry[] = [
  { name: "Halloway Reach", currentType: "place", needsReview: true },
  { name: "Corin Ashe", currentType: "character", needsReview: true },
  { name: "Ántonia", currentType: "place", needsReview: true },
  { name: "O'Rourke", currentType: "place", needsReview: true },
];

const scan = () => ({
  characters: ["Corin Ashe"],
  places: ["Halloway Reach", "Ántonia", "O'Rourke"],
  factions: [] as string[],
  entities: [] as string[],
});

console.log("═".repeat(70));
console.log("entity review — robustness under a misbehaving model");
console.log("═".repeat(70));

// ── 1. Non-ASCII and punctuated names carry real evidence ────────────────
{
  console.log("\nnames the regexes used to break on");
  const a = usageSignals(TEXT, "Ántonia");
  gate(a.occurrences === 4 && a.spoken >= 1,
    "an accented name is counted, not half-counted",
    `occurrences ${a.occurrences}, speaks ${a.spoken}`);
  gate(a.occurrences >= a.spoken + a.addressed,
    "occurrences can never be under its own sub-counts",
    `${a.occurrences} >= ${a.spoken} + ${a.addressed}`);
  gate(usageSnippets(TEXT, "Ántonia").length > 0,
    "an accented name produces snippets, so it can be asked about",
    `${usageSnippets(TEXT, "Ántonia").length} snippet(s)`);

  const o = usageSignals(TEXT, "O'Rourke");
  gate(o.occurrences === 3, "an apostrophe name is counted", `occurrences ${o.occurrences}`);
  gate(usageSnippets(TEXT, "O'Rourke").length > 0, "and produces snippets",
    `${usageSnippets(TEXT, "O'Rourke").length} snippet(s)`);

  // A regex metacharacter in a name must be escaped everywhere, not just in
  // the places somebody remembered.
  const meta = usageSignals(TEXT, "C.O.R.I.N (Ashe)");
  gate(meta.occurrences === 0, "regex metacharacters do not throw or match wildly",
    `occurrences ${meta.occurrences}`);
}

// ── 2. A malformed answer costs that name and nothing else ───────────────
{
  console.log("\nmalformed model output");
  const junk: Record<string, unknown> = {
    "Halloway Reach": null,
    "Corin Ashe": "place",
    "Ántonia": { reason: "shows travel to it", type: "wharf", confidence: 0.9 },
    "O'Rourke": { reason: "  ", type: "place", confidence: 0.9 },
  };
  let asked = 0;
  const proposals = await reviewEntities({ entries, text: TEXT }, {
    run: async (req) => {
      asked += 1;
      const j = junk[req.tag];
      return j === null ? { ok: false as const, error: "declined" } : { ok: true as const, json: j };
    },
  });
  gate(asked === entries.length, "every entry was still asked", `${asked} of ${entries.length}`);
  gate(proposals.length === 0, "not one malformed answer became a proposal",
    `${proposals.length} proposal(s)`);
}

// ── 3. A runner that THROWS costs that name and nothing else ─────────────
{
  console.log("\na runner that throws");
  let asked = 0;
  const proposals = await reviewEntities({ entries, text: TEXT }, {
    run: async (req) => {
      asked += 1;
      if (req.tag === "Corin Ashe") throw new Error("host died mid-request");
      return { ok: true as const, json: { reason: "it speaks", type: "character", confidence: 0.9 } };
    },
  });
  gate(asked === entries.length, "the pass kept going past the throw", `${asked} asked`);
  gate(proposals.length === entries.length - 1,
    "every other name still produced its proposal",
    `${proposals.length} of ${entries.length - 1}`);
}

// ── 4. Duplicate and conflicting proposals ───────────────────────────────
{
  console.log("\nduplicate and conflicting proposals");
  const p = (name: string, to: EntityReviewProposal["proposedType"], conf: number): EntityReviewProposal => ({
    name, currentType: "place", proposedType: to, confidence: conf,
    reason: "the snippets show it", scanDoubted: true, occurrences: 9,
  });
  const twice = applyProposalsToScanResult(scan(), [
    p("Halloway Reach", "character", 0.9),
    p("Halloway Reach", "faction", 0.9),
  ]);
  gate(twice.changes.length === 1, "a second proposal for the same name is ignored",
    `${twice.changes.length} change(s)`);
  gate(twice.scan.characters.filter((n) => n === "Halloway Reach").length === 1,
    "and the name lands in exactly one bucket",
    `characters: ${twice.scan.characters.join(", ")}`);
}

// ── 5. A name the scan filed in two buckets ──────────────────────────────
{
  console.log("\na name the scan filed twice");
  const doubled = {
    characters: ["Halloway Reach"],
    places: ["Halloway Reach"],
    factions: [] as string[],
    entities: [] as string[],
  };
  const moved = applyProposalsToScanResult(doubled, [{
    name: "Halloway Reach", currentType: "place", proposedType: "faction",
    confidence: 0.9, reason: "acts as one body", scanDoubted: true, occurrences: 9,
  }]);
  const total = moved.scan.characters.length + moved.scan.places.length
    + moved.scan.factions.length + moved.scan.entities.length;
  gate(total === 1, "the duplicate is resolved, not multiplied",
    `characters ${moved.scan.characters.length}, places ${moved.scan.places.length}, factions ${moved.scan.factions.length}`);
}

// ── 6. Selection never asks a question with no answer in it ──────────────
{
  console.log("\nselection");
  const noEvidence: EntityReviewEntry[] = Array.from({ length: 30 }, (_, i) => ({
    name: `Absent${i}`, currentType: "character",
  }));
  const withText = selectReviewable(noEvidence, { text: TEXT });
  gate(withText.length === 0,
    "names with no doubt AND no contradiction are not asked about",
    `${withText.length} selected from ${noEvidence.length}`);

  // The twin: without text there is no contradiction score to compute, so
  // priority 0 means "unknown", not "nothing to ask".
  const withoutText = selectReviewable(noEvidence, {});
  gate(withoutText.length === 24, "without text, selection still degrades to the cap",
    `${withoutText.length} selected`);

  const doubted = selectReviewable(entries, { text: TEXT });
  gate(doubted.length === entries.length, "a name the scan doubted is always asked",
    `${doubted.length} of ${entries.length}`);
}

console.log(`\n${failures === 0 ? "✓ ALL GATES GREEN" : `✗ ${failures} GATE(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
