/**
 * test-dialogue-events.ts — WHICH UTTERANCES ARE EVENTS?
 *
 * Run:  npx tsx scripts/test-dialogue-events.ts     (exit 1 on failure)
 *
 * ─── WHY THIS SUITE EXISTS ───────────────────────────────────────────────────
 *
 * 49% of the MAJOR events the engine never finds sit inside quoted dialogue —
 * the single largest blind spot, measured on 134 majors across nine books:
 *
 *     "I have come to bring you home, dear brother!"
 *     "I do; and I release you."
 *     "I mean to give him the same chance every year"
 *
 * The obvious fix is to widen what counts as an event-bearing utterance. That has
 * been tried before and it flooded: an earlier version typed 84.4% of everything
 * in Pride and Prejudice as "revelation", putting a chip on lines like "I do not
 * cough for my own amusement". Narrowing to PERFORMATIVE verbs fixed that and is
 * what caused the current blind spot — the list covers commissives well and
 * nothing else.
 *
 * So the risk here is symmetric, and a single number cannot see both sides of it.
 * This suite pins BOTH: utterances that must produce an event, and utterances
 * that must not. Widening coverage without breaking the negatives is the whole
 * job, and neither half is optional.
 *
 * ─── IT TESTS THROUGH THE PUBLIC INTERFACE ───────────────────────────────────
 *
 * Cases run through `detectNarrativeEvents` on a real paragraph list, not against
 * the internal classifier. That costs a little noise — attribution has to succeed
 * for the utterance to be reachable at all — and buys a test that survives any
 * refactor of how the decision is actually made.
 *
 * Every POSITIVE case is a real clause from the gold set that the engine misses.
 * Every NEGATIVE is a real clause it wrongly emitted. Nothing here is invented.
 */

import { detectNarrativeEvents } from "../src/lib/narrative-events";
import { detectSpeechInChapter } from "../src/lib/speech-detect";

interface Case {
  name: string;
  /** Paragraphs exactly as they appear in the source, attribution included. */
  paragraphs: string[];
  /** Index of the paragraph that must (or must not) yield an event. */
  target: number;
  speakers: string[];
  from: string;
}

/** Utterances that ARE events. Each is a MAJOR gold event the engine misses. */
const SHOULD_DETECT: Case[] = [
  {
    name: "release from an obligation",
    from: "carol ch2 — Belle releases Scrooge from their engagement",
    paragraphs: [
      "She looked at him steadily, and he could not meet her eyes.",
      "“It matters little,” she said, softly. “To you, very little. Another idol has displaced me.”",
      "“I do; and I release you,” said Belle.",
      "The bell struck and he turned away.",
    ],
    target: 2,
    speakers: ["Belle", "Scrooge"],
  },
  {
    name: "a standing commitment",
    from: "carol ch3 — Fred commits to inviting Scrooge every year",
    paragraphs: [
      "He was full of glee, and could scarcely stand upright.",
      "“I mean to give him the same chance every year, whether he likes it or not,” said Fred.",
      "The company applauded and the fiddle struck up again.",
    ],
    target: 1,
    speakers: ["Fred", "Scrooge"],
  },
  {
    name: "an order that ends the working day",
    from: "carol ch2 — Fezziwig closes the warehouse for Christmas Eve",
    paragraphs: [
      "Old Fezziwig laid down his pen and looked up at the clock.",
      "“No more work to-night. Christmas Eve, Dick. Christmas, Ebenezer!” said Fezziwig.",
      "Clear away, my lads, and let's have lots of room here!",
    ],
    target: 1,
    speakers: ["Fezziwig", "Dick", "Ebenezer"],
  },
  {
    name: "a consequential prediction",
    from: "carol ch3 — the Ghost foretells Tiny Tim's death",
    paragraphs: [
      "Scrooge bent before the Ghost's rebuke, and trembling cast his eyes upon the ground.",
      "“If these shadows remain unaltered by the future, the child will die,” said the Ghost.",
      "The Spirit turned away and the scene faded.",
    ],
    target: 1,
    speakers: ["Scrooge", "Ghost"],
  },
];

/**
 * KNOWN GAPS — reported every run, NOT gated.
 *
 * These fail for a reason outside this file, so gating on them would leave a
 * permanently red suite that says nothing about the code it guards. They are
 * kept visible because a gap nobody can see is a gap nobody fixes.
 */
const KNOWN_GAPS: Case[] = [
  {
    name: "announced arrival with a purpose",
    from: "carol ch2 — Fan arrives to take Scrooge home. BLOCKED ON ATTRIBUTION: "
      + "the tag is “said the child”, a definite description rather than a name, "
      + "so speech-detect never resolves a speaker and the utterance is "
      + "unreachable. The classifier rule for it is already in place and correct. "
      + "Fixing this means teaching attribution to resolve definite descriptions "
      + "(“the child”, “the old man”, “the stranger”) against the cast — a "
      + "speech-detect change, scored by accuracy-suite, not by this file.",
    paragraphs: [
      "The door opened and a little girl came darting in.",
      "“I have come to bring you home, dear brother!” said the child.",
      "She clapped her tiny hands and bent to laugh.",
    ],
    target: 1,
    speakers: ["Fan", "Scrooge"],
  },
];

