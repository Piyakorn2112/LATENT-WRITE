import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "./Icon";
import {
  emptyWorldData,
  scanAndClassify,
  type ScanProgress,
  type ScanResult,
} from "../lib/world-data";
import { loadPrefs } from "../lib/preferences";
import { assistantAvailable, assistantRunJSON, cancelWhere } from "../lib/assistant-client";
import {
  ENTITY_REVIEW_TASK,
  applyProposalsToScanResult,
  reviewEntities,
  selectReviewable,
  type EntityReviewChange,
  type EntityReviewEntry,
} from "../lib/entity-review";
import type { AdaptivePredictionTrace, Novel, WorldData } from "../types";

/**
 * CastConfirmOverlay — the cold-start moment.
 *
 * Shown once per manuscript, when chapters exist but no world data has been
 * curated. The app shows the people it believes it found (with mention counts
 * and a line of their dialogue as evidence) and asks a single question:
 * "is this your cast?". Confirming writes worldData.characters — the ground
 * truth that speaker attribution and entity highlighting feed on — and files
 * the detected places / factions alongside. Thirty seconds of the writer's
 * time replaces an unsolvable cold-start inference problem.
 *
 * Composition reuses the WidgetConfigOverlay chrome (wc-overlay / wc-panel /
 * wc-row) so the screen inherits the glass panel, specular ring, and row
 * interactions without any new styling.
 */

interface CastCandidate {
  name: string;
  /** Short forms folded into this candidate (e.g. "Tessa" → "Tessa Mosswell"). */
  aliases: string[];
  mentions: number;
  /** A short dialogue line attributed near the name, or a sentence fragment. */
  evidence: string | null;
  checked: boolean;
}

interface Props {
  novel: Novel;
  onConfirm: (worldData: WorldData) => void;
  onSkip: () => void;
}

// ─── Evidence gathering (cheap, capped) ────────────────────────────────────

const EVIDENCE_TEXT_CAP = 400_000; // chars of manuscript scanned for evidence
const EVIDENCE_MAX_LEN = 64;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary mention count (same manual boundary approach as renameInText). */
function countMentions(text: string, name: string): number {
  const re = new RegExp(
    `(^|[^A-Za-z0-9_'\\u00C0-\\u024F])${escapeRe(name)}(?=$|[^A-Za-z0-9_'\\u00C0-\\u024F])`,
    "g",
  );
  let n = 0;
  while (re.exec(text) !== null) n++;
  return n;
}

/**
 * Counts occurrences that are NOT sentence-initial or quote-initial. Real
 * names show up mid-sentence constantly ("said Mira", "with Gareth"); words
 * that are only capitalized because they open a sentence or a line of
 * dialogue ("Come", "Alright") score ~0 here. This is the cheap signal that
 * separates people from capitalization artifacts.
 */
function countMidSentenceMentions(text: string, name: string): number {
  const re = new RegExp(
    `(^|[^A-Za-z0-9_'\\u00C0-\\u024F])${escapeRe(name)}(?=$|[^A-Za-z0-9_'\\u00C0-\\u024F])`,
    "g",
  );
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Walk back over whitespace from the match start to the previous glyph.
    let i = m.index + m[1].length - 1;
    while (i >= 0 && (text[i] === " " || text[i] === "\t")) i--;
    if (i < 0) continue; // text start
    const prev = text[i];
    // Sentence/dialogue openers don't count; anything else is mid-sentence.
    if ('.!?\n"“”\'‘’—*'.includes(prev)) continue;
    n++;
  }
  return n;
}

/**
 * Finds a short dialogue line spoken near the name — the proof the app has
 * actually read the book. Prefers `"…" Name said` / `Name said "…"` shapes,
 * falls back to the first sentence containing the name.
 */
function findEvidence(text: string, name: string): string | null {
  const esc = escapeRe(name);
  const quote = `[“"]([^”"\n]{2,${EVIDENCE_MAX_LEN}})[”"]`;
  const attributions = [
    new RegExp(`${quote}[^\n]{0,24}\\b${esc}\\b`, "gm"),
    new RegExp(`\\b${esc}\\b[^\n“"]{0,32}${quote}`, "gm"),
  ];
  // Prefer a quote with some substance (3+ words) over fragments like
  // “well” — scan a handful of matches before settling for the first one.
  let fallback: string | null = null;
  for (const re of attributions) {
    let m: RegExpExecArray | null;
    let scanned = 0;
    while ((m = re.exec(text)) !== null && scanned < 12) {
      scanned++;
      const q = m[1]?.trim();
      if (!q) continue;
      if (q.split(/\s+/).length >= 3) return `“${q}”`;
      if (!fallback) fallback = `“${q}”`;
    }
  }
  if (fallback) return fallback;
  // Fallback: first sentence mentioning the name, trimmed.
  const sentence = new RegExp(`[^.!?\n]{0,${EVIDENCE_MAX_LEN}}\\b${esc}\\b[^.!?\n]{0,${EVIDENCE_MAX_LEN}}[.!?]`);
  const m = sentence.exec(text);
  if (m) {
    const s = m[0].trim();
    return s.length > EVIDENCE_MAX_LEN * 2 ? null : s;
  }
  return null;
}

