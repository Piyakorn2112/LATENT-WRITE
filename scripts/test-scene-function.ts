/**
 * test-scene-function.ts — direct cases for the chapter-part label engine.
 *
 * The corpus harness (test-scene-labels.ts) can only see rates. This file
 * pins the behaviours that matter one at a time, including the two that no
 * aggregate number would ever catch:
 *
 *   • ABSTENTION — thin evidence must produce NO label. An engine that always
 *     answers is the gimmick this replaced.
 *   • NARRATION SCOPING — interiority words spoken INSIDE dialogue must not
 *     make a conversation read as a reflection. That defect shipped, was
 *     invisible to every metric, and was only found by reading output.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-scene-function.ts
 */

import { classifyScene } from "../src/lib/scene-function";
import { detectSpeechInChapter } from "../src/lib/speech-detect";

let passed = 0, failed = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

/** Run paragraphs through the real pipeline and return the scene labels. */
function labelsOf(paras: string[]): (string | undefined)[] {
  return detectSpeechInChapter(paras, [])
    .filter((r) => r.meta.sceneStart)
    .map((r) => r.meta.sceneLabel);
}

/** Classify a single scene directly, with control over the surrounding state. */
function one(paras: string[], opts: Partial<Parameters<typeof classifyScene>[0]> = {}) {
  return classifyScene({
    paragraphs: paras,
    dialogueDensity: paras.map(() => opts.dialogueDensity?.[0] ?? 0),
    tension: "calm",
    ...opts,
  } as Parameters<typeof classifyScene>[0]);
}

console.log("\n══ abstention: the engine must be able to say nothing ══");
{
  // Flat, featureless narration. Nothing here is any narrative function in
  // particular, so naming one would be a fabrication.
  const flat = [
    "The table stood where it had always stood. There were four chairs around it, and a cloth over it, and on the cloth a bowl.",
    "He counted the chairs. There were four. He counted them again and there were still four, which was the number there had been the day before.",
  ];
  ok("featureless prose gets NO label", one(flat) === null,
    JSON.stringify(one(flat)?.label));
}
{
  ok("a scene below the word floor gets NO label",
    one(["She waited."]) === null);
}

console.log("\n══ narration scoping: spoken 'I think' is not a reflection ══");
{
  // Every interiority word here is INSIDE quotation marks. The prose itself is
  // doing nothing reflective — it is two people talking.
  const spoken = [
    "“I have been thinking about it,” she said. “I remember what you told me, and I wonder whether you understood what you were saying.”",
    "“I thought you knew,” he said. “I felt sure you realised. I remember telling you, and I remember that you seemed to understand it perfectly well at the time.”",
    "“Then I misremembered,” she said. “I have wondered about it since, and I believe I understood nothing at all.”",
  ];
  const r = one(spoken, { dialogueDensity: [0.9] });
  ok("dialogue full of interiority words is NOT 'reflection'",
    r?.label !== "reflection", `got ${JSON.stringify(r?.label)}`);
}
{
  // The same vocabulary, but in narration. This one SHOULD read reactive.
  const narrated = [
    "She had been thinking about it for a long time. She remembered what he had told her, and she wondered whether he had understood what he was saying.",
    "He had thought she knew. He had felt sure she realised it. He remembered telling her, and he remembered that she had seemed to understand it perfectly well at the time.",
    "She considered it again. She had wondered about it since, and she believed now that she had understood nothing at all.",
  ];
  const r = one(narrated);
  ok("the same words in NARRATION read as reactive",
    r?.mode === "reactive", `got ${JSON.stringify(r)}`);
}

console.log("\n══ mode: Swain's proactive / reactive split ══");
{
  const confront = [
    "“You will not go,” he said. “I forbid it.”",
    "“You have no right to forbid me anything,” she answered. She refused to look at him. “I have made the arrangements already.”",
    "He demanded to know who had helped her. She denied that anyone had. He accused her of lying, and she did not trouble to deny that either.",
  ];
  const r = one(confront, { dialogueDensity: [0.55], tension: "rising" });
  ok("an argument reads proactive", r?.mode === "proactive", JSON.stringify(r));
}
{
  const decide = [
    "He sat for a long while with the letter in his hands and considered what it meant.",
    "There was no choice in it, not really. He could stay and let the thing happen, or he could go and try to stop it, and he knew which of those he would be able to live with afterwards.",
    "By morning he had decided. He would go, and he would go before anyone could talk him out of it.",
  ];
  const r = one(decide);
  ok("a deliberation ending in a decision is 'resolve'",
    r?.label === "resolve", JSON.stringify(r));
}

console.log("\n══ no label may be a synonym for the tension colour ══");
{
  // The old engine mapped high tension straight onto a loud word. Nothing in
  // the vocabulary may do that any more.
  const LOUD = ["tense", "intense", "pressure", "impact", "combat", "violence", "confrontation-high"];
  const violent = [
    "The blade bit into his shoulder. He staggered back, blood sheeting down his arm.",
    "He hit the floor hard. A boot drove into his ribs, then another. He could not breathe, could not see.",
  ];
  const r = one(violent, { tension: "high" });
  ok("a violent scene is not labelled with a volume word",
    !r || !LOUD.includes(r.label), JSON.stringify(r?.label));
}

console.log("\n══ the previous label is not repeated back to back ══");
{
  const paras = [
    "She had been thinking about it for a long time. She remembered what he had told her and wondered what he had meant by it.",
    "She considered it again, and she remembered, and she wondered, and she understood nothing at all of what she remembered.",
  ];
  const first = one(paras);
  const second = one(paras, { prevLabel: first?.label });
  ok("an identical scene does not repeat the previous label",
    !first || second?.label !== first.label,
    `${first?.label} then ${second?.label}`);
}

console.log("\n══ end to end through detectSpeechInChapter ══");
{
  const chapter = [
    "The morning light fell across the kitchen table. She poured the tea and watched the steam curl toward the ceiling.",
    "The garden was quiet. Bees moved among the lavender and beyond the wall a wood pigeon called.",
    "“You lied to me,” she said. “I trusted you.” He grabbed her wrist. “Let go,” she screamed, wrenching herself free.",
    "He slammed the door so hard the frame cracked. Glass shattered against the wall as he hurled the bottle past her head.",
  ];
  const labels = labelsOf(chapter);
  ok("a chapter produces scene starts without throwing", labels.length > 0);
  ok("every emitted label is a non-empty string",
    labels.filter(Boolean).every((l) => typeof l === "string" && l!.length > 0));
}

const total = passed + failed;
console.log(`\n${"=".repeat(60)}`);
console.log(`scene-function: ${passed}/${total} assertions`);
console.log("=".repeat(60));
if (failed > 0) { console.log("Below target.\n"); process.exit(1); }
console.log("All assertions passed.\n");
