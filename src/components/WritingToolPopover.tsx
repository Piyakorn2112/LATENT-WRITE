/**
 * WritingToolPopover — the selection's writing helper (max mode).
 *
 * Same glass + vocabulary as MaxAskPopover on purpose: one AI-tool look.
 * The popover is dumb UI — batching, context, the grammar gate and the
 * splice all live in writing-tool.ts / App; this chooses an op, narrates
 * progress in first person, and offers cancel / write again / a changed
 * request.
 */
import { useEffect, useRef, useState } from "react";
import { OrbEngine } from "./orb/OrbEngine";
import { ThinkingLabel } from "./ThinkingLabel";
import type { WritingOp, WritingToolOutcome } from "../lib/writing-tool";
import { CUSTOM_SYSTEM, WRITING_TASK } from "../lib/writing-tool";
import { assistantRunJSON } from "../lib/assistant-client";

export interface WritingToolPopoverProps {
  x: number;
  y: number;
  selectionPreview: string;
  selectionChars: number;
  batchEstimate: number;
  onRun: (
    op: WritingOp,
    instruction: string | undefined,
    onProgress: (done: number, total: number) => void,
    onThinking: (thinking: boolean) => void,
  ) => Promise<WritingToolOutcome | null>;
  /** Cancels the in-flight batch chain (queued + running). */
  onCancel: () => void;
  onClose: () => void;
}

type Phase = "choose" | "running" | "done" | "failed";

/** Runner reasons → honest human copy. The old label reported every failure
 *  as "nothing needed changing", including out-of-memory. */
function humanFailure(reasons: string[]): string {
  const r = reasons[0] ?? "";
  if (r === "low-memory") return "not enough free memory right now";
  if (r === "busy") return "the model is busy with another task";
  if (r === "timeout") return "the model took too long";
  if (r === "no-model") return "the Max model is not downloaded";
  if (r === "selection-too-long") return "the selection is too long for a reshaping request";
  if (r === "target-not-found") return "the word to change was not found in the selection";
  if (r === "nothing-to-replace") return "there was nothing left to replace";
  if (r === "unavailable" || r === "not-loaded" || r === "no-host") return "the model is not running";
  return r ? `error: ${r}` : "an unknown error";
}

/** Failures the harness diagnosed BEFORE any model ran — the popover shows
 *  the diagnosis itself, since "try again in a moment" would be a lie. */
const PREFLIGHT = new Set(["selection-too-long", "target-not-found", "nothing-to-replace"]);

const OP_LABEL: Record<WritingOp, string> = {
  proofread: "Proofreading…",
  rewrite: "Revising…",
  custom: "Rewriting to your request…",
};

