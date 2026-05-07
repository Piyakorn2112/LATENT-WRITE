import React, { memo, useMemo, type ReactNode, type CSSProperties } from "react";
import type { ChapterAnalysisResult } from "../lib/use-analysis";
import { buildSpeakerPalette, IOS_COLORS, getSpeakerColor, type ColorPair } from "../lib/palette";
import { findActionSentences, attributeActor, type ActionPrediction, type ActionSpan } from "../lib/action-detect";
import type { GrammarSuggestion } from "../lib/grammar-check";
import type { AnnotationTarget, AdaptivePredictionTrace } from "../types";

const NARRATIVE_COLOR = "#888888";
const ACTION_TEXT     = IOS_COLORS.orange.text;
const BASE_COLOR      = "var(--text-body)";

// Scene label tension colours — drawn from the same iOS-system palette
// used for entity highlights so they read with consistent saturation in
// both light and dark mode (the previous slate/amber/rose values washed
// out on light surfaces). The mapping is intentional, not arbitrary:
//   calm   → indigo (low-key, recedes)
//   rising → orange (warning warmth)
//   high   → red    (alarm)
const SCENE_T: Record<"calm" | "rising" | "high", string> = {
  calm:   IOS_COLORS.indigo.text,  // #4F45D8 — readable on white, vivid on dark
  rising: IOS_COLORS.orange.text,  // #DC7B19
  high:   IOS_COLORS.red.text,     // #D6363B
};

// Zero-size inline-block anchor that lets a child float above the paragraph's
// first line via `position:absolute` without contributing any width, height,
// or baseline shift to the surrounding text flow. Safe inside the mirror-div.
const SCENE_ANCHOR: CSSProperties = {
  display: "inline-block",
  width: 0,
  height: 0,
  overflow: "visible",
  verticalAlign: "baseline",
  position: "relative",
  pointerEvents: "none",
  userSelect: "none",
};

