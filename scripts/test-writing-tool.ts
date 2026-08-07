/**
 * test-writing-tool.ts — gates for the writing-tool core (no model needed:
 * the run loop is exercised with scripted runners).
 *
 * Run: ./node_modules/.bin/tsx scripts/test-writing-tool.ts
 */
import {
  planWritingBatches, buildWritingRequest, assembleRevision, applyRevision,
  revisionAcceptable, runWritingTool, BATCH_MAX_CHARS, STRUCTURAL_MAX_CHARS,
  gateProfileFor, judgeRevision, countTerm, findTermCased, renameAll,
  countFilterWords, countLyAdverbs, countPassive, openingRun,
  toWire, fromWire, matchQuoteStyle, isLengthInstruction,
} from "../src/lib/writing-tool";
import { classifyInstruction, namesInInstruction } from "../src/lib/writing-intent";
import type { AssistantJSONRequest, AssistantJSONRunner } from "../src/lib/assistant-client";

let failures = 0;
const gate = (ok: boolean, label: string, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

console.log("── 1 · batching is a partition of the selection ─────────────");
{
  const para = (n: number, len = 300) =>
    `Paragraph ${n} ${"sentence of ordinary length here. ".repeat(Math.ceil(len / 36))}`.trim();
  const cases: Array<[string, string]> = [
    ["single short", "Just one paragraph."],
    ["two paras", `${para(1)}\n\n${para(2)}`],
    ["windows seps", `${para(1)}\r\n\r\n${para(2)}\n\n\n${para(3)}`],
    ["long selection", Array.from({ length: 12 }, (_, i) => para(i, 700)).join("\n\n")],
    ["one huge paragraph", "A very long sentence goes here and keeps going. ".repeat(90)],
    ["leading blank lines", `\n\n${para(1)}\n\n${para(2)}\n\n`],
    ["tabs in separator", `${para(1)}\n\t\n${para(2)}`],
  ];
  for (const [name, sel] of cases) {
    const batches = planWritingBatches(sel);
    const roundtrip = batches.map((b) => b.text + b.sep).join("");
    gate(roundtrip === sel, `${name}: batches+seps reassemble to the exact selection`,
      `lens ${roundtrip.length} vs ${sel.length}`);
    gate(batches.every((b) => b.text.length <= BATCH_MAX_CHARS + 200),
      `${name}: no batch runs far over the cap`,
      `max ${Math.max(...batches.map((b) => b.text.length))}`);
    gate(batches.every((b, i) => b.index === i), `${name}: indexes are dense`, "");
  }
  const long = planWritingBatches(Array.from({ length: 12 }, (_, i) => para(i, 700)).join("\n\n"));
  gate(long.length > 1, "a long selection actually batches", `${long.length} batches`);
  // Unpacked mode: one paragraph per batch, still a perfect partition.
  const sel3 = `${para(1)}\n\n${para(2)}\n\n${para(3)}`;
  const unpacked = planWritingBatches(sel3, BATCH_MAX_CHARS, false);
  gate(unpacked.length === 3, "unpacked: one batch per paragraph", `${unpacked.length}`);
  gate(unpacked.map((b) => b.text + b.sep).join("") === sel3, "unpacked: still reassembles exactly");
}

console.log("\n── 2 · request assembly ─────────────────────────────────────");
{
  const [batch] = planWritingBatches("She walked to the door. She opened it.");
  const req = buildWritingRequest("proofread", batch, { before: "Earlier text.", revisedTail: "" });
  gate(req.userText.includes("PASSAGE:") && req.userText.includes("CONTEXT"),
    "proofread request carries passage and context blocks");
  gate(req.systemPrompt.includes("PROOFREADING ONLY"), "proofread uses the proofread rules");
  gate(req.maxTokens > 60 && req.maxTokens < 400, "token budget scales with the batch", `${req.maxTokens}`);
  const custom = buildWritingRequest("custom", batch, { before: "", revisedTail: "", instruction: "make it tense" });
  gate(custom.userText.includes("INSTRUCTION: make it tense"), "custom instruction rides the user turn");
}

console.log("\n── 2b · the quote wire ──────────────────────────────────────");
{
  const dialogue = `"I ain't got nothin' to say," Teo said. "Ask me later."`;
  gate(fromWire(toWire(dialogue)) === dialogue, "wire roundtrip is lossless on dialogue");
  gate(!toWire(dialogue).includes('"'), "no straight double quote survives onto the wire");
  const [b] = planWritingBatches(dialogue);
  const req = buildWritingRequest("proofread", b, { before: 'She said "go".', revisedTail: "" });
  gate(!req.userText.split("PASSAGE:")[1].includes('"') && !req.userText.includes('CONTEXT — the manuscript just before this passage (do not revise):\n She'),
    "passage and context are wire-escaped in the request");
  gate(matchQuoteStyle("plain 'text'", "curly ‘text’ and “quotes”") === `curly 'text' and "quotes"`,
    "curly output folds back to straight when the original is straight");
  gate(matchQuoteStyle("has ‘curly’ already", "kept ‘curly’") === "kept ‘curly’",
    "an already-curly manuscript keeps curly");
}

console.log("\n── 3 · the grammar gate ─────────────────────────────────────");
{
  const original = "He walked to teh door and and opened it.";
  gate(revisionAcceptable(original, "He walked to the door and opened it."),
    "a genuine correction is accepted");
  gate(!revisionAcceptable(original, ""), "an empty revision is refused");
  gate(!revisionAcceptable(original, "Completely different text.\n\nNow two paragraphs."),
    "a paragraph-count change is refused");
  gate(!revisionAcceptable(original, "He left."), "a wild shortening is refused");
  // ★ THE LENGTH WINDOW IS PER OP: "make it longer" legitimately doubles a
  //   passage; the proofread/rewrite window silently vetoed it and the
  //   popover reported "nothing needed changing".
  const doubled = "He walked slowly to the old door, breathing hard, and after a long moment of hesitation he finally opened it with both hands.";
  gate(!revisionAcceptable("He walked to the door and opened it.", doubled, "rewrite"),
    "rewrite still refuses a 2x expansion");
  gate(revisionAcceptable("He walked to the door and opened it.", doubled, "custom"),
    "custom accepts the expansion an instruction asked for");
  // ★ CUSTOM MAY RESHAPE PARAGRAPHS A LITTLE — a grown paragraph splitting
  //   in two is what "add more detail" looks like; strict equality was
  //   refusing most creative requests.
  const grown = "He walked slowly to the old door, breathing hard.\n\nAfter a long moment of hesitation he finally opened it with both hands, and stood in the doorway.";
  gate(revisionAcceptable("He walked to the door and opened it.", grown, "custom"),
    "custom accepts a paragraph split the instruction caused");
  gate(!revisionAcceptable("He walked to the door and opened it.", grown, "rewrite"),
    "rewrite still refuses a paragraph-count change");

  // Routing: expansion phrases go to the length prompt; style asks stay custom.
  for (const [ins, expect] of [
    ["make it longer", true], ["add more detail about the storm", true],
    ["expand this with the sea's smell", true], ["flesh out the second beat", true],
    ["make it more playful", false], ["make this moment feel more tense", false],
    ["use simpler words", false],
  ] as Array<[string, boolean]>) {
    gate(isLengthInstruction(ins) === expect, `"${ins}" routes ${expect ? "LENGTH" : "CUSTOM"}`);
  }
  gate(!revisionAcceptable("She said it plainly.", "She duck said it it plainly plainly to to to the the man man who who."),
    "a revision that ADDS hard errors is refused");
}

console.log("\n── 4 · the run loop with scripted runners ───────────────────");
await (async () => {
  const sel = "First paragraph here with words.\n\nSecond paragraph here with words.";
  const good: AssistantJSONRunner = async <T,>(req: { userText: string }) => {
    const passage = req.userText.split("PASSAGE:\n")[1];
    return { ok: true as const, json: { text: passage.replace("words", "better words") } as T, modelId: "m", timings: null };
  };
  const out = await runWritingTool(sel, { run: good, op: "rewrite", before: "" });
  gate(out.revised.includes("better words") && out.revised.split("\n\n").length === 2,
    "revisions land per batch and separators survive", out.revised);
  gate(out.batchOutcomes.every((o) => o === "revised"), "outcomes report revised", out.batchOutcomes.join(","));

  const failing: AssistantJSONRunner = async () => ({ ok: false as const, reason: "busy" });
  const kept = await runWritingTool(sel, { run: failing, op: "proofread", before: "" });
  gate(kept.revised === sel, "every-run-failed keeps the selection byte-identical");
  gate(kept.batchOutcomes.every((o) => o === "failed"), "outcomes report failed");

  const cancelling: AssistantJSONRunner = async () => ({ ok: false as const, reason: "cancelled" });
  const cx = await runWritingTool(sel, { run: cancelling, op: "proofread", before: "" });
  gate(cx.cancelled && cx.revised === sel, "cancellation stops the loop and keeps the original");

  // Apply is a pure splice.
  const full = `AAA ${sel} ZZZ`;
  gate(applyRevision(full, 4, 4 + sel.length, out.revised) === `AAA ${out.revised} ZZZ`,
    "applyRevision splices at exact offsets");

  // assemble with partial revisions keeps unrevised batches original (small
  // cap forces the two paragraphs into separate batches).
  const batches = planWritingBatches(sel, 40);
  gate(batches.length === 2, "small cap yields one batch per paragraph", `${batches.length}`);
  const partial = assembleRevision(batches, [batches[0].text, "Rewritten second."]);
  gate(partial.startsWith("First paragraph") && partial.endsWith("Rewritten second."),
    "assemble mixes revised and original batches");
})();

console.log("\n── 5 · intent classifier (minimal pairs) ────────────────────");
{
  const cases: Array<[string, string, number?]> = [
    ["merge these two paragraphs", "merge", 1],
    ["merge these 2 paragraphs and make them shorter", "merge", 1],
    ["combine them into one", "merge", 1],
    ["please combine the two paragraphs into a single paragraph", "merge", 1],
    ["split this into two paragraphs", "split", 2],
    ["break this up into three parts", "split", 3],
    ["make it shorter", "condense", undefined],
    ["make it half as long", "condense", undefined],
    ["condense this into one paragraph", "condense", 1],
    ["make it longer", "expand", undefined],
    ["add more detail about the storm", "expand", undefined],
    ["add an action scene to this", "insert", undefined],
    ["insert a flashback about the war", "insert", undefined],
    ["write a new scene where they argue", "insert", undefined],
    ["make it funny", "tone", undefined],
    ["make it more playful", "tone", undefined],
    ["make this moment feel more tense", "tone", undefined],
    ["fix the pacing", "unknown", undefined],
    ["use simpler words", "unknown", undefined],
  ];
  for (const [ins, intent, target] of cases) {
    const r = classifyInstruction(ins);
    gate(r.intent === intent, `"${ins}" → ${intent}`, `got ${r.intent}`);
    if (target !== undefined) gate(r.targetParas === target, `  …target ${target}`, `got ${r.targetParas}`);
  }
  gate(classifyInstruction("merge these 2 paragraphs and make them shorter").wantsShorter === true,
    "merge+shorter carries wantsShorter");
  // Provisioning name match is word-bounded and case-sensitive.
  gate(namesInInstruction("add detail about Mira's action", ["Mira", "Teo"]).join(",") === "Mira",
    "instruction names resolve against the cast");
  gate(namesInInstruction("the rose garden at dusk", ["Rose"]).length === 0,
    "a lowercase common noun never matches a proper name");
}

console.log("\n── 6 · gate profiles judge with a diagnosis ─────────────────");
{
  const twoParas = "The bell rang across the harbour.\n\nNobody moved from the quay.";
  const merge = gateProfileFor("custom", { intent: "merge", targetParas: 1 });
  gate(judgeRevision(twoParas, "The bell rang across the harbour and nobody moved from the quay.", merge).ok,
    "merge: a genuine one-paragraph merge passes");
  const mergeFail = judgeRevision(twoParas, "The bell rang across the harbour.\n\nNobody moved at all.", merge);
  gate(!mergeFail.ok && mergeFail.failure.code === "para-count" && mergeFail.failure.detail.includes("exactly 1"),
    "merge: two paragraphs back fails with the target in the diagnosis",
    mergeFail.ok ? "passed" : mergeFail.failure.detail);

  const onePara = "The bell rang across the harbour and nobody moved from the quay at all.";
  const split = gateProfileFor("custom", { intent: "split" });
  gate(judgeRevision(onePara, "The bell rang across the harbour.\n\nNobody moved from the quay at all.", split).ok,
    "split: more paragraphs passes");
  const splitFail = judgeRevision(onePara, onePara.replace("bell", "brass bell"), split);
  gate(!splitFail.ok && splitFail.failure.code === "para-count",
    "split: same paragraph count fails");

  const condense = gateProfileFor("custom", { intent: "condense" });
  gate(judgeRevision(onePara, "The bell rang; nobody moved.", condense).ok, "condense: a real cut passes");
  const condenseFail = judgeRevision(onePara, onePara.replace("bell", "big bell"), condense);
  gate(!condenseFail.ok && condenseFail.failure.code === "len-high",
    "condense: same-length text fails the window");

  const expand = gateProfileFor("custom", { intent: "expand" });
  const expandFail = judgeRevision(onePara, "The bell rang.", expand);
  gate(!expandFail.ok && expandFail.failure.code === "len-low",
    "expand: a shrunken answer fails with len-low");

  // The legacy profiles ARE today's gate — spot-check equivalence.
  gate(revisionAcceptable("He walked to teh door.", "He walked to the door.") === true &&
    revisionAcceptable("He walked to teh door.", "") === false,
    "legacy delegation preserves the boolean gate");
}

console.log("\n── 7 · the diagnose-adjust-retry loop ───────────────────────");
await (async () => {
  const twoParas = "The bell rang across the harbour tonight.\n\nNobody moved from the quay at all.";
  const merged = "The bell rang across the harbour tonight and nobody moved from the quay at all.";

  // A scripted runner that records every request it sees.
  const record = (answers: Array<string | { fail: string }>) => {
    const seen: AssistantJSONRequest[] = [];
    const run: AssistantJSONRunner = async <T,>(req: AssistantJSONRequest) => {
      seen.push(req);
      const a = answers[Math.min(seen.length - 1, answers.length - 1)];
      if (typeof a !== "string") return { ok: false as const, reason: a.fail };
      return { ok: true as const, json: { text: a } as T, modelId: "m", timings: null };
    };
    return { run, seen };
  };

  // Gate failure → retry carries the diagnosis → second attempt ships.
  {
    const { run, seen } = record([twoParas.replace("bell", "brass bell"), merged]);
    const out = await runWritingTool(twoParas, { run, think: false, op: "custom", instruction: "merge these two paragraphs", before: "" });
    gate(seen.length === 2, "merge: gate failure earns exactly one retry", `${seen.length} calls`);
    gate(seen[0].userText.includes("PASSAGE:") && !seen[0].userText.includes("REJECTED"),
      "attempt 0 carries no retry note");
    gate(seen[1].userText.includes("REJECTED BY THE EDITOR'S CHECK") && seen[1].userText.includes("exactly 1"),
      "the retry quotes the gate's diagnosis with its numbers");
    gate(seen[0].systemPrompt.includes("RESHAPING IS THE JOB"), "merge routes to the structure prompt");
    gate(out.batchOutcomes.join(",") === "revised" && out.revised === merged,
      "the repaired attempt ships", out.batchOutcomes.join(","));
  }

  // Structural ops run the selection as ONE batch.
  {
    const { run, seen } = record([merged]);
    await runWritingTool(twoParas, { run, think: false, op: "custom", instruction: "merge these two paragraphs", before: "" });
    gate(seen.length === 1 && seen[0].userText.includes("Nobody moved"),
      "a merge sees both paragraphs in one prompt");
  }

  // Whitespace fringes survive the structural path byte-for-byte.
  {
    const fringed = `\n\n${twoParas}\n\n`;
    const { run } = record([merged]);
    const out = await runWritingTool(fringed, { run, think: false, op: "custom", instruction: "merge these two paragraphs", before: "" });
    gate(out.revised === `\n\n${merged}\n\n`, "leading/trailing blank lines are preserved through a merge", JSON.stringify(out.revised.slice(0, 8)));
  }

  // Unchanged on custom is a refusal → retried; the LAST retry samples.
  // (Single-paragraph selection: tone batches per paragraph, so only there
  // does a verbatim answer equal the batch text.)
  {
    const onePlain = twoParas.split("\n\n")[0];
    const playful = "The bell clanged its cheerful racket across the harbour tonight.";
    const { run, seen } = record([onePlain, onePlain, playful]);
    const out = await runWritingTool(onePlain, { run, think: false, op: "custom", instruction: "make it more playful", before: "" });
    gate(seen.length === 3 && out.batchOutcomes.join(",") === "revised",
      "unchanged custom answers are retried until a real revision ships", `${seen.length} calls, ${out.batchOutcomes.join(",")}`);
    const last = seen[seen.length - 1];
    gate(seen[0].temperature === undefined && last.temperature === 0.7 && last.minP === 0.05,
      "attempt 0 is deterministic; the last custom retry samples",
      `t0=${seen[0].temperature} tN=${last.temperature}`);
    gate(seen[1].userText.includes("came back unchanged"), "the unchanged diagnosis rides the retry");
  }

  // Exhaustion keeps the original and surfaces the last diagnosis.
  {
    const stubborn = twoParas.replace("bell", "brass bell"); // always 2 paras on a merge ask
    const { run, seen } = record([stubborn]);
    const out = await runWritingTool(twoParas, { run, think: false, op: "custom", instruction: "merge these two paragraphs", before: "" });
    gate(seen.length === 3 && out.batchOutcomes.join(",") === "kept-original",
      "exhausted retries keep the original", `${seen.length} calls, ${out.batchOutcomes.join(",")}`);
    gate((out.diagnosis ?? "").includes("exactly 1"), "the outcome carries the diagnosis", out.diagnosis ?? "none");
    gate(out.revised === twoParas, "the selection is untouched after exhaustion");
  }

  // Runner failures never retry (they would fight the memory guard).
  {
    const { run, seen } = record([{ fail: "low-memory" }]);
    const out = await runWritingTool(twoParas, { run, think: false, op: "custom", instruction: "merge these two paragraphs", before: "" });
    gate(seen.length === 1 && out.batchOutcomes.join(",") === "failed" && out.failReasons[0] === "low-memory",
      "a runner failure fails once, honestly", `${seen.length} calls`);
  }

  // Proofread unchanged is a good answer — one call, no retry.
  {
    const { run, seen } = record([twoParas.split("\n\n")[0]]);
    const out = await runWritingTool(twoParas.split("\n\n")[0], { run, think: false, op: "proofread", before: "" });
    gate(seen.length === 1 && out.batchOutcomes.join(",") === "unchanged",
      "proofread accepts unchanged without retrying", `${seen.length} calls`);
  }

  // Too-long structural selections fail honestly, before any model call.
  {
    const big = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} ${"with plenty of words here. ".repeat(10)}`).join("\n\n");
    gate(big.length > STRUCTURAL_MAX_CHARS, "fixture actually exceeds the cap");
    const { run, seen } = record([merged]);
    const out = await runWritingTool(big, { run, think: false, op: "custom", instruction: "merge these paragraphs", before: "" });
    gate(seen.length === 0 && out.failReasons[0] === "selection-too-long" && out.revised === big,
      "an oversized merge is refused with zero model calls", `${seen.length} calls`);
    gate((out.diagnosis ?? "").includes("2,800"), "the refusal names the cap", out.diagnosis ?? "none");
  }

  // Provisioning: an instruction-named character rides in even when absent
  // from the passage; an unnamed one does not.
  {
    const { run, seen } = record([twoParas.replace("Nobody", "Mira says nobody")]);
    await runWritingTool(twoParas, {
      run, op: "custom", instruction: "add more detail about Mira",
      before: "", characters: [{ name: "Mira", info: "a harbour pilot" }, { name: "Teo", info: "a clerk" }],
    });
    gate(seen[0].userText.includes("Mira: a harbour pilot"), "the instruction-named character is provisioned");
    gate(!seen[0].userText.includes("Teo"), "an unmentioned character stays out of the prompt");
  }

  // INSERT routes to its own prompt with an absolute token allowance.
  {
    const { run, seen } = record([`${twoParas}\n\nSteel rang on steel as the first boarder came over the rail.`]);
    const out = await runWritingTool(twoParas, { run, think: false, op: "custom", instruction: "add an action scene to this", before: "" });
    gate(seen[0].systemPrompt.includes("ADD something NEW"), "insert routes to the insert prompt");
    gate((seen[0].maxTokens ?? 0) > 900, "insert carries the new-material token allowance", `${seen[0].maxTokens}`);
    gate(out.batchOutcomes.join(",") === "revised", "a grounded insertion ships", out.batchOutcomes.join(","));
  }
})();

console.log("\n── 8 · term-targeted edits ──────────────────────────────────");
await (async () => {
  const prose =
    "John pushed the boat off the ramp. The water took it slowly, and John waded in after it up to his knees.\n\n" +
    "By the time the sail caught, John was laughing. Mara had never seen John laugh like that.";

  // Classification.
  const p1 = classifyInstruction("replace John with a pronoun");
  gate(p1.intent === "target" && p1.target?.mode === "pronounize" && p1.target.term === "John",
    `"replace John with a pronoun" → target/pronounize`, JSON.stringify(p1));
  const p2 = classifyInstruction("rename Mara to Naomi");
  gate(p2.intent === "target" && p2.target?.mode === "rename" && p2.target.replacement === "Naomi",
    `"rename Mara to Naomi" → target/rename`);
  const p3 = classifyInstruction("replace the sword with a dagger");
  gate(p3.intent === "target" && p3.target?.mode === "substitute" && p3.target.term === "sword",
    `"replace the sword with a dagger" → target/substitute`, JSON.stringify(p3));
  const p4 = classifyInstruction("stop repeating the word suddenly");
  gate(p4.intent === "target" && p4.target?.mode === "reduce" && p4.target.term === "suddenly",
    `"stop repeating the word suddenly" → target/reduce`, JSON.stringify(p4));
  const p5 = classifyInstruction('use "just" less');
  gate(p5.intent === "target" && p5.target?.mode === "reduce" && p5.target.term === "just",
    `quoted reduce term extracts`, JSON.stringify(p5));
  gate(classifyInstruction("change the tone to formal").intent === "tone",
    "meta words never become targets (tone ask stays tone)");
  gate(classifyInstruction("turn the sword into a dagger").target?.mode === "substitute",
    `"turn X into Y" reads as substitution`);
  gate(classifyInstruction("use dagger instead of sword").target?.term === "sword",
    `"use Y instead of X" targets X`);

  // Counting is word-bounded and case-sensitive; possessives count.
  gate(countTerm(prose, "John") === 4, "countTerm counts every John", `${countTerm(prose, "John")}`);
  gate(countTerm("John's boat. JOHNSON left.", "John") === 1, "possessive counts, Johnson does not");
  gate(countTerm("Suddenly it died. It guttered suddenly.", "suddenly") === 2,
    "counting is case-insensitive across sentence starts");
  gate(findTermCased(prose, "john") === "John", "a lowercase-typed term re-cases from the prose");
  gate(findTermCased(prose, "jhon") === null, "a typo resolves to nothing, not to a guess");

  // Deterministic rename: exact, possessive-safe, model-free.
  gate(renameAll("John took John's coat. JOHN!", "John", "Marcus") === "Marcus took Marcus's coat. MARCUS!",
    "renameAll rewrites mentions, possessives and shouts", renameAll("John took John's coat. JOHN!", "John", "Marcus"));

  // The pronounize gate: count must come down, which mentions is free.
  const prof = gateProfileFor("custom", classifyInstruction("replace John with a pronoun"));
  const good = prose.replace("John waded", "he waded").replace("John was laughing", "he was laughing").replace("seen John laugh", "seen him laugh");
  gate(judgeRevision(prose, good, prof).ok, "keeping the first mention and pronounizing the rest passes");
  const lazy = judgeRevision(prose, prose.replace("pushed", "shoved"), prof);
  gate(!lazy.ok && lazy.failure.code === "target" && lazy.failure.detail.includes("still appears 4"),
    "an unchanged count fails with the count in the diagnosis", lazy.ok ? "passed" : lazy.failure.detail);

  // Run loop: rename never calls the model.
  {
    const seen: AssistantJSONRequest[] = [];
    const run: AssistantJSONRunner = async <T,>(req: AssistantJSONRequest) => {
      seen.push(req);
      return { ok: true as const, json: { text: "unused" } as T, modelId: "m", timings: null };
    };
    const out = await runWritingTool(prose, { run, think: false, op: "custom", instruction: "replace John with Marcus", before: "" });
    gate(seen.length === 0 && out.batchOutcomes.join(",") === "revised",
      "a rename ships deterministically with zero model calls", `${seen.length} calls`);
    gate(countTerm(out.revised, "John") === 0 && countTerm(out.revised, "Marcus") === 4,
      "every John became Marcus", out.revised.slice(0, 60));
  }

  // Run loop: honest pre-flight failures.
  {
    const run: AssistantJSONRunner = async () => { throw new Error("must not run"); };
    const miss = await runWritingTool(prose, { run, think: false, op: "custom", instruction: "replace Renner with a pronoun", before: "" });
    gate(miss.failReasons[0] === "target-not-found" && (miss.diagnosis ?? "").includes("Renner"),
      "an absent term fails before any model run", miss.diagnosis ?? "none");
    const single = await runWritingTool("Mara sat down.", { run, think: false, op: "custom", instruction: "replace Mara with a pronoun", before: "" });
    gate(single.failReasons[0] === "nothing-to-replace",
      "a single mention has no later mentions to replace", single.failReasons[0]);
  }

  // Run loop: pronounize runs the selection whole and retries on a lazy count.
  {
    const seen: AssistantJSONRequest[] = [];
    const answers = [prose.replace("pushed", "shoved"), good];
    const run: AssistantJSONRunner = async <T,>(req: AssistantJSONRequest) => {
      seen.push(req);
      return { ok: true as const, json: { text: answers[Math.min(seen.length - 1, answers.length - 1)] } as T, modelId: "m", timings: null };
    };
    const out = await runWritingTool(prose, { run, think: false, op: "custom", instruction: "replace john with a pronoun", before: "" });
    gate(seen.length === 2 && out.batchOutcomes.join(",") === "revised",
      "a lazy pronounize earns a diagnosed retry and then ships", `${seen.length} calls, ${out.batchOutcomes.join(",")}`);
    gate(seen[1].userText.includes("still appears 4"), "the count rides the retry note");
    gate(seen[0].userText.includes("PASSAGE:\nJohn pushed"), "the whole mention chain is one prompt");
  }
})();

console.log("\n── 9 · scrub edits (self-editing checklist family) ──────────");
await (async () => {
  // Classification.
  for (const [ins, kind] of [
    ["remove the filter words", "filter-words"],
    ["de-filter this, it's deep POV", "filter-words"],
    ["cut the -ly adverbs and use stronger verbs", "ly-adverbs"],
    ["fewer adverbs please", "ly-adverbs"],
    ["make this active voice", "passive"],
    ["too much passive voice, fix it", "passive"],
    ["vary the sentence openings, everything starts with She", "opening-run"],
    ["every sentence starts with I, fix that", "opening-run"],
  ] as Array<[string, string]>) {
    const r = classifyInstruction(ins);
    gate(r.intent === "scrub" && r.scrub?.kind === kind, `"${ins}" → scrub/${kind}`, JSON.stringify(r));
  }
  // Continuity patches are reversed substitutions; bare comparatives are not.
  const cont = classifyInstruction("she's holding a knife, not a gun");
  gate(cont.intent === "target" && cont.target?.mode === "substitute" &&
    cont.target.term === "gun" && cont.target.replacement === "knife",
    "continuity patch reads as substitute gun→knife", JSON.stringify(cont));
  gate(classifyInstruction("make it shorter, not longer").intent === "condense",
    "'shorter, not longer' is still a condense, never a substitution");
  gate(classifyInstruction("stop using the word just").target?.mode === "reduce",
    "reduce still wins over scrub for a named word");

  // Measures.
  const filtery = "Mara felt the cold. She heard the gulls and noticed the tide. It seemed late.";
  gate(countFilterWords(filtery) === 4, "filter words count", `${countFilterWords(filtery)}`);
  gate(countLyAdverbs("He walked slowly and only spoke softly to his friendly family.") === 2,
    "-ly adverbs count past the whitelist", `${countLyAdverbs("He walked slowly and only spoke softly to his friendly family.")}`);
  gate(countPassive("The door was opened by Teo. The sail is torn. She ran.") === 2,
    "passive proxy counts be+participle", `${countPassive("The door was opened by Teo. The sail is torn. She ran.")}`);
  const runny = "She stood. She waited. She counted the boats. The tide turned.";
  gate(openingRun(runny).run === 3 && openingRun(runny).word === "she",
    "opening run finds 3xShe", JSON.stringify(openingRun(runny)));

  // Judge: a scrub that does not move the count fails with the count.
  const sp = gateProfileFor("custom", classifyInstruction("remove the filter words"));
  const lazy = judgeRevision(filtery, filtery.replace("Mara", "She"), sp);
  gate(!lazy.ok && lazy.failure.code === "measure" && lazy.failure.detail.includes("filter word"),
    "a no-op scrub fails with the measure diagnosis", lazy.ok ? "passed" : lazy.failure.detail);
  gate(judgeRevision(filtery, "The cold bit at Mara. Gulls cried over the turning tide. The light was already going.", sp).ok,
    "a real de-filter passes");

  // Run loop: clean paragraphs are skipped, dirty ones run.
  {
    const sel = `${filtery}\n\nThe rope lay coiled on the deck. Salt dried white on the rail.`;
    const seen: AssistantJSONRequest[] = [];
    const run: AssistantJSONRunner = async <T,>(req: AssistantJSONRequest) => {
      seen.push(req);
      return { ok: true as const, json: { text: "The cold bit at Mara. Gulls cried over the turning tide. The light was already going." } as T, modelId: "m", timings: null };
    };
    const out = await runWritingTool(sel, { run, think: false, op: "custom", instruction: "remove the filter words", before: "" });
    gate(seen.length === 1, "a paragraph with zero filter words never reaches the model", `${seen.length} calls`);
    gate(out.batchOutcomes.join(",") === "revised,unchanged", "outcomes: dirty revised, clean untouched",
      out.batchOutcomes.join(","));
    gate(out.revised.includes("Salt dried white"), "the clean paragraph survives byte-identical");
  }
})();

console.log("\n── 10 · adaptive thinking in the writing loop ────────────────");
await (async () => {
  const { decideWritingThinking } = await import("../src/lib/think");
  gate(!decideWritingThinking("merge", 0, "custom").think, "gated intents run fast at attempt 0");
  gate(decideWritingThinking("merge", 1, "custom").think, "every custom retry thinks");
  gate(decideWritingThinking("insert", 0, "custom").think, "creative generation thinks from the start");
  gate(decideWritingThinking("tone", 0, "custom").think, "open-ended tone thinks from the start");
  gate(!decideWritingThinking("unknown", 0, "proofread").think, "proofread never thinks at attempt 0");

  const onePara =
    "The bell rang across the harbour tonight and the boats answered it, hull after hull, while Mara stood at the rail and listened to the sound move away from her over the dark water.";
  // Sits BETWEEN the strict tone ceiling (1.6x + 120) and the relaxed one
  // (1.84x + 200) — the only region where "relaxed profile applied" is a
  // falsifiable claim rather than a vacuous one.
  const stretched =
    "The bell rang across the harbour tonight with the self-importance of a town crier, and the boats answered it hull after gossiping hull, a knock here, a shiver of rigging there, until the whole basin was talking at once. Mara stood at the rail like a teacher waiting out a rowdy classroom, listening to the sound skip away over the dark water, taking its sweet time about it, as if the night had nowhere better to be and neither, for once, did she.";
  const seen: AssistantJSONRequest[] = [];
  const thinkFlags: boolean[] = [];
  const run: AssistantJSONRunner = async <T,>(req: AssistantJSONRequest) => {
    seen.push(req);
    if (req.freeText) {
      return { ok: true as const, json: { text: "<think>The ask is playful register; lively harbour sounds carry it. Length can stretch a little for rhythm.</think>" } as T, modelId: "m", timings: null };
    }
    return { ok: true as const, json: { text: stretched } as T, modelId: "m", timings: null };
  };
  const out = await runWritingTool(onePara, {
    run, op: "custom", instruction: "make it more playful", before: "",
    onThinking: (t) => thinkFlags.push(t),
  });
  gate(seen[0].freeText === true && (seen[0].stopTexts ?? []).includes("</think>"),
    "★ the think pass is unconstrained and stops at </think>");
  gate(seen[1].freeText !== true && seen[1].userText.includes("YOUR NOTES"),
    "★ the notes ride the constrained attempt");
  gate(stretched.length > onePara.length * 1.6 + 120, "fixture actually exceeds the strict window",
    `${stretched.length} vs ${Math.round(onePara.length * 1.6 + 120)}`);
  gate(out.batchOutcomes.join(",") === "revised",
    "★ a thought attempt is judged against the RELAXED profile", out.batchOutcomes.join(","));
  gate(thinkFlags[0] === true && thinkFlags[thinkFlags.length - 1] === false,
    "the thinking indicator is raised and lowered", thinkFlags.join(","));

  // think:false is a hard off-switch (the control arm every probe needs).
  {
    const quiet: AssistantJSONRequest[] = [];
    const runQuiet: AssistantJSONRunner = async <T,>(req: AssistantJSONRequest) => {
      quiet.push(req);
      return { ok: true as const, json: { text: onePara } as T, modelId: "m", timings: null };
    };
    await runWritingTool(onePara, { run: runQuiet, think: false, op: "custom", instruction: "make it more playful", before: "" });
    gate(quiet.every((r) => r.freeText !== true), "think:false never issues a freeText pass");
  }
})();

console.log(`\n${failures === 0 ? "✓ ALL GATES GREEN" : `✗ ${failures} GATE(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
