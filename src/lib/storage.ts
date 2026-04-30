import type { Novel } from "../types";
import { emptyNovel } from "./parser";

const KEY = "glass-editor:novel-v1";

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
