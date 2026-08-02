import type { Chapter, Novel } from "../types";
import { emptyNovel, parseNovel, serializeNovel } from "./parser";
import { isDesktopApp, saveProjectState, loadProjectState, readProjectFile, writeProjectFile } from "./project-manager";

const KEY = "glass-editor:novel-v1";
const CURRENT_CHAPTER_KEY = "glass-editor:current-chapter-v1";
const PROJECT_NOVEL_PATH = "novel.txt";
const PROJECT_CHAPTER_ID_MAP_KEY = "chapter-id-map";

export interface PersistedChapterRef {
  id: string;
  number: number | null;
  title: string;
}

const ALL_LS_KEYS = [
  KEY,
  CURRENT_CHAPTER_KEY,
  "glass-editor:story-graph-v1",
  "glass-editor:review-results-v1",
  "glass-editor:annotations-v1",
  "glass-editor:adaptive-learning-v1",
  "glass-editor:knowledge-ledger-v1",
];

export function clearProjectLocalStorage(): void {
  for (const k of ALL_LS_KEYS) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
}

function buildPersistedChapterRefs(chapters: Chapter[]): PersistedChapterRef[] {
  return chapters.map((chapter) => ({
    id: chapter.id,
    number: chapter.number,
    title: chapter.title,
  }));
}

function takeMatchingPersistedChapter(
  persisted: PersistedChapterRef[],
  usedIds: Set<string>,
  predicate: (entry: PersistedChapterRef) => boolean,
): PersistedChapterRef | null {
  let match: PersistedChapterRef | null = null;
  for (const entry of persisted) {
    if (usedIds.has(entry.id) || !predicate(entry)) continue;
    if (match) return null;
    match = entry;
  }
  if (!match) return null;
  usedIds.add(match.id);
  return match;
}

function rehydrateProjectChapterIds(novel: Novel, persisted: PersistedChapterRef[]): void {
  const usedIds = new Set<string>();

  for (const chapter of novel.chapters) {
    const exact = takeMatchingPersistedChapter(
      persisted,
      usedIds,
      (entry) => entry.number === chapter.number && entry.title === chapter.title,
    );
    const byNumber = exact ?? takeMatchingPersistedChapter(
      persisted,
      usedIds,
      (entry) => entry.number === chapter.number,
    );
    const byTitle = byNumber ?? (chapter.title.trim()
      ? takeMatchingPersistedChapter(
          persisted,
          usedIds,
          (entry) => entry.title === chapter.title,
        )
      : null);

    const match = exact ?? byNumber ?? byTitle;
    if (match) chapter.id = match.id;
  }
}

export function resolvePersistedCurrentChapterId(
  chapters: Chapter[],
  persisted: PersistedChapterRef | string | null,
): string | null {
  if (!persisted) return null;
  if (typeof persisted === "string") {
    return chapters.some((chapter) => chapter.id === persisted) ? persisted : null;
  }
  if (persisted.id && chapters.some((chapter) => chapter.id === persisted.id)) {
    return persisted.id;
  }
  if (persisted.number !== null) {
    const exact = chapters.find((chapter) => chapter.number === persisted.number && chapter.title === persisted.title);
    if (exact) return exact.id;

    const byNumber = chapters.filter((chapter) => chapter.number === persisted.number);
    if (byNumber.length === 1) return byNumber[0].id;
  }
  if (persisted.title.trim()) {
    const byTitle = chapters.filter((chapter) => chapter.title === persisted.title);
    if (byTitle.length === 1) return byTitle[0].id;
  }
  return null;
}

export function loadNovel(): Novel {
  if (isDesktopApp()) return emptyNovel();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyNovel();
    const parsed = JSON.parse(raw) as Novel;
    if (!parsed.meta || !Array.isArray(parsed.chapters)) return emptyNovel();
    return parsed;
  } catch {
    return emptyNovel();
  }
}

export async function loadNovelFromProject(): Promise<Novel | null> {
  const raw = await readProjectFile(PROJECT_NOVEL_PATH);
  if (raw && raw.trim()) {
    const parsed = parseNovel(raw);
    if (parsed.meta && Array.isArray(parsed.chapters)) {
      const persistedRefs = await loadProjectState<PersistedChapterRef[]>(PROJECT_CHAPTER_ID_MAP_KEY);
      if (persistedRefs?.length) rehydrateProjectChapterIds(parsed, persistedRefs);
      await saveProjectState(PROJECT_CHAPTER_ID_MAP_KEY, buildPersistedChapterRefs(parsed.chapters));
      return parsed;
    }
  }

  const legacy = await loadProjectState<Novel>("novel");
  if (!legacy || !legacy.meta || !Array.isArray(legacy.chapters)) return null;

  // Migrate older desktop projects away from hidden JSON state to the
  // human-readable manuscript text format used by import/export.
  void writeProjectFile(PROJECT_NOVEL_PATH, serializeNovel(legacy));
  await saveProjectState(PROJECT_CHAPTER_ID_MAP_KEY, buildPersistedChapterRefs(legacy.chapters));
  return legacy;
}

export async function saveNovelToProject(novel: Novel): Promise<boolean> {
  if (!isDesktopApp()) {
    saveNovel(novel);
    return true;
  }

  const wroteNovel = await writeProjectFile(PROJECT_NOVEL_PATH, serializeNovel(novel));
  if (!wroteNovel) return false;
  await saveProjectState(PROJECT_CHAPTER_ID_MAP_KEY, buildPersistedChapterRefs(novel.chapters));
  return true;
}

export function saveNovel(novel: Novel): void {
  if (isDesktopApp()) {
    void saveNovelToProject(novel);
    return;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(novel));
  } catch {
    /* quota — silently ignore */
  }
}

export function loadCurrentChapterId(): string | null {
  if (isDesktopApp()) return null;
  try {
    return localStorage.getItem(CURRENT_CHAPTER_KEY);
  } catch {
    return null;
  }
}

export async function loadCurrentChapterIdFromProject(): Promise<PersistedChapterRef | string | null> {
  return loadProjectState<PersistedChapterRef | string>("current-chapter");
}

export function saveCurrentChapterId(id: string | null, chapter?: Pick<Chapter, "number" | "title"> | null): void {
  if (isDesktopApp()) {
    saveProjectState(
      "current-chapter",
      id
        ? {
            id,
            number: chapter?.number ?? null,
            title: chapter?.title ?? "",
          }
        : null,
    );
    return;
  }
  try {
    if (id) localStorage.setItem(CURRENT_CHAPTER_KEY, id);
    else localStorage.removeItem(CURRENT_CHAPTER_KEY);
  } catch {
    /* ignore */
  }
}
