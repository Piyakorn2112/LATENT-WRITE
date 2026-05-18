import type { AnnotationCorrection, AnnotationStore } from "../types";
import { isDesktopApp, saveProjectState, loadProjectState } from "./project-manager";

// ── Storage ───────────────────────────────────────────────────────────────

const KEY = "glass-editor:annotations-v1";

export function loadAnnotationStore(): AnnotationStore {
  if (isDesktopApp()) return empty();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as AnnotationStore;
    if (parsed.version !== 1 || !Array.isArray(parsed.corrections)) return empty();
    return parsed;
  } catch {
    return empty();
  }
}

export async function loadAnnotationStoreFromProject(): Promise<AnnotationStore | null> {
  const data = await loadProjectState<AnnotationStore>("annotations");
  if (!data || data.version !== 1 || !Array.isArray(data.corrections)) return null;
  return data;
}

export function saveAnnotationStore(store: AnnotationStore): void {
  if (isDesktopApp()) { saveProjectState("annotations", store); return; }
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* quota — silently ignore */
  }
}

function empty(): AnnotationStore {
  return { version: 1, corrections: [] };
}

// ── CRUD ──────────────────────────────────────────────────────────────────

/** Append a correction, deduplicating by chapterId + paragraphIndex + spanIndex + spanType. */
export function addCorrection(
  store: AnnotationStore,
  correction: AnnotationCorrection,
): AnnotationStore {
  const key = `${correction.chapterId}|${correction.paragraphIndex}|${correction.spanIndex}|${correction.spanType}`;
  const filtered = store.corrections.filter((c) => {
    const k = `${c.chapterId}|${c.paragraphIndex}|${c.spanIndex}|${c.spanType}`;
    return k !== key;
  });
  return { ...store, corrections: [...filtered, correction] };
}

export function clearAnnotations(): AnnotationStore {
  return empty();
}

// ── Export ────────────────────────────────────────────────────────────────

/**
 * Download the full store as a pretty-printed JSON file.
 * Includes a summary object at the top for human readability.
 */
export function exportAnnotationsJSON(
  store: AnnotationStore,
  novelTitle: string,
): void {
  const byChar: Record<string, number> = {};
  for (const c of store.corrections) {
    const name = c.correctedSpeaker ?? "(narrative)";
    byChar[name] = (byChar[name] ?? 0) + 1;
  }
  const payload = {
    exportedAt: new Date().toISOString(),
    novelTitle,
    totalCorrections: store.corrections.length,
    byCharacter: byChar,
    corrections: store.corrections,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeTitle = (novelTitle || "novel").replace(/[^\w\d-]+/g, "-").toLowerCase();
  a.href = url;
  a.download = `${safeTitle}-annotations.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
