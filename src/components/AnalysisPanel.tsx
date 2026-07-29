import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ChapterAnalysisResult } from "../lib/use-analysis";
import { buildChapterObservation } from "../lib/chapter-observation";
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
import { ChevronRight as ChevronIcon, SettingsIcon, PilcrowIcon, LayersIcon, Wand2Icon, resolveToolIcon } from "./Icon";
import { StoryGraphPanel } from "./StoryGraphPanel";
import { RendererPanel } from "./RendererPanel";
import { WidgetConfigOverlay } from "./WidgetConfigOverlay";
import type { StoryGraph, ReviewResult } from "../types";
import { SeparatorHorizontal } from "lucide-react";
import { IOS_COLORS } from "../lib/palette";
import type { Preferences, Typography, WritingGoals } from "../lib/preferences";
import { FONT_LABELS } from "../lib/preferences";
import { NumberStepper } from "./NumberStepper";
import { GlassRange } from "./GlassRange";
import { GlassToggle } from "./GlassToggle";
import {
  type WidgetConfig,
  type WidgetConfigEntry,
  type WidgetMeta,
  loadWidgetConfig,
  loadWidgetConfigFromProject,
  saveWidgetConfig,
} from "../lib/widget-config";
import { isDesktopApp } from "../lib/project-manager";
import { activateCode, clearLicense, type Tier } from "../lib/license";
import { ProBadge, LockedHint } from "./ProBadge";
import { useRendererActive } from "../lib/renderer-active-store";
import { type ToolRegistry, type RegisteredTool, EMPTY_REGISTRY, buildToolRegistry } from "../lib/tool-registry";

const ToolWidgetSlot = lazy(() => import("./widgets/ToolWidgetSlot").then(m => ({ default: m.ToolWidgetSlot })));

const EMPTY_CHAPTERS: Chapter[] = [];

type IntelMode = "off" | "fast" | "default" | "high" | "auto";

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
  onNovelRefresh?: (novel: import("../types").Novel | null) => void;
  onImportTools?: () => void;
  onToolHighlights?: (highlights: import("../lib/tool-runner").ToolHighlight[]) => void;
  /** Scrolls the editor to a paragraph — wired to the chapter observation. */
  onJumpToParagraph?: (paragraphIndex: number) => void;
  tier: Tier;
  onTierChange: (t: Tier) => void;
}

// Converge-on-idle removed the tier choice: a fast pass runs while typing
// and a deep pass replaces it when the writer pauses. The only decision left
// to make is whether the layer is on at all.
const INTEL_LEVELS: { value: IntelMode; label: string; desc: string; color: string }[] = [
  { value: "off",  label: "Off", desc: "No highlighting",                                        color: "#888888" },
  { value: "auto", label: "On",  desc: "Fast pass while typing, deep pass refines when you pause", color: IOS_COLORS.indigo.text },
];

interface SettingsProps {
  intelMode: IntelMode;
  onSetIntelMode: (m: IntelMode) => void;
  prefs: Preferences;
  onSetPrefs: (next: Preferences) => void;
  onImportTools?: () => void;
  tier: Tier;
  onTierChange: (t: Tier) => void;
}

const FONT_OPTIONS: Typography["fontFamily"][] = ["georgia", "iowan", "system", "sf-pro", "menlo"];