/** True when the evidence is a quoted dialogue line (vs a narration fallback). */
const isDialogueEvidence = (evidence: string | null): boolean =>
  !!evidence && evidence.startsWith("“");

// ─── Candidate quality gates ───────────────────────────────────────────────
//
// The classifier's character bucket is deliberately forgiving (its normal
// consumer is the World panel's manual review). This screen is one-click, so
// it gates harder:
//  · article-led names ("The Pale Office") are never people — drop here, the
//    scan already filed real places/factions in their own buckets
//  · a display floor keeps one-off capitalized words out of the list
//  · default-check only what either SPEAKS in the text or recurs heavily —
//    everything else stays visible but unchecked for the writer to opt in

const DISPLAY_MIN_MENTIONS = 5;
const DISPLAY_CAP = 24;
const AUTOCHECK_MIN_MENTIONS = 12;
const ARTICLE_RE = /^(the|a|an)\s/i;

/**
 * Folds single-word short forms into the multi-word candidate whose FIRST
 * token matches ("Tessa" → "Tessa Mosswell", mentions summed, short form kept
 * as an alias). Last-token matches are deliberately NOT merged — a bare
 * family name ("Vell" beside "Anwen Vell" and "Goodman Vell") is its own,
 * usually collective, reference.
 */
function mergeShortForms(
  candidates: Array<{ name: string; mentions: number; evidence: string | null }>,
): Array<{ name: string; aliases: string[]; mentions: number; evidence: string | null }> {
  const singles = candidates.filter((c) => !c.name.includes(" "));
  const multis = candidates.filter((c) => c.name.includes(" "));
  const merged = new Map(
    multis.map((c) => [c.name, { ...c, aliases: [] as string[] }]),
  );
  const out: Array<{ name: string; aliases: string[]; mentions: number; evidence: string | null }> = [];

  for (const s of singles) {
    const hosts = multis.filter(
      (m) => m.name.split(" ")[0].toLowerCase() === s.name.toLowerCase(),
    );
    if (hosts.length === 1) {
      const host = merged.get(hosts[0].name)!;
      host.aliases.push(s.name);
      host.mentions += s.mentions;
      if (!host.evidence) host.evidence = s.evidence;
    } else {
      out.push({ ...s, aliases: [] });
    }
  }
  return [...out, ...merged.values()];
}

// ─── Assistant refinement of the scan (invisible) ──────────────────────────
//
// The cold-start screen is exactly where a laundered name hurts most: whatever
// lands in the character bucket here becomes the manuscript's ground truth. So
// after the deterministic scan finishes, the local model is handed ONLY the
// names the scan itself flagged as uncertain, sees two ±140-char snippets of
// each, and may move them between buckets or drop them as "not-a-name". The
// writer sees a better list and nothing else. The deterministic result is
// first-class — it is what ships whenever the assistant is off, absent, slow,
// or wrong-shaped.
//
// The same three helpers exist in WorldDataView.tsx. They are duplicated
// rather than shared because these two scan surfaces are the only consumers
// and neither owns the other.

/** Share of the progress bar the deterministic scan keeps when a review may
 *  follow; the review coda owns the rest. Never reached in browser mode. */
const REVIEW_PROGRESS_SPLIT = 0.9;

/** The half of the gate that is knowable synchronously, before the scan starts.
 *  False in the browser build, which is what keeps that path unchanged. */
function assistantMayReview(): boolean {
  try {
    return (
      loadPrefs().assistant?.enabled === true &&
      typeof window !== "undefined" &&
      !!window.electronAPI
    );
  } catch {
    return false;
  }
}

const REVIEWABLE_TYPES = new Set(["character", "place", "faction", "entity"]);

/** Scan traces → review entries. The scan's own uncertainty rides along;
 *  `selectReviewable` (not this) decides what is worth a model run. */
function reviewEntriesFromTraces(
  traces: readonly AdaptivePredictionTrace[],
): EntityReviewEntry[] {
  const seen = new Set<string>();
  const entries: EntityReviewEntry[] = [];
  for (const trace of traces) {
    const name = trace.spanText;
    const label = trace.predictedLabel;
    if (!name || seen.has(name) || !label || !REVIEWABLE_TYPES.has(label)) continue;
    seen.add(name);
    entries.push({
      name,
      currentType: label as EntityReviewEntry["currentType"],
      needsReview: trace.needsReview,
      ambiguityGap: trace.ambiguityGap,
    });
  }
  return entries;
}

