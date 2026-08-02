/**
 * emit-assistant-task-fixtures.ts — the live harness's other half.
 *
 * An Electron `.cjs` harness cannot import TypeScript, and a harness that
 * hand-copies the prompt it is testing stops testing anything the moment the
 * real prompt moves. So this script builds the fixtures with the REAL modules —
 * `buildEvidencePack`, `buildAdjudicationRequest`, `selectReviewable`,
 * `usageSnippets`, `buildEntityReviewRequest` — and writes the exact bytes the
 * app would send to scripts/fixtures/assistant-tasks.json.
 * `scripts/verify-assistant-tasks.cjs` regenerates this file every run, so the
 * fixtures cannot drift from the code they test.
 *
 * ★ EVERY NAME IS FABRICATED. If a case used a real person, place or book, a
 *   pass would not prove the harness reads the evidence — it would prove the
 *   model remembers the world. Nothing here exists outside these fixtures.
 *
 * Run: /opt/homebrew/bin/node node_modules/tsx/dist/cli.mjs scripts/emit-assistant-task-fixtures.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADJUDICATOR_PROMPT_VERSION,
  VERDICT_SCHEMA,
  buildAdjudicationRequest,
  wireVerdictFor,
} from "../src/lib/adjudicator";
import { PACK_VERSION } from "../src/lib/evidence-pack";
import type { EvidencePackInput } from "../src/lib/evidence-pack";
import type { ChapterKnowledgeFacts, KnowledgeCandidate } from "../src/lib/knowledge-store";
import {
  ENTITY_REVIEW_PROMPT_VERSION,
  buildEntityReviewRequest,
  selectReviewable,
  usageSnippets,
} from "../src/lib/entity-review";
import type { EntityReviewEntry } from "../src/lib/entity-review";
import type { WorldData } from "../src/types";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "fixtures", "assistant-tasks.json");

/** The harness passes the real id so the emitted verdictKeys are the real ones. */
const MODEL_ID = process.env.ASSISTANT_MODEL_ID || "qwen3-1.7b-q4_k_m";

// ── fixture scaffolding ────────────────────────────────────────────────────

interface ChapterSpec {
  n: number;
  present: string[];
  exposed: string[];
  paragraphs: string[];
}

function chapters(specs: ChapterSpec[]): {
  chapters: ChapterKnowledgeFacts[];
  paragraphsByChapterId: Map<string, string[]>;
} {
  const out: ChapterKnowledgeFacts[] = [];
  const paragraphs = new Map<string, string[]>();
  for (const spec of specs) {
    const chapterId = `ch-${spec.n}`;
    out.push({
      chapterId,
      chapterNumber: spec.n,
      contentHash: `${spec.paragraphs.join("\n").length}|fixture`,
      present: [...spec.present].sort(),
      presentNarrow: [...spec.present].sort(),
      exposed: [...spec.exposed].sort(),
      references: [],
    });
    paragraphs.set(chapterId, spec.paragraphs);
  }
  return { chapters: out, paragraphsByChapterId: paragraphs };
}

function candidate(
  speaker: string,
  entity: string,
  chapterNumber: number,
  paragraphIndex: number,
  sentence: string,
): KnowledgeCandidate {
  return {
    key: `${speaker}→${entity}`,
    speaker,
    entity,
    chapterId: `ch-${chapterNumber}`,
    chapterNumber,
    paragraphIndex,
    sentence,
    band: "normal",
    status: "pending",
  };
}

// ── case (a) — a clear break ───────────────────────────────────────────────
// No channel exists at all: Merrow is never in a chapter where Vashti Orn has
// come up, there is no dossier to imply reputation, and the line reads as
// settled familiarity ("owes me three winters"), not as hearsay.

const A_CLAIM = "Vashti Orn owes me three winters of silence, and I mean to collect.";