function sceneTagStyle(tension: "calm" | "rising" | "high"): CSSProperties {
  return {
    position: "absolute",
    left: 0,
    bottom: "3.15em", // floats into the inter-paragraph whitespace above
    whiteSpace: "nowrap",
    fontSize: "9px",
    lineHeight: 1,
    letterSpacing: "0.09em",
    fontFamily: "var(--font-ui)",
    fontWeight: 700,                 // slightly heavier so the iOS hue reads
    color: SCENE_T[tension],
    opacity: 0.85,                   // bumped from 0.65 — iOS palette is balanced for it
    textTransform: "uppercase",
    pointerEvents: "none",
    userSelect: "none",
  };
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Inline-level render: entity tags + grammar ghost text ─────────────────
//
// Walks `text` and emits ReactNodes, splitting at:
//   · entity-name occurrences  → <span class="entity-tag">
//   · grammar suggestion ranges → <span class="grammar-issue" data-suggestion>
// Grammar wins on overlap (the user should fix the typo before the entity
// match becomes meaningful again). Plain text uses `baseStyle`.
//
// `grammarLocal` contains text-relative ranges (already filtered to fit `text`).
function renderInline(
  text: string,
  speakerNames: string[],
  palette: Map<string, ColorPair>,
  baseStyle: CSSProperties,
  grammarLocal: GrammarSuggestion[],
  keyPrefix: string,
  onEntityClick?: (name: string, anchor: DOMRect) => void,
  annotationMode?: boolean,
): ReactNode[] {
  // Build a unified list of decoration ranges sorted by start.
  type Deco =
    | { kind: "entity"; start: number; end: number; matched: string }
    | { kind: "grammar"; start: number; end: number; suggestion: string; gkind: GrammarSuggestion["kind"] };

  const decos: Deco[] = [];

  if (speakerNames.length > 0) {
    const sorted = [...speakerNames].sort((a, b) => b.length - a.length).map(escapeRegex);
    const re = new RegExp(`\\b(?:${sorted.join("|")})\\b`, "gi");
    for (const m of text.matchAll(re)) {
      const idx = m.index ?? 0;
      decos.push({ kind: "entity", start: idx, end: idx + m[0].length, matched: m[0] });
    }
  }
  for (const g of grammarLocal) {
    decos.push({ kind: "grammar", start: g.start, end: g.end, suggestion: g.suggestion, gkind: g.kind });
  }

  // Sort by start; grammar wins ties so it sits in the layered order first.
  decos.sort((a, b) => a.start - b.start || (a.kind === "grammar" ? -1 : 1));

  // Drop any deco that overlaps an earlier one (grammar takes priority).
  const accepted: Deco[] = [];
  let lastEnd = -1;
  for (const d of decos) {
    if (d.start < lastEnd) continue;
    accepted.push(d);
    lastEnd = d.end;
  }

  const parts: ReactNode[] = [];
  let cursor = 0;
  let i = 0;

  for (const d of accepted) {
    if (d.start > cursor) {
      parts.push(
        <span key={`${keyPrefix}-t${i++}`} style={baseStyle}>
          {text.slice(cursor, d.start)}
        </span>,
      );
    }
    if (d.kind === "entity") {
      const matched = d.matched;
      const canonical = speakerNames.find(n => n.toLowerCase() === matched.toLowerCase()) ?? matched;
      const entityColor = getSpeakerColor(palette, canonical).text;
      parts.push(
        <span
          key={`${keyPrefix}-e${i++}`}
          className="entity-tag "
          style={{ "--entity-color": entityColor } as CSSProperties}
          onClick={onEntityClick ? (e) => {
            e.stopPropagation();
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onEntityClick(canonical, rect);
          } : undefined}
        >
          <div className="entity-tag-bg-sub" />
          <div className="entity-tag-bg" />
          {matched}
        </span>,
      );
    } else {
      // grammar
      // Style-kind spans (filter/passive/adverb/wordy/cliche) need pointer-events
      // so CSS :hover fires to reveal their ghost text. mousedown is cancelled to
      // keep textarea focus; click refocuses in case the browser moved it anyway.
      const isStyleKind =
        d.gkind === "filter" || d.gkind === "passive" || d.gkind === "adverb" ||
        d.gkind === "wordy" || d.gkind === "cliche";
      parts.push(
        <span
          key={`${keyPrefix}-g${i++}`}
          className="grammar-issue"
          data-suggestion={d.suggestion}
          data-kind={d.gkind}
          style={baseStyle}
          onMouseDown={isStyleKind ? (e) => e.preventDefault() : undefined}
          /* `.focus()` here is a backup for browsers that don't honour
             the mousedown preventDefault — keeps typing focus on the
             textarea when clicking a style underline mid-paragraph.
             In annotation mode the textarea is intentionally blurred
             (Editor.tsx) AND the speech/action spans wrap these
             grammar children, so the inner refocus would steal focus
             back to the textarea, scrolling the page to the textarea's
             top edge — that's the "click jumps to top" bug. Skip the
             refocus entirely in annotation mode. */
          onClick={isStyleKind && !annotationMode ? (e) => {
            (e.currentTarget as HTMLElement)
              .closest(".editor-wrap")
              ?.querySelector<HTMLTextAreaElement>("textarea")
              ?.focus();
          } : undefined}
        >
          {text.slice(d.start, d.end)}
        </span>,
      );
    }
    cursor = d.end;
  }

  if (cursor < text.length) {
    parts.push(
      <span key={`${keyPrefix}-t${i++}`} style={baseStyle}>
        {text.slice(cursor)}
      </span>,
    );
  }
  return parts;
}

// ─── Sentence-level render: wraps action sentences ─────────────────────────
//
// Splits `text` by action-sentence ranges, wrapping each in a tinted box.
// Inside each chunk (action or non-action), defers to `renderInline` so
// entity tags + grammar still work normally inside action sentences.
//
// Pass an empty `actionsLocal` to skip action wrapping (e.g. inside dialogue).
// `actorColor` is computed per action span by the caller (entity-in-text
// match → speaker; otherwise carrying speaker; otherwise null = grey default).
function renderActionable(
  text: string,
  actionsLocal: ActionSpan[],
  actionColors: (string | null)[],   // parallel to actionsLocal — hex colours
  actionActors: (string | null)[],   // parallel to actionsLocal — character NAMES
  actionOverrideFlags: boolean[],    // parallel to actionsLocal — true if annotation override
  actionReviewFlags: boolean[],      // parallel to actionsLocal — true if confidence is low
  speakerNames: string[],
  palette: Map<string, ColorPair>,
  baseStyle: CSSProperties,
  grammarLocal: GrammarSuggestion[],
  keyPrefix: string,
  onEntityClick?: (name: string, anchor: DOMRect) => void,
  onActionClick?: (localActionIndex: number, text: string, actor: string | null, anchor: DOMRect) => void,
  annotationMode?: boolean,
): ReactNode[] {
  if (actionsLocal.length === 0) {
    return renderInline(text, speakerNames, palette, baseStyle, grammarLocal, keyPrefix, onEntityClick, annotationMode);
  }

  const parts: ReactNode[] = [];
  let cursor = 0;
  let i = 0;

  for (const a of actionsLocal) {
    if (a.start > cursor) {
      const chunk = text.slice(cursor, a.start);
      const grammarChunk = sliceGrammar(grammarLocal, cursor, a.start);
      parts.push(
        <span key={`${keyPrefix}-pre${i}`}>
          {renderInline(chunk, speakerNames, palette, baseStyle, grammarChunk, `${keyPrefix}-pre${i}`, onEntityClick, annotationMode)}
        </span>,
      );
    }
    const chunk = text.slice(a.start, a.end);
    const grammarChunk = sliceGrammar(grammarLocal, a.start, a.end);
    const actor = actionActors[i] ?? null;
    const colorVal = actionColors[i] ?? null;
    const hasOvr = actionOverrideFlags[i] ?? false;
    const needsReview = actionReviewFlags[i] ?? false;
    const apStyle: CSSProperties | undefined = colorVal
      ? ({ "--ap-color": colorVal } as CSSProperties)
      : undefined;
    // IMPORTANT: capture `i` as a const to avoid the classic closure-in-a-loop
    // bug — `let i` is shared across iterations so by click time it would be
    // `actionsLocal.length`, not the current index.
    const actionIdx = i;
    parts.push(
      <React.Fragment key={`${keyPrefix}-actgrp${i}`}>
        <span
          className={`action-phrase${onActionClick ? " action-annotatable" : ""}${hasOvr ? " annotation-tagged" : ""}${needsReview ? " prediction-needs-review" : ""}`}
          style={apStyle}
          onClick={onActionClick ? (e) => {
            e.stopPropagation();
            onActionClick(actionIdx, chunk, actor, (e.currentTarget as HTMLElement).getBoundingClientRect());
          } : undefined}
        >
          {renderInline(chunk, speakerNames, palette, baseStyle, grammarChunk, `${keyPrefix}-act${i}`, onEntityClick, annotationMode)}
        </span>
        {hasOvr && renderAnnotationPill(`${keyPrefix}-act${i}`, actor, colorVal || "var(--text-secondary)", "action")}
      </React.Fragment>,
    );
    cursor = a.end;
    i++;
  }

  if (cursor < text.length) {
    const chunk = text.slice(cursor);
    const grammarChunk = sliceGrammar(grammarLocal, cursor, text.length);
    parts.push(
      <span key={`${keyPrefix}-post${i}`}>
        {renderInline(chunk, speakerNames, palette, baseStyle, grammarChunk, `${keyPrefix}-post${i}`, onEntityClick, annotationMode)}
      </span>,
    );
  }
  return parts;
}

function renderAnnotationPillContent(label: string | null | undefined): ReactNode {
  return (
    <>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>
      <span className="annotation-pill-tag-name">{label ?? "none"}</span>
    </>
  );
}

function renderAnnotationPill(
  keyPrefix: string,
  label: string | null | undefined,
  color: string,
  variant: "speech" | "action",
): ReactNode {
  return (
    <span key={`${keyPrefix}-pill`} className={`annotation-pill-slot annotation-pill-slot--${variant}`} aria-hidden="true">
      <span className="annotation-pill-tag" style={{ color }}>
        {renderAnnotationPillContent(label)}
      </span>
    </span>
  );
}

// Slice a grammar list to text-relative offsets, restricted to [from, to].
function sliceGrammar(
  list: GrammarSuggestion[],
  from: number,
  to: number,
): GrammarSuggestion[] {
  const out: GrammarSuggestion[] = [];
  for (const g of list) {
    if (g.end <= from || g.start >= to) continue;
    if (g.start < from || g.end > to) continue; // skip partial overlaps for simplicity
    out.push({ ...g, start: g.start - from, end: g.end - from });
  }
  return out;
}

// ─── Paragraph position resolution (color persistence strategy) ────────────
//
// matched=true  → render with full speech colours at the located position.
// matched=false → that paragraph has been edited and no longer appears verbatim;
//                 its slot is filled with whatever current content sits between
//                 surrounding matched paragraphs, rendered as plain text.
//
// Edits to ONE paragraph don't strip colour from the others. Only the
// actively-edited paragraph reverts to plain text until analysis catches up.
interface ParaPos { start: number; end: number; matched: boolean; }

function mapPositions(content: string, paragraphs: string[]): ParaPos[] {
  const out: ParaPos[] = [];
  let from = 0;
  for (const p of paragraphs) {
    const i = content.indexOf(p, from);
    if (i >= 0) {
      out.push({ start: i, end: i + p.length, matched: true });
      from = i + p.length;
    } else {
      out.push({ start: from, end: from, matched: false });
    }
  }
  for (let i = 0; i < out.length; i++) {
    if (out[i].matched) continue;
    let nextStart = content.length;
    for (let j = i + 1; j < out.length; j++) {
      if (out[j].matched) { nextStart = out[j].start; break; }
    }
    const sep = nextStart >= 2 ? 2 : 0;
    out[i].end = Math.max(out[i].start, nextStart - sep);
  }
  return out;
}

interface Props {
  content: string;
  paragraphs: string[];
  visible?: boolean;
  speechResults: ChapterAnalysisResult["speechResults"];
  knownNames?: string[];
  /** Grammar suggestions over the FULL `content` (absolute offsets). */
  grammarSuggestions?: GrammarSuggestion[];
  onEntityClick?: (name: string, anchor: DOMRect) => void;
  /** When true, speech and action spans are clickable to open the annotation popover. */
  annotationMode?: boolean;
  onSpeechAnnotate?: (info: AnnotationTarget, anchor: DOMRect) => void;
  onActionAnnotate?: (info: AnnotationTarget, anchor: DOMRect) => void;
  /** Mapping of "paragraphIndex-spanIndex-spanType" → corrected speaker name (or null for narrative).
   *  Applied immediately to highlight layer so corrections are visible before re-analysis. */
  annotationOverrides?: Map<string, string | null>;
  speechPredictions?: AdaptivePredictionTrace[];
  actionPredictions?: ActionPrediction[][];
}

function HighlightLayerImpl({
  content, paragraphs, speechResults, knownNames, visible = true,
  grammarSuggestions = [], onEntityClick, annotationMode, onSpeechAnnotate, onActionAnnotate,
  annotationOverrides, speechPredictions, actionPredictions,
}: Props) {
  // Building the highlight nodes is the heavy bit (string indexOf per
  // paragraph + per-segment span construction + grammar slicing). Memoising
  // here means the work runs only when content/paragraphs/grammar actually
  // change, not on every parent re-render — and combined with React.memo
  // and the editor's `useDeferredValue` on content it runs at low priority.
  const nodes = useMemo<ReactNode[]>(() => {
    if (!paragraphs.length || !content) return [];

    const positions = mapPositions(content, paragraphs);
    const out: ReactNode[] = [];
    let cursor = 0;

    const speakerSet = new Set<string>();
    for (const r of speechResults) {
      for (const s of r?.segments ?? []) {
        if (s.speaker) speakerSet.add(s.speaker);
      }
    }
    for (const n of knownNames ?? []) speakerSet.add(n);
    // Also include any corrected speaker names from annotation overrides so they
    // get a deterministic palette entry (colour) rather than the grey fallback.
    if (annotationOverrides) {
      for (const name of annotationOverrides.values()) {
        if (name) speakerSet.add(name);
      }
    }
    const speakerNames = [...speakerSet];

    const palette = buildSpeakerPalette(speakerNames);
    const speechPredictionMap = new Map<string, AdaptivePredictionTrace>();
    for (const prediction of speechPredictions ?? []) {
      speechPredictionMap.set(`${prediction.paragraphIndex}-${prediction.spanIndex}`, prediction);
    }
    const actionPredictionMap = new Map<string, ActionPrediction>();
    for (let pi = 0; pi < (actionPredictions?.length ?? 0); pi++) {
      for (const prediction of actionPredictions?.[pi] ?? []) {
        actionPredictionMap.set(`${pi}-${prediction.start}`, prediction);
      }
    }
    const resolvedActionActorCache = new Map<string, string | null>();

    // Carrying speaker: the most recent attributed speaker (confidence ≥ 0.65).
    let carryingSpeaker: string | null = null;

    const resolveActionActor = (paraIndex: number, paraText: string, as: number, ae: number): string | null => {
      const cacheKey = `${paraIndex}-${as}-${ae}-${carryingSpeaker ?? ""}`;
      if (resolvedActionActorCache.has(cacheKey)) {
        return resolvedActionActorCache.get(cacheKey) ?? null;
      }
      const predicted = actionPredictionMap.get(`${paraIndex}-${as}`);
      const actor = predicted?.actor ?? attributeActor(paraText.slice(as, ae), speakerNames, carryingSpeaker);
      resolvedActionActorCache.set(cacheKey, actor ?? null);
      return actor ?? null;
    };

    const actorColor = (paraIndex: number, paraText: string, as: number, ae: number): string | null => {
      const actor = resolveActionActor(paraIndex, paraText, as, ae);
      return actor ? getSpeakerColor(palette, actor).text : null;
    };

    /** Return the attributed actor NAME (not colour) for a given action slice. */
    const actorName = (paraIndex: number, paraText: string, as: number, ae: number): string | null => {
      return resolveActionActor(paraIndex, paraText, as, ae);
    };

    for (let pi = 0; pi < paragraphs.length; pi++) {
      const pos       = positions[pi];
      const paraStart = pos.start;
      const paraEnd   = pos.end;
      const para      = paragraphs[pi];
      const segs      = speechResults[pi]?.segments ?? [];
      const meta      = speechResults[pi]?.meta;

      // Gap (newlines / freshly-typed text) before this paragraph's slot.
      if (paraStart > cursor) {
        const gapText = content.slice(cursor, paraStart);
        const grammarGap = sliceGrammar(grammarSuggestions, cursor, paraStart);
        out.push(
          <span key={`gap${pi}`}>
            {renderInline(gapText, speakerNames, palette, { color: BASE_COLOR },
              grammarGap, `gap${pi}`, onEntityClick, annotationMode)}
          </span>,
        );
      }

      if (!pos.matched) {
        // Stale paragraph: render the corresponding slice of CURRENT content as
        // plain text. Other paragraphs keep their colours.
        const sliceText = content.slice(paraStart, paraEnd);
        const grammarSlice = sliceGrammar(grammarSuggestions, paraStart, paraEnd);
        out.push(
          <span key={`para${pi}-stale`}>
            {renderInline(sliceText, speakerNames, palette, { color: BASE_COLOR },
              grammarSlice, `para${pi}-stale`, onEntityClick, annotationMode)}
          </span>,
        );
        cursor = paraEnd;
        continue;
      }

      // Action sentences are detected paragraph-locally (offsets relative to para).
      const paraActions = findActionSentences(para);
      // Grammar for THIS paragraph, shifted to para-relative.
      const paraGrammar = sliceGrammar(grammarSuggestions, paraStart, paraEnd);

      const paraNodes: ReactNode[] = [];

      const sorted = [...segs].sort((a, b) => a.start - b.start);
      let pc = 0;

      for (let segIndex = 0; segIndex < sorted.length; segIndex++) {
        const seg = sorted[segIndex];
        // Non-speech gap before this segment — eligible for action wrapping.
        if (seg.start > pc) {
          const gapText = para.slice(pc, seg.start);
          const gapActions = clipSpans(paraActions, pc, seg.start);
          const gapGrammar = clipGrammar(paraGrammar, pc, seg.start);
          const gapColors = gapActions.map((a: ActionSpan) => {
            const paraRelStart = a.start + pc;
            const overrideKey = `${pi}-${paraRelStart}-action`;
            if (annotationOverrides?.has(overrideKey)) {
              const overriddenActor = annotationOverrides.get(overrideKey);
              return overriddenActor ? getSpeakerColor(palette, overriddenActor).text : null;
            }
            return actorColor(pi, para, paraRelStart, a.end + pc);
          });
          const gapActors = gapActions.map((a: ActionSpan) => {
            const paraRelStart = a.start + pc;
            const overrideKey = `${pi}-${paraRelStart}-action`;
            if (annotationOverrides?.has(overrideKey)) {
              return annotationOverrides.get(overrideKey) ?? null;
            }
            return actorName(pi, para, paraRelStart, a.end + pc);
          });
          const gapOverrideFlags = gapActions.map((a: ActionSpan) => {
            const paraRelStart = a.start + pc;
            return !!annotationOverrides?.has(`${pi}-${paraRelStart}-action`);
          });
          const gapReviewFlags = gapActions.map((a: ActionSpan) => {
            const paraRelStart = a.start + pc;
            return actionPredictionMap.get(`${pi}-${paraRelStart}`)?.needsReview ?? false;
          });
          paraNodes.push(
            <span key={`bp${seg.start}`}>
              {renderActionable(gapText, gapActions, gapColors, gapActors, gapOverrideFlags, gapReviewFlags, speakerNames, palette,
                { color: BASE_COLOR }, gapGrammar, `bp${pi}-${seg.start}`, onEntityClick,
                annotationMode && onActionAnnotate
                  ? (localIdx, text, actor, anchor) => {
                      const paraRelStart = gapActions[localIdx]?.start + pc;
                      onActionAnnotate({
                        paragraphIndex: pi,
                        spanIndex: paraRelStart,
                        spanType: "action",
                        currentSpeaker: actor,
                        spanText: text,
                        contextBefore: para.slice(Math.max(0, paraRelStart - 80), paraRelStart),
                        contextAfter: para.slice(paraRelStart + text.length, Math.min(para.length, paraRelStart + text.length + 80)),
                      }, anchor);
                    }
                  : undefined,
                annotationMode,
              )}
            </span>,
          );
        }
        const speechOverrideKey = `${pi}-${segIndex}-speech`;
        const speechPrediction = speechPredictionMap.get(`${pi}-${segIndex}`);
        const effectiveSpeaker = annotationOverrides?.has(speechOverrideKey)
          ? annotationOverrides.get(speechOverrideKey)
          : seg.speaker;
        // Update carrying speaker AFTER resolving overrides so subsequent
        // action gaps colour from the corrected speaker, not the raw one.
        if (seg.type === "speech" && seg.confidence >= 0.65) {
          carryingSpeaker = (effectiveSpeaker ?? seg.speaker) || carryingSpeaker;
        }
        const color =
          seg.type === "narrative"
            ? NARRATIVE_COLOR
            : effectiveSpeaker
            ? getSpeakerColor(palette, effectiveSpeaker).text
            : ACTION_TEXT;

        const segText = para.slice(seg.start, seg.end);
        const isAnnotatable = seg.type === "speech" || seg.type === "narrative";
        const segStyle: CSSProperties = {
          color,
          fontStyle: seg.type === "narrative" ? "italic" : undefined,
          cursor: annotationMode && isAnnotatable ? "pointer" : undefined,
        };
        const segGrammar = clipGrammar(paraGrammar, seg.start, seg.end);
        // Build speech/narrative annotation click handler
        const segSpeechOnClick =
          annotationMode && isAnnotatable && onSpeechAnnotate
            ? (segIdx: number) => (e: React.MouseEvent) => {
                e.stopPropagation();
                onSpeechAnnotate({
                  paragraphIndex: pi,
                  spanIndex: segIdx,
                  spanType: "speech",
                  currentSpeaker: seg.speaker ?? null,
                  spanText: segText,
                  contextBefore: para.slice(Math.max(0, seg.start - 80), seg.start),
                  contextAfter: para.slice(seg.end, Math.min(para.length, seg.end + 80)),
                }, (e.currentTarget as HTMLElement).getBoundingClientRect());
              }
            : undefined;
        // Check if this span has an active annotation override
        const hasOverride = annotationOverrides?.has(speechOverrideKey) && isAnnotatable;
        const overrideName = hasOverride ? annotationOverrides!.get(speechOverrideKey) : undefined;

        // segIndex already computed above (reused for override lookup)
        paraNodes.push(
          <React.Fragment key={`sggrp${seg.start}`}>
            <span
              className={`${annotationMode && isAnnotatable ? "speech-annotatable" : ""}${hasOverride ? " annotation-tagged" : ""}${speechPrediction?.needsReview ? " prediction-needs-review" : ""}`}
              onClick={segSpeechOnClick ? segSpeechOnClick(segIndex) : undefined}
            >
              {renderInline(segText, speakerNames, palette, segStyle,
                segGrammar, `sg${pi}-${seg.start}`, onEntityClick, annotationMode)}
            </span>
            {hasOverride && renderAnnotationPill(`sg${pi}-${seg.start}`, overrideName, color, "speech")}
          </React.Fragment>,
        );
        pc = seg.end;
      }

      if (pc < para.length) {
        const tailText = para.slice(pc);
        const tailActions = clipSpans(paraActions, pc, para.length);
        const tailGrammar = clipGrammar(paraGrammar, pc, para.length);
        const tailColors = tailActions.map((a: ActionSpan) => {
          const paraRelStart = a.start + pc;
          const overrideKey = `${pi}-${paraRelStart}-action`;
          if (annotationOverrides?.has(overrideKey)) {
            const overriddenActor = annotationOverrides.get(overrideKey);
            return overriddenActor ? getSpeakerColor(palette, overriddenActor).text : null;
          }
          return actorColor(pi, para, paraRelStart, a.end + pc);
        });
        const tailActors = tailActions.map((a: ActionSpan) => {
          const paraRelStart = a.start + pc;
          const overrideKey = `${pi}-${paraRelStart}-action`;
          if (annotationOverrides?.has(overrideKey)) {
            return annotationOverrides.get(overrideKey) ?? null;
          }
          return actorName(pi, para, paraRelStart, a.end + pc);
        });
        const tailOverrideFlags = tailActions.map((a: ActionSpan) => {
          const paraRelStart = a.start + pc;
          return !!annotationOverrides?.has(`${pi}-${paraRelStart}-action`);
        });
        const tailReviewFlags = tailActions.map((a: ActionSpan) => {
          const paraRelStart = a.start + pc;
          return actionPredictionMap.get(`${pi}-${paraRelStart}`)?.needsReview ?? false;
        });
        paraNodes.push(
          <span key="tail">
            {renderActionable(tailText, tailActions, tailColors, tailActors, tailOverrideFlags, tailReviewFlags, speakerNames, palette,
              { color: BASE_COLOR }, tailGrammar, `tail${pi}`, onEntityClick,
              annotationMode && onActionAnnotate
                ? (localIdx, text, actor, anchor) => {
                    const paraRelStart = tailActions[localIdx]?.start + pc;
                    onActionAnnotate({
                      paragraphIndex: pi,
                      spanIndex: paraRelStart,
                      spanType: "action",
                      currentSpeaker: actor,
                      spanText: text,
                      contextBefore: para.slice(Math.max(0, paraRelStart - 80), paraRelStart),
                      contextAfter: para.slice(paraRelStart + text.length, Math.min(para.length, paraRelStart + text.length + 80)),
                    }, anchor);
                  }
                : undefined,
              annotationMode,
            )}
          </span>,
        );
      }

      const tension = meta?.sceneTension ?? "calm";
      out.push(
        <span key={`para${pi}`}>
          {meta?.sceneStart && meta.sceneLabel && (
            <span aria-hidden="true" style={SCENE_ANCHOR}>
              <span style={sceneTagStyle(tension)}>| {meta.sceneLabel}</span>
            </span>
          )}
          {paraNodes}
        </span>
      );
      cursor = paraEnd;
    }

    if (cursor < content.length) {
      const trailText = content.slice(cursor);
      const trailGrammar = sliceGrammar(grammarSuggestions, cursor, content.length);
      out.push(
        <span key="trail">
          {renderInline(trailText, speakerNames, palette, { color: BASE_COLOR },
            trailGrammar, "trail", onEntityClick, annotationMode)}
        </span>,
      );
    }

    return out;
  }, [content, paragraphs, speechResults, knownNames, grammarSuggestions, onEntityClick, annotationMode, onSpeechAnnotate, onActionAnnotate, annotationOverrides, speechPredictions, actionPredictions]);

  if (nodes.length === 0) return null;

  return (
    <div
      className="editor-highlight"
      aria-hidden="true"
      style={{ opacity: visible ? 1 : 0, transition: "opacity 0.25s ease", pointerEvents: visible ? undefined : "none" }}
    >
      {nodes}
    </div>
  );
}

export const HighlightLayer = memo(HighlightLayerImpl);

// Clip an ActionSpan list to a [from, to] window, returning ranges
// shifted to be relative to `from`. Spans that don't fully fit are dropped.
function clipSpans(spans: ActionSpan[], from: number, to: number): ActionSpan[] {
  const out: ActionSpan[] = [];
  for (const s of spans) {
    if (s.end <= from || s.start >= to) continue;
    if (s.start < from || s.end > to) continue;
    out.push({ start: s.start - from, end: s.end - from });
  }
  return out;
}
function clipGrammar(list: GrammarSuggestion[], from: number, to: number): GrammarSuggestion[] {
  const out: GrammarSuggestion[] = [];
  for (const g of list) {
    if (g.end <= from || g.start >= to) continue;
    if (g.start < from || g.end > to) continue;
    out.push({ ...g, start: g.start - from, end: g.end - from });
  }
  return out;
}