/**
 * Never throws, never rejects, never blocks the scan on the model: every exit
 * that is not a clean set of proposals returns the scan untouched.
 *
 * `text` is the scanned span in full, but only `usageSnippets` reads it — the
 * model is sent two short windows per name, never the manuscript.
 */
async function refineScanWithAssistant(
  scan: ScanResult,
  traces: readonly AdaptivePredictionTrace[],
  text: string,
  signal: AbortSignal,
  onReviewProgress: (done: number, total: number) => void,
): Promise<{ scan: ScanResult; changes: EntityReviewChange[] }> {
  const untouched = { scan, changes: [] as EntityReviewChange[] };
  try {
    if (!(await assistantAvailable()) || signal.aborted) return untouched;
    const selected = selectReviewable(reviewEntriesFromTraces(traces));
    if (selected.length === 0) return untouched;

    let done = 0;
    onReviewProgress(done, selected.length);
    const proposals = await reviewEntities(
      { entries: selected, text },
      {
        run: assistantRunJSON,
        isCancelled: () => signal.aborted,
        onProposal: () => onReviewProgress((done += 1), selected.length),
      },
    );
    if (signal.aborted || proposals.length === 0) return untouched;
    return applyProposalsToScanResult(scan, proposals);
  } catch {
    return untouched;
  }
}

// ─── Component ─────────────────────────────────────────────────────────────

type Phase = "scanning" | "review";

