import { useEffect, useState } from "react";
import { RendererPanel } from "./RendererPanel";
import { loadPrefs } from "../lib/preferences";
import { currentTier, type Tier } from "../lib/license";

/**
 * Root for the standalone renderer-workspace window (loaded via the #workspace
 * hash route). It mounts a single RendererPanel in windowMode, which renders
 * the full-bleed workspace and owns the chat while this window is open. The
 * project, Claude session, and chat history are all shared through the main
 * process / project files, so this window stays in sync with the main app.
 *
 * Live editor context (chapter analysis, world data) is not available here —
 * renderer commands still work because the pipeline reads project files.
 */
export function WorkspaceWindow() {
  const [tier, setTier] = useState<Tier>(() => currentTier());
  const prefs = loadPrefs();

  useEffect(() => {
    document.body.classList.add("workspace-window");
    return () => document.body.classList.remove("workspace-window");
  }, []);

  return (
    <RendererPanel
      windowMode
      visible
      chapterId={null}
      chapterContent={undefined}
      chapterTitle={undefined}
      reviewResult={null}
      onReviewComplete={() => {}}
      prefs={prefs}
      onSetPrefs={() => {}}
      onProjectLoaded={() => {}}
      onNovelRefresh={() => {}}
      tier={tier}
      onTierChange={setTier}
    />
  );
}
