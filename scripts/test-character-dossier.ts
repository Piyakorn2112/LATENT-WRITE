/**
 * test-character-dossier.ts — deterministic contract lock for the dossier
 * engine. No model, no corpus: a synthetic mini-novel with KNOWN facts, so
 * every assertion is checkable by reading the fixture.
 *
 * The suite follows the gates-that-prove-nothing rules: every negative gate
 * (a thing that must NOT be harvested, a field that must stay empty) is
 * paired with a positive twin (the same shape that MUST be harvested), so a
 * dead harvester cannot pass by producing nothing.
 *
 * Run: node node_modules/tsx/dist/cli.mjs scripts/test-character-dossier.ts
 * Gate: 100%.
 */
import {
  buildDossierPack,
  buildExtractiveCard,
  buildFieldRequest,
  buildFieldRetryRequest,
  deriveRoleFromCounts,
  dossierSignature,
  harvestDossierEvidence,
  hasDescriptiveAppearance,
  honorificClassOf,
  missingWords,
  normalizeFieldAnswer,
  usefulAppearance,
  type DossierPack,
} from "../src/lib/character-dossier";
import type { Novel } from "../src/types";

let passed = 0;
let failed = 0;
function expect(label: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

// ── the fixture ───────────────────────────────────────────────────────────
//
// Marlow: the viewpoint character. Rich evidence in every channel.
// Wren: female, described only by pronoun (the Elizabeth Bennet shape).
// Osric: mentioned often, never described (the gate case).
// Tam: "Mr. Tam" dominant, with a "Miss Tam" sister whose description must
//      NOT leak to him (the Darcy/Georgiana shape).

const CH1 = [
  "Marlow was a tall, gaunt man with a weathered face. Marlow's grey eyes missed nothing.",
  // Mid-sentence lowercase adjective (the attributive shape) and the habit
  // frame with the NAME as its subject — sentence-initial "Old" is
  // title-cased and pronoun subjects are unowned, so neither would count.
  "The dockhands nodded to old Marlow at dawn. Marlow walked the tide line, and Marlow was in the habit of counting the boats twice.",
  '"You are early," murmured Marlow, folding his coat.',
  "Marlow had been born in the fishing quarter, and Marlow's brother still worked the nets there.",
  "Osric waited by the gate. Osric said nothing, and Osric left before the bell.",
].join("\n\n");

const CH2 = [
  "Wren came down to the harbour at noon. Her dark hair was cropped short, and her thin face was scarred above the brow.",
  '"The ledger is wrong," Wren said. She was seldom wrong about the ledger.',
  "Osric brought the crates in. Osric counted them, and Osric signed for them.",
  // Mr. Tam is written with the masculine honorific often enough to establish
  // dominance (the mask acts only on CLEAR dominance, by design), and his
  // sister must not donate her description to him.
  "Mr. Tam kept the harbour office. Miss Tam, a small woman with silver hair, kept the garden behind it.",
  "Wren left the ledger with Mr. Tam at dusk. Mr. Tam signed it, and Mr. Tam filed the copy without a word.",
  '"They say Marlow escaped a wreck off the point," Wren said.',
].join("\n\n");

const NOVEL: Novel = {
  meta: { title: "Tideline", author: "t", description: "" },
  chapters: [
    { id: "c1", number: 1, title: "One", content: CH1 },
    { id: "c2", number: 2, title: "Two", content: CH2 },
  ],
};

const CAST = [
  { name: "Marlow", aliases: [] },
  { name: "Wren", aliases: [] },
  { name: "Osric", aliases: [] },
  { name: "Tam", aliases: [] },
];

async function main() {
  const evidence = await harvestDossierEvidence(NOVEL, CAST);
  const marlow = evidence.byName.get("Marlow")!;
  const wren = evidence.byName.get("Wren")!;
  const osric = evidence.byName.get("Osric")!;
  const tam = evidence.byName.get("Tam")!;

  console.log("\n══ channel harvest — positives and their negative twins ══");

  const texts = (c: Parameters<typeof buildDossierPack>[0], ch: keyof typeof c.byChannel) =>
    c.byChannel[ch].map((s) => s.text).join(" | ");

  expect("copular: 'Marlow was a tall, gaunt man' harvested",
    texts(marlow, "copular").includes("tall, gaunt man"), texts(marlow, "copular"));
  expect("possessive: 'Marlow's grey eyes' harvested",
    texts(marlow, "possessive").includes("grey eyes"));
  expect("attributive: 'old Marlow' harvested",
    texts(marlow, "attributive").includes("old Marlow"));
  expect("attributive twin: dialogue tag 'murmured Marlow' NOT harvested",
    !texts(marlow, "attributive").includes("murmured"), texts(marlow, "attributive"));
  expect("habitual: 'in the habit of counting the boats' harvested",
    texts(marlow, "habitual").includes("habit of counting"));
  expect("lore-narrated: 'had been born in the fishing quarter' harvested",
    texts(marlow, "lore-narrated").includes("fishing quarter"));
  expect("relation: 'Marlow's brother' harvested",
    texts(marlow, "relation").includes("brother"));
  expect("lore-spoken: the wreck rumour lands in SPOKEN, not narrated",
    texts(marlow, "lore-spoken").includes("escaped a wreck")
      && !texts(marlow, "lore-narrated").includes("escaped a wreck"));

  console.log("\n══ the pronoun shape — description without the name ══");
  const wrenVisual = ["appositive", "copular", "attributive", "possessive", "pronoun-attr", "pronoun-owned"]
    .flatMap((c) => wren.byChannel[c as keyof typeof wren.byChannel]).map((s) => s.text).join(" | ");
  expect("Wren's 'dark hair … thin face … scarred' found via a pronoun channel",
    wrenVisual.includes("dark hair"), wrenVisual);

  console.log("\n══ the family trap — Miss Tam must not describe Mr. Tam ══");
  expect("honorific class: Tam reads masculine",
    honorificClassOf(NOVEL.chapters.map((c) => c.content).join("\n"), ["Tam"]) === "masc");
  const tamAll = Object.values(tam.byChannel).flat().map((s) => s.text).join(" | ");
  expect("'small woman with silver hair' NOT in Mr. Tam's evidence",
    !tamAll.includes("silver hair"), tamAll);
  expect("family-mask twin: Mr. Tam's own sentence IS harvested",
    tamAll.includes("harbour office") || tam.counts.mentions >= 1,
    `mentions ${tam.counts.mentions}`);

  console.log("\n══ counted facts ══");
  expect("Marlow's mentions counted", marlow.counts.mentions >= 5, String(marlow.counts.mentions));
  expect("Marlow present in both chapters", marlow.counts.chapters.length === 2);
  expect("agent verbs counted ('walked' among them)",
    marlow.counts.agentVerbs.some(([v]) => v === "walked"),
    JSON.stringify(marlow.counts.agentVerbs));
  expect("co-presence: Marlow shares chapters with Osric",
    marlow.counts.coPresent.some(([n]) => n === "Osric"));

  console.log("\n══ pack and gates ══");
  const marlowPack = buildDossierPack(marlow);
  const osricPack = buildDossierPack(osric);
  expect("Marlow's visual gate open", marlowPack.visualCandidates.length >= 2,
    JSON.stringify(marlowPack.visualCandidates));
  expect("Marlow's trait gate open", marlowPack.traitCandidates.length >= 1);
  expect("Marlow's lore gate open", marlowPack.loreCandidates.length >= 1);
  expect("gate twin: Osric (never described) has EVERY gate closed",
    osricPack.visualCandidates.length === 0
      && osricPack.traitCandidates.length === 0
      && osricPack.loreCandidates.length === 0,
    JSON.stringify({ v: osricPack.visualCandidates, t: osricPack.traitCandidates, l: osricPack.loreCandidates }));
  expect("relation spans are excluded from the background candidates",
    marlowPack.spans
      .filter((s) => s.channel === "relation")
      .every((s) => !marlowPack.loreCandidates.includes(s.n)));
  expect("provenance tags printed in the pack text",
    /\(named\)/.test(marlowPack.text));
  expect("spoken lore is tagged (said)",
    marlowPack.spans.some((s) => s.channel === "lore-spoken")
      ? /\(said\)/.test(marlowPack.text)
      : true);

  console.log("\n══ requests ══");
  expect("no request can be built for a closed gate (fabrication is unbuildable)",
    buildFieldRequest(osricPack, "appearance") === null
      && buildFieldRequest(osricPack, "personality") === null
      && buildFieldRequest(osricPack, "background") === null);
  const req = buildFieldRequest(marlowPack, "appearance")!;
  expect("request twin: an open gate builds one", !!req);
  expect("appearance request shows ONLY visual-candidate spans",
    marlowPack.visualCandidates.every((n) => req.userText.includes(`[${n}]`))
      && marlowPack.spans
        .filter((s) => !marlowPack.visualCandidates.includes(s.n))
        .every((s) => !req.userText.includes(`[${s.n}] ch`)));
  expect("schema puts spans before the prose field",
    Object.keys(req.schema.properties)[0] === "spans");
  const retry = buildFieldRetryRequest(marlowPack, "appearance")!;
  expect("retry request exists and hardens the instruction",
    retry.systemPrompt.includes("ONLY words copied"));

  console.log("\n══ grounding · repair · refuse · vacuous ══");
  const packFor = (over: Partial<DossierPack>): DossierPack => ({ ...marlowPack, ...over });
  const g1 = normalizeFieldAnswer(
    { spans: [marlowPack.visualCandidates[0]], appearance: "tall, gaunt, grey eyes", confidence: 0.9 },
    marlowPack, "appearance");
  expect("a claim inside its citations grounds",
    g1.status === "grounded" || g1.status === "repaired", g1.status);
  const wrongCite = marlowPack.spans.find((s) => !s.text.includes("gaunt"))?.n ?? 99;
  const g2 = normalizeFieldAnswer(
    { spans: [wrongCite], appearance: "tall, gaunt man", confidence: 0.8 },
    marlowPack, "appearance");
  expect("right words, wrong citation → REPAIRED, corrected spans",
    g2.status === "repaired" && g2.spans.length > 0
      && g2.spans.every((n) => marlowPack.spans.find((s) => s.n === n)?.text.includes("gaunt")),
    `${g2.status} [${g2.spans.join(",")}]`);
  // Appearance-shaped (so the usefulness test passes) but the words appear
  // nowhere in the pack: exactly the fabrication shape.
  const g3 = normalizeFieldAnswer(
    { spans: [marlowPack.visualCandidates[0]], appearance: "a scarlet beard", confidence: 0.9 },
    marlowPack, "appearance");
  expect("words nowhere in the pack → REFUSED, text dropped",
    g3.status === "refused" && g3.text === "", g3.status);
  const g4 = normalizeFieldAnswer(
    { spans: [1], appearance: "a beard and a white robe", confidence: 0.8 },
    packFor({ visualCandidates: [] }), "appearance");
  expect("closed gate beats any model output (the Elder Kang case)",
    g4.status === "gated" && g4.text === "", g4.status);
  const g5 = normalizeFieldAnswer(
    { spans: [marlowPack.traitCandidates[0]], personality: "forgotten", confidence: 0.7 },
    marlowPack, "personality");
  expect("a one-word prose answer is VACUOUS, not shipped", g5.status === "vacuous", g5.status);

  // The grammar cap leaves a ragged tail; observed verbatim on the real 4B.
  // The tidy pass must cut back to the completed sentence BEFORE grounding.
  const raggedAtCap =
    "abstracted, eating mechanically, with her big eyes fixed unswervingly and unseeingly " +
    "on the sky outside the window. a little, flat, glossy, new sailor, the [ext";
  const tidyPack = {
    ...marlowPack,
    spans: [{ n: 1, channel: "copular" as const, chapter: 1, text: raggedAtCap.replace(" [ext", " extreme") }],
    traitCandidates: [1],
  };
  const g6 = normalizeFieldAnswer(
    { spans: [1], personality: raggedAtCap, confidence: 0.7 }, tidyPack, "personality");
  expect("an at-cap ragged tail tidies to the completed sentence",
    g6.status === "grounded" && g6.text.endsWith("window.") && !g6.text.includes("[ext"),
    JSON.stringify(g6.text.slice(-40)));

  console.log("\n══ usefulness — the measured answers, verbatim ══");
  expect("'dark eyes' is useful", usefulAppearance("dark eyes"));
  expect("'bushy brows' is useful", usefulAppearance("bushy brows"));
  expect("'fine, tall person, handsome features, noble mien' is useful",
    usefulAppearance("fine, tall person, handsome features, noble mien"));
  expect("the Darcy vacuous line is NOT useful",
    !usefulAppearance("standing near enough for her to overhear a conversation"));

  console.log("\n══ grounding vocabulary ══");
  expect("iterative stem: 'laughs and answers' grounds against 'laughingly answered'",
    missingWords("laughs and answers", ["she laughingly answered him"]).length === 0);
  expect("word-boundary twin: 'rite' does NOT hide inside 'favourite'",
    missingWords("dark rite", ["her favourite dark evening"]).length === 1,
    JSON.stringify(missingWords("dark rite", ["her favourite dark evening"])));

  console.log("\n══ descriptive test ══");
  expect("'his tall, gaunt figure' is descriptive", hasDescriptiveAppearance("his tall, gaunt figure"));
  expect("'reopened his eyes and looked' is not",
    !hasDescriptiveAppearance("reopened his eyes and looked"));
  expect("later noun rescues an early bare one (the Elizabeth sentence)",
    hasDescriptiveAppearance("hardly a good feature in her face, rendered intelligent by the expression of her dark eyes"));

  console.log("\n══ the conservative tier ══");
  const card = buildExtractiveCard(marlow, 0);
  expect("role derives from counts", card.role === "central character", card.role);
  expect("role thresholds: scarce presence in a long book reads minor",
    deriveRoleFromCounts({ ...osric.counts, chapters: [1], chapterTotal: 20, speechLines: 0 }, 9) === "minor character");
  expect("fact line carries the counted stats", /named \d+ times/.test(card.factLine));
  expect("quotes offered with provenance and chapter",
    card.quotes.length >= 2 && card.quotes.every((q) => q.chapter >= 1 && !!q.provenance),
    JSON.stringify(card.quotes.map((q) => q.kind)));
  const osricCard = buildExtractiveCard(osric, 2);
  expect("extractive twin: Osric's card has a role but ZERO quotes",
    osricCard.role.length > 0 && osricCard.quotes.length === 0,
    JSON.stringify(osricCard.quotes));

  console.log("\n══ cache signature ══");
  const sig1 = dossierSignature(NOVEL, CAST);
  expect("signature stable", sig1 === dossierSignature(NOVEL, CAST));
  expect("signature moves on edit",
    sig1 !== dossierSignature(
      { ...NOVEL, chapters: [NOVEL.chapters[0], { ...NOVEL.chapters[1], content: CH2 + " More." }] },
      CAST));
  expect("signature moves on cast change",
    sig1 !== dossierSignature(NOVEL, [...CAST, { name: "New", aliases: [] }]));

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