function CastConfirmOverlayInner({ novel, onConfirm, onSkip }: Props) {
  const [phase, setPhase] = useState<Phase>("scanning");
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [candidates, setCandidates] = useState<CastCandidate[]>([]);
  const scanResultRef = useRef<ScanResult | null>(null);

  // Escape = skip (same dismissal contract as every wc overlay).
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onSkip();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onSkip]);

  // Classification scan — same rAF-after-paint + abort pattern as
  // WorldDataView so the loading state renders before heavy work starts.
  useEffect(() => {
    let raf1 = 0;
    let raf2 = 0;
    const controller = new AbortController();
    const scanTexts = novel.chapters.map((c) => c.content);
    // Decided before the first byte is scanned so the progress readout can
    // leave room for the review coda instead of jumping backwards from 100%.
    const mayReview = assistantMayReview();

    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        void (async () => {
          const predictionTraceOut: { value: AdaptivePredictionTrace[] } = { value: [] };
          const reportReview = (done: number, total: number) =>
            setProgress({
              stage: "classify",
              label: "Reviewing ambiguous names",
              detail: `Name ${Math.min(done + 1, total)} / ${total}`,
              completed: done,
              total,
              fraction:
                REVIEW_PROGRESS_SPLIT +
                (1 - REVIEW_PROGRESS_SPLIT) * (done / Math.max(1, total)),
            });
          try {
            const scanned = await scanAndClassify(scanTexts, emptyWorldData(), 2, {
              predictionTraceOut,
              onProgress: mayReview
                ? (progress) =>
                    setProgress({
                      ...progress,
                      fraction: progress.fraction * REVIEW_PROGRESS_SPLIT,
                    })
                : setProgress,
              signal: controller.signal,
            });
            if (controller.signal.aborted) return;

            const results = mayReview
              ? (
                  await refineScanWithAssistant(
                    scanned,
                    predictionTraceOut.value,
                    scanTexts.join("\n\n"),
                    controller.signal,
                    reportReview,
                  )
                ).scan
              : scanned;
            if (controller.signal.aborted) return;
            scanResultRef.current = results;

            const fullText = scanTexts.join("\n");
            const evidenceText = fullText.slice(0, EVIDENCE_TEXT_CAP);
            const scored = results.characters
              .filter((name) => !ARTICLE_RE.test(name))
              .filter((name) => countMidSentenceMentions(fullText, name) >= 2)
              .map((name) => ({
                name,
                mentions: countMentions(fullText, name),
                evidence: findEvidence(evidenceText, name),
              }));
            const ranked = mergeShortForms(scored)
              .filter((c) => c.mentions >= DISPLAY_MIN_MENTIONS)
              .sort((a, b) => b.mentions - a.mentions)
              .slice(0, DISPLAY_CAP)
              .map((c) => ({
                ...c,
                checked:
                  isDialogueEvidence(c.evidence) ||
                  c.mentions >= AUTOCHECK_MIN_MENTIONS,
              }));
            setCandidates(ranked);
            setPhase("review");
          } catch (error) {
            if ((error as Error)?.name !== "AbortError") {
              console.error(error);
              onSkip(); // never trap the writer behind a failed scan
            }
          }
        })();
      });
    });
    return () => {
      controller.abort();
      // `isCancelled` stops the loop between names; this releases the request
      // already in flight so a dismissed overlay cannot hold the single-flight
      // queue.
      if (mayReview) cancelWhere((job) => job.task === ENTITY_REVIEW_TASK);
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
    // Runs once for the mount's novel snapshot — the overlay is shown for a
    // just-loaded manuscript, not kept live across edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = useCallback((name: string) => {
    setCandidates((prev) =>
      prev.map((c) => (c.name === name ? { ...c, checked: !c.checked } : c)),
    );
  }, []);

  const checkedCount = useMemo(
    () => candidates.filter((c) => c.checked).length,
    [candidates],
  );

  const otherCounts = useMemo(() => {
    const r = scanResultRef.current;
    if (!r) return null;
    const parts: string[] = [];
    if (r.places.length) parts.push(`${r.places.length} place${r.places.length === 1 ? "" : "s"}`);
    if (r.factions.length) parts.push(`${r.factions.length} faction${r.factions.length === 1 ? "" : "s"}`);
    if (r.entities.length) parts.push(`${r.entities.length} other`);
    return parts.length ? parts.join(" · ") : null;
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleConfirm = useCallback(() => {
    const r = scanResultRef.current;
    const confirmed = candidates.filter((c) => c.checked);
    onConfirm({
      characters: confirmed.map((c) => ({ name: c.name, aliases: c.aliases, role: "", description: "" })),
      places: (r?.places ?? []).map((name) => ({ name, aliases: [], type: "", description: "" })),
      factions: (r?.factions ?? []).map((name) => ({ name, aliases: [], type: "", description: "" })),
      entities: (r?.entities ?? []).map((name) => ({ name, aliases: [], type: "", description: "" })),
      castReviewed: true,
    });
  }, [candidates, onConfirm]);

  return createPortal(
    <div
      className="wc-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onSkip(); }}
    >
      <div className="wc-panel">
        <div className="wc-header">
          <div className="wc-header-text">
            <h2 className="wc-title">Your cast</h2>
            <p className="wc-subtitle">
              {phase === "scanning"
                ? `Reading your manuscript… ${Math.round((progress?.fraction ?? 0) * 100)}%`
                : `${checkedCount} of ${candidates.length} confirmed as people` +
                  (otherCounts ? ` — also filing ${otherCounts}` : "")}
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onSkip} aria-label="Skip">
            <CloseIcon />
          </button>
        </div>

        <div className="wc-list">
          {phase === "scanning" ? (
            <div className="wc-row wc-row--disabled" aria-live="polite">
              <div className="wc-row-text">
                <span className="wc-row-label">{progress?.label ?? "Preparing scan"}</span>
                <span className="wc-row-desc">{progress?.detail ?? ""}</span>
              </div>
            </div>
          ) : candidates.length === 0 ? (
            <div className="wc-row wc-row--disabled">
              <div className="wc-row-text">
                <span className="wc-row-label">No recurring names found yet</span>
                <span className="wc-row-desc">
                  Write a little more, or add characters by hand in the World panel.
                </span>
              </div>
            </div>
          ) : (
            candidates.map((c) => (
              <div
                key={c.name}
                className={`wc-row${c.checked ? "" : " wc-row--disabled"}`}
              >
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={c.checked}
                  className={`wc-checkbox${c.checked ? " wc-checkbox--checked" : ""}`}
                  onClick={() => toggle(c.name)}
                >
                  {c.checked && (
                    <svg width={12} height={12} viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path d="M2.5 6.5L5 9L9.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
                <div className="wc-row-text">
                  <span className="wc-row-label">
                    {c.name}
                    {c.aliases.length > 0 && (
                      <span style={{ color: "var(--text-secondary)", fontWeight: 400, marginLeft: 6 }}>
                        ({c.aliases.join(", ")})
                      </span>
                    )}
                    <span style={{ color: "var(--text-tertiary)", fontWeight: 400, marginLeft: 8, fontSize: "11px" }}>
                      {c.mentions} mention{c.mentions === 1 ? "" : "s"}
                    </span>
                  </span>
                  {c.evidence && (
                    <span className="wc-row-desc" style={{ fontFamily: "var(--font-body)" }}>
                      {c.evidence}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="wc-footer">
          <button type="button" className="wc-btn wc-btn--secondary" onClick={onSkip}>
            Skip for now
          </button>
          <button
            type="button"
            className="wc-btn wc-btn--primary"
            onClick={handleConfirm}
            disabled={phase !== "review"}
          >
            {phase !== "review"
              ? "Reading…"
              : checkedCount > 0
                ? "Yes, that’s my cast"
                : "Save without cast"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export const CastConfirmOverlay = memo(CastConfirmOverlayInner);
