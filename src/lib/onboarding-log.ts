/**
 * The first-session record — local only, structural only, readable by the
 * writer it describes.
 *
 * This is the measurement layer the redesigned onboarding stands on
 * (plans/onboarding-reimagine-2026-08.md §3): a device-only log of WHICH
 * onboarding moments happened and when, never any content. It is written to
 * localStorage, it is never transmitted anywhere, and it doubles as product
 * surface — the getting-started checklist derives its ticks from it, and the
 * finished checklist offers a recap drawn from the same record. Instrumenting
 * this way keeps the app's local-first promise literal: the funnel exists,
 * and it exists only on the writer's machine.
 *
 * Every event stores its FIRST occurrence timestamp only (recordOnb is
 * idempotent per kind), so the log is bounded and cannot grow with use.
 */

export type OnbEventKind =
  // the welcome screen
  | "welcome-seen"        // the screen was shown at all
  | "door-sample"         // chose "Open the sample story"
  | "door-own"            // chose "Start your own book"
  | "door-import"         // brought an existing draft in
  | "welcome-skipped"     // closed the welcome without choosing a door
  // the sandbox
  | "sample-reset"        // asked for a fresh copy of the sample
  | "sample-exit"         // left the sample for their own writing
  // the reader, observed (J2)
  | "world-opened"
  | "analysis-opened"
  | "entity-clicked"
  // words (J1)
  | "first-edit"          // any edit, sample included
  | "first-own-edit"      // an edit outside the sample — their book
  // the AI gestures (J3)
  | "ask-used"
  | "rewrite-used"
  | "max-hint-shown"
  // the cast question, absorbed (J5)
  | "cast-confirmed"
  | "cast-skipped"
  // the checklist itself
  | "checklist-hidden"
  | "checklist-done"
  | "recap-seen";

const KEY = "latentwrite:onboarding-v1";

type OnbRecord = Partial<Record<OnbEventKind, number>>;

let cache: OnbRecord | null = null;
const listeners = new Set<() => void>();

function read(): OnbRecord {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as OnbRecord) : {};
    cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

function write(next: OnbRecord): void {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* quota — the in-memory copy still serves this session */
  }
  for (const fn of listeners) fn();
}

/** Record a moment. Returns true only the FIRST time a kind is recorded, so
 *  call sites can gate one-shot behaviour (a hint, a tick animation) on it. */
export function recordOnb(kind: OnbEventKind): boolean {
  const rec = read();
  if (rec[kind] !== undefined) return false;
  write({ ...rec, [kind]: Date.now() });
  return true;
}

export function onbHappened(kind: OnbEventKind): boolean {
  return read()[kind] !== undefined;
}

/** Snapshot for useSyncExternalStore — a stable reference until a write. */
export function onbSnapshot(): OnbRecord {
  return read();
}

export function onbSubscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── The checklist, derived ────────────────────────────────────────────────
// Four items (the benchmark cliff is at five), each satisfied by real work
// recorded above — never by watching or waiting. The first is complete the
// moment the widget can appear at all, because choosing any door IS opening
// a story: the endowed-progress start, credited for work actually done.

export interface OnbChecklistItem {
  id: "open" | "notice" | "change" | "own";
  label: string;
  hint: string;
  done: boolean;
}

export function onbChecklist(): OnbChecklistItem[] {
  const rec = read();
  const has = (...kinds: OnbEventKind[]) => kinds.some((k) => rec[k] !== undefined);
  return [
    {
      id: "open",
      label: "Open a story",
      hint: "done — you're in one",
      done: has("door-sample", "door-own", "door-import"),
    },
    {
      id: "notice",
      label: "See what it noticed",
      hint: "open World or Analysis, or click a marked name",
      done: has("world-opened", "analysis-opened", "entity-clicked"),
    },
    {
      id: "change",
      label: "Change a sentence",
      hint: "edit anything and watch it re-read",
      done: has("first-edit"),
    },
    {
      id: "own",
      label: "Start your own book",
      hint: "your words, a blank page or an import",
      done: has("door-own", "door-import", "first-own-edit"),
    },
  ];
}

export function onbChecklistDone(): boolean {
  return onbChecklist().every((i) => i.done);
}
