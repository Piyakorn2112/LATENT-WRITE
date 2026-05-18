import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ChapterAnalysisResult } from "../lib/use-analysis";
import { useDebouncedValue } from "../lib/use-debounced";
import { TensionWidget } from "./widgets/TensionWidget";
import { StyleWatchWidget } from "./widgets/StyleWatchWidget";
import { RhythmWidget } from "./widgets/RhythmWidget";
import { RepetitionWidget } from "./widgets/RepetitionWidget";
import { TitleSuggesterWidget } from "./widgets/TitleSuggesterWidget";
import { ProseProfileWidget } from "./widgets/ProseProfileWidget";
import { ContinuityWidget } from "./widgets/ContinuityWidget";
import { CharacterVoiceWidget } from "./widgets/CharacterVoiceWidget";
import { ScrollEdgeRight } from "./ScrollEdgeRight";
import type { Chapter, WorldData } from "../types";
import { DiagnosticsWidget } from "./widgets/DiagnosticsWidget";
import { ShapingWidget } from "./widgets/ShapingWidget";
import { StructureWidget } from "./widgets/StructureWidget";
import { VoiceWidget } from "./widgets/VoiceWidget";
import { CastWidget } from "./widgets/CastWidget";
import { RoleWidget } from "./widgets/RoleWidget";
import { CrossArcWidget } from "./widgets/CrossArcWidget";
import { MomentumWidget } from "./widgets/MomentumWidget";
import { SensoryBalanceWidget } from "./widgets/SensoryBalanceWidget";
import { CrossPacingWidget } from "./widgets/CrossPacingWidget";
import { PlaceholderWidget } from "./widgets/PlaceholderWidget";
import { ChevronRight as ChevronIcon, SettingsIcon, PilcrowIcon, LayersIcon, Wand2Icon } from "./Icon";
import { StoryGraphPanel } from "./StoryGraphPanel";
import { RendererPanel } from "./RendererPanel";
import type { StoryGraph, ReviewResult } from "../types";
import { SeparatorHorizontal } from "lucide-react";
import { IOS_COLORS } from "../lib/palette";
import type { Preferences, Typography, WritingGoals } from "../lib/preferences";
import { FONT_LABELS } from "../lib/preferences";
import { NumberStepper } from "./NumberStepper";
import { GlassRange } from "./GlassRange";
import { GlassToggle } from "./GlassToggle";

const EMPTY_CHAPTERS: Chapter[] = [];

type IntelMode = "off" | "low" | "default" | "high" | "auto";

interface Props {
  result: ChapterAnalysisResult | null;
  prevResult: ChapterAnalysisResult | null;
  nextResult: ChapterAnalysisResult | null;
  isAnalyzing: boolean;
  intelMode: IntelMode;
  onSetIntelMode: (m: IntelMode) => void;
  prefs: Preferences;
  onSetPrefs: (next: Preferences) => void;
  chapterId?: string | null;
  chapterTitle?: string;
  chapterContent?: string;
  needsProjectSaveWarning?: boolean;
  allChapters?: Chapter[];
  chapterIndex?: number;
  worldData?: WorldData;
  onAutoParagraph?: () => void;
  autoParagraphing?: boolean;
  onAutoSceneBreak?: () => void;
  sceneBreaking?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Story Graph — full novel structure accumulated from NLP analysis. */
  storyGraph?: StoryGraph;
  onSelectChapter?: (id: string) => void;
  /** Renderer review result for the current chapter (null = not yet run). */
  reviewResult?: ReviewResult | null;
  onReviewComplete?: (result: ReviewResult) => void;
  onProjectLoaded?: (novel: import("../types").Novel | null) => void;
}

const INTEL_LEVELS: { value: IntelMode; label: string; desc: string; color: string }[] = [
  { value: "off",     label: "Off",     desc: "No highlighting",            color: "#888888" },
  { value: "auto",    label: "Auto",    desc: "Adapts to chapter content",  color: IOS_COLORS.green.text  },
  { value: "low",     label: "Low",     desc: "Fast, ~85% accuracy",        color: IOS_COLORS.orange.text },
  { value: "default", label: "Default", desc: "Balanced analysis",          color: IOS_COLORS.blue.text   },
  { value: "high",    label: "High",    desc: "Max accuracy",               color: IOS_COLORS.purple.text },
];

