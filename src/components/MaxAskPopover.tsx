import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { OrbEngine } from "./orb/OrbEngine";
import { assistantRunJSON, cancelWhere } from "../lib/assistant-client";
import {
  MAX_ASK_TASK,
  runMaxAsk,
  type AskKind,
  type MaxAskInput,
  type MaxAskResult,
} from "../lib/max-ask";
import type { AssistantJSONRunner } from "../lib/assistant-client";

interface Props {
  /** Click point, viewport coordinates. */
  x: number;
  y: number;
  /** First line of the paragraph under the pointer, so the writer can confirm
   *  the surface is about the paragraph they think it is. */
  paragraphPreview: string;
  build: (kind: AskKind, question?: string) => MaxAskInput | null;
  onClose: () => void;
}

/**
 * The right-click surface for max mode: a small menu over the paragraph, then
 * the answer in place.
 *
 * ★ THE MODEL RUNS ON THE MAX TIER WITH THINKING ON — `tier: "max"` and
 *   `noThink: false` ride every request from here, which is the one place in
 *   the app that uses the 4B. Every other engine keeps the 1.7B it was
 *   measured against.
 *
 * ★ CLOSING CANCELS. The runtime is single-flight; a writer who right-clicks,
 *   asks, and immediately closes must not leave a 4B inference blocking the
 *   entity reviewer for ten seconds. cancelWhere on unmount, by task.
 */
const maxRunner: AssistantJSONRunner = (req) =>
  // contextSize 8192: Q8_0 KV cache means the 8k window now costs what the
  // old 4k f16 window did (~265 MB), so the ask surface takes the room — the
  // evidence budget grew with it, and the memory guard still walks down on a
  // machine that cannot hold it.
  assistantRunJSON({ ...req, tier: "max", noThink: false, contextSize: 8192 });

const MENU: ReadonlyArray<{ kind: AskKind; label: string; hint: string }> = [
  { kind: "check", label: "Check against the story", hint: "does anything here conflict?" },
  { kind: "explain", label: "What is this doing?", hint: "the work this paragraph performs" },
  { kind: "suggest", label: "What could follow?", hint: "grounded in what is established" },
];

const RUNG_LABEL: Record<string, string> = {
  passage: "this paragraph",
  ask: "the question",
  who: "who is present",
  neighbours: "the surrounding paragraphs",
  "story-so-far": "earlier chapters",
  "open-threads": "open threads",
  related: "earlier passages",
};

type Phase =
  | { name: "menu" }
  | { name: "asking"; label: string }
  | { name: "done"; result: MaxAskResult }
  | { name: "failed"; reason?: string };

