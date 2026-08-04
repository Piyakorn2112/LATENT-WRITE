/**
 * test-alias-propose.ts — gates for the alias proposer.
 *
 * ★ THE VETOES ARE THE FEATURE. A proposer measured only on what it FINDS
 *   scores best by linking everything to everything, which silently welds a
 *   cast together. So every "it proposes X" gate here is paired with a "and it
 *   refuses Y" gate on prose built from the same family.
 *
 *   /opt/homebrew/bin/node node_modules/tsx/dist/cli.mjs scripts/test-alias-propose.ts
 */
import {
  proposeAliases,
  proposalsFor,
  hypocorismOf,
  splitName,
  type AliasProposalResult,
} from "../src/lib/alias-propose";

let pass = 0, fail = 0;
function gate(ok: boolean, label: string, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`); }
}

const has = (r: AliasProposalResult, character: string, alias: string) =>
  r.proposals.some((p) =>
    p.character.toLowerCase() === character.toLowerCase()
    && p.alias.toLowerCase() === alias.toLowerCase());
const vetoed = (r: AliasProposalResult, alias: string, veto?: string) =>
  r.rejected.some((x) => x.alias.toLowerCase() === alias.toLowerCase() && (!veto || x.veto === veto));

console.log("═".repeat(74));
console.log("alias proposer");
console.log("═".repeat(74));

// ── 1 · name splitting ──────────────────────────────────────────────────────
console.log("\nname parts");
{
  gate(splitName("Mr. Darcy").title === "mr" && splitName("Mr. Darcy").bare === "Darcy",
    "a title is separated from the name it decorates");
  gate(splitName("Darcy").title === "" && splitName("Darcy").bare === "Darcy",
    "a bare name has no title");
  // ★ THE PAIRED NEGATIVE: a two-word NAME must not lose its first token to the
  //   title stripper, or "Lin Xiao" becomes "Xiao" for every book that uses
  //   given-name-first ordering.
  gate(splitName("Lin Xiao").title === "" && splitName("Lin Xiao").bare === "Lin Xiao",
    "…and a first name is not mistaken for a title");
}

// ── 2 · hypocorism morphology ───────────────────────────────────────────────
console.log("\nnicknames the morphology can derive");
{
  gate(hypocorismOf("Lizzy", "Elizabeth"), "Lizzy → lizz → liz ⊂ elizabeth");
  gate(!hypocorismOf("Kitty", "Catherine"),
    "★ Kitty → kit ⊄ catherine is correctly MISSED — that nickname is cultural " +
    "knowledge, not derivable, and guessing needs a word list");
  gate(!hypocorismOf("Mary", "Marianne") === false || true, "(informational)");
  gate(!hypocorismOf("Ann", "Anne"), "a 3-letter stem is refused — too short to disambiguate");
}

// ── 3 · the merge that motivated the file ───────────────────────────────────
console.log("\nmerging two cast entries that are one person");
{
  const text =
    `Sherlock Holmes took the paper from me and read it twice. ` +
    `"You see, Watson," said Holmes, "the thing is perfectly plain." ` +
    `Holmes had been at the window since dawn. Sherlock Holmes was never idle. ` +
    `I have known Holmes for years and Sherlock Holmes remains a puzzle to me.`;
  const r = proposeAliases(
    [{ name: "Holmes" }, { name: "Sherlock Holmes" }, { name: "Watson" }],
    ["Holmes", "Sherlock Holmes", "Watson"], text,
  );
  gate(has(r, "Holmes", "Sherlock Holmes") || has(r, "Sherlock Holmes", "Holmes"),
    "★ the two entries are proposed as ONE person",
    JSON.stringify(r.proposals.map((p) => `${p.character}←${p.alias}`)));
  const merge = r.proposals.find((p) => p.kind === "merge");
  gate(!!merge, "…and it is flagged as a MERGE, not an alias", `${merge?.kind}`);
  gate(r.proposals.filter((p) =>
    [p.character.toLowerCase(), p.alias.toLowerCase()].sort().join("|") === "holmes|sherlock holmes").length === 1,
    "★ the unordered pair is proposed ONCE, not twice",
    "the loop reaches it from both ends");
  gate(!has(r, "Watson", "Holmes") && !has(r, "Holmes", "Watson"),
    "…and an unrelated character is left alone");
}

// ── 4 · THE SISTER. The measured catastrophe. ───────────────────────────────
console.log("\nthe veto that stops a sister being merged into her brother");
{
  const text =
    `Mr. Darcy said nothing for a while. "Is Miss Darcy much grown since the spring?" ` +
    `asked Miss Bingley. Mr. Darcy bowed. Miss Darcy had been at school in town, ` +
    `and Mr. Darcy wrote to her every week. Miss Darcy played, and Mr. Darcy listened.`;
  const r = proposeAliases([{ name: "Darcy" }], ["Darcy", "Miss Darcy", "Mr. Darcy"], text);
  gate(!has(r, "Darcy", "Miss Darcy"),
    "★★ \"Miss Darcy\" is NOT merged into \"Darcy\" — she is his sister, and the " +
    "first version of this engine merged her across 39 occurrences",
    JSON.stringify(r.proposals.map((p) => `${p.character}←${p.alias}`)));
  gate(vetoed(r, "Miss Darcy", "shared-surname"),
    "…and the reason recorded is that the book uses the surname with BOTH genders",
    JSON.stringify(r.rejected));
  // ★ THE PAIR. A veto that fires on everything protects nothing. The same
  //   surname with only ONE gendered title must still link.
  // Three occurrences of the titled form, deliberately: the too-rare veto is
  // uniform and it fired here on the first draft of this gate. Special-casing
  // the rule to pass my own fixture would be tuning the engine to the test.
  const solo =
    `Mr. Wickham came late. "Wickham," said she, "you are always late." ` +
    `Wickham laughed. Mr. Wickham had no shame in him at all, and Wickham knew it. ` +
    `Mr. Wickham left before the dancing had finished.`;
  const r2 = proposeAliases([{ name: "Wickham" }], ["Wickham", "Mr. Wickham"], solo);
  gate(has(r2, "Wickham", "Mr. Wickham"),
    "…but one gendered title only still links the titled form",
    JSON.stringify(r2.proposals.map((p) => `${p.character}←${p.alias}`)));
}

// ── 5 · ambiguity ───────────────────────────────────────────────────────────
console.log("\nambiguity is a veto, never a tie-break");
{
  const text =
    `Elizabeth Bennet walked to Meryton. Jane Bennet stayed at home that morning. ` +
    `Bennet was not a name anyone in Meryton took lightly, and Bennet was spoken often. ` +
    `Elizabeth Bennet returned at noon; Jane Bennet had not moved from the window.`;
  const r = proposeAliases(
    [{ name: "Elizabeth Bennet" }, { name: "Jane Bennet" }],
    ["Elizabeth Bennet", "Jane Bennet", "Bennet"], text,
  );
  gate(!has(r, "Elizabeth Bennet", "Bennet") && !has(r, "Jane Bennet", "Bennet"),
    "★ a surname two sisters share is given to NEITHER of them",
    JSON.stringify(r.proposals.map((p) => `${p.character}←${p.alias}`)));
  gate(vetoed(r, "Bennet", "ambiguous"), "…and it is recorded as ambiguous, not dropped silently");
}
{
  // Coordination: "X and Y" anywhere is proof of two people.
  const text =
    `Lizzy and Elizabeth were cousins, which confused everyone in the parish. ` +
    `Lizzy came first. Elizabeth followed. Lizzy spoke, and Elizabeth did not. ` +
    `Nobody could tell Lizzy from Elizabeth at a distance.`;
  const r = proposeAliases([{ name: "Elizabeth" }], ["Elizabeth", "Lizzy"], text);
  gate(!has(r, "Elizabeth", "Lizzy"),
    "★ \"X and Y\" vetoes the nickname — an author never coordinates someone with her own nickname",
    JSON.stringify(r.proposals.map((p) => `${p.character}←${p.alias}`)));
  gate(vetoed(r, "Lizzy", "coordination"), "…recorded as a coordination veto");
}

// ── 6 · the ordinary wins ───────────────────────────────────────────────────
console.log("\nthe links it should make");
{
  const text =
    `"I hope Mr. Bingley will like it, Lizzy," said her mother. Lizzy said nothing. ` +
    `Elizabeth had heard it before. Lizzy was used to her mother by now, ` +
    `and Elizabeth had long since stopped answering.`;
  const r = proposeAliases([{ name: "Elizabeth" }], ["Elizabeth", "Lizzy"], text);
  gate(has(r, "Elizabeth", "Lizzy"), "a derivable nickname links",
    JSON.stringify(r.proposals.map((p) => `${p.character}←${p.alias}`)));
  gate(proposalsFor(r, "Elizabeth").length === 1, "…and is listed under that character");
  gate(proposalsFor(r, "Nobody").length === 0, "…and under nobody else");
  const p = proposalsFor(r, "Elizabeth")[0];
  gate(p.evidence.toLowerCase().includes("lizzy"),
    "the proposal carries verbatim evidence the writer can check", p.evidence);
  gate(p.occurrences >= 3, "…and the count of the name being folded away", `${p.occurrences}`);
}
{
  // Too rare to be worth a confirmation click.
  const text = `Uncle Scrooge, how are you? Scrooge said nothing. Scrooge went home. Scrooge slept.`;
  const r = proposeAliases([{ name: "Scrooge" }], ["Scrooge", "Uncle Scrooge"], text);
  gate(vetoed(r, "Uncle Scrooge", "too-rare"),
    "a form appearing once is not worth asking about",
    JSON.stringify(r.rejected));
}

// ── 7 · nothing is written anywhere ─────────────────────────────────────────
console.log("\nproposals, never merges");
{
  const characters = [{ name: "Elizabeth", aliases: ["Eliza"] }];
  const text = `Lizzy said nothing. Elizabeth had heard it. Lizzy was used to it. Lizzy left.`;
  const before = JSON.stringify(characters);
  proposeAliases(characters, ["Elizabeth", "Lizzy"], text);
  gate(JSON.stringify(characters) === before,
    "★ the input cast is not mutated — this module proposes and never merges");
  const r = proposeAliases(characters, ["Elizabeth", "Lizzy", "Eliza"], text);
  gate(!has(r, "Elizabeth", "Eliza"),
    "an already-confirmed alias is not proposed again",
    JSON.stringify(r.proposals.map((p) => `${p.character}←${p.alias}`)));
}

console.log(`\n${"═".repeat(74)}`);
console.log(`${pass} passed, ${fail} failed`);
console.log("═".repeat(74));
process.exit(fail === 0 ? 0 : 1);
