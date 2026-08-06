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
import type { WritingOp, WritingToolOutcome } from "../lib/writing-tool";

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
  ) => Promise<WritingToolOutcome | null>;
  /** Cancels the in-flight batch chain (queued + running). */
  onCancel: () => void;
  onClose: () => void;
}

type Phase = "choose" | "running" | "done" | "failed";

const OP_LABEL: Record<WritingOp, string> = {
  proofread: "Proofreading…",
  rewrite: "Revising…",
  custom: "Rewriting to your request…",
};

export function WritingToolPopover(props: WritingToolPopoverProps) {
  const [phase, setPhase] = useState<Phase>("choose");
  const [instruction, setInstruction] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [lastOp, setLastOp] = useState<WritingOp>("proofread");
  const [outcome, setOutcome] = useState<WritingToolOutcome | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const start = async (op: WritingOp) => {
    setLastOp(op);
    setPhase("running");
    setProgress(null);
    const result = await props.onRun(
      op,
      op === "custom" ? instruction.trim() || undefined : undefined,
      (done, total) => { if (aliveRef.current) setProgress({ done, total }); },
    );
    if (!aliveRef.current) return;
    if (!result || result.cancelled) { setPhase(result ? "choose" : "failed"); return; }
    setOutcome(result);
    setPhase("done");
  };

  const clampX = Math.min(props.x, window.innerWidth - 340);
  const clampY = Math.min(props.y, window.innerHeight - 260);

  const revisedCount = outcome?.batchOutcomes.filter((o) => o === "revised").length ?? 0;
  const keptCount = outcome?.batchOutcomes.filter((o) => o === "kept-original" || o === "failed").length ?? 0;

  return (
    <div
      className="max-ask liquid-glass writing-tool"
      style={{ position: "fixed", left: clampX, top: clampY, zIndex: 60 }}
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
              {OP_LABEL[lastOp]}
              {progress && progress.total > 1 ? ` part ${progress.done} of ${progress.total}` : ""}
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
                  ? `Done — ${revisedCount} ${revisedCount === 1 ? "part" : "parts"} revised${keptCount > 0 ? `, ${keptCount} kept as written (revision did not beat the original)` : ""}. The text has been replaced; undo works as usual.`
                  : "Nothing needed changing — the text is untouched."}
              </div>
            </div>
            <div className="max-ask-line">
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
            <div className="max-ask-line">
              <button className="max-ask-again" onClick={() => void start(lastOp)}>Try again</button>
              <button className="max-ask-again" onClick={props.onClose}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