const breakCase = (() => {
  const { chapters: chs, paragraphsByChapterId } = chapters([
    {
      n: 1,
      present: ["Merrow", "Talle"],
      exposed: ["Merrow", "Talle"],
      paragraphs: [
        "The lamp-house at Kerrin Bar had two rooms and one door, and Merrow had spent eleven years learning to sleep through the noise of the second.",
        "Talle came up the stair with the tide book under one arm. “You will want to see the third column,” she said, and put it down open.",
      ],
    },
    {
      n: 2,
      present: ["Merrow", "Talle"],
      exposed: ["Merrow", "Talle"],
      paragraphs: [
        "They worked the counting through the middle watch. Nothing came up the channel but weather, and the weather was not worth writing down.",
      ],
    },
    {
      n: 3,
      present: ["Talle"],
      exposed: ["Talle", "Vashti Orn"],
      paragraphs: [
        "Talle went down to the customs shed alone, because someone had to and because Merrow had not come back from the flats.",
        "The name on the writ was Vashti Orn. Talle read it twice, folded it, and put it in the stove without saying anything to anyone.",
      ],
    },
    {
      n: 4,
      present: ["Talle"],
      exposed: ["Talle", "Vashti Orn"],
      paragraphs: [
        "A second writ came, in the same hand, with the same name at the foot of it. Talle burned that one too and slept badly.",
      ],
    },
    {
      n: 5,
      present: ["Merrow", "Talle"],
      exposed: ["Merrow", "Talle", "Vashti Orn"],
      paragraphs: [
        "Merrow came back on the eighth day with salt in his beard and nothing to show for the walk.",
        "He would not sit down. He would not eat. He stood at the window with the shutter open and let the cold come in.",
        "“There is a thing you have not told me,” Talle said.",
        `Merrow set the lamp on the sill and did not turn around. “${A_CLAIM}” Talle said nothing, which was answer enough.`,
      ],
    },
  ]);

  const cand = candidate("Merrow", "Vashti Orn", 5, 3, A_CLAIM);
  const packInput: EvidencePackInput = {
    candidate: cand,
    chapters: chs,
    facts: [],
    paragraphsByChapterId,
    worldData: null,
  };
  return { id: "break", expect: "break", cand, packInput };
})();

// ── case (d) — the false-alarm canary ──────────────────────────────────────
// Structurally identical to (a) — no shared chapter, same claim, same absence
// of a dossier — with ONE addition: an author-asserted prior ruling, which the
// pack renders as rung 7. The writer already settled this pair, so a "break"
// here would mean the label fires on structure and ignores the evidence.
// Prove the test can fail (the colour-wheel discipline): (a) and (d) differ by
// exactly one rung.

const canaryCase = (() => {
  const { chapters: chs, paragraphsByChapterId } = chapters([
    {
      n: 1,
      present: ["Merrow", "Talle"],
      exposed: ["Merrow", "Talle"],
      paragraphs: [
        "The lamp-house at Kerrin Bar had two rooms and one door, and Merrow had spent eleven years learning to sleep through the noise of the second.",
      ],
    },
    {
      n: 3,
      present: ["Talle"],
      exposed: ["Talle", "Vashti Orn"],
      paragraphs: [
        "The name on the writ was Vashti Orn. Talle read it twice, folded it, and put it in the stove without saying anything to anyone.",
      ],
    },
    {
      n: 5,
      present: ["Merrow", "Talle"],
      exposed: ["Merrow", "Talle", "Vashti Orn"],
      paragraphs: [
        "Merrow came back on the eighth day with salt in his beard and nothing to show for the walk.",
        `Merrow set the lamp on the sill and did not turn around. “${A_CLAIM}” Talle said nothing, which was answer enough.`,
      ],
    },
  ]);

  const cand = candidate("Merrow", "Vashti Orn", 5, 1, A_CLAIM);
  const packInput: EvidencePackInput = {
    candidate: cand,
    chapters: chs,
    facts: [
      {
        subject: "Merrow",
        entity: "Vashti Orn",
        chapterId: "ch-1",
        chapterNumber: 1,
        how: "author-asserted",
      },
    ],
    paragraphsByChapterId,
    worldData: null,
  };
  return { id: "canary", expect: "not-break", cand, packInput };
})();

// ── case (b) — clearly plausible offscreen ─────────────────────────────────
// Same structural gap (no shared chapter), but the dossiers supply exactly the
// channel the prompt names: the entity is famous, and the speaker's role puts
// him inside the same institution.

const B_CLAIM = "Sable Rethe signs every writ that leaves this house, and she has not signed this one.";

