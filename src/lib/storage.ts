import type { Novel } from "../types";
import { emptyNovel, parseNovel, serializeNovel } from "./parser";
import { isDesktopApp, saveProjectState, loadProjectState, readProjectFile, writeProjectFile } from "./project-manager";

const KEY = "glass-editor:novel-v1";
const CURRENT_CHAPTER_KEY = "glass-editor:current-chapter-v1";
const PROJECT_NOVEL_PATH = "novel.txt";

const ALL_LS_KEYS = [
  KEY,
  CURRENT_CHAPTER_KEY,
  "glass-editor:story-graph-v1",
  "glass-editor:review-results-v1",
  "glass-editor:annotations-v1",
  "glass-editor:adaptive-learning-v1",
];

export function clearProjectLocalStorage(): void {
  for (const k of ALL_LS_KEYS) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
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
    if (parsed.meta && Array.isArray(parsed.chapters)) return parsed;
  }

  const legacy = await loadProjectState<Novel>("novel");
  if (!legacy || !legacy.meta || !Array.isArray(legacy.chapters)) return null;

  // Migrate older desktop projects away from hidden JSON state to the
  // human-readable manuscript text format used by import/export.
  void writeProjectFile(PROJECT_NOVEL_PATH, serializeNovel(legacy));
  return legacy;
}

export function saveNovel(novel: Novel): void {
  if (isDesktopApp()) {
    void writeProjectFile(PROJECT_NOVEL_PATH, serializeNovel(novel));
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

export async function loadCurrentChapterIdFromProject(): Promise<string | null> {
  return loadProjectState<string>("current-chapter");
}

export function saveCurrentChapterId(id: string | null): void {
  if (isDesktopApp()) {
    saveProjectState("current-chapter", id);
    return;
  }
  try {
    if (id) localStorage.setItem(CURRENT_CHAPTER_KEY, id);
    else localStorage.removeItem(CURRENT_CHAPTER_KEY);
  } catch {
    /* ignore */
  }
}
