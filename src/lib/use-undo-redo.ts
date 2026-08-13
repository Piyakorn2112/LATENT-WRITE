import { useCallback, useRef, useState } from "react";
import type { Novel } from "../types";

const MAX_STACK = 50;
const DEBOUNCE_MS = 600;

function snap(novel: Novel): string {
  return JSON.stringify(novel);
}

export interface UndoRedoHandle {
  canUndo: boolean;
  canRedo: boolean;
  push: (novel: Novel) => void;
  undo: () => Novel | null;
  redo: () => Novel | null;
  flush: () => void;
  /** Drop all history. Called at the sample-mode boundary in both
   *  directions — an undo stack that crosses it could resurrect sample
   *  prose into the real book (and the autosave would then persist it). */
  reset: () => void;
}

export function useUndoRedo(): UndoRedoHandle {
  const undoRef = useRef<string[]>([]);
  const redoRef = useRef<string[]>([]);
  const currentRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef<Novel | null>(null);

  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const syncFlags = useCallback(() => {
    setCanUndo(undoRef.current.length > 0 || pendingRef.current !== null);
    setCanRedo(redoRef.current.length > 0);
  }, []);

  const commitSnapshot = useCallback((novel: Novel) => {
    const s = snap(novel);
    if (s === currentRef.current) return;
    if (currentRef.current !== null) {
      undoRef.current.push(currentRef.current);
      if (undoRef.current.length > MAX_STACK) {
        undoRef.current.splice(0, undoRef.current.length - MAX_STACK);
      }
    }
    currentRef.current = s;
    redoRef.current = [];
    syncFlags();
  }, [syncFlags]);

  const push = useCallback((novel: Novel) => {
    pendingRef.current = novel;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (pendingRef.current) {
        commitSnapshot(pendingRef.current);
        pendingRef.current = null;
      }
    }, DEBOUNCE_MS);
    syncFlags();
  }, [commitSnapshot, syncFlags]);

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingRef.current) {
      commitSnapshot(pendingRef.current);
      pendingRef.current = null;
    }
  }, [commitSnapshot]);

  const undo = useCallback((): Novel | null => {
    flush();
    if (undoRef.current.length === 0) return null;
    const prev = undoRef.current.pop()!;
    if (currentRef.current !== null) {
      redoRef.current.push(currentRef.current);
    }
    currentRef.current = prev;
    syncFlags();
    return JSON.parse(prev) as Novel;
  }, [flush, syncFlags]);

  const redo = useCallback((): Novel | null => {
    flush();
    if (redoRef.current.length === 0) return null;
    const next = redoRef.current.pop()!;
    if (currentRef.current !== null) {
      undoRef.current.push(currentRef.current);
    }
    currentRef.current = next;
    syncFlags();
    return JSON.parse(next) as Novel;
  }, [flush, syncFlags]);

  const reset = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    undoRef.current = [];
    redoRef.current = [];
    currentRef.current = null;
    syncFlags();
  }, [syncFlags]);

  return { canUndo, canRedo, push, undo, redo, flush, reset };
}