export function WritingToolPopover(props: WritingToolPopoverProps) {
  // ★★ PREWARM ON INTENT (probe-ttft): a cold writing call pays engine boot
  //    plus ~3.3s prefilling its fixed system prompt; the batch engine
  //    reuses a cached prefix at ~160ms. The three op prompts share their
  //    SHARED_RULES head, so one 1-token request on the longest of them
  //    warms the family while the writer chooses an op. Fire-and-forget;
  //    App cancels by task when the popover closes.
  useEffect(() => {
    void assistantRunJSON({
      task: WRITING_TASK, tier: "max", lane: "batch", jsonStyle: "compact",
      systemPrompt: CUSTOM_SYSTEM, userText: ".",
      schema: { type: "object", properties: { w: { type: "string", maxLength: 4 } } },
      maxTokens: 1, timeoutMs: 30_000,
    }).catch(() => { /* a failed prewarm costs nothing */ });
  }, []);

  const [phase, setPhase] = useState<Phase>("choose");
  const [instruction, setInstruction] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [lastOp, setLastOp] = useState<WritingOp>("proofread");
  const [outcome, setOutcome] = useState<WritingToolOutcome | null>(null);
  const aliveRef = useRef(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const phaseRef = useRef<Phase>("choose");
  phaseRef.current = phase;
  useEffect(() => () => { aliveRef.current = false; }, []);

  // ★ THE POPOVER RIDES THE TEXT. It anchors to a document position, not the
  //   viewport: the editor's scrolling ancestor is found once and the anchor
  //   is translated by scroll delta, so scrolling never strands the popover
  //   over unrelated prose.
  const [scrollShift, setScrollShift] = useState(0);
  useEffect(() => {
    let el: HTMLElement | null = document.querySelector(".document-editor");
    let scroller: HTMLElement | null = null;
    while (el) {
      const cs = window.getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) { scroller = el; break; }
      el = el.parentElement;
    }
    const readTop = () => (scroller ? scroller.scrollTop : window.scrollY);
    const top0 = readTop();
    const onScroll = () => setScrollShift(top0 - readTop());
    const target: HTMLElement | Window = scroller ?? window;
    target.addEventListener("scroll", onScroll, { passive: true });
    return () => target.removeEventListener("scroll", onScroll);
  }, []);

  // ★ CLICK-AWAY DISMISSES — EXCEPT MID-RUN (owner call): while the model is
  //   revising, the popover is the cancel surface and must not vanish under a
  //   stray click; every other phase behaves like the app's other popovers.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (phaseRef.current === "running") return;
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phaseRef.current !== "running") props.onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [props.onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  const [thinking, setThinking] = useState(false);
  const start = async (op: WritingOp) => {
    setLastOp(op);
    setPhase("running");
    setProgress(null);
    setThinking(false);
    const result = await props.onRun(
      op,
      op === "custom" ? instruction.trim() || undefined : undefined,
      (done, total) => { if (aliveRef.current) setProgress({ done, total }); },
      (t) => { if (aliveRef.current) setThinking(t); },
    );
    if (!aliveRef.current) return;
    if (!result || result.cancelled) { setPhase(result ? "choose" : "failed"); return; }
    setOutcome(result);
    setPhase("done");
  };

  const clampX = Math.min(props.x, window.innerWidth - 312);
  const clampY = Math.min(props.y, window.innerHeight - 260);

  const revisedCount = outcome?.batchOutcomes.filter((o) => o === "revised").length ?? 0;
  const keptCount = outcome?.batchOutcomes.filter((o) => o === "kept-original").length ?? 0;
  const failedCount = outcome?.batchOutcomes.filter((o) => o === "failed").length ?? 0;

  return (
    <div
      ref={rootRef}
      className="max-ask liquid-glass writing-tool"
      style={{ position: "fixed", left: clampX, top: clampY + scrollShift, zIndex: 60 }}
      role="dialog"
      aria-label="Writing tool"
    >
      <div className="max-ask-inner">
        <div className="max-ask-context" title={props.selectionPreview}>
          {props.selectionPreview}
          <span className="max-ask-item-hint">
            {" "}· {props.selectionChars.toLocaleString()} chars
            {props.batchEstimate > 1 ? ` · ${props.batchEstimate} parts` : ""}
          </span>
        </div>

        {phase === "choose" && (
          <>
            <button className="max-ask-item" onClick={() => void start("proofread")}>
              <span className="max-ask-item-label">Proofread</span>
              <span className="max-ask-item-hint">fix typos and grammar, keep every word choice</span>
            </button>
            <button className="max-ask-item" onClick={() => void start("rewrite")}>
              <span className="max-ask-item-label">Rewrite</span>
              <span className="max-ask-item-hint">smooth clarity and flow, keep the meaning</span>
            </button>
            <input
              className="max-ask-question-input"
              placeholder="Or describe a change… (Enter to run)"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && instruction.trim()) void start("custom");
                if (e.key === "Escape") props.onClose();
              }}
            />
          </>
        )}

        {phase === "running" && (
          <div className="max-ask-wait">
            <span className="max-ask-orb">
              <OrbEngine mode="default" analyzing size={18} flowScale={0.8} aberration={0.45} tint="--control-value-fill" />
            </span>
            <span>
              {thinking ? <ThinkingLabel /> : OP_LABEL[lastOp]}
              {!thinking && progress && progress.total > 1 ? ` part ${progress.done} of ${progress.total}` : ""}
            </span>
            <button className="max-ask-again" onClick={() => { props.onCancel(); setPhase("choose"); }}>
              Cancel
            </button>
          </div>
        )}

        {phase === "done" && (
          <>
            <div className="max-ask-answer">
              <div className="max-ask-answer-text">
                {revisedCount > 0
                  ? `Done. ${revisedCount} ${revisedCount === 1 ? "part" : "parts"} revised${keptCount > 0 ? `, ${keptCount} kept as written` : ""}${failedCount > 0 ? `, ${failedCount} failed` : ""}. The new text is in place; press ⌘Z to bring the old text back.`
                  : failedCount > 0
                    ? PREFLIGHT.has(outcome?.failReasons[0] ?? "") && outcome?.diagnosis
                      ? `The text is untouched: ${outcome.diagnosis}. Adjust the selection or the request and try again.`
                      : `The run failed (${humanFailure(outcome?.failReasons ?? [])}), so the text is untouched. Try again in a moment.`
                    : keptCount > 0
                      ? outcome?.diagnosis
                        ? `The revision didn't pass the check (${outcome.diagnosis}), so nothing was replaced. Try rephrasing the request.`
                        : "The revision didn't pass the safety check (it read worse than the original), so nothing was replaced. Try rephrasing the request."
                      : "Nothing needed changing. The text is exactly as it was."}
              </div>
            </div>
            <div className="writing-tool-actions">
              <button className="max-ask-again" onClick={() => void start(lastOp)}>Write again</button>
              <button className="max-ask-again" onClick={() => { setPhase("choose"); setOutcome(null); }}>
                Change request
              </button>
              <button className="max-ask-again" onClick={props.onClose}>Close</button>
            </div>
          </>
        )}

        {phase === "failed" && (
          <div className="max-ask-answer">
            <div className="max-ask-answer-text max-ask-answer-text--muted">
              The model could not finish. The text is untouched.
            </div>
            <div className="writing-tool-actions">
              <button className="max-ask-again" onClick={() => void start(lastOp)}>Try again</button>
              <button className="max-ask-again" onClick={props.onClose}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
