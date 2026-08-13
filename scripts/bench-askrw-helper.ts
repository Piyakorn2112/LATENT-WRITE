/**
 * bench-askrw-helper.ts — the deterministic half of the ask/rewrite bench,
 * executed step by step by the Electron runner. Every build, normalize and
 * judge goes through the SHIPPED modules; the runner owns only the call
 * sequencing, mirroring MaxAskPopover/runMaxAsk and runWritingTool.
 *
 *   tsx scripts/bench-askrw-helper.ts <step> '<json>'
 */
import {
  buildMaxAskPack,
  buildMaxAskRequest,
  buildRefineRequest,
  buildReviewRequest,
  coerceProseAbstention,
  computeReviewVerdict,
  isUsefulAnswer,
  normalizeClaimCheck,
  normalizeMaxAsk,
  questionEntities,
  REFINE_CONF_FLOOR,
  WIDEN_CEILING_TOKENS,
  type MaxAskAnswer,
  type MaxAskInput,
} from "../src/lib/max-ask";
import { decideAskThinking, decideWritingThinking } from "../src/lib/think";
import {
  buildWritingRequest,
  fromWire,
  gateProfileFor,
  judgeRevision,
  matchQuoteStyle,
  planWritingBatches,
  relaxProfile,
  unchangedRetryNote,
  BATCH_MAX_CHARS,
  CONTEXT_BEFORE_CHARS,
  type WritingOp,
} from "../src/lib/writing-tool";
import { classifyInstruction, type IntentReading } from "../src/lib/writing-intent";

const [, , step, payload] = process.argv;
const arg = JSON.parse(payload || "{}");
const out = (value: unknown) => console.log(JSON.stringify(value));

switch (step) {
  case "ask-prep": {
    const input = arg.input as MaxAskInput;
    const pack = buildMaxAskPack(input, arg.budget);
    const req = buildMaxAskRequest(pack, undefined, input.kind);
    const decision = arg.think === false
      ? { think: false, budget: 0, reason: "disabled" }
      : decideAskThinking(input.kind, input.question, questionEntities(input).length);
    out({
      req: { systemPrompt: req.systemPrompt, userText: req.userText, schema: req.schema, maxTokens: req.maxTokens },
      rungs: pack.rungsIncluded,
      dropped: pack.rungsDropped,
      tokensEstimate: pack.tokensEstimate,
      tokensIfComplete: pack.tokensIfComplete,
      packText: pack.text,
      decision,
      widened: Math.min(Math.max((arg.budget ?? 2400) * 2, pack.tokensIfComplete), WIDEN_CEILING_TOKENS),
    });
    break;
  }
  case "ask-norm": {
    let answer = normalizeMaxAsk(arg.json, arg.rungs);
    if (answer) answer = coerceProseAbstention(answer, arg.kind);
    out({
      answer,
      useful: isUsefulAnswer(answer),
      needsRefineOnLowConf: !!answer && answer.confidence < REFINE_CONF_FLOOR,
    });
    break;
  }
  case "ask-review-build": {
    const pack = buildMaxAskPack(arg.input as MaxAskInput, arg.budget);
    const req = buildReviewRequest(pack, arg.answer as MaxAskAnswer);
    out({ req, packText: pack.text });
    break;
  }
  case "ask-review-verdict": {
    const claims = normalizeClaimCheck(arg.json);
    out({ review: claims ? computeReviewVerdict(claims, arg.packText) : null });
    break;
  }
  case "ask-refine-build": {
    const pack = buildMaxAskPack(arg.input as MaxAskInput, arg.budget);
    const req = buildRefineRequest(pack, arg.answer as MaxAskAnswer, arg.flag, arg.kind);
    out({ req });
    break;
  }
  case "rw-prep": {
    const op = arg.op as WritingOp;
    const reading: IntentReading =
      op === "custom" ? classifyInstruction(arg.instruction ?? "") : { intent: "unknown" };
    const batches = planWritingBatches(arg.text, BATCH_MAX_CHARS, op === "proofread");
    if (batches.length !== 1) throw new Error(`bench expects single-batch cases, got ${batches.length}`);
    const profile = gateProfileFor(op, reading);
    const request = buildWritingRequest(op, batches[0], {
      before: (arg.before ?? "").slice(-CONTEXT_BEFORE_CHARS),
      revisedTail: "",
      instruction: arg.instruction,
      characters: [],
      reading,
      retryNote: arg.retryNote,
    });
    out({
      reading,
      profile,
      batchText: batches[0].text,
      request: {
        systemPrompt: request.systemPrompt, userText: request.userText,
        schema: request.schema, maxTokens: request.maxTokens,
      },
      decision: decideWritingThinking(reading.intent, arg.attempt ?? 0, op),
      maxAttempts: op === "custom" ? 3 : 2,
    });
    break;
  }
  case "rw-judge": {
    const text = matchQuoteStyle(arg.original, fromWire(String(arg.raw ?? "").trim()));
    const unchanged = text === String(arg.original).trim() || text === "";
    const reading: IntentReading = arg.reading;
    const profile = arg.relaxed ? relaxProfile(arg.profile) : arg.profile;
    const verdict = unchanged ? null : judgeRevision(arg.original, text, profile);
    out({
      text,
      unchanged,
      verdict,
      unchangedNote: unchangedRetryNote(reading),
    });
    break;
  }
  default:
    throw new Error(`unknown step ${step}`);
}
