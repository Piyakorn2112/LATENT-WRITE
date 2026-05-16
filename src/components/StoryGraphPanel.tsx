import { memo, startTransition, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Novel, StoryGraph, WorldData } from "../types";
import type { Preferences } from "../lib/preferences";
import {
  buildSnapshotTimelineCharacterTracks,
  buildTimelineCharacterTracks,
  type TimelineCharacterTrack,
} from "../lib/story-graph-display";
import { Maximize2Icon } from "./Icon";
import { GlassToggle } from "./GlassToggle";
import { TimelineGraph } from "./TimelineGraph";
import { TimelineGraphFull } from "./TimelineGraphFull";

interface Props {
  storyGraph: StoryGraph;
  chapters: Array<Pick<Novel["chapters"][number], "id" | "number" | "title">>;
  syncChapters: Novel["chapters"];
  worldData?: WorldData;
  currentChapterId: string | null;
  onSelectChapter: (id: string) => void;
  prefs: Preferences;
  onSetPrefs: (next: Preferences) => void;
}

type LMStatus = "idle" | "loading" | "ready" | "offline";

const LM_STATUS_LABEL: Record<LMStatus, string> = {
  idle:    "Idle",
  loading: "Loading…",
  ready:   "Active",
  offline: "Offline",
};
const LM_STATUS_COLOR: Record<LMStatus, string> = {
  idle:    "var(--panel-text-4)",
  loading: "#f59e0b",
  ready:   "#10b981",
  offline: "#f43f5e",
};

const electronAPI = (window as Window & {
  electronAPI?: {
    narrativeLMEmbed?:  (t: string) => Promise<number[] | null>;
    narrativeLMStatus?: () => Promise<string>;
  };
}).electronAPI;