function SettingsPanel({ intelMode, onSetIntelMode, prefs, onSetPrefs, onImportTools, tier, onTierChange }: SettingsProps) {
  const { typography, goals } = prefs;
  const [lockedHintFor, setLockedHintFor] = useState<IntelMode | null>(null);
  const [codeInput, setCodeInput] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeSuccess, setCodeSuccess] = useState(false);
  const [isActivating, setIsActivating] = useState(false);

  const handleActivate = async () => {
    if (isActivating) return;
    setIsActivating(true);
    const result = await activateCode(codeInput);
    setIsActivating(false);
    if (result.ok) {
      setCodeInput("");
      setCodeSuccess(true);
      setCodeError(null);
      onTierChange("pro");
    } else {
      setCodeError(result.error ?? "Invalid code.");
      setCodeSuccess(false);
    }
  };

  const setTypography = (t: Partial<Typography>) =>
    onSetPrefs({ ...prefs, typography: { ...typography, ...t } });
  const setGoals = (g: Partial<WritingGoals>) =>
    onSetPrefs({ ...prefs, goals: { ...goals, ...g } });

  return (
    <div className="settings-panel liquid-glass" data-liquid-glass-scroll-adaptive="panel">
      {/* Inner wrapper carries the scroll. Keeping the scroll INSIDE
          the panel (not on .settings-panel itself) lets the panel's
          .liquid-glass::before specular ring stay anchored to the
          card edges instead of scrolling away with the content. */}
      <div className="settings-panel-scroll">
      <p className="settings-section-label">Intelligence</p>
      <div className="settings-intel-grid">
        {INTEL_LEVELS.map(({ value, label, desc, color }) => {
          // Both remaining choices (On / Off) are free-tier — converge gives
          // everyone the deep pass; Pro differentiates on renderer/tools.
          const isLocked = false;
          return (
            <button
              key={value}
              className={`settings-intel-btn ${intelMode === value ? "settings-intel-btn--active" : ""}${isLocked ? " settings-intel-btn--locked" : ""}`}
              style={intelMode === value ? { "--intel-color": color } as CSSProperties : undefined}
              onClick={() => {
                if (isLocked) {
                  setLockedHintFor(lockedHintFor === value ? null : value);
                } else {
                  setLockedHintFor(null);
                  onSetIntelMode(value);
                }
              }}
            >
              <span className="settings-intel-label" style={{ color: intelMode === value ? color : undefined }}>
                {label}
              </span>
              <span className="settings-intel-desc">{desc}</span>
              {isLocked && <ProBadge />}
            </button>
          );
        })}
      </div>
      <LockedHint visible={lockedHintFor !== null} />

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
      <div className="settings-toggle-row">
        <div className="settings-toggle-row-text">
          <span className="settings-toggle-row-title">Group tools</span>
          <span className="settings-toggle-row-desc">
            Split the top toolbar into separate glass tool groups and collapse the right tools into a more menu on smaller windows.
          </span>
        </div>
        <GlassToggle
          checked={!!prefs.groupTools}
          onChange={(v) => onSetPrefs({ ...prefs, groupTools: v })}
          ariaLabel="Toggle grouped toolbar tools"
        />
      </div>
      <div className="settings-toggle-row">
        <div className="settings-toggle-row-text">
          <span className="settings-toggle-row-title">Split screen</span>
          <span className="settings-toggle-row-desc">
            View two chapters side by side. Toggle with ⌘\.
          </span>
        </div>
        <GlassToggle
          checked={!!prefs.splitView}
          onChange={(v) => onSetPrefs({ ...prefs, splitView: v })}
          ariaLabel="Toggle split screen"
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

      <p className="settings-section-label">Advanced</p>
      <div className="settings-toggle-row">
        <div className="settings-toggle-row-text">
          <span className="settings-toggle-row-title">Custom tool plugins</span>
          <span className="settings-toggle-row-desc">
            Load custom tools from this project's tools/ directory.
          </span>
        </div>
        <GlassToggle
          checked={!!prefs.customToolsEnabled}
          onChange={(v) => onSetPrefs({ ...prefs, customToolsEnabled: v })}
          ariaLabel="Toggle custom tool plugins"
        />
      </div>
      {isDesktopApp() && onImportTools && (
        <button
          type="button"
          className="settings-import-tools-btn"
          onClick={onImportTools}
        >
          Import tools from project
        </button>
      )}

      <p className="settings-section-label">Account</p>
      {tier === "pro" ? (
        <div className="settings-toggle-row">
          <div className="settings-code-pro-status">
            <ProBadge />
            <span>Pro active</span>
          </div>
          <button
            type="button"
            className="settings-code-remove-btn"
            onClick={() => { clearLicense(); onTierChange("free"); }}
          >
            Remove
          </button>
        </div>
      ) : (
        <>
          <div className="settings-code-row">
            <input
              type="text"
              className="settings-code-input"
              placeholder="Enter your Pro code…"
              value={codeInput}
              spellCheck={false}
              onChange={(e) => { setCodeInput(e.target.value); setCodeError(null); setCodeSuccess(false); }}
              onKeyDown={(e) => { if (e.key === "Enter") { void handleActivate(); } }}
            />
            <button
              type="button"
              className={`settings-code-submit${codeInput.trim() ? " settings-code-submit--active" : ""}`}
              disabled={isActivating}
              onClick={() => { void handleActivate(); }}
            >
              {isActivating ? "…" : "Activate"}
            </button>
          </div>
          {codeError && <p className="settings-code-status settings-code-status--error">{codeError}</p>}
          {codeSuccess && <p className="settings-code-status settings-code-status--success">Pro activated!</p>}
          <p className="settings-hint">One-time purchase. Works offline.</p>
        </>
      )}

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
    // One setTimeout for the delay, one terminal RAF to sync to the next
    // paint boundary. No ongoing RAF loop — zero overhead during the wait.
    let rafId = 0;
    const timerId = window.setTimeout(() => {
      rafId = requestAnimationFrame(() => setReady(true));
    }, framesToWait * 16);
    return () => {
      window.clearTimeout(timerId);
      cancelAnimationFrame(rafId);
    };
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

interface WidgetSlotProps {
  result: ChapterAnalysisResult;
  prevResult: ChapterAnalysisResult | null;
  nextResult: ChapterAnalysisResult | null;
  showCrossArc: boolean;
  chapterContent: string;
  allChapters: Chapter[];
  chapterIndex: number;
  worldData?: WorldData;
  wordCount: number;
}

function resolveWidgetSlot(
  id: string,
  props: WidgetSlotProps,
): { show: boolean; element: React.ReactNode } | null {
  const { result, prevResult, nextResult, showCrossArc, chapterContent, allChapters, chapterIndex, worldData, wordCount } = props;
  const a = result.analysis;
  const hi = a.highModeAnalysis;

  switch (id) {
    case "diagnostics":
      return { show: a.writerDiagnostics.length > 0, element: <DiagnosticsWidget analysis={a} /> };
    case "shaping":
      return { show: !!hi, element: <ShapingWidget analysis={a} /> };
    case "tension":
      return { show: true, element: <TensionWidget analysis={a} paragraphs={result.paragraphs} speechResults={result.speechResults} /> };
    case "structure":
      return { show: !!hi, element: <StructureWidget analysis={a} /> };
    case "momentum":
      return { show: !!hi && hi.narrativeMomentum.segments.length > 0, element: <MomentumWidget analysis={a} /> };
    case "cross-arc":
      return { show: showCrossArc, element: <CrossArcWidget current={result} prev={prevResult} next={nextResult} /> };
    case "cross-pacing":
      return { show: showCrossArc && (!!prevResult || !!nextResult), element: <CrossPacingWidget current={result} prev={prevResult} next={nextResult} /> };
    case "continuity":
      return { show: allChapters.length > 1 && chapterIndex >= 0, element: <ContinuityWidget chapters={allChapters} worldData={worldData} chapterIndex={chapterIndex} /> };
    case "prose-profile":
      return { show: wordCount > 80, element: <ProseProfileWidget content={chapterContent} /> };
    case "sensory-balance":
      return { show: !!hi?.proseStyle && hi.proseStyle.topChannels.length > 0, element: <SensoryBalanceWidget analysis={a} /> };
    case "style-watch":
      return { show: chapterContent.trim().length > 50, element: <StyleWatchWidget content={chapterContent} /> };
    case "rhythm":
      return { show: chapterContent.trim().length > 50, element: <RhythmWidget content={chapterContent} /> };
    case "repetition":
      return { show: chapterContent.length > 200, element: <RepetitionWidget content={chapterContent} /> };
    case "title-suggester":
      return { show: result.paragraphs.length > 0, element: <TitleSuggesterWidget result={result} knownNames={a.speakerCounts.map(s => s.name)} /> };
    case "character-voice":
      return { show: result.paragraphs.length > 0 && a.speakerCounts.length >= 2, element: <CharacterVoiceWidget paragraphs={result.paragraphs} speechResults={result.speechResults} worldData={worldData} content={chapterContent} /> };
    case "voice":
      return { show: !!hi || a.speakerCounts.length > 0, element: <VoiceWidget analysis={a} /> };
    case "cast":
      return { show: a.speakerCounts.length > 0, element: <CastWidget analysis={a} /> };
    case "role":
      return { show: true, element: <RoleWidget analysis={a} /> };
    default:
      return null;
  }
}

function WidgetSet({
  result, prevResult, nextResult, showCrossArc,
  chapterContent, allChapters, chapterIndex, worldData, wordCount,
  widgetOrder, renderToolWidget,
}: {
  result: ChapterAnalysisResult;
  prevResult: ChapterAnalysisResult | null;
  nextResult: ChapterAnalysisResult | null;
  showCrossArc: boolean;
  chapterContent?: string;
  allChapters?: Chapter[];
  chapterIndex?: number;
  worldData?: WorldData;
  wordCount?: number;
  widgetOrder: WidgetConfigEntry[];
  renderToolWidget?: (toolName: string) => React.ReactNode;
}) {
  const slotProps: WidgetSlotProps = {
    result,
    prevResult,
    nextResult,
    showCrossArc,
    chapterContent: chapterContent ?? "",
    allChapters: allChapters ?? [],
    chapterIndex: chapterIndex ?? -1,
    worldData,
    wordCount: wordCount ?? 0,
  };

  let staggerIndex = 0;

  return (
    <>
      {widgetOrder.map((entry) => {
        if (!entry.enabled) return null;
        if (entry.id.startsWith("tool:")) {
          const order = staggerIndex++;
          return (
            <AnimatedWidget key={entry.id} order={order} show>
              {renderToolWidget?.(entry.id.slice(5))}
            </AnimatedWidget>
          );
        }
        const slot = resolveWidgetSlot(entry.id, slotProps);
        if (!slot) return null;
        const order = staggerIndex++;
        return (
          <AnimatedWidget key={entry.id} order={order} show={slot.show}>
            {slot.element}
          </AnimatedWidget>
        );
      })}
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
  reviewResult, onReviewComplete, onProjectLoaded, onNovelRefresh,
  onImportTools, onToolHighlights, onJumpToParagraph,
  tier, onTierChange,
}: Props) {
  // High-mode gating mirrors the reader: cross-arc data is only meaningful
  // under high intelligence. Auto resolves dynamically per chapter, so we
  // permit it whenever the resolved analysis itself includes highModeAnalysis.
  const showCrossArc =
    intelMode === "high" ||
    (intelMode === "auto" && !!result?.analysis.highModeAnalysis);
  const [view, setView] = useState<string | null>(null);
  const [widgetConfig, setWidgetConfig] = useState<WidgetConfig>(() => loadWidgetConfig());
  const [showWidgetConfig, setShowWidgetConfig] = useState(false);
  const [toolWidgetData, setToolWidgetData] = useState<Map<string, unknown>>(new Map());
  const [toolWidgetMetas, setToolWidgetMetas] = useState<WidgetMeta[]>([]);

  useEffect(() => {
    if (!isDesktopApp()) return;
    let cancelled = false;
    void loadWidgetConfigFromProject().then((cfg) => {
      if (!cancelled) setWidgetConfig(cfg);
    });
    return () => { cancelled = true; };
  }, []);

  const handleSaveWidgetConfig = useCallback((next: WidgetConfig) => {
    setWidgetConfig(next);
    saveWidgetConfig(next);
  }, []);

  const rendererActive = useRendererActive();

  const [toolRegistry, setToolRegistry] = useState<ToolRegistry>(EMPTY_REGISTRY);
  const toolProjectRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isDesktopApp() || !prefs.customToolsEnabled) {
      setToolRegistry(EMPTY_REGISTRY);
      toolProjectRef.current = null;
      return;
    }
    const api = window.electronAPI;
    if (!api) return;
    let cancelled = false;
    api.projectGetPath().then((currentPath: string | null) => {
      if (cancelled || !currentPath) return;
      if (currentPath === toolProjectRef.current) return;
      toolProjectRef.current = currentPath;
      const reader = {
        listTree: () => api.projectListTree().then((t: unknown) => (t as Array<{ name: string; path: string; type: string; children?: unknown[] }>) ?? []),
        readFile: (relPath: string) => api.projectReadFile(relPath),
      };
      buildToolRegistry(reader, { skipPrompts: true }).then(({ registry }) => {
        if (!cancelled) setToolRegistry(registry);
      });
    });
    return () => { cancelled = true; };
  }, [prefs.customToolsEnabled, chapterId]);

  useEffect(() => {
    const metas: WidgetMeta[] = toolRegistry.widgetTools.map((t) => ({
      id: `tool:${t.manifest.name}`,
      label: t.manifest.display,
      description: t.manifest.description,
    }));
    setToolWidgetMetas(metas);
    if (metas.length > 0) {
      if (isDesktopApp()) {
        void loadWidgetConfigFromProject(metas).then(setWidgetConfig);
      } else {
        setWidgetConfig(loadWidgetConfig(metas));
      }
    }

    if (!isDesktopApp() || toolRegistry.widgetTools.length === 0) return;
    const api = window.electronAPI;
    if (!api) return;
    const allTools = [...toolRegistry.widgetTools, ...toolRegistry.sidebarTools];
    const seen = new Set<string>();
    for (const tool of allTools) {
      const name = tool.manifest.name;
      if (seen.has(name)) continue;
      seen.add(name);
      const reportDir = tool.manifest.outputs.report;
      if (!reportDir) continue;
      const dir = reportDir.endsWith("/") ? reportDir : reportDir + "/";
      api.projectReadFile(`${dir}state.json`).then((result: { ok: boolean; content?: string }) => {
        if (!result.ok || !result.content) return;
        try {
          const saved = JSON.parse(result.content);
          setToolWidgetData((prev) => {
            const next = new Map(prev);
            next.set(name, saved);
            return next;
          });
        } catch {}
      });
    }
  }, [toolRegistry]);

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

  // Keep the heavy text-derived widgets bound to the settled analysis snapshot
  // instead of near-live chapter text. That preserves editor/highlight budget
  // while the widgets drawer is open under load.
  const widgetSnapshotContent = displayed?.contentSnapshot ?? "";

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
    (target: string) =>
      setView((v) => (v === target ? null : target)),
    [],
  );

  const isOpen = view !== null;
  const hasContent = displayed && displayed.paragraphs.length > 0;

  // One sentence about the chapter, with a location — the panel's entry
  // point. The widgets below remain the deep-dive (see chapter-observation.ts).
  const observation = useMemo(
    () => (displayed ? buildChapterObservation(displayed, prevResult) : null),
    [displayed, prevResult],
  );

  useLayoutEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);

  // Word-count threshold check used twice (widgetCount badge + WidgetSet
  // gating). Computing once at this level avoids a second .split on every
  // render and keeps the count badge stable across keystrokes.
  const widgetWordCount = useMemo(
    () => (widgetSnapshotContent ? widgetSnapshotContent.trim().split(/\s+/).length : 0),
    [widgetSnapshotContent],
  );

  const enabledWidgetIds = useMemo(
    () => new Set(widgetConfig.order.filter((e) => e.enabled).map((e) => e.id)),
    [widgetConfig],
  );

  const toolWidgetMap = useMemo(() => {
    const m = new Map<string, RegisteredTool>();
    for (const t of toolRegistry.widgetTools) m.set(t.manifest.name, t);
    return m;
  }, [toolRegistry.widgetTools]);

  const renderToolWidget = useCallback((toolName: string) => {
    const tool = toolWidgetMap.get(toolName);
    if (!tool) return null;
    return (
      <Suspense fallback={null}>
        <ToolWidgetSlot
          tool={tool}
          widgetData={toolWidgetData.get(toolName) ?? null}
          chapterTitle={chapterTitle ?? ""}
          isAnalyzing={isAnalyzing}
        />
      </Suspense>
    );
  }, [toolWidgetMap, toolWidgetData, chapterTitle, isAnalyzing]);

  const widgetCount = useMemo(() => {
    if (!hasContent) return 0;
    const a = displayed!.analysis;
    let n = 0;
    const hi = a.highModeAnalysis;
    const checks: Record<string, boolean> = {
      "diagnostics": a.writerDiagnostics.length > 0,
      "shaping": !!hi,
      "tension": true,
      "structure": !!hi,
      "momentum": !!hi && hi.narrativeMomentum.segments.length > 0,
      "cross-arc": showCrossArc,
      "cross-pacing": showCrossArc,
      "continuity": !!debouncedChapters && debouncedChapters.length > 1 && chapterIndex != null,
      "prose-profile": widgetWordCount > 80,
      "sensory-balance": !!hi?.proseStyle && hi.proseStyle.topChannels.length > 0,
      "style-watch": !!widgetSnapshotContent && widgetSnapshotContent.trim().length > 50,
      "rhythm": !!widgetSnapshotContent && widgetSnapshotContent.trim().length > 50,
      "repetition": (widgetSnapshotContent?.length ?? 0) > 200,
      "title-suggester": displayed!.paragraphs.length > 0,
      "character-voice": displayed!.paragraphs.length > 0 && a.speakerCounts.length >= 2,
      "voice": !!hi || a.speakerCounts.length > 0,
      "cast": a.speakerCounts.length > 0,
      "role": true,
    };
    for (const [id, visible] of Object.entries(checks)) {
      if (visible && enabledWidgetIds.has(id)) n++;
    }
    return n;
  }, [hasContent, displayed, showCrossArc, widgetSnapshotContent, widgetWordCount, debouncedChapters, chapterIndex, enabledWidgetIds]);

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

        {toolRegistry.sidebarTools.length > 0 && toolRegistry.sidebarTools.map((tool) => {
          const IconComp = resolveToolIcon(tool.manifest.sidebar?.icon ?? "");
          const viewKey = `sidebar:${tool.manifest.name}`;
          return (
            <button
              key={tool.manifest.name}
              className={`analysis-tab analysis-tab--settings ${view === viewKey ? "analysis-tab--active" : ""}`}
              onClick={() => toggle(viewKey)}
              aria-label={tool.manifest.display}
              title={tool.manifest.display}
            >
              <IconComp size={13} />
            </button>
          );
        })}

        <button
          className={`analysis-tab analysis-tab--settings ${view === "graph" ? "analysis-tab--active" : ""}`}
          onClick={() => toggle("graph")}
          aria-label="Story graph"
          title="Story graph"
        >
          <LayersIcon size={13} />
        </button>

        <button
          className={`analysis-tab analysis-tab--settings ${view === "renderer" ? "analysis-tab--active" : ""}${rendererActive && view !== "renderer" ? " analysis-tab--renderer-active" : ""}`}
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
              <>
              {observation && (
                <div
                  className="chapter-observation liquid-glass"
                  data-liquid-glass-scroll-adaptive="panel"
                >
                  <span className="chapter-observation-eyebrow">This chapter</span>
                  <p className="chapter-observation-text">
                    {observation.text}
                    {observation.paragraphIndex !== undefined && onJumpToParagraph && (
                      <button
                        type="button"
                        className="chapter-observation-jump"
                        onClick={() => onJumpToParagraph(observation.paragraphIndex!)}
                      >
                        Go to ¶{observation.paragraphIndex + 1}
                      </button>
                    )}
                  </p>
                </div>
              )}
              <div className="widget-list-stack">
                {exiting && (
                  <div className="widget-list widget-list--exiting" aria-hidden>
                    <WidgetSet
                      result={exiting}
                      prevResult={prevResult}
                      nextResult={nextResult}
                      showCrossArc={showCrossArc}
                      chapterContent={exiting.contentSnapshot ?? ""}
                      allChapters={allChapters}
                      chapterIndex={chapterIndex}
                      worldData={worldData}
                      widgetOrder={widgetConfig.order}
                      renderToolWidget={renderToolWidget}
                    />
                  </div>
                )}
                <div className="widget-list" key={revealKey}>
                  <WidgetSet
                    result={displayed!}
                    prevResult={prevResult}
                    nextResult={nextResult}
                    showCrossArc={showCrossArc}
                    chapterContent={widgetSnapshotContent}
                    allChapters={debouncedChapters}
                    chapterIndex={chapterIndex}
                    worldData={worldData}
                    wordCount={widgetWordCount}
                    widgetOrder={widgetConfig.order}
                    renderToolWidget={renderToolWidget}
                  />
                  {toolRegistry.overlayTools.length > 0 && (
                    <Suspense fallback={null}>
                      {toolRegistry.overlayTools.map((tool) => (
                        <ToolWidgetSlot
                          key={`overlay-${tool.manifest.name}`}
                          tool={tool}
                          widgetData={toolWidgetData.get(tool.manifest.name) ?? null}
                          chapterTitle={chapterTitle ?? ""}
                          isAnalyzing={isAnalyzing}
                        />
                      ))}
                    </Suspense>
                  )}
                  <button
                    type="button"
                    className="wc-edit-pill"
                    onClick={() => setShowWidgetConfig(true)}
                  >
                    Edit Widgets
                  </button>
                </div>
              </div>
              </>
            ) : (
              <div className="widget-list" key={`placeholder-${placeholderVariant}`}>
                <PlaceholderWidget variant={placeholderVariant} intelMode={intelMode} />
              </div>
            )}
          </div>
        )}

        {showWidgetConfig && (
          <WidgetConfigOverlay
            config={widgetConfig}
            extraMetas={toolWidgetMetas}
            onSave={handleSaveWidgetConfig}
            onClose={() => setShowWidgetConfig(false)}
          />
        )}

        {view === "settings" && (
          <div className="analysis-inner analysis-inner--settings">
            <SettingsPanel
              intelMode={intelMode}
              onSetIntelMode={onSetIntelMode}
              prefs={prefs}
              onSetPrefs={onSetPrefs}
              onImportTools={onImportTools}
              tier={tier}
              onTierChange={onTierChange}
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

        <div className="analysis-inner analysis-inner--settings" style={{ display: view === "renderer" ? undefined : "none" }}>
          <RendererPanel
            visible={view === "renderer"}
            chapterId={chapterId ?? null}
            chapterContent={chapterContent}
            chapterTitle={chapterTitle}
            needsProjectSaveWarning={needsProjectSaveWarning}
            reviewResult={reviewResult ?? null}
            onReviewComplete={(r) => onReviewComplete?.(r)}
            prefs={prefs}
            onSetPrefs={onSetPrefs}
            onProjectLoaded={(n) => onProjectLoaded?.(n)}
            onNovelRefresh={(n) => onNovelRefresh?.(n)}
            chapterAnalysis={result?.analysis ?? null}
            chapterSpeechResults={result?.speechResults}
            worldData={worldData}
            allChapters={allChapters}
            chapterIndex={chapterIndex}
            onToolHighlights={onToolHighlights}
            onToolWidgetData={(name, data) => setToolWidgetData(prev => {
              const next = new Map(prev);
              next.set(name, data);
              return next;
            })}
            tier={tier}
            onTierChange={onTierChange}
          />
        </div>

        {view?.startsWith("sidebar:") && (() => {
          const toolName = view.slice("sidebar:".length);
          const tool = toolRegistry.sidebarTools.find(t => t.manifest.name === toolName);
          if (!tool) return null;
          return (
            <div className="analysis-inner analysis-inner--settings">
              <Suspense fallback={null}>
                <ToolWidgetSlot
                  tool={tool}
                  widgetData={toolWidgetData.get(toolName) ?? null}
                  chapterTitle={chapterTitle ?? ""}
                  isAnalyzing={isAnalyzing}
                  surface="sidebar"
                />
              </Suspense>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
