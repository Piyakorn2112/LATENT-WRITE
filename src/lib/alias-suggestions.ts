import { useEffect, useRef, useState } from "react";
import type { Novel } from "../types";
import { proposeAliases, type AliasProposalResult } from "./alias-propose";
import { resolveSpeakerCandidates, extractNameCandidatesFast } from "./world-data";

/**
 * alias-suggestions.ts — "which other names in this book are this character?",
 * asked without blocking the panel that shows the answer.
 *
 * ★★ THE WORK USED TO HAPPEN DURING RENDER. WorldDataView computed this in a
 *    `useMemo`, and React runs a memo synchronously while rendering — so every
 *    millisecond of a whole-book analysis was a millisecond before the overlay
 *    existed on screen. The writer clicked World and watched the OLD screen.
 *    Measured on hollow-iris (3.4M chars) with 80 characters: 9.3 seconds, then
 *    654ms after the scan fixes, and even 654ms is a freeze in the wrong place.
 *
 * ★★ AND THE MEMO'S KEY WAS THE CAST, so it re-ran on every keystroke in a Name
 *    or Aliases field. Typing "Elizabeth" was nine whole-book analyses.
 *
 * The seam this module puts there does three things the memo could not:
 *
 *   DEFERRED — nothing runs during render. The panel paints, then the work is
 *   scheduled on idle, so the first frame never waits for it.
 *
 *   CANCELLED AND DEBOUNCED — a cast change while a run is pending replaces it
 *   rather than queueing behind it. Typing costs one analysis after the typing
 *   stops, not one per letter.
 *
 *   CACHED IN TWO LAYERS, because the two halves have different lifetimes. The
 *   candidate list and the joined text depend only on the MANUSCRIPT (~320ms of
 *   the bill on hollow-iris) and are keyed on the chapters array by identity;
 *   only `proposeAliases` depends on the cast. So editing a character re-runs
 *   the cast half alone, and switching tabs away and back re-runs nothing.
 *
 * ★ IDENTITY, NOT A CONTENT HASH, for the book key. Hashing 3.4M characters to
 *   decide whether to skip work that takes 320ms is its own tax, and a new
 *   chapters array means the manuscript changed, which is exactly when the
 *   index should be rebuilt. A missed cache hit costs one recompute; a false
 *   hit would show suggestions for text the writer has since deleted.
 */

export type AliasSuggestionStatus = "idle" | "pending" | "ready";

export interface AliasSuggestions {
  /** Null until the first run finishes, and while disabled. */
  result: AliasProposalResult | null;
  status: AliasSuggestionStatus;
}

/** The manuscript half: everything that does not depend on the cast. */
interface BookIndex {
  text: string;
  candidates: string[];
}

type IdleHandle = number;

const scheduleIdle: (cb: () => void) => IdleHandle =
  typeof (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number }).requestIdleCallback === "function"
    ? ((cb) => (globalThis as { requestIdleCallback: (cb: () => void, opts?: { timeout?: number }) => number }).requestIdleCallback(cb, { timeout: 300 }))
    : ((cb) => requestAnimationFrame(cb) as IdleHandle);

