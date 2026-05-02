import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ChapterAnalysisResult } from "../lib/use-analysis";
import { TensionWidget } from "./widgets/TensionWidget";
import { StyleWatchWidget } from "./widgets/StyleWatchWidget";
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
import { ChevronRight as ChevronIcon, SettingsIcon } from "./Icon";
import { IOS_COLORS } from "../lib/palette";
import type { Preferences, Typography, WritingGoals } from "../lib/preferences";
import { FONT_LABELS } from "../lib/preferences";
import { NumberStepper } from "./NumberStepper";

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
  /** Stable ID of the open chapter — triggers the reveal animation only on
   *  actual chapter navigation, not on every incremental analysis update. */
  chapterId?: string | null;
  /** Raw chapter content — required by StyleWatchWidget for its grammar
   *  and echo passes. */
  chapterContent?: string;
  /** Full chapter list — Continuity widget needs the surrounding book
   *  to compute first-appearance and Chekhov candidates. */
  allChapters?: Chapter[];
  chapterIndex?: number;
  /** worldData — used by Continuity (place hand-off) and Character Voice
   *  (gender / pronoun reconciliation). */
  worldData?: WorldData;
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
        <input
          type="range" min={14} max={26} step={1}
          value={typography.fontSize}
          onChange={(e) => setTypography({ fontSize: Number(e.target.value) })}
          className="settings-range"
        />
      </div>

      <div className="settings-stack">
        <div className="settings-stack-head">
          <label className="settings-label">Line height</label>
          <span className="settings-value">{typography.lineHeight.toFixed(2)}</span>
        </div>
        <input
          type="range" min={1.3} max={2.2} step={0.05}
          value={typography.lineHeight}
          onChange={(e) => setTypography({ lineHeight: Number(e.target.value) })}
          className="settings-range"
        />
      </div>

      <div className="settings-stack">
        <div className="settings-stack-head">
          <label className="settings-label">Measure</label>
          <span className="settings-value">{typography.measure}ch</span>
        </div>
        <input
          type="range" min={50} max={100} step={2}
          value={typography.measure}
          onChange={(e) => setTypography({ measure: Number(e.target.value) })}
          className="settings-range"
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

      <p className="settings-hint">
        Settings persist locally. Goals reset at midnight.
      </p>
    </div>
  );
}

