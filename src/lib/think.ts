/**
 * think.ts — adaptive reasoning for the interactive surfaces.
 *
 * ★ THE POLICY, IN ONE LINE: background batch work never thinks (chips,
 *   summaries — speed is the product), interactive work thinks WHEN THE
 *   TASK SHAPE EARNS IT, and a failed first attempt is itself a signal
 *   (verifier-guided escalation, the only self-correction pattern with
 *   positive small-model evidence).
 *
 * ★ WHY TWO PHASES: a grammar masks think tokens from token zero
 *   (measured), so "noThink:false on a constrained run" has always been
 *   cosmetic. Real thinking = one unconstrained pass stopped at </think>,
 *   whose notes then ride the normal constrained request. The host's
 *   prefix cache makes the second prefill nearly free — the two prompts
 *   share every byte up to the notes.
 *
 * Decision signals are deliberately CHEAP AND DETERMINISTIC (rules over a
 * classifier model: a second model load to decide whether to think would
 * cost more than thinking). The rules encode the difficulty features the
 * adaptive-reasoning literature converges on: multi-entity, causal/temporal
 * shape, multi-clause length, and first-attempt failure.
 */
import type { AssistantJSONRunner } from "./assistant-client";

export interface ThinkDecision {
  think: boolean;
  /** Reasoning token budget when thinking. */
  budget: number;
  reason: string;
}

const CAUSAL_RE = /\b(why|how|what (did|does|would|happens?)|because|before|after|change[ds]?|different|between|compare|lead[s]? to|result|instead|motiv\w+|feel[s]? about|relationship)\b/i;

/**
 * Ask surface. Fixed menu kinds (check/explain/suggest) stay fast — their
 * prompts already scaffold the reasoning shape. Free-typed questions think
 * when they carry difficulty features; a bare lookup ("who is Tim") does
 * not earn four seconds of latency.
 */
export function decideAskThinking(
  kind: string,
  question: string | undefined,
  entityCount: number,
): ThinkDecision {
  if (kind !== "question" || !question) {
    return { think: false, budget: 0, reason: "fixed-kind" };
  }
  const q = question.trim();
  const causal = CAUSAL_RE.test(q);
  const multiEntity = entityCount >= 2;
  const long = q.length > 60 || q.split(/\s+/).length > 12;
  if (!causal && !multiEntity && !long) {
    return { think: false, budget: 0, reason: "simple-lookup" };
  }
  // Base 256; the "what did Tim do to Annaha" shape (causal AND
  // multi-entity) gets the >512 regime — measured (probe-think-ask): at 448
  // and again at 768 the reasoning was still walking the evidence when cut,
  // and truncated notes carried no conclusions to use.
  const budget = causal && multiEntity ? 1024 : 256;
  return { think: true, budget, reason: [causal && "causal", multiEntity && "multi-entity", long && "long"].filter(Boolean).join("+") };
}

/**
 * Writing surface. Attempt 0 stays fast for the intents that measured 100%
 * at attempt 0 (structural, target, scrub — their gates carry the load).
 * Creative generation (insert) and open-ended asks (tone, unknown custom)
 * think from the start; EVERY custom retry thinks — the gate failure just
 * proved the fast path insufficient, which is the cheapest accurate
 * difficulty signal there is.
 */
export function decideWritingThinking(
  intent: string,
  attempt: number,
  op: string,
): ThinkDecision {
  if (op !== "custom") {
    return attempt > 0
      ? { think: true, budget: 256, reason: "retry-escalation" }
      : { think: false, budget: 0, reason: "mechanical-op" };
  }
  if (attempt > 0) return { think: true, budget: 320, reason: "retry-escalation" };
  if (intent === "insert") return { think: true, budget: 320, reason: "creative-generation" };
  if (intent === "tone" || intent === "unknown") return { think: true, budget: 256, reason: "open-ended" };
  return { think: false, budget: 0, reason: "gated-intent" };
}

/**
 * The unconstrained reasoning pass. Same system + user text as the main
 * request (prefix-cache aligned), stopped at </think>, budget-capped.
 * Returns the cleaned notes, or null when the pass failed or produced
 * nothing — the caller proceeds without notes either way; thinking is an
 * upgrade, never a dependency.
 */
export async function runThinkPass(
  run: AssistantJSONRunner,
  req: {
    task: string;
    tag: string;
    systemPrompt: string;
    userText: string;
    schema: object;
    budget: number;
    timeoutMs?: number;
    /**
     * ★ PASS THIS WHENEVER THE CALLER'S OTHER REQUESTS SET ONE, AND PASS THE
     *   SAME VALUE. `ensureLoaded` reuses a session when the loaded context
     *   is >= the wanted one, so a small answer call after a big think pass
     *   is free — but a big think pass after a small answer call RELOADS the
     *   model. A caller that sizes its answers down and leaves this unset
     *   therefore pays a full reload mid-card, which is the opposite of what
     *   sizing down was for. Omitted keeps the tier default.
     */
    contextSize?: number;
  },
): Promise<string | null> {
  const result = await run<{ text?: unknown }>({
    task: req.task,
    tag: `${req.tag}-think`,
    systemPrompt: req.systemPrompt,
    userText: req.userText,
    schema: req.schema, // ignored by the host in freeText mode; keeps the type whole
    freeText: true,
    stopTexts: ["</think>"],
    noThink: false,
    tier: "max",
    maxTokens: req.budget,
    timeoutMs: req.timeoutMs ?? 60_000,
    ...(req.contextSize ? { contextSize: req.contextSize } : {}),
  });
  if (!result.ok) return null;
  const raw = typeof result.json?.text === "string" ? result.json.text : "";
  const notes = raw.replace(/^[\s\S]*?<think>/, "").replace(/<\/think>[\s\S]*$/, "").trim();
  // A think pass that produced almost nothing is noise, not notes. When the
  // budget truncated the reasoning, keep the TAIL: conclusions form at the
  // end of a trace; the head is preamble (measured, probe-think-ask).
  if (notes.length < 40) return null;
  return notes.length <= 2400 ? notes : notes.slice(-2400);
}

/** The notes block appended to the MAIN request's user text. Kept short and
 *  clearly labeled as the model's own prior reasoning, not new evidence. */
export function notesBlock(notes: string): string {
  return `YOUR NOTES — you already thought this through; use these conclusions:\n${notes}`;
}