export function MaxAskPopover({ x, y, paragraphPreview, build, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>({ name: "menu" });
  const [question, setQuestion] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [boxHeight, setBoxHeight] = useState<number | null>(null);
  const armedRef = useRef(false);
  const aliveRef = useRef(true);

  /**
   * ★ THE GLASS CONTAINER ANIMATES ITS HEIGHT BY MEASUREMENT, because `height:
   *   auto` cannot transition. The inner content renders at natural size; this
   *   measures it on every phase change and eases the container to match. The
   *   first paint is exempt (armedRef) — a popover that GROWS INTO existence
   *   from 0 fights its own reveal animation.
   *
   *   The liquid-glass engine keeps up on its own: every tracked surface has a
   *   ResizeObserver (liquid-glass-filter.ts) that reschedules the refraction
   *   map as the box resizes, so the material stays correct THROUGH the
   *   transition rather than snapping at the end.
   */
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const measure = () => {
      const h = inner.offsetHeight;
      if (!armedRef.current) {
        armedRef.current = true;
        setBoxHeight(h);
        return;
      }
      setBoxHeight(h);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [phase.name]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      cancelWhere((job) => job.task === MAX_ASK_TASK);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [onClose]);

  const ask = (kind: AskKind, q?: string) => {
    const input = build(kind, q);
    if (!input) { setPhase({ name: "failed", reason: "no-input" }); return; }
    setPhase({ name: "asking", label: "Reading passage…" });
    void runMaxAsk(input, {
      run: maxRunner,
      selfReview: true,
      // The harness narrates its phases; the popover just translates them.
      // "reviewing" is the one worth naming — the answer exists at that point,
      // and "checking its answer" is a different promise than "reading".
      onPhase: (p) => {
        if (!aliveRef.current) return;
        setPhase({
          name: "asking",
          // First-person working notes, not third-person narration: the
          // surface says what it is DOING, tersely, as if thinking aloud.
          label: p === "asking" ? "Reading passage…"
            : p === "widening" ? "Reading more of the story…"
            : p === "refining" ? "Correcting answer…"
            : "Reviewing answer…",
        });
      },
    }).then((result) => {
      if (!aliveRef.current) return;
      setPhase(result.answer
        ? { name: "done", result }
        : { name: "failed", reason: result.failReason });
    });
  };

  // Clamp into the viewport; the menu opens toward whichever side has room.
  const W = 340;
  const left = Math.max(12, Math.min(x, window.innerWidth - W - 12));
  const top = Math.max(12, Math.min(y + 8, window.innerHeight - 220));

  return (
    <div
      ref={boxRef}
      className="max-ask liquid-glass"
      style={{ left, top, width: W, height: boxHeight ?? undefined }}
      role="dialog"
      aria-label="Ask about this paragraph"
    >
      <div ref={innerRef} className="max-ask-inner">
      <div className="max-ask-context" title={paragraphPreview}>{paragraphPreview}</div>

      {phase.name === "menu" && (
        <>
          {MENU.map((m) => (
            <button key={m.kind} type="button" className="max-ask-item" onClick={() => ask(m.kind)}>
              <span className="max-ask-item-label">{m.label}</span>
              <span className="max-ask-item-hint">{m.hint}</span>
            </button>
          ))}
          <form
            className="max-ask-question"
            onSubmit={(e) => {
              e.preventDefault();
              if (question.trim()) ask("question", question.trim());
            }}
          >
            <input
              className="max-ask-question-input"
              placeholder="Ask about this paragraph…"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              // The editor owns most shortcuts; a question being typed must not
              // trigger them.
              onKeyDown={(e) => e.stopPropagation()}
            />
          </form>
        </>
      )}

      {phase.name === "asking" && (
        <div className="max-ask-wait">
          {/* THE app orb — the six-oval sheet-glass OrbEngine from the
              toolbar's intel button, not a gradient stand-in — tinted to
              SYSTEM BLUE via --control-value-fill, the token the toggle's
              on-state uses, so the colour AND its light/dark handling are
              inherited from the one place that defines them. `analyzing`
              gives it the working motion. */}
          <span className="max-ask-orb" aria-hidden="true">
            <OrbEngine mode="default" analyzing size={18} flowScale={0.8}
              aberration={0.45} tint="--control-value-fill" />
          </span>
          {phase.label}
        </div>
      )}

      {phase.name === "done" && (
        <div className="max-ask-answer">
          {/* ★ LINE-BY-LINE REVEAL. Sentences stand in for lines (answers are
              two or three of them); each rises ~10px on a small-overshoot
              curve while its TEXT fades in faster than it travels — the words
              are legible mid-rise, which is the "characters go in first" read.
              Curve family: the widgetReveal grammar with a touch of bounce;
              stagger 90ms, inside the 120ms grouping window so it reads as one
              paragraph arriving, not three events. */}
          {/* ★ WORDS POUR, LINES RISE. Whole sentences moving as rigid slabs
              read stiff — the life is in the words leading their line by a few
              ms each, left to right, while the line settles under them. Delays
              are absolute (line 110ms + word 16ms) so the cascade reads as one
              gesture; the rise curve carries a real overshoot and the fade
              lands first, which is what "the text arrives before the motion
              finishes" feels like. */}
          <p className="max-ask-answer-text">
            {(phase.result.answer?.answer ?? "").split(/(?<=[.!?…])\s+/).map((line, li, lines) => (
              <span key={li} className="max-ask-line">
                {line.split(/\s+/).map((word, wi) => (
                  <span
                    key={wi}
                    className="max-ask-word"
                    style={{ animationDelay: `${li * 70 + wi * 9}ms` }}
                  >
                    {word}
                    {"\u00A0"}
                  </span>
                ))}
                {li < lines.length - 1 ? " " : ""}
              </span>
            ))}
          </p>
          {/* The check's result is VISIBLE either way — the user asked where
              it went, and the honest answer was "it never ran on this kind".
              Now it runs on every kind, and: an unlocated FACT gets the
              caution with the claim named; a clean check says so quietly, with
              the count, so "checked" can never mean "checked nothing". */}
          {phase.result.review?.verdict === "overreaches" && (
            <div className="max-ask-caution">
              self-check: "{phase.result.review.note}" is not in what it was given. Verify
              against the chapter
            </div>
          )}
          {phase.result.review?.verdict === "supported" && phase.result.review.facts > 0 && (
            <div className="max-ask-checked">
              checked · {phase.result.review.facts} fact{phase.result.review.facts === 1 ? "" : "s"} located in the story
            </div>
          )}
          {phase.result.answer?.basis === "fits" ? (
            <div className="max-ask-basis">fits the story · nothing conflicts</div>
          ) : phase.result.answer && RUNG_LABEL[phase.result.answer.basis] ? (
            <div className="max-ask-basis">from {RUNG_LABEL[phase.result.answer.basis]}</div>
          ) : null}
          {/* ★ The small indicator, not a warning: the refine pass exists so
              the writer RARELY sees a caution — a flagged answer was revised
              and re-verified before it got here. */}
          {phase.result.refined && (
            <div className="max-ask-refined">self-corrected · re-checked against the story</div>
          )}
          {/* An answer the loop had to break out of is still shown — best
              effort beats silence — but says so rather than passing as full. */}
          {phase.result.stopped !== "answered" && (
            <div className="max-ask-basis">best effort · context ran out</div>
          )}
          <button type="button" className="max-ask-again" onClick={() => setPhase({ name: "menu" })}>
            Ask something else
          </button>
        </div>
      )}

      {phase.name === "failed" && (
        <div className="max-ask-answer">
          <p className="max-ask-answer-text max-ask-answer-text--muted">
            {/* ★ "low-memory" is the guard doing its job, and it deserves its
                own words: "still loading, try again" sends the writer into a
                retry loop against a refusal that will not change until they
                free the memory. */}
            {/low-memory/.test(phase.reason ?? "")
              ? "Not enough free memory for the Max model right now. Close some other apps and try again."
              : /busy/.test(phase.reason ?? "")
                ? "The assistant is busy with another task. Try again in a few seconds."
                : "No answer this time. The model may still be loading; try again in a moment."}
          </p>
          <button type="button" className="max-ask-again" onClick={() => setPhase({ name: "menu" })}>
            Back
          </button>
        </div>
      )}
      </div>
    </div>
  );
}