// Animated collapse/expand wrapper for conditionally-present widgets.
// Mounts immediately but starts in the collapsed (--off) state so the entry
// CSS transition plays from height:0 → natural height. On hide, the CSS
// transition plays first, then the element is removed from the DOM after the
// transition ends so the surrounding stack smoothly closes the gap.
function AnimatedWidget({ show, children }: { show: boolean; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(show);
  const [on, setOn] = useState(show);
  const frameRef = useRef(0);

  useEffect(() => {
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
  }, [show]);

  if (!mounted) return null;
  return (
    <div className={`widget-anim ${on ? "widget-anim--on" : "widget-anim--off"}`}>
      <div className="widget-anim-inner">{children}</div>
    </div>
  );
}

function WidgetSet({
  result, prevResult, nextResult, showCrossArc,
  chapterContent, allChapters, chapterIndex, worldData,
}: {
  result: ChapterAnalysisResult;
  prevResult: ChapterAnalysisResult | null;
  nextResult: ChapterAnalysisResult | null;
  showCrossArc: boolean;
  chapterContent?: string;
  allChapters?: Chapter[];
  chapterIndex?: number;
  worldData?: WorldData;
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
  const hasProseProfile = !!chapterContent && chapterContent.trim().split(/\s+/).length > 80;
  const hasContinuityCtx = !!allChapters && allChapters.length > 1 && chapterIndex != null && chapterIndex >= 0;
  const hasCharacterVoice = result.paragraphs.length > 0 && a.speakerCounts.length >= 2;

  return (
    <>
      <AnimatedWidget show={hasDiagnostics}><DiagnosticsWidget analysis={a} /></AnimatedWidget>
      <AnimatedWidget show={!!hi}><ShapingWidget analysis={a} /></AnimatedWidget>
      <TensionWidget
        analysis={a}
        paragraphs={result.paragraphs}
        speechResults={result.speechResults}
      />
      <AnimatedWidget show={!!hi}><StructureWidget analysis={a} /></AnimatedWidget>
      <AnimatedWidget show={hasMomentum}><MomentumWidget analysis={a} /></AnimatedWidget>
      <AnimatedWidget show={showCrossArc}>
        <CrossArcWidget current={result} prev={prevResult} next={nextResult} />
      </AnimatedWidget>
      <AnimatedWidget show={showCrossArc && (!!prevResult || !!nextResult)}>
        <CrossPacingWidget current={result} prev={prevResult} next={nextResult} />
      </AnimatedWidget>
      {/* Continuity slots between cross-pacing and prose profile so cross-
          chapter and chapter-level structural notes sit together visually. */}
      <AnimatedWidget show={hasContinuityCtx}>
        <ContinuityWidget
          chapters={allChapters ?? []}
          worldData={worldData}
          chapterIndex={chapterIndex ?? -1}
        />
      </AnimatedWidget>
      <AnimatedWidget show={hasProseProfile}>
        <ProseProfileWidget content={chapterContent ?? ""} />
      </AnimatedWidget>
      <AnimatedWidget show={hasSensory}><SensoryBalanceWidget analysis={a} /></AnimatedWidget>
      <AnimatedWidget show={hasStyleContent}>
        <StyleWatchWidget content={chapterContent ?? ""} />
      </AnimatedWidget>
      <AnimatedWidget show={hasCharacterVoice}>
        <CharacterVoiceWidget
          paragraphs={result.paragraphs}
          speechResults={result.speechResults}
          worldData={worldData}
          content={chapterContent ?? ""}
        />
      </AnimatedWidget>
      <AnimatedWidget show={!!hi || hasCast}><VoiceWidget analysis={a} /></AnimatedWidget>
      <AnimatedWidget show={hasCast}><CastWidget analysis={a} /></AnimatedWidget>
      <RoleWidget analysis={a} />
    </>
  );
}

export function AnalysisPanel({
  result, prevResult, nextResult, isAnalyzing, intelMode, onSetIntelMode,
  prefs, onSetPrefs, chapterId, chapterContent,
  allChapters, chapterIndex, worldData,
}: Props) {
  // High-mode gating mirrors the reader: cross-arc data is only meaningful
  // under high intelligence. Auto resolves dynamically per chapter, so we
  // permit it whenever the resolved analysis itself includes highModeAnalysis.
  const showCrossArc =
    intelMode === "high" ||
    (intelMode === "auto" && !!result?.analysis.highModeAnalysis);
  const [view, setView] = useState<"widgets" | "settings" | null>(null);

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
      exitTimer.current = window.setTimeout(() => setExiting(null), 300);
      setRevealKey((k) => k + 1);
    }
    setDisplayed(result);
  }, [result, chapterId, displayed]);

  useEffect(() => () => {
    if (exitTimer.current) window.clearTimeout(exitTimer.current);
  }, []);

  const toggle = (target: "widgets" | "settings") =>
    setView((v) => (v === target ? null : target));

  const isOpen = view !== null;
  const hasContent = displayed && displayed.paragraphs.length > 0;

  const widgetCount = !hasContent ? 0 : (() => {
    const a = displayed!.analysis;
    let n = 2; // tension + role always
    if (a.writerDiagnostics.length > 0) n++;
    if (a.highModeAnalysis) n += 2; // shaping + structure
    if (showCrossArc) n++; // cross-arc widget
    if (a.highModeAnalysis || a.speakerCounts.length > 0) n++;
    if (a.speakerCounts.length > 0) n++;
    if (chapterContent && chapterContent.trim().length > 50) n++;       // style watch
    if (chapterContent && chapterContent.trim().split(/\s+/).length > 80) n++; // prose profile
    if (allChapters && allChapters.length > 1 && chapterIndex != null) n++;    // continuity (may suppress at render)
    if (a.speakerCounts.length >= 2) n++;                                // character voice
    return n;
  })();

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
                    chapterContent={chapterContent}
                    allChapters={allChapters}
                    chapterIndex={chapterIndex}
                    worldData={worldData}
                  />
                </div>
              </div>
            ) : (
              <div className="widget-list" key={`placeholder-${placeholderVariant}`}>
                <PlaceholderWidget variant={placeholderVariant} />
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
      </div>
    </div>
  );
}
