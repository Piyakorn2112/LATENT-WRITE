/**
 * test-character-presence.ts — gates for the presence-vs-evocation engine.
 *
 * ★ EVERY FIXTURE HERE IS DECIDED BY EVIDENCE, NOT BY MY READING OF PROSE.
 *   A gate whose expected answer is a judgement call is tunable by rewording
 *   the fixture until the engine agrees, which is worth nothing. So: a name
 *   inside a dialogue tag SPEAKS, a name that only ever appears between
 *   quotation marks is EVOKED, and where a reader could genuinely argue either
 *   way the gate asserts `uncertain` rather than a class.
 *
 * ★ EVERY NEGATIVE GATE IS PAIRED WITH A POSITIVE ONE. `every(x => !bad)` is
 *   satisfied perfectly by an empty set, and this repo has shipped that bug
 *   twice — a fixture below a length floor made a whole suite vacuous.
 *
 *   /opt/homebrew/bin/node node_modules/tsx/dist/cli.mjs scripts/test-character-presence.ts
 */
import {
  classifyChapterPresence,
  maskDialogue,
  onPageNames,
  firstOnPageByName,
  type CharacterPresence,
} from "../src/lib/character-presence";

let pass = 0, fail = 0;
function gate(ok: boolean, label: string, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`); }
}

const cast = (...names: string[]) => names.map((name) => ({ name, variants: [] as string[] }));
const find = (rs: CharacterPresence[], n: string) => rs.find((r) => r.name === n)!;

console.log("═".repeat(74));
console.log("character presence — presence vs evocation");
console.log("═".repeat(74));

// ── 1 · dialogue masking ────────────────────────────────────────────────────
console.log("\nmasking");
{
  const text = `He waited. “Is Marcus coming?” she asked. Marcus was already gone.`;
  const { narration, dialogue } = maskDialogue(text);
  gate(narration.length === text.length && dialogue.length === text.length,
    "both halves keep the original length, so offsets still index the source");
  gate(!/Is Marcus coming/.test(narration), "the quoted question is out of narration");
  gate(/Marcus was already gone/.test(narration), "the narrated sentence survives in narration");
  gate(/Is Marcus coming/.test(dialogue), "the quoted question is in dialogue");
  gate(!/already gone/.test(dialogue), "narration does not leak into dialogue");
}

// ── 2 · speaking ────────────────────────────────────────────────────────────
console.log("\nspeaking");
{
  const text = `The room was cold. “We leave at dawn,” said Alder. Bramble did not answer.`;
  const r = classifyChapterPresence(text, cast("Alder", "Bramble"));
  gate(find(r, "Alder").klass === "speaking", "a trailing dialogue tag is speech",
    `got ${find(r, "Alder").klass}`);
  gate(find(r, "Alder").cue.includes("Alder"), "the cue quotes the tag");
  gate(find(r, "Bramble").klass === "present", "the silent one in narration is present, not speaking",
    `got ${find(r, "Bramble").klass}`);
}
{
  const text = `Alder said, “We leave at dawn.” Nobody moved.`;
  const r = classifyChapterPresence(text, cast("Alder"));
  gate(find(r, "Alder").klass === "speaking", "a leading dialogue tag is speech",
    `got ${find(r, "Alder").klass}`);
}
{
  // ★ THE PAIRED NEGATIVE. "returned" and "called" are dialogue tags AND motion
  //   verbs; the engine allows them ONLY against a quote. Without this gate the
  //   speech list silently readmits England and Baker Street to the cast.
  const text = `He returned to Ashford in the spring. A hamlet called Ashford lay beyond.`;
  const r = classifyChapterPresence(text, cast("Ashford"));
  gate(find(r, "Ashford").evidence.speaks === false,
    "\"returned to X\" / \"called X\" with no quote is NOT speech");
  const quoted = `“Not yet,” Ashford returned. The room stayed quiet.`;
  const r2 = classifyChapterPresence(quoted, cast("Ashford"));
  gate(find(r2, "Ashford").klass === "speaking",
    "…but the same verb against a quote still tags a speaker",
    `got ${find(r2, "Ashford").klass}`);
}

// ── 3 · evocation ───────────────────────────────────────────────────────────
console.log("\nevocation");
{
  const text =
    `The two of them sat by the fire while the rain went on. ` +
    `“I suppose Corwin told you what he saw at the mill,” said Alder. ` +
    `“He tells everyone. Corwin has never kept a secret in his life.” ` +
    `Bramble poked at the coals and said nothing for a while.`;
  const r = classifyChapterPresence(text, cast("Alder", "Bramble", "Corwin"));
  gate(find(r, "Corwin").klass === "mentioned",
    "a name that appears ONLY inside quotation marks is evoked, not present",
    `got ${find(r, "Corwin").klass}`);
  gate(find(r, "Corwin").uncertain === false,
    "and the engine is not hedging about it — dialogue-only is its cleanest call");
  gate(find(r, "Corwin").evidence.narrationMentions === 0,
    "the evidence says why: zero narration mentions");
  // The pair: the same fixture must still put the other two on the page, or
  // this gate would pass just as well on prose the engine cannot read at all.
  // ★ Bramble is `present`, not `speaking`, and the first draft of this gate
  //   demanded `speaking` for both — the fixture says he "said nothing". That
  //   is the taste trap: I wrote the expectation from what I meant rather than
  //   from what the sentence says.
  gate(find(r, "Alder").klass === "speaking" && find(r, "Bramble").klass === "present",
    "…while the one who talks is speaking and the one who stays silent is present",
    `got ${find(r, "Alder").klass} / ${find(r, "Bramble").klass}`);
  gate(onPageNames(r).sort().join(",") === "Alder,Bramble",
    "onPageNames drops the evoked name and keeps the present ones",
    `got [${onPageNames(r).join(", ")}]`);
}
{
  // A vocative overrides dialogue-only: being spoken TO means being there.
  const text = `“You were wrong about the mill, Corwin,” said Alder. Nobody else spoke.`;
  const r = classifyChapterPresence(text, cast("Alder", "Corwin"));
  gate(find(r, "Corwin").klass === "present",
    "a vocative inside a quote puts the addressee in the room",
    `got ${find(r, "Corwin").klass}`);
  gate(find(r, "Corwin").evidence.addressed === true, "and the evidence records the vocative");
}
{
  // ★ THE TITLE STEP-OVER. "welcome, Mr. Harker, to my house" is a vocative and
  //   the first version of this engine missed it — the pattern anchored on the
  //   comma and the honorific sat between comma and name.
  const text = `“I bid you welcome, Mr. Harker, to my house.” The door closed behind them.`;
  const r = classifyChapterPresence(text, cast("Harker"));
  gate(find(r, "Harker").klass === "present",
    "a vocative behind an honorific is still a vocative",
    `got ${find(r, "Harker").klass}`);
}

// ── 4 · presence without a word list ────────────────────────────────────────
console.log("\npredicates a verb list cannot reach");
{
  // Auxiliary chain: not one word here is an action verb.
  const text = `Elizabeth Bennet had been obliged, by the scarcity of gentlemen, to sit down for two dances.`;
  const r = classifyChapterPresence(text, cast("Elizabeth"));
  gate(find(r, "Elizabeth").klass === "present",
    "\"had been obliged … to sit down\" is presence (auxiliary chain, no action verb)",
    `got ${find(r, "Elizabeth").klass}`);
}
{
  // ★ THE TRAILING SURNAME. The cast holds "Sir William"; the prose writes "Sir
  //   William Lucas had been…", so the surname sits between name and verb.
  const text = `Sir William Lucas had been formerly in trade, and stood by the window all evening.`;
  const r = classifyChapterPresence(text, cast("Sir William"));
  gate(find(r, "Sir William").klass === "present",
    "a trailing surname does not hide the predicate",
    `got ${find(r, "Sir William").klass}`);
}
{
  const text = `Catherine and Lydia had been fortunate enough to be never without partners.`;
  const r = classifyChapterPresence(text, cast("Lydia"));
  gate(find(r, "Lydia").klass === "present",
    "a coordinated subject still reaches its verb",
    `got ${find(r, "Lydia").klass}`);
}
{
  // Narrated speech with no quotation anywhere near it. The quote-adjacent
  // speaks test cannot see this, so the subject test has to.
  const text = `Mr. Darcy said very little, and Mr. Hurst nothing at all.`;
  const r = classifyChapterPresence(text, cast("Darcy"));
  gate(find(r, "Darcy").klass === "present",
    "a narrator's report of speech is presence even with no quotation",
    `got ${find(r, "Darcy").klass}`);
}

// ── 5 · the uncertain middle is declared, not guessed ───────────────────────
console.log("\nthe uncertain middle");
{
  const text = `She smiled, as she thought of poor Miss Bingley, and turned back to the letter.`;
  const r = classifyChapterPresence(text, cast("Miss Bingley"));
  gate(find(r, "Miss Bingley").uncertain === true,
    "\"thought of X\" is flagged uncertain rather than called either way",
    `klass=${find(r, "Miss Bingley").klass} uncertain=${find(r, "Miss Bingley").uncertain}`);
}
{
  // The PAIR for the gate above: unambiguous prose must NOT be flagged, or
  // "everything is uncertain" would pass it and the model would be handed the
  // whole book.
  const text = `“We leave at dawn,” said Alder. Bramble rose and went to the door.`;
  const r = classifyChapterPresence(text, cast("Alder", "Bramble"));
  gate(r.every((p) => !p.uncertain),
    "clear prose is never flagged uncertain",
    `flagged: ${r.filter((p) => p.uncertain).map((p) => p.name).join(", ")}`);
}
{
  const text = `Mrs. Bennet now asked her whether Charlotte Lucas had been at Longbourn since her coming away.`;
  const r = classifyChapterPresence(text, cast("Charlotte"));
  const c = find(r, "Charlotte");
  gate(c.evidence.reported === true,
    "a name inside a reported complement clause is recorded as reported",
    `evidence=${JSON.stringify(c.evidence)}`);
}

// ── 6 · absence and first appearance ────────────────────────────────────────
console.log("\nabsence and first on-page chapter");
{
  const r = classifyChapterPresence(`The hall was empty and the fire had gone out.`, cast("Alder"));
  gate(find(r, "Alder").klass === "absent", "an unnamed character is absent");
  gate(onPageNames(r).length === 0, "…and contributes no on-page name");
}
{
  const chapters = [
    // Named but never on the page: the others discuss him.
    `“Corwin will come when he is ready,” said Alder. “Corwin always does.”`,
    // Still only talked about.
    `Alder wrote to Corwin twice that winter and burned both letters.`,
    // Now he actually arrives.
    `Corwin pushed the door open and stood dripping on the flagstones.`,
  ].map((t) => classifyChapterPresence(t, cast("Alder", "Corwin")));
  const first = firstOnPageByName(chapters);
  gate(first.get("Corwin") === 2,
    "first ON-PAGE chapter is the arrival, not the first time the name is said",
    `got ${first.get("Corwin")}`);
  gate(first.get("Alder") === 0, "and the character who was there all along starts at 0",
    `got ${first.get("Alder")}`);
  gate(chapters[0].find((p) => p.name === "Corwin")!.klass === "mentioned",
    "chapter 1 records him as mentioned, so the gap is visible rather than inferred");
  // ★ THE MIDDLE CHAPTER IS THE POINT. "Alder wrote to Corwin" is a real
  //   narration verb with Corwin in the object slot, so an object test calls it
  //   presence — and writing to someone means they are elsewhere.
  gate(chapters[1].find((p) => p.name === "Corwin")!.klass === "mentioned",
    "\"wrote to X\" is absence wearing an object's grammar",
    `got ${chapters[1].find((p) => p.name === "Corwin")!.klass}`);
  gate(chapters[1].find((p) => p.name === "Corwin")!.evidence.distal === true,
    "…and the evidence names the reason");
}

// ── 7 · aliases are honoured when supplied ──────────────────────────────────
console.log("\nvariants");
{
  const text = `“The game is afoot,” said Holmes. Sherlock Holmes was already at the door.`;
  const merged = classifyChapterPresence(text, [{ name: "Sherlock Holmes", variants: ["Holmes"] }]);
  gate(merged.length === 1 && merged[0].klass === "speaking",
    "one character with variants resolves to one speaking record",
    `got ${merged.length} records`);
  gate(merged[0].evidence.mentions === 2,
    "…counting every surface form as the same person",
    `got ${merged[0].evidence.mentions}`);
  const split = classifyChapterPresence(text, cast("Sherlock Holmes", "Holmes"));
  gate(split.filter((p) => p.klass !== "absent").length === 2,
    "★ WITHOUT the variants the same prose yields TWO characters — which is what " +
    "the DEV books do today, and why presence is coupled to the alias work");
}

console.log(`\n${"═".repeat(74)}`);
console.log(`${pass} passed, ${fail} failed`);
console.log("═".repeat(74));
process.exit(fail === 0 ? 0 : 1);