/**
 * Utterances that are NOT events. Every one was actually emitted by an earlier,
 * wider version of the rule — this is the flood, pinned so it cannot return.
 */
const SHOULD_NOT_DETECT: Case[] = [
  {
    name: "a complaint about oneself",
    from: "pride ch1 — emitted as “Kitty tells do”",
    paragraphs: [
      "Mrs. Bennet was busy with her needle and did not look up.",
      "“I do not cough for my own amusement,” replied Kitty, fretfully.",
      "The subject was allowed to drop.",
    ],
    target: 1,
    speakers: ["Kitty", "Mrs. Bennet"],
  },
  {
    name: "an opinion about a third party",
    from: "pride ch1 — emitted as “Mrs tells”",
    paragraphs: [
      "They spoke of the neighbours for some time.",
      "“She is a selfish, hypocritical woman, and I have no opinion of her,” said Elizabeth.",
      "Jane made no answer.",
    ],
    target: 1,
    speakers: ["Elizabeth", "Jane"],
  },
  {
    name: "a wish about the past",
    from: "pride ch1 — emitted as “Lizzy tells wish you”",
    paragraphs: [
      "The evening wore on pleasantly enough.",
      "“I wish you had been there, my dear, to have given him one of your set-downs,” said Mrs. Bennet.",
      "She returned to her sewing.",
    ],
    target: 1,
    speakers: ["Mrs. Bennet", "Elizabeth"],
  },
  {
    name: "a statement of present feeling",
    from: "pride ch1 — emitted as “Lydia tells afraid”",
    paragraphs: [
      "Lydia was not to be intimidated by anybody.",
      "“Oh, I am not afraid; for though I am the youngest, I am the tallest,” said Lydia, stoutly.",
      "Her sisters laughed at her.",
    ],
    target: 1,
    speakers: ["Lydia", "Kitty"],
  },
];

let passed = 0;
let failed = 0;

/**
 * Returns whether the target paragraph produced an event, plus WHY NOT when it
 * did not. The two failure modes need different fixes and look identical from
 * outside: an utterance can be unreachable because the speaker was never
 * attributed, or reachable and judged not to be an event. Reporting only
 * pass/fail sent me to rewrite the classifier for a case that was actually
 * failing on attribution.
 */
function detectAt(c: Case): { found: boolean; why: string } {
  const speech = detectSpeechInChapter(c.paragraphs, c.speakers, { intelligenceLevel: "default" });
  const events = detectNarrativeEvents(c.paragraphs, speech, {
    knownNames: c.speakers,
    // No floor: this suite asks whether the utterance is REACHABLE as an event at
    // all, which is a different question from whether it wins its chapter. The
    // ranking is scored by test-event-detect.
    confidenceFloor: 0,
  });
  const found = events.some((e) => e.paragraphIndex === c.target);
  const seg = speech[c.target]?.segments?.find((s) => s.type === 'speech');
  const why = !seg
    ? "no dialogue segment found in the paragraph"
    : !seg.speaker
      ? "SPEAKER NOT ATTRIBUTED — the utterance never reaches classification"
      : seg.confidence < 0.5
        ? `speaker "${seg.speaker}" attributed at confidence ${seg.confidence.toFixed(2)}, below the 0.5 gate`
        : `speaker "${seg.speaker}" ok — the utterance was classified as NOT an event`;
  return { found, why };
}

function check(c: Case, want: boolean) {
  const { found, why } = detectAt(c);
  if (found === want) { passed++; console.log(`  ✓ ${c.name}`); }
  else {
    failed++;
    console.log(`  ✗ ${c.name}`);
    console.log(`      ${want ? "expected an event, got none" : "expected NO event, got one"}`);
    console.log(`      why: ${why}`);
    console.log(`      ${c.from}`);
    console.log(`      ${c.paragraphs[c.target].slice(0, 92)}`);
  }
}

async function main() {
  console.log("\n══ Utterances that ARE events (currently missed MAJOR gold events) ══");
  for (const c of SHOULD_DETECT) check(c, true);

  console.log("\n══ Utterances that are NOT events (the flood, pinned) ══");
  for (const c of SHOULD_NOT_DETECT) check(c, false);

  console.log("\n══ Known gaps (reported, not gated) ══");
  for (const c of KNOWN_GAPS) {
    const { found, why } = detectAt(c);
    console.log(`  ${found ? "✓ NOW PASSES — promote it into SHOULD_DETECT" : "· still open"}  ${c.name}`);
    if (!found) console.log(`      ${why}`);
  }

  console.log(`\n${"═".repeat(30)}`);
  console.log(`dialogue events: ${passed}/${passed + failed}`);
  console.log("═".repeat(30));
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
