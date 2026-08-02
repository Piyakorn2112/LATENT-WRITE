/**
 * test-evidence-pack.ts — GATED harness for the evidence assembler (M2).
 *
 * The pack is what the model sees INSTEAD of the manuscript, so the gates are
 * about honesty and determinism, not cleverness:
 *   1. DETERMINISM   same inputs → byte-identical text and hash.
 *   2. BUDGET        at real budgets (≥1200) the estimate never exceeds it.
 *   3. MINIMUM       rungs 1–3 (claim, facts, entity dossier) are present at
 *                    ANY budget — the minimum honest context outranks the
 *                    budget at absurd settings, and that precedence is the
 *                    documented contract, not an accident.
 *   4. DROP ORDER    rungs drop from the BOTTOM of the ladder only.
 *   5. DEGRADE       no worldData / no retrieval → still a valid pack.
 *   6. SNAPSHOT      the full-budget fixture pack matches
 *                    scripts/fixtures/evidence-pack.snapshot.txt byte-for-byte
 *                    (UPDATE_SNAPSHOT=1 regenerates it deliberately). Any
 *                    change to packing MUST show up as a reviewed diff here,
 *                    because the pack hash invalidates cached verdicts.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-evidence-pack.ts
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEvidencePack, type EvidencePackInput } from "../src/lib/evidence-pack";
import type { ChapterKnowledgeFacts } from "../src/lib/knowledge-store";
import type { WorldData } from "../src/types";

const here = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.join(here, "fixtures", "evidence-pack.snapshot.txt");

let failures = 0;
const gate = (ok: boolean, label: string, detail: string) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label} — ${detail}`);
  if (!ok) failures++;
};

// ── Fixture: Pew names Flint in ch5; Flint first named ch4, Pew absent ────
const mkChapter = (
  n: number,
  present: string[],
  exposed: string[],
): ChapterKnowledgeFacts => ({
  chapterId: `ch${n}`,
  chapterNumber: n,
  contentHash: `hash${n}`,
  present: present.sort(),
  presentNarrow: present.sort(),
  exposed: exposed.sort(),
  references: [],
});

const chapters = [
  mkChapter(1, ["Pew", "Bones"], ["Pew", "Bones"]),
  mkChapter(2, ["Pew", "Livesey"], ["Pew", "Livesey"]),
  mkChapter(3, ["Bones", "Livesey"], ["Bones", "Livesey"]),
  mkChapter(4, ["Bones", "Silver"], ["Bones", "Silver", "Flint"]),
  mkChapter(5, ["Pew", "Bones"], ["Pew", "Bones", "Flint"]),
];

const paragraphsByChapterId = new Map<string, readonly string[]>([
  ["ch4", [
    "The captain lowered his voice.",
    "“Flint was the bloodthirstiest buccaneer that sailed,” said Silver, and the room went quiet around the word.",
  ]],
  ["ch5", [
    "The blind man came tapping down the frozen road.",
    "“Flint’s fist, I mean,” said Pew, pressing the paper into his hand.",
  ]],
]);

const worldData: WorldData = {
  characters: [
    { name: "Pew", role: "blind beggar", description: "Messenger of the crew" },
    { name: "Flint", role: "dead pirate captain", description: "Feared across the trade routes" },
  ],
  places: [],
  factions: [],
};

const baseInput: EvidencePackInput = {
  candidate: {
    key: "Pew→Flint",
    speaker: "Pew",
    entity: "Flint",
    chapterId: "ch5",
    chapterNumber: 5,
    paragraphIndex: 1,
    sentence: "“Flint’s fist, I mean,” said Pew, pressing the paper into his hand.",
    band: "normal",
    status: "pending",
  },
  chapters,
  facts: [
    { subject: "Bones", entity: "Flint", chapterId: "ch4", chapterNumber: 4, how: "present" },
    { subject: "Livesey", entity: "Flint", chapterId: "ch4", chapterNumber: 4, how: "author-asserted" },
  ],
  paragraphsByChapterId,
  worldData,
  majorEvents: [
    { chapterNumber: 4, label: "Flint named", sentence: "Flint was the bloodthirstiest buccaneer that sailed", rank: 0, agent: "Flint" },
    { chapterNumber: 3, label: "unrelated", sentence: "The doctor argued with the captain", rank: 1 },
  ],
  related: [
    { chapterNumber: 4, text: "Silver spoke of Flint only in a whisper.", score: 0.82 },
    { chapterNumber: 4, text: "The crew feared the dead captain's name.", score: 0.71 },
  ],
  budgetTokens: 2000,
};

function main() {
  console.log("═".repeat(74));
  console.log("evidence pack — gated harness");
  console.log("═".repeat(74));

  // 1. Determinism
  const a = buildEvidencePack(baseInput);
  const b = buildEvidencePack(structuredClone(baseInput));
  gate(a.text === b.text && a.packHash === b.packHash, "determinism",
    `hash ${a.packHash} reproduced`);

  // 2. Budget at real tiers
  for (const budget of [1200, 2000]) {
    const p = buildEvidencePack({ ...baseInput, budgetTokens: budget });
    gate(p.tokensEstimate <= budget, `budget ${budget}`,
      `${p.tokensEstimate} tokens, rungs: ${p.rungsIncluded.join(" · ")}`);
  }

  // 3. Minimum honest context at an absurd budget
  {
    const p = buildEvidencePack({ ...baseInput, budgetTokens: 50 });
    const hasCore = ["claim", "facts", "entity-dossier"].every((r) => p.rungsIncluded.includes(r));
    gate(hasCore && !p.rungsIncluded.includes("related"), "minimum context",
      `rungs at budget 50: ${p.rungsIncluded.join(" · ")}`);
  }

  // 4. Drop order: shrink until something drops; it must be a bottom rung.
  {
    const full = buildEvidencePack({ ...baseInput, budgetTokens: 100000 });
    let dropped: string[] | null = null;
    for (let budget = full.tokensEstimate; budget > 200; budget -= 10) {
      const p = buildEvidencePack({ ...baseInput, budgetTokens: budget });
      if (p.rungsIncluded.length < full.rungsIncluded.length) {
        dropped = full.rungsIncluded.filter((r) => !p.rungsIncluded.includes(r));
        break;
      }
    }
    const bottom = new Set(["rulings", "related", "events", "speaker-dossier"]);
    gate(!!dropped && dropped.every((r) => bottom.has(r)), "drop order",
      `first drop under pressure: ${dropped?.join(", ") ?? "never dropped"}`);
  }

  // 5. Degrade with no dossiers and no retrieval
  {
    const p = buildEvidencePack({ ...baseInput, worldData: null, related: [], majorEvents: [] });
    gate(
      p.text.includes("no dossier; only what the manuscript shows") &&
      p.rungsIncluded.includes("claim") && !p.rungsIncluded.includes("related"),
      "degrades honestly",
      `rungs: ${p.rungsIncluded.join(" · ")}`,
    );
  }

  // 6. Snapshot — packs are the product; changes must be reviewed diffs.
  {
    const p = buildEvidencePack(baseInput);
    if (process.env.UPDATE_SNAPSHOT === "1" || !existsSync(SNAPSHOT)) {
      writeFileSync(SNAPSHOT, p.text, "utf8");
      console.log(`  • snapshot ${existsSync(SNAPSHOT) ? "written" : "created"}: ${path.relative(process.cwd(), SNAPSHOT)}`);
    }
    const expected = readFileSync(SNAPSHOT, "utf8");
    gate(p.text === expected, "snapshot",
      p.text === expected ? `byte-identical (${p.text.length} chars)` : "DIFFERS — review the diff, then UPDATE_SNAPSHOT=1 to accept");
  }

  console.log(`\n── the full-budget pack (read it; this is what the model sees) ──\n`);
  console.log(buildEvidencePack(baseInput).text.split("\n").map((l) => `  ${l}`).join("\n"));

  console.log(`\n${failures === 0 ? "✓ ALL GATES GREEN" : `✗ ${failures} GATE(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