const offscreenCase = (() => {
  const { chapters: chs, paragraphsByChapterId } = chapters([
    {
      n: 1,
      present: ["Doran", "Hesk"],
      exposed: ["Doran", "Hesk"],
      paragraphs: [
        "The lower rooms of the Ninefold Court smelled of wet stone and older paper, and Doran had a desk in the worst-lit corner of them.",
        "Hesk brought the day's satchel down at the ninth bell, as Hesk had brought it down every day for six years.",
      ],
    },
    {
      n: 2,
      present: ["Doran", "Hesk"],
      exposed: ["Doran", "Hesk"],
      paragraphs: [
        "Two hundred entries went into the ledger before noon. Doran did not look up for any of them.",
      ],
    },
    {
      n: 3,
      present: ["Doran"],
      exposed: ["Doran"],
      paragraphs: [
        "The clerk who worked the stair above him was dismissed on a Tuesday and nobody explained why, which was itself the explanation.",
      ],
    },
    {
      n: 4,
      present: ["Hesk"],
      exposed: ["Hesk", "Sable Rethe"],
      paragraphs: [
        "Above the third stair the corridors were warm and carpeted and Hesk walked them with his hat in both hands.",
        "Sable Rethe did not keep him waiting, which frightened him more than an hour on the bench would have. She read the page, said four words, and gave it back.",
      ],
    },
    {
      n: 5,
      present: ["Hesk"],
      exposed: ["Hesk", "Sable Rethe"],
      paragraphs: [
        "The order went out under the Warden's seal that evening and the whole river knew it by morning.",
      ],
    },
    {
      n: 6,
      present: ["Doran", "Hesk"],
      exposed: ["Doran", "Hesk", "Sable Rethe"],
      paragraphs: [
        "Hesk came down the stair too fast and put the writ on Doran's desk face up, which he never did.",
        `Doran read it once and pushed it back across the wood. “${B_CLAIM}” He did not pick up his pen again until Hesk had gone.`,
      ],
    },
  ]);

  const worldData: WorldData = {
    characters: [
      {
        name: "Sable Rethe",
        role: "Warden of the Ninefold Court",
        description:
          "Her name is cried in every market from the river to the pass, and children are threatened with it. No writ leaves the Court without her seal.",
      },
      {
        name: "Doran",
        role: "tax-clerk of the Ninefold Court",
        description:
          "Keeps the Court's lower ledgers. Has served the Court eleven years and has never been called above the third stair.",
      },
    ],
    places: [],
    factions: [],
  };

  const cand = candidate("Doran", "Sable Rethe", 6, 1, B_CLAIM);
  const packInput: EvidencePackInput = {
    candidate: cand,
    chapters: chs,
    facts: [],
    paragraphsByChapterId,
    worldData,
  };
  return { id: "offscreen", expect: "not-break", cand, packInput };
})();

// ── case (c) — genuinely thin ──────────────────────────────────────────────
// One bare mention in a list, one flat assertion later, no dossier, no
// reputation, no hearsay marker. Deliberately UNGATED: this case exists to
// show what the model does when the honest answer may be "unsure", and a gate
// on it would be a gate on taste.

const C_CLAIM = "Iskra Bene will not wait past the thaw.";

const thinCase = (() => {
  const { chapters: chs, paragraphsByChapterId } = chapters([
    {
      n: 1,
      present: ["Pell", "Ruen"],
      exposed: ["Pell", "Ruen"],
      paragraphs: [
        "The upper landing froze first every year and thawed last, and Pell had built her whole trade around the four weeks in between.",
      ],
    },
    {
      n: 2,
      present: ["Ruen"],
      exposed: ["Ruen", "Iskra Bene"],
      paragraphs: [
        "The tally for the season ran to eleven names. Iskra Bene was one of them, written small at the bottom in a different ink.",
      ],
    },
    {
      n: 3,
      present: ["Pell", "Ruen"],
      exposed: ["Pell", "Ruen", "Iskra Bene"],
      paragraphs: [
        "Ruen wanted to argue about the order of the loading and Pell did not have the patience for it.",
        `Pell put the last crate down where it did not belong and straightened up. “${C_CLAIM}” Ruen went back to the ropes.`,
      ],
    },
  ]);

  const cand = candidate("Pell", "Iskra Bene", 3, 1, C_CLAIM);
  const packInput: EvidencePackInput = {
    candidate: cand,
    chapters: chs,
    facts: [],
    paragraphsByChapterId,
    worldData: null,
  };
  return { id: "thin", expect: "any", cand, packInput };
})();

// ── entity-review cases ────────────────────────────────────────────────────
// Each span is written so that the GRAMMAR around the name decides the answer:
// "the road to X" / "the streets of X"; "said X" / "turned to X and asked";
// and a capitalised sentence-opener that is not a name at all.