interface SettingsProps {
  intelMode: IntelMode;
  onSetIntelMode: (m: IntelMode) => void;
  prefs: Preferences;
  onSetPrefs: (next: Preferences) => void;
}

const FONT_OPTIONS: Typography["fontFamily"][] = ["georgia", "iowan", "system", "sf-pro", "menlo"];

function SettingsPanel({ intelMode, onSetIntelMode, prefs, onSetPrefs }: SettingsProps) {
  const { typography, goals } = prefs;

  const setTypography = (t: Partial<Typography>) =>
    onSetPrefs({ ...prefs, typography: { ...typography, ...t } });
  const setGoals = (g: Partial<WritingGoals>) =>
    onSetPrefs({ ...prefs, goals: { ...goals, ...g } });

  return (
    <div className="settings-panel liquid-glass">
      {/* Inner wrapper carries the scroll. Keeping the scroll INSIDE
          the panel (not on .settings-panel itself) lets the panel's
          .liquid-glass::before specular ring stay anchored to the
          card edges instead of scrolling away with the content. */}
      <div className="settings-panel-scroll">
      <p className="settings-section-label">Intelligence</p>
      <div className="settings-intel-grid">
        {INTEL_LEVELS.map(({ value, label, desc, color }) => (
          <button
            key={value}
            className={`settings-intel-btn ${intelMode === value ? "settings-intel-btn--active" : ""}`}
            style={intelMode === value ? { "--intel-color": color } as CSSProperties : undefined}
            onClick={() => onSetIntelMode(value)}
          >
            <span className="settings-intel-label" style={{ color: intelMode === value ? color : undefined }}>
              {label}
            </span>
            <span className="settings-intel-desc">{desc}</span>
          </button>
        ))}
      </div>

      <p className="settings-section-label">Typography</p>

      <div className="settings-stack">
        <div className="settings-stack-head">
          <label className="settings-label">Font</label>
        </div>
        <div className="settings-pillgroup" role="radiogroup" aria-label="Font family">
          {FONT_OPTIONS.map((f) => (
            <button
              key={f}
              role="radio"
              aria-checked={typography.fontFamily === f}
              className={`settings-pill ${typography.fontFamily === f ? "settings-pill--active" : ""}`}
              onClick={() => setTypography({ fontFamily: f })}
            >
              {FONT_LABELS[f]}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-stack">
        <div className="settings-stack-head">
          <label className="settings-label">Size</label>
          <span className="settings-value">{typography.fontSize}px</span>
        </div>
        <GlassRange
          min={14} max={26} step={1}
          value={typography.fontSize}
          onChange={(v) => setTypography({ fontSize: v })}
        />
      </div>

      <div className="settings-stack">
        <div className="settings-stack-head">
          <label className="settings-label">Line height</label>
          <span className="settings-value">{typography.lineHeight.toFixed(2)}</span>
        </div>
        <GlassRange
          min={1.3} max={2.2} step={0.05}
          value={typography.lineHeight}
          onChange={(v) => setTypography({ lineHeight: v })}
        />
      </div>

      <div className="settings-stack">
        <div className="settings-stack-head">
          <label className="settings-label">Measure</label>
          <span className="settings-value">{typography.measure}ch</span>
        </div>
        <GlassRange
          min={50} max={100} step={2}
          value={typography.measure}
          onChange={(v) => setTypography({ measure: v })}
        />
      </div>

      <p className="settings-section-label">Layout</p>
      <div className="settings-toggle-row">
        <div className="settings-toggle-row-text">
          <span className="settings-toggle-row-title">Side panel compensation</span>
          <span className="settings-toggle-row-desc">
            Shifts the writing surface left when the right drawer opens on narrow windows.
          </span>
        </div>
        <GlassToggle
          checked={!!prefs.sidePanelCompensation}
          onChange={(v) => onSetPrefs({ ...prefs, sidePanelCompensation: v })}
          ariaLabel="Toggle side panel compensation"
        />
      </div>

      <p className="settings-section-label">Daily goal</p>
      <div className="settings-stack">
        <div className="settings-stack-head">
          <label className="settings-label">Words / day</label>
          <span className="settings-value">{goals.dailyWords === 0 ? "off" : `${goals.dailyWords}`}</span>
        </div>
        <NumberStepper
          value={goals.dailyWords}
          onChange={(v) => setGoals({ dailyWords: v })}
          step={100}
          min={0}
          max={20000}
          placeholder="0 = off"
        />
      </div>

      <p className="settings-section-label">Easter eggs</p>
      <div className="settings-toggle-row">
        <div className="settings-toggle-row-text">
          <span className="settings-toggle-row-title">Fun mode</span>
          <span className="settings-toggle-row-desc">
            Adds bouncy gooey eyes to the toolbar intelligence orb.
          </span>
        </div>
        <GlassToggle
          checked={!!prefs.funMode}
          onChange={(v) => onSetPrefs({ ...prefs, funMode: v })}
          ariaLabel="Toggle fun mode"
        />
      </div>
      <div className="settings-toggle-row">
        <div className="settings-toggle-row-text">
          <span className="settings-toggle-row-title">Debug panel</span>
          <span className="settings-toggle-row-desc">
            Shows adaptive model confidence, review load, and training samples.
          </span>
        </div>
        <GlassToggle
          checked={!!prefs.debugPanel}
          onChange={(v) => onSetPrefs({ ...prefs, debugPanel: v })}
          ariaLabel="Toggle debug panel"
        />
      </div>

      <p className="settings-hint">
        Settings persist locally. Goals reset at midnight.
      </p>
      </div>
    </div>
  );
}

// Sequenced mount: when the widget tree (re)mounts on a chapter switch, each
// AnimatedWidget waits `order` animation frames before rendering its child.
// Spreads the per-widget render + useMemo cost across multiple frames so the
// initial reveal doesn't blow a single frame budget on ~15 widgets at once.
function useFrameDelay(framesToWait: number): boolean {
  const [ready, setReady] = useState(framesToWait <= 0);
  useEffect(() => {
    if (framesToWait <= 0) {
      setReady(true);
      return;
    }
    let cancelled = false;
    let count = 0;
    const tick = () => {
      if (cancelled) return;
      count++;
      if (count >= framesToWait) {
        setReady(true);
      } else {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
    return () => { cancelled = true; };
  }, [framesToWait]);
  return ready;
}

// Animated collapse/expand wrapper for conditionally-present widgets.
// Mounts immediately but starts in the collapsed (--off) state so the entry
// CSS transition plays from height:0 → natural height. On hide, the CSS
// transition plays first, then the element is removed from the DOM after the
// transition ends so the surrounding stack smoothly closes the gap.
function AnimatedWidget({
  show,
  order = 0,
  children,
}: {
  show: boolean;
  /** Stagger slot — child renders after this many animation frames. */
  order?: number;
  children: React.ReactNode;
}) {
  const ready = useFrameDelay(order);
  const [mounted, setMounted] = useState(false);
  const [on, setOn] = useState(false);
  const frameRef = useRef(0);

  useEffect(() => {
    if (!ready) return;
    if (show) {
      setMounted(true);
      // Two rAFs: first lets React flush the mount with --off applied to the
      // DOM, second triggers the CSS transition to --on.
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = requestAnimationFrame(() => setOn(true));
      });
    } else {
      cancelAnimationFrame(frameRef.current);
      setOn(false);
      const t = window.setTimeout(() => setMounted(false), 380);
      return () => window.clearTimeout(t);
    }
    return () => cancelAnimationFrame(frameRef.current);
  }, [show, ready]);

  if (!mounted) return null;
  return (
    <div className={`widget-anim ${on ? "widget-anim--on" : "widget-anim--off"}`}>
      <div className="widget-anim-inner">{children}</div>
    </div>
  );
}

function WidgetSet({
  result, prevResult, nextResult, showCrossArc,
  chapterContent, allChapters, chapterIndex, worldData, wordCount,
}: {
  result: ChapterAnalysisResult;
  prevResult: ChapterAnalysisResult | null;
  nextResult: ChapterAnalysisResult | null;
  showCrossArc: boolean;
  chapterContent?: string;
  allChapters?: Chapter[];
  chapterIndex?: number;
  worldData?: WorldData;
  /** Pre-computed word count from the parent — avoids a second .split here. */
  wordCount?: number;
}) {
  const a = result.analysis;
  const hi = a.highModeAnalysis;
  const hasDiagnostics = a.writerDiagnostics.length > 0;
  const hasCast = a.speakerCounts.length > 0;

  const hasMomentum = !!hi && hi.narrativeMomentum.segments.length > 0;
  const hasSensory  = !!hi && hi.proseStyle && hi.proseStyle.topChannels.length > 0;
  const hasStyleContent = !!chapterContent && chapterContent.trim().length > 50;
  // Prose Profile needs ~80 words of prose to be informative; the widget
  // also internally guards on that, but we use the same threshold here so
  // the AnimatedWidget's enter transition doesn't fire for a no-op render.
  const hasProseProfile = (wordCount ?? 0) > 80;
  const hasContinuityCtx = !!allChapters && allChapters.length > 1 && chapterIndex != null && chapterIndex >= 0;
  const hasCharacterVoice = result.paragraphs.length > 0 && a.speakerCounts.length >= 2;

  // `order` slots stagger the actual MOUNT (not just the CSS reveal) one
  // animation frame at a time. With ~15 widgets that's ~240 ms for the last
  // one to land, but each individual frame only does the work of one widget.
  return (
    <>
      <AnimatedWidget order={0} show={hasDiagnostics}><DiagnosticsWidget analysis={a} /></AnimatedWidget>
      <AnimatedWidget order={1} show={!!hi}><ShapingWidget analysis={a} /></AnimatedWidget>
      <AnimatedWidget order={2} show={true}>
        <TensionWidget
          analysis={a}
          paragraphs={result.paragraphs}
          speechResults={result.speechResults}
        />
      </AnimatedWidget>
      <AnimatedWidget order={3} show={!!hi}><StructureWidget analysis={a} /></AnimatedWidget>
      <AnimatedWidget order={4} show={hasMomentum}><MomentumWidget analysis={a} /></AnimatedWidget>
      <AnimatedWidget order={5} show={showCrossArc}>
        <CrossArcWidget current={result} prev={prevResult} next={nextResult} />
      </AnimatedWidget>
      <AnimatedWidget order={6} show={showCrossArc && (!!prevResult || !!nextResult)}>
        <CrossPacingWidget current={result} prev={prevResult} next={nextResult} />
      </AnimatedWidget>
      {/* Continuity slots between cross-pacing and prose profile so cross-
          chapter and chapter-level structural notes sit together visually. */}
      <AnimatedWidget order={7} show={hasContinuityCtx}>
        <ContinuityWidget
          chapters={allChapters ?? []}
          worldData={worldData}
          chapterIndex={chapterIndex ?? -1}
        />
      </AnimatedWidget>
      <AnimatedWidget order={8} show={hasProseProfile}>
        <ProseProfileWidget content={chapterContent ?? ""} />
      </AnimatedWidget>
      <AnimatedWidget order={9} show={hasSensory}><SensoryBalanceWidget analysis={a} /></AnimatedWidget>
      <AnimatedWidget order={10} show={hasStyleContent}>
        <StyleWatchWidget content={chapterContent ?? ""} />
      </AnimatedWidget>
      {/* Sentence-rhythm — only meaningful with ≥4 sentences (~20+ words),
          guard inside the widget itself; the show flag keeps the slot
          stable when the chapter has any prose. */}
      <AnimatedWidget order={11} show={hasStyleContent}>
        <RhythmWidget content={chapterContent ?? ""} />
      </AnimatedWidget>
      {/* Repetition / echo finder — needs substantial text to find
          phrasal tics; the widget itself returns null below threshold. */}
      <AnimatedWidget order={12} show={(chapterContent?.length ?? 0) > 200}>
        <RepetitionWidget content={chapterContent ?? ""} />
      </AnimatedWidget>
      {/* Chapter title suggester — sits near the end of the widget
          stack as a quiet utility; updates as the chapter changes. */}
      <AnimatedWidget order={13} show={result.paragraphs.length > 0}>
        <TitleSuggesterWidget result={result} knownNames={a.speakerCounts.map(s => s.name)} />
      </AnimatedWidget>
      <AnimatedWidget order={14} show={hasCharacterVoice}>
        <CharacterVoiceWidget
          paragraphs={result.paragraphs}
          speechResults={result.speechResults}
          worldData={worldData}
          content={chapterContent ?? ""}
        />
      </AnimatedWidget>
      <AnimatedWidget order={15} show={!!hi || hasCast}><VoiceWidget analysis={a} /></AnimatedWidget>
      <AnimatedWidget order={16} show={hasCast}><CastWidget analysis={a} /></AnimatedWidget>
      <AnimatedWidget order={17} show={true}><RoleWidget analysis={a} /></AnimatedWidget>
    </>
  );
}

export function AnalysisPanel({
  result, prevResult, nextResult, isAnalyzing, intelMode, onSetIntelMode,
  prefs, onSetPrefs, chapterId, chapterTitle, chapterContent, needsProjectSaveWarning,
  allChapters, chapterIndex, worldData,
  onAutoParagraph, autoParagraphing,
  onAutoSceneBreak, sceneBreaking, onOpenChange,
  storyGraph, onSelectChapter,
  reviewResult, onReviewComplete, onProjectLoaded,
}: Props) {
  // High-mode gating mirrors the reader: cross-arc data is only meaningful
  // under high intelligence. Auto resolves dynamically per chapter, so we
  // permit it whenever the resolved analysis itself includes highModeAnalysis.
  const showCrossArc =
    intelMode === "high" ||
    (intelMode === "auto" && !!result?.analysis.highModeAnalysis);
  const [view, setView] = useState<"widgets" | "settings" | "graph" | "renderer" | null>(null);

  // Debounce live content props so widgets don't recompute on every keystroke
  // — the widget tree contains heavy passes (grammar, echo detection, prose
  // profile) that previously ran on every input event when the panel was open.
  // 350 ms is short enough to feel near-live; analysis itself is debounced
  // separately at 1 s in useAnalysis.
  const debouncedContent = useDebouncedValue(chapterContent ?? "", 350);
  const debouncedChapters = useDebouncedValue(allChapters, 350);
  const graphSyncSource = view === "graph" ? (allChapters ?? EMPTY_CHAPTERS) : EMPTY_CHAPTERS;
  const graphSyncChapters = useDebouncedValue(graphSyncSource, 1200);
  const graphDisplayKey = useMemo(
    () => (allChapters ?? EMPTY_CHAPTERS).map((chapter) => `${chapter.id}\u001f${chapter.number}\u001f${chapter.title}`).join("\u001e"),
    [allChapters],
  );
  const graphDisplayChapters = useMemo(
    () => (allChapters ?? EMPTY_CHAPTERS).map(({ id, number, title }) => ({ id, number, title })),
    [graphDisplayKey],
  );
  const handleGraphSelectChapter = useCallback((id: string) => {
    onSelectChapter?.(id);
    setView(null);
  }, [onSelectChapter]);

  // Cross-fade state: old widgets exit, new ones stagger in on chapter change.
  // For same-chapter re-analyses (data updates), just swap displayed silently
  // so widgets update in place without replaying the reveal animation.
  const [displayed, setDisplayed] = useState<ChapterAnalysisResult | null>(result);
  const [exiting, setExiting] = useState<ChapterAnalysisResult | null>(null);
  const [revealKey, setRevealKey] = useState(0);
  const exitTimer = useRef<number | null>(null);
  const prevChapterIdRef = useRef(chapterId);

  useEffect(() => {
    if (result === displayed) return;
    const chapterChanged = chapterId !== prevChapterIdRef.current;
    prevChapterIdRef.current = chapterId;
    // Only play the full exit→reveal sequence when the user navigates to a
    // different chapter. Re-scans of the same chapter update data in place.
    if (chapterChanged && displayed && displayed.paragraphs.length > 0) {
      setExiting(displayed);
      if (exitTimer.current) window.clearTimeout(exitTimer.current);
      exitTimer.current = window.setTimeout(() => setExiting(null), 200);
      setRevealKey((k) => k + 1);
    }
    setDisplayed(result);
  }, [result, chapterId, displayed]);

  useEffect(() => () => {
    if (exitTimer.current) window.clearTimeout(exitTimer.current);
  }, []);

  const toggle = useCallback(
    (target: "widgets" | "settings" | "graph" | "renderer") =>
      setView((v) => (v === target ? null : target)),
    [],
  );

  const isOpen = view !== null;
  const hasContent = displayed && displayed.paragraphs.length > 0;

  useLayoutEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);

  // Word-count threshold check used twice (widgetCount badge + WidgetSet
  // gating). Computing once at this level avoids a second .split on every
  // render and keeps the count badge stable across keystrokes.
  const debouncedWordCount = useMemo(
    () => (debouncedContent ? debouncedContent.trim().split(/\s+/).length : 0),
    [debouncedContent],
  );

  const widgetCount = useMemo(() => {
    if (!hasContent) return 0;
    const a = displayed!.analysis;
    let n = 2; // tension + role always
    if (a.writerDiagnostics.length > 0) n++;
    if (a.highModeAnalysis) n += 2;
    if (showCrossArc) n++;
    if (a.highModeAnalysis || a.speakerCounts.length > 0) n++;
    if (a.speakerCounts.length > 0) n++;
    if (debouncedContent && debouncedContent.trim().length > 50) n++;
    if (debouncedWordCount > 80) n++;
    if (debouncedChapters && debouncedChapters.length > 1 && chapterIndex != null) n++;
    if (a.speakerCounts.length >= 2) n++;
    return n;
  }, [hasContent, displayed, showCrossArc, debouncedContent, debouncedWordCount, debouncedChapters, chapterIndex]);

  const placeholderVariant: "empty" | "processing" = isAnalyzing ? "processing" : "empty";

  return (
    <div className={`analysis-panel ${isOpen ? "analysis-panel--open" : ""}`}>
      {/* Right-edge ambient blur — scoped to the panel so it slides in
          and out with the drawer. Acts as a separation layer between the
          panel and whatever editor area sits beneath it. Sits at z-index 0
          so the tabs and drawer paint above it. */}
      <ScrollEdgeRight />

      {/* Tab column — chevron on top, settings below */}
      <div className="analysis-tabs">
        <button
          className={`analysis-tab ${view === "widgets" ? "analysis-tab--active" : ""}`}
          onClick={() => toggle("widgets")}
          aria-label={view === "widgets" ? "Collapse analysis" : "Expand analysis"}
        >
          <ChevronIcon
            size={14}
            style={{
              transform: view === "widgets" ? "rotate(180deg)" : undefined,
              transition: "transform 0.3s ease",
            }}
          />
          {view !== "widgets" && widgetCount > 0 && (
            <span className="analysis-tab-badge">{widgetCount}</span>
          )}
        </button>

        {(onAutoParagraph || onAutoSceneBreak) && (
          <div className="analysis-action-group" aria-label="Formatting actions" role="group">
            {/* Auto-paragraph — single-shot action button, NOT a tab toggle.
                Click runs the smart paragrapher on the current chapter
                content and applies the result. The host (App) drives the
                actual processing loop, including the analyzing pill
                ("Analysing chapter…") and the editor-scan orb gradient. */}
            {onAutoParagraph && (
              <button
                className={`analysis-action-button ${autoParagraphing ? "analysis-tab--working" : ""}`}
                onClick={onAutoParagraph}
                disabled={autoParagraphing}
                aria-label="Smart auto-paragraph chapter"
                title="Smart auto-paragraph chapter"
              >
                <PilcrowIcon size={13} />
              </button>
            )}

            {onAutoParagraph && onAutoSceneBreak && <span className="analysis-action-divider" aria-hidden="true" />}

            {/* Auto-scene-break — companion to auto-paragraph. Inserts `* * *`
                markers at detected scene boundaries (tension flips,
                time-shift markers, speaker-discontinuity gaps). Same single-
                shot button language; pulses while the host runs the pass. */}
            {onAutoSceneBreak && (
              <button
                className={`analysis-action-button ${sceneBreaking ? "analysis-tab--working" : ""}`}
                onClick={onAutoSceneBreak}
                disabled={sceneBreaking}
                aria-label="Auto-insert scene breaks"
                title="Auto-insert scene breaks"
              >
                <SeparatorHorizontal size={13} strokeWidth={1.8} />
              </button>
            )}
          </div>
        )}

        <button
          className={`analysis-tab analysis-tab--settings ${view === "graph" ? "analysis-tab--active" : ""}`}
          onClick={() => toggle("graph")}
          aria-label="Story graph"
          title="Story graph"
        >
          <LayersIcon size={13} />
        </button>

        <button
          className={`analysis-tab analysis-tab--settings ${view === "renderer" ? "analysis-tab--active" : ""}`}
          onClick={() => toggle("renderer")}
          aria-label="Renderer review"
          title="Renderer review"
        >
          <Wand2Icon size={13} />
        </button>

        <button
          className={`analysis-tab analysis-tab--settings ${view === "settings" ? "analysis-tab--active" : ""}`}
          onClick={() => toggle("settings")}
          aria-label="Analysis settings"
          title="Analysis settings"
        >
          <SettingsIcon size={13} />
        </button>
      </div>

      {/* Scrollable drawer */}
      <div className="analysis-drawer">
        {view === "widgets" && (
          <div className={`analysis-inner ${isAnalyzing ? "analysis-inner--analyzing" : ""}`}>
            {hasContent ? (
              <div className="widget-list-stack">
                {exiting && (
                  <div className="widget-list widget-list--exiting" aria-hidden>
                    <WidgetSet
                      result={exiting}
                      prevResult={prevResult}
                      nextResult={nextResult}
                      showCrossArc={showCrossArc}
                      chapterContent={chapterContent}
                      allChapters={allChapters}
                      chapterIndex={chapterIndex}
                      worldData={worldData}
                    />
                  </div>
                )}
                <div className="widget-list" key={revealKey}>
                  <WidgetSet
                    result={displayed!}
                    prevResult={prevResult}
                    nextResult={nextResult}
                    showCrossArc={showCrossArc}
                    chapterContent={debouncedContent}
                    allChapters={debouncedChapters}
                    chapterIndex={chapterIndex}
                    worldData={worldData}
                    wordCount={debouncedWordCount}
                  />
                </div>
              </div>
            ) : (
              <div className="widget-list" key={`placeholder-${placeholderVariant}`}>
                <PlaceholderWidget variant={placeholderVariant} intelMode={intelMode} />
              </div>
            )}
          </div>
        )}

        {view === "settings" && (
          <div className="analysis-inner analysis-inner--settings">
            <SettingsPanel
              intelMode={intelMode}
              onSetIntelMode={onSetIntelMode}
              prefs={prefs}
              onSetPrefs={onSetPrefs}
            />
          </div>
        )}

        {view === "graph" && (
          <div className="analysis-inner analysis-inner--settings">
            <StoryGraphPanel
              storyGraph={storyGraph ?? { version: 1, entries: {} }}
              chapters={graphDisplayChapters}
              syncChapters={graphSyncChapters}
              worldData={worldData}
              currentChapterId={chapterId ?? null}
              onSelectChapter={handleGraphSelectChapter}
              prefs={prefs}
              onSetPrefs={onSetPrefs}
            />
          </div>
        )}

        {view === "renderer" && (
          <div className="analysis-inner analysis-inner--settings">
            <RendererPanel
              chapterId={chapterId ?? null}
              chapterContent={chapterContent}
              chapterTitle={chapterTitle}
              needsProjectSaveWarning={needsProjectSaveWarning}
              reviewResult={reviewResult ?? null}
              onReviewComplete={(r) => onReviewComplete?.(r)}
              prefs={prefs}
              onSetPrefs={onSetPrefs}
              onProjectLoaded={(n) => onProjectLoaded?.(n)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
