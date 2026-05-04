import type { Novel } from "../types";
import { emptyNovel } from "./parser";

const KEY = "glass-editor:novel-v1";
// Last-opened chapter id, kept independently from the novel payload so a
// refresh restores the writer to whatever they were last reading/editing
// instead of always landing on chapter 1. Tiny string; never fails quota.
const CURRENT_CHAPTER_KEY = "glass-editor:current-chapter-v1";

export function loadNovel(): Novel {
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

export function saveNovel(novel: Novel): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(novel));
  } catch {
    /* quota — silently ignore */
  }
}

export function loadCurrentChapterId(): string | null {
  try {
    return localStorage.getItem(CURRENT_CHAPTER_KEY);
  } catch {
    return null;
  }
}

export function saveCurrentChapterId(id: string | null): void {
  try {
    if (id) localStorage.setItem(CURRENT_CHAPTER_KEY, id);
    else localStorage.removeItem(CURRENT_CHAPTER_KEY);
  } catch {
    /* ignore */
  }
}