function StoryGraphPanelImpl({
  storyGraph, chapters, syncChapters, worldData, currentChapterId, onSelectChapter, prefs, onSetPrefs,
}: Props) {
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [lmStatus, setLmStatus] = useState<LMStatus>("idle");
  const [syncedTracks, setSyncedTracks] = useState<TimelineCharacterTrack[] | null>(null);
  const [tracksSyncing, setTracksSyncing] = useState(false);
  const chapterIdKey = useMemo(() => syncChapters.map((chapter) => chapter.id).join("\u001f"), [syncChapters]);

  // Poll LM status from main process once at mount (and whenever panel opens)
  useEffect(() => {
    if (!electronAPI?.narrativeLMStatus) return;
    let alive = true;
    const poll = async () => {
      const s = await electronAPI.narrativeLMStatus!().catch(() => "offline");
      if (alive) setLmStatus(s as LMStatus);
      // Re-poll while loading until settled
      if (alive && s === "loading") setTimeout(poll, 1200);
    };
    poll();
    return () => { alive = false; };
  }, []);

  const analyzedCount = Object.keys(storyGraph.entries).length;
  const totalWords    = Object.values(storyGraph.entries).reduce((s, e) => s + e.wordCount, 0);
  const nlpEnabled    = prefs.storyNlpEnabled !== false;
  const hasElectron   = !!electronAPI?.narrativeLMEmbed;

  const snapshotTracks = useMemo(
    () => buildSnapshotTimelineCharacterTracks(storyGraph, worldData, 6),
    [storyGraph, worldData],
  );
  const topChars = syncedTracks ?? snapshotTracks;

  useEffect(() => {
    setSyncedTracks(null);
  }, [chapterIdKey]);

  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;

    if (syncChapters.length === 0 || (worldData?.characters?.length ?? 0) === 0) {
      setTracksSyncing(false);
      return () => controller.abort();
    }

    setTracksSyncing(true);
    timer = window.setTimeout(() => {
      void buildTimelineCharacterTracks(storyGraph, syncChapters, worldData, 6, {
        signal: controller.signal,
        yieldEvery: syncChapters.length > 80 ? 2 : 4,
      })
        .then((tracks) => {
          if (controller.signal.aborted) return;
          startTransition(() => setSyncedTracks(tracks));
        })
        .catch((error) => {
          if ((error as Error)?.name !== "AbortError") console.error(error);
        })
        .finally(() => {
          if (!controller.signal.aborted) setTracksSyncing(false);
        });
    }, 0);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [syncChapters, storyGraph, worldData]);

  function fmtWords(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }

  return (
    <div className="settings-panel liquid-glass" style={{ display: "flex", flexDirection: "column" }}>

      {/* ── Scrollable region — mask fades bottom edge, button sits below ── */}
      <div
        className="settings-panel-scroll"
        style={{
          flex: 1, minHeight: 0, paddingBottom: 4,
          // Short, tight fade at the very bottom — content scrolls fully into
          // view; only the last ~8% fades to hint at the sticky button below.
          maskImage: "linear-gradient(to bottom, black 0%, black 88%, transparent 100%)",
          WebkitMaskImage: "linear-gradient(to bottom, black 0%, black 88%, transparent 100%)",
        }}
      >

        {/* ── Stats header ── */}
        {analyzedCount > 0 && (
          <>
            <div className="sg-stats">
              <div className="sg-stat">
                <span className="sg-stat-num">{analyzedCount}</span>
                <span className="sg-stat-key">analyzed</span>
              </div>
              <div className="sg-stat">
                <span className="sg-stat-num">{fmtWords(totalWords)}</span>
                <span className="sg-stat-key">words</span>
              </div>
              <div className="sg-stat">
                <span className="sg-stat-num">{chapters.length}</span>
                <span className="sg-stat-key">chapters</span>
              </div>
            </div>
            {/* Character presence list */}
            {topChars.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 6px", padding: "4px 0 8px" }}>
                {topChars.map((track) => (
                  <div key={track.name} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{
                      width: 6, height: 6, borderRadius: "50%",
                      background: track.color,
                      display: "inline-block", flexShrink: 0,
                    }} />
                    <span style={{
                      fontFamily: "var(--font-ui)", fontSize: 9,
                      color: "var(--panel-text-3)", letterSpacing: "0.03em",
                    }}>
                      {track.name}
                    </span>
                    <span style={{
                      fontFamily: "var(--font-ui)", fontSize: 8,
                      color: "var(--panel-text-4)",
                    }}>
                      ×{track.count}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {tracksSyncing && (
              <div style={{ padding: "0 0 8px", fontFamily: "var(--font-ui)", fontSize: 8.5, color: "var(--panel-text-4)", letterSpacing: "0.05em", textTransform: "uppercase" }}>
                Syncing timeline cast…
              </div>
            )}
          </>
        )}

        {/* ── Compact timeline ── */}
        {chapters.length > 0 ? (
          <div style={{ margin: "0 -6px" }}>
            <TimelineGraph
              storyGraph={storyGraph}
              chapters={chapters}
              characterTracks={topChars}
              currentChapterId={currentChapterId}
              onSelectChapter={onSelectChapter}
            />
          </div>
        ) : (
          <p className="settings-hint" style={{ textAlign: "center", padding: "16px 0" }}>
            No chapters yet. Add a chapter to start building the graph.
          </p>
        )}

        {analyzedCount === 0 && chapters.length > 0 && (
          <p className="settings-hint">
            Navigate through chapters to build the graph.
          </p>
        )}

        {/* ── Story analysis settings ── */}
        {/* Bottom padding so the last content row scrolls fully into view above the sticky button */}
        <div style={{ height: 48 }} aria-hidden />
        {/* Story analysis — unique to story graph: cross-chapter scope.
            Widgets show this chapter's statistics in real time.
            This section shows whole-novel structure + on-demand editorial patterns. */}
        <p className="settings-section-label" style={{ marginTop: 0 }}>Story analysis</p>
        <p className="settings-hint" style={{ marginTop: 0, marginBottom: 6, fontSize: 9 }}>
          Cross-chapter structure — complements per-chapter widget feedback.
        </p>

        <div className="settings-toggle-row" style={{ padding: "0 2px" }}>
          <div className="settings-toggle-row-text">
            <span className="settings-toggle-row-title">Background NLP</span>
            <span className="settings-toggle-row-desc">
              Detects narrative events as you write each chapter.
            </span>
          </div>
          <GlassToggle
            checked={nlpEnabled}
            onChange={v => onSetPrefs({ ...prefs, storyNlpEnabled: v })}
            ariaLabel="Toggle story NLP analysis"
          />
        </div>

        {/* LM status indicator */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "6px 2px 2px", marginBottom:"40px",
        }}>
          <span style={{ fontFamily: "var(--font-ui)", fontSize: 10, color: "var(--panel-text-4)" }}>
            Local LM
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            {hasElectron ? (
              <>
                <span style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: LM_STATUS_COLOR[lmStatus],
                  display: "inline-block",
                  boxShadow: lmStatus === "ready" ? `0 0 4px ${LM_STATUS_COLOR.ready}` : "none",
                }} />
                <span style={{ fontFamily: "var(--font-ui)", fontSize: 10, color: LM_STATUS_COLOR[lmStatus] }}>
                  {LM_STATUS_LABEL[lmStatus]}
                </span>
              </>
            ) : (
              <span style={{ fontFamily: "var(--font-ui)", fontSize: 10, color: "var(--panel-text-4)" }}>
                Electron required
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Sticky footer: expand button, inset from edges ── */}
      {chapters.length > 0 && (
        <div className="sg-sticky-footer">
          <button className="sg-expand-btn" onClick={() => setOverlayOpen(true)}>
            <Maximize2Icon size={11} />
            <span>Arc timeline view</span>
          </button>
        </div>
      )}

      {/* Portal full-screen overlay to document.body */}
      {overlayOpen && createPortal(
        <TimelineGraphFull
          storyGraph={storyGraph}
          chapters={chapters}
          characterTracks={topChars}
          currentChapterId={currentChapterId}
          onSelectChapter={(id) => { onSelectChapter(id); setOverlayOpen(false); }}
          onClose={() => setOverlayOpen(false)}
        />,
        document.body,
      )}
    </div>
  );
}

export const StoryGraphPanel = memo(StoryGraphPanelImpl);