const cancelIdle: (handle: IdleHandle) => void =
  typeof (globalThis as { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback === "function"
    ? ((handle) => (globalThis as { cancelIdleCallback: (handle: number) => void }).cancelIdleCallback(handle))
    : ((handle) => cancelAnimationFrame(handle));

/**
 * Keyed on the chapters array itself so an edit to worldData — which is what
 * this panel does all day — never invalidates it, while an edit to the
 * manuscript always does.
 */
const BOOK_INDEX_CACHE = new WeakMap<object, BookIndex>();

/**
 * ★★ THE UNION IS LOAD-BEARING AND PREDATES THIS FILE. resolveSpeakerCandidates
 *    goes through resolveKnownNames, which returns the writer's OWN cast once
 *    worldData is non-empty — so on any real book the proposer would only ever
 *    see names already in the list. It could offer to merge two entries and
 *    could never offer "Lizzy", which is the case the feature exists for.
 *    extractNameCandidatesFast is what reads the manuscript.
 */
export function buildBookIndex(novel: Novel): BookIndex {
  const cached = BOOK_INDEX_CACHE.get(novel.chapters);
  if (cached) return cached;
  const text = novel.chapters.map((c) => c.content).join("\n");
  const candidates = [...new Set([
    ...resolveSpeakerCandidates(novel),
    ...extractNameCandidatesFast(novel, 3, 60),
  ])];
  const index: BookIndex = { text, candidates };
  BOOK_INDEX_CACHE.set(novel.chapters, index);
  return index;
}

/** Enough text to be worth proposing against. Same floor as the old memo. */
const MIN_TEXT_LENGTH = 200;

/**
 * ★ THE DEBOUNCE IS FOR TYPING, NOT FOR OPENING. A panel that opens and then
 *   waits a fixed beat before doing anything reads as slower than it is, so
 *   the first run for a given cast goes straight to idle scheduling; only a
 *   REPLACEMENT of a pending run pays the debounce.
 */
const TYPING_DEBOUNCE_MS = 350;

export function useAliasSuggestions(
  novel: Novel,
  characters: readonly { name: string; aliases?: readonly string[] }[],
  enabled: boolean,
): AliasSuggestions {
  const [state, setState] = useState<AliasSuggestions>({ result: null, status: "idle" });

  // The cast, flattened to a value so a new array of identical names is not a
  // new question. This is the memo's old key, and it is still the right one.
  const castKey = characters.map((c) => `${c.name}|${(c.aliases ?? []).join(",")}`).join("¶");
  const answeredForRef = useRef<string | null>(null);
  const chaptersRef = useRef<object | null>(null);

  useEffect(() => {
    // ★ DISABLED MEANS "DO NOT RUN", NOT "FORGET". Clearing the answer when the
    //   writer switches to the Places tab would make coming back a full
    //   recompute, which is one of the three slow moments in the report. The
    //   result is only ever read on the Characters tab, so keeping it costs
    //   nothing and makes tab switching free. If the cast changed in the
    //   meantime the castKey check below catches it on the way back.
    if (!enabled || characters.length === 0) return;
    // Already answered this exact question — a tab switch must cost nothing.
    if (answeredForRef.current === castKey && chaptersRef.current === novel.chapters) return;

    let cancelled = false;
    const hadAnswer = answeredForRef.current !== null;
    setState((prev) => ({ result: prev.result, status: "pending" }));

    const run = () => {
      if (cancelled) return;
      try {
        const index = buildBookIndex(novel);
        if (cancelled) return;
        if (index.text.trim().length < MIN_TEXT_LENGTH) {
          answeredForRef.current = castKey;
          chaptersRef.current = novel.chapters;
          setState({ result: null, status: "ready" });
          return;
        }
        const result = proposeAliases(characters, index.candidates, index.text);
        if (cancelled) return;
        answeredForRef.current = castKey;
        chaptersRef.current = novel.chapters;
        setState({ result, status: "ready" });
      } catch (err) {
        // ★ SAY SO OUT LOUD. A bare catch here would report "no suggestions"
        //   for a thrown error and for a book with genuinely nothing to
        //   suggest, identically and forever. This repo has lost months to that
        //   shape once already, in the story-graph LM pass.
        console.warn("[alias-suggestions] proposal pass failed —", err);
        if (cancelled) return;
        answeredForRef.current = castKey;
        chaptersRef.current = novel.chapters;
        setState({ result: null, status: "ready" });
      }
    };

    let idle: IdleHandle | null = null;
    const timer = window.setTimeout(
      () => { idle = scheduleIdle(run); },
      hadAnswer ? TYPING_DEBOUNCE_MS : 0,
    );

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (idle !== null) cancelIdle(idle);
    };
    // `characters` is covered by castKey; depending on the array itself would
    // re-run on every render that rebuilt it with identical contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, castKey, novel.chapters, characters.length]);

  return state;
}

/**
 * How many rows of a long list to render right now, growing a batch per frame.
 *
 * ★ THE FIRST BATCH PAINTS, THE REST STREAM IN BEHIND IT. A writer with a
 *   large cast should see the panel and the top of their list immediately
 *   rather than waiting on a list they cannot read all of anyway.
 *
 * ★ AND IT IS FREE FOR SMALL LISTS. When `total <= batch` the first value is
 *   already `total`, so there is no second render and no scheduling at all —
 *   the common case pays nothing for the large-cast case.
 */
export function useProgressiveCount(total: number, batch = 60): number {
  const [shown, setShown] = useState(() => Math.min(total, batch));

  // ★ THE COUNT ONLY EVER GROWS, and clamping at the end is what makes that
  //   safe. Restarting the stream whenever `total` changed looked equivalent
  //   and was not: adding a character to a cast of eighty collapsed the list
  //   back to the first batch and re-streamed it, and the new entry — which
  //   Add immediately selects — was not on screen to see. Growing monotonically
  //   also means switching to Places (3 rows) and back to Characters (80)
  //   re-renders the whole list at once rather than streaming it again.
  useEffect(() => {
    if (shown >= total) return;
    const raf = requestAnimationFrame(() => setShown((n) => Math.min(n + batch, total)));
    return () => cancelAnimationFrame(raf);
  }, [shown, total, batch]);

  return Math.min(shown, total);
}