const entitySpans: Array<{ id: string; expect: string; entry: EntityReviewEntry; text: string }> = [
  {
    id: "place",
    expect: "place",
    entry: { name: "Halloway Reach", currentType: "character", needsReview: true, ambiguityGap: 0.04 },
    text:
      "The road to Halloway Reach ran north out of the marsh and did not pretend to be a road for the last two miles of it. " +
      "Carts went up it loaded and came down empty, and nobody who used it had a good word for the crossing at the ford. " +
      "The tolls were collected twice and recorded once, which surprised nobody who had paid them.\n\n" +
      "By the second week the streets of Halloway Reach were thick with sawdust and the smell of tar, and every window on " +
      "the water side had been shuttered against the wind coming off the flats.",
  },
  {
    id: "person",
    expect: "character",
    entry: { name: "Corin Ashe", currentType: "place", needsReview: true, ambiguityGap: 0.07 },
    text:
      "“Wait,” said Corin Ashe, and put a hand flat on the table so that the cups jumped. Nobody waited. " +
      "The door was already swinging and the cold was already in the room, and whatever had been agreed a moment " +
      "earlier was plainly not agreed any longer.\n\n" +
      "Nell turned to Corin Ashe and asked whether he had eaten, which was the only kindness she had left to offer " +
      "that evening.",
  },
  {
    id: "not-a-name",
    expect: "not-a-name",
    entry: { name: "Meanwhile", currentType: "character", needsReview: true, ambiguityGap: 0.11 },
    text:
      "Meanwhile, the harbour bell rang twice and stopped, as if whoever pulled it had thought better of the third. " +
      "Nobody came down to the water and nobody sent word up from it, and the whole business was left to stand where " +
      "it had fallen.\n\n" +
      "Meanwhile the rain kept on, thin and steady, and the boats knocked against one another in the dark like animals " +
      "shifting in a byre.",
  },
];

// ── emit ───────────────────────────────────────────────────────────────────

// The wire label the model must emit for a "break" — single-sourced from the
// module, never spelled out here or in the .cjs harness.
const BREAK_WIRE = wireVerdictFor("break");
if (!(VERDICT_SCHEMA.properties.verdict.enum as readonly string[]).includes(BREAK_WIRE)) {
  throw new Error(`VERDICT_SCHEMA enum does not contain the break wire label "${BREAK_WIRE}"`);
}

const adjudicationCases = [breakCase, offscreenCase, thinCase, canaryCase].map((c) => {
  const request = buildAdjudicationRequest(c.cand, c.packInput, MODEL_ID);
  return {
    id: c.id,
    expect: c.expect,
    /** Wire labels the gate compares against; null = ungated. */
    expectVerdict: c.expect === "break" ? BREAK_WIRE : null,
    expectNotVerdict: c.expect === "not-break" ? BREAK_WIRE : null,
    candidateKey: c.cand.key,
    speaker: c.cand.speaker,
    entity: c.cand.entity,
    chapterNumber: c.cand.chapterNumber,
    packHash: request.pack.packHash,
    rungsIncluded: request.pack.rungsIncluded,
    tokensEstimate: request.pack.tokensEstimate,
    verdictKey: request.verdictKey,
    systemPrompt: request.systemPrompt,
    userText: request.userText,
    schema: request.schema,
    maxTokens: request.maxTokens,
  };
});

const entityCases = entitySpans.map((c) => {
  // Selection runs through the real filter, so a broken selector fails here
  // rather than silently emitting an entry the app would never have asked about.
  const selected = selectReviewable([c.entry]);
  if (selected.length !== 1) throw new Error(`entity case "${c.id}" was not selected for review`);
  const snippets = usageSnippets(c.text, c.entry.name);
  if (snippets.length === 0) throw new Error(`entity case "${c.id}" produced no usage snippets`);
  const request = buildEntityReviewRequest(c.entry, snippets);
  return {
    id: c.id,
    expect: c.expect,
    name: c.entry.name,
    currentType: c.entry.currentType,
    snippets,
    systemPrompt: request.systemPrompt,
    userText: request.userText,
    schema: request.schema,
    maxTokens: request.maxTokens,
  };
});

const payload = {
  generatedAt: new Date().toISOString(),
  modelId: MODEL_ID,
  packVersion: PACK_VERSION,
  adjudicatorPromptVersion: ADJUDICATOR_PROMPT_VERSION,
  entityReviewPromptVersion: ENTITY_REVIEW_PROMPT_VERSION,
  adjudication: adjudicationCases,
  entityReview: entityCases,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

console.log(`wrote ${OUT}`);
console.log(
  `  ${adjudicationCases.length} adjudication cases · ` +
  `${entityCases.length} entity-review cases · modelId=${MODEL_ID}`,
);
for (const c of adjudicationCases) {
  console.log(`  adj/${c.id.padEnd(9)} pack ${c.tokensEstimate} tok · rungs [${c.rungsIncluded.join(", ")}] · verdictKey ${c.verdictKey}`);
}
for (const c of entityCases) {
  console.log(`  ent/${c.id.padEnd(9)} ${c.name} · ${c.snippets.length} snippet(s)`);
}
