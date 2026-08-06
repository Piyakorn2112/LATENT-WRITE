/**
 * test-writing-tool.ts — gates for the writing-tool core (no model needed:
 * the run loop is exercised with scripted runners).
 *
 * Run: ./node_modules/.bin/tsx scripts/test-writing-tool.ts
 */
import {
  planWritingBatches, buildWritingRequest, assembleRevision, applyRevision,
  revisionAcceptable, runWritingTool, BATCH_MAX_CHARS,
  toWire, fromWire, matchQuoteStyle,
} from "../src/lib/writing-tool";
import type { AssistantJSONRunner } from "../src/lib/assistant-client";

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

console.log(`\n${failures === 0 ? "✓ ALL GATES GREEN" : `✗ ${failures} GATE(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
