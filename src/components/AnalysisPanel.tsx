import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ChapterAnalysisResult } from "../lib/use-analysis";
import { buildChapterBrief } from "../lib/chapter-observation";
import { selectDisplayChips } from "../lib/narrative-events";
import { useDebouncedValue } from "../lib/use-debounced";
import { TensionWidget } from "./widgets/TensionWidget";
import { StyleWatchWidget } from "./widgets/StyleWatchWidget";
import { RhythmWidget } from "./widgets/RhythmWidget";
import { RepetitionWidget } from "./widgets/RepetitionWidget";
import { ProseProfileWidget } from "./widgets/ProseProfileWidget";
import { ContinuityWidget } from "./widgets/ContinuityWidget";
import { CharacterVoiceWidget } from "./widgets/CharacterVoiceWidget";
import { ScrollEdgeRight } from "./ScrollEdgeRight";
import type { Chapter, WorldData } from "../types";
import { DiagnosticsWidget } from "./widgets/DiagnosticsWidget";
import { ShapingWidget } from "./widgets/ShapingWidget";
import { VoiceWidget } from "./widgets/VoiceWidget";
import { CastWidget } from "./widgets/CastWidget";
import { RoleWidget } from "./widgets/RoleWidget";
import { CrossArcWidget } from "./widgets/CrossArcWidget";
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
  WIDGET_REGISTRY,
  loadWidgetConfig,
  loadWidgetConfigFromProject,
  saveWidgetConfig,
} from "../lib/widget-config";
import { WidgetHelpContext } from "./widgets/WidgetCard";
import { isDesktopApp } from "../lib/project-manager";
import type { AssistantStatus, AssistantPreset } from "../lib/project-manager";
import type { KnowledgeCandidate, KnowledgeLedgerStore } from "../lib/knowledge-store";
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
  /** Knowledge ledger — read-only here; the widget renders surfaced findings. */
  knowledgeStore?: KnowledgeLedgerStore;
  onKnowledgeKnewAlready?: (candidate: KnowledgeCandidate) => void;
  onKnowledgeGoodCatch?: (candidate: KnowledgeCandidate) => void;
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
  /** Opens a chapter and selects a stored event's source clause — wired to the
   *  story timeline, which is the only surface that spans chapters. */
  onJumpToEvent?: (chapterId: string, event: { sentence?: string; paragraphIndex?: number }) => void;
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

// The row names what the model DOES across the app, not the first task that
// happened to need it: it sharpens the entity scan, picks and writes the
// timeline's chips and chapter summaries, and checks who could know what.
const ASSISTANT_DESC = "Sharper entity scanning, timeline chips and continuity checks, using a small model that runs entirely on this Mac.";

/** Bytes → the honest figure the settings copy promises ("1.1 GB"). */
function gb(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/**
 * The assistant row's second line. It is the ONLY place this feature reports
 * itself: download progress, readiness with its real memory cost, and errors
 * all replace the description in place — never a dialog, never a new surface.
 */
function assistantStatusLine(status: AssistantStatus | null, enabled: boolean): string {
  if (!status) return ASSISTANT_DESC;
  const label = status.model?.label || "assistant model";
  if (status.state === "downloading") {
    const fraction = status.progress?.fraction ?? 0;
    const size = status.model?.bytes ? ` · ${gb(status.model.bytes)}` : "";
    return `downloading ${label}${size} · ${Math.round(fraction * 100)}%`;
  }
  if (status.state === "low-memory") return "paused: not enough free memory right now";
  if (status.state === "error") return status.error || "paused: the assistant could not start";
  if (!enabled) return ASSISTANT_DESC;
  if (status.state === "loading") return `loading ${label} · uses ≈1.5 GB of memory while checking`;
  if (status.state === "ready" || status.state === "busy") {
    return "ready · uses ≈1.5 GB of memory while checking";
  }
  return ASSISTANT_DESC;
}

/**
 * "Local enhancements" — the one opt-in for the local model, which now serves
 * several engines (entity review, timeline chips, chapter summaries,
 * continuity adjudication), so the row is named for the capability rather than
 * for any one task. Desktop only: the browser build has no runtime to opt into,
 * so the row does not exist there rather than existing and refusing.
 */
function AssistantSettingsRow({ prefs, onSetPrefs }: { prefs: Preferences; onSetPrefs: (next: Preferences) => void }) {
  const enabled = !!prefs.assistant?.enabled;
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sourceDraft, setSourceDraft] = useState(prefs.assistant?.sourceUrl ?? "");
  const [presets, setPresets] = useState<AssistantPreset[]>([]);

  useEffect(() => {
    if (!menuOpen || presets.length) return;
    void window.electronAPI?.assistantPresets?.()
      .then((r) => setPresets(r?.presets ?? []))
      .catch(() => {});
  }, [menuOpen, presets.length]);

  // A source saved on a previous launch has to reach the runtime before the
  // first download, and the runtime holds it in memory only.
  useEffect(() => {
    const url = prefs.assistant?.sourceUrl;
    if (!url) return;
    void window.electronAPI?.assistantSetSource?.({ url }).catch(() => {});
  }, [prefs.assistant?.sourceUrl]);

  // Status is read when this panel mounts, and refreshed by the runtime's own
  // download events while it is open. No interval, and nothing running when
  // the panel is closed — the writer is not paying for a settings row.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    let cancelled = false;
    const refresh = () => {
      void api.assistantStatus().then((next) => { if (!cancelled) setStatus(next); }).catch(() => {});
    };
    refresh();
    const off = api.onAssistantProgress?.(() => refresh());
    return () => { cancelled = true; off?.(); };
  }, []);

  const handleToggle = (next: boolean) => {
    onSetPrefs({ ...prefs, assistant: { ...(prefs.assistant ?? {}), enabled: next } });
    const api = window.electronAPI;
    if (!api) return;
    if (!next) {
      void api.assistantUnload().catch(() => {});
      void api.assistantStatus().then(setStatus).catch(() => {});
      return;
    }
    setBusy(true);
    // "auto" is the runtime's own choice, so it is expressed by NOT pinning a
    // tier; only an explicit pin travels.
    const opts = prefs.assistant?.tier === "small" ? { tier: "small" as const } : undefined;
    void api.assistantEnsureModel(opts)
      .catch(() => undefined)
      .then(() => api.assistantStatus())
      .then((s) => setStatus(s ?? null))
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  const downloading = status?.state === "downloading";
  const fraction = status?.progress?.fraction ?? 0;
  const modelPresent = !!status?.model?.present;

  const handleDelete = () => {
    const api = window.electronAPI;
    if (!api?.assistantDeleteModel) return;
    setBusy(true);
    void api.assistantDeleteModel()
      .catch(() => undefined)
      .then(() => api.assistantStatus())
      .then((s) => setStatus(s ?? null))
      .catch(() => {})
      .finally(() => { setBusy(false); setMenuOpen(false); });
  };

  const handleSaveSource = () => {
    const api = window.electronAPI;
    const url = sourceDraft.trim();
    const next = url === "" ? undefined : url;
    onSetPrefs({ ...prefs, assistant: { ...(prefs.assistant ?? { enabled }), sourceUrl: next } });
    void api?.assistantSetSource?.(next ? { url: next } : null).catch(() => {});
    setMenuOpen(false);
  };

  return (
    <>
      <div className="settings-toggle-row">
        <div className="settings-toggle-row-text">
          <span className="settings-toggle-row-title">Local enhancements</span>
          <span className="settings-toggle-row-desc">
            {busy && !status ? ASSISTANT_DESC : assistantStatusLine(status, enabled)}
          </span>
          {/* ★ THE BAR ONLY EXISTS WHILE THERE IS PROGRESS TO REPORT. A download
              is the one thing here with a real end, so it gets the one control
              that implies one; the status line above already carries the words.
              Same fill token as the slider and the toggle, so "how far along"
              reads in the same blue as every other value in the panel. */}
          {downloading && (
            <div
              className="assistant-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(fraction * 100)}
              aria-label="Downloading the assistant model"
            >
              <div className="assistant-progress-fill" style={{ width: `${Math.max(2, fraction * 100)}%` }} />
            </div>
          )}
        </div>
        {/* The second layer, behind a dots affordance: everything here is for
            the day the pinned source stops working, which is not most days. */}
        <button
          type="button"
          className="assistant-more"
          aria-label={menuOpen ? "Hide model options" : "Model options"}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          ⋯
        </button>
        <GlassToggle
          checked={enabled}
          onChange={handleToggle}
          ariaLabel="Toggle local enhancements"
        />
      </div>

      {menuOpen && (
        <div className="assistant-options">
          <span className="assistant-options-label">Model</span>
          {/* ★ THE DEFAULT STAYS ONE CLICK AWAY. Customisation that cannot be
              undone by pointing at a thing is a trap, so the tuned model is the
              first row and choosing it clears the custom entry outright. */}
          <div className="assistant-presets">
            {presets.map((preset) => {
              const active = preset.builtin ? !sourceDraft : sourceDraft === preset.url;
              return (
                <button
                  key={preset.id}
                  type="button"
                  className="assistant-preset"
                  data-active={active || undefined}
                  onClick={() => {
                    const url = preset.url ?? "";
                    setSourceDraft(url);
                    onSetPrefs({
                      ...prefs,
                      assistant: { ...(prefs.assistant ?? { enabled }), sourceUrl: url || undefined },
                    });
                    void window.electronAPI?.assistantSetSource?.(
                      preset.builtin || !preset.url ? null : {
                        id: preset.id, label: preset.label, url: preset.url,
                        contextSize: preset.contextSize, noThink: preset.noThink,
                      },
                    ).catch(() => {});
                  }}
                >
                  <span className="assistant-preset-name">{preset.label}</span>
                  {preset.note && <span className="assistant-preset-note">{preset.note}</span>}
                </button>
              );
            })}
          </div>
          <label className="assistant-options-label" htmlFor="assistant-source">
            Or a direct URL
          </label>
          <input
            id="assistant-source"
            className="settings-code-input"
            type="url"
            spellCheck={false}
            placeholder="https://…/model.gguf — leave empty for the default"
            value={sourceDraft}
            onChange={(e) => setSourceDraft(e.currentTarget.value)}
            onBlur={handleSaveSource}
            onKeyDown={(e) => { if (e.key === "Enter") handleSaveSource(); }}
          />
          <p className="assistant-options-hint">
            A direct link to the same GGUF file. Use this if the default source is
            unreachable; the download is still checked against the expected file.
          </p>
          <button
            type="button"
            className="assistant-options-danger"
            disabled={!modelPresent || busy}
            onClick={handleDelete}
          >
            {modelPresent
              ? `Delete downloaded model${status?.model?.bytes ? ` (${gb(status.model.bytes)})` : ""}`
              : "No model downloaded"}
          </button>
        </div>
      )}
    </>
  );
}

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

      {isDesktopApp() && <AssistantSettingsRow prefs={prefs} onSetPrefs={onSetPrefs} />}

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
  knowledgeStore?: KnowledgeLedgerStore;
  onKnowledgeKnewAlready?: (candidate: KnowledgeCandidate) => void;
  onKnowledgeGoodCatch?: (candidate: KnowledgeCandidate) => void;
}

function resolveWidgetSlot(
  id: string,
  props: WidgetSlotProps,
): { show: boolean; element: React.ReactNode } | null {
  const {
    result, prevResult, nextResult, showCrossArc, chapterContent, allChapters, chapterIndex, worldData, wordCount,
    knowledgeStore, onKnowledgeKnewAlready, onKnowledgeGoodCatch,
  } = props;
  const a = result.analysis;
  const hi = a.highModeAnalysis;

  switch (id) {
    case "diagnostics":
      return { show: a.writerDiagnostics.length > 0, element: <DiagnosticsWidget analysis={a} /> };
    case "shaping":
      return { show: !!hi, element: <ShapingWidget analysis={a} /> };
    case "tension":
      return { show: true, element: <TensionWidget analysis={a} paragraphs={result.paragraphs} speechResults={result.speechResults} /> };
    case "cross-arc":
      return { show: showCrossArc, element: <CrossArcWidget current={result} prev={prevResult} next={nextResult} /> };
    case "continuity":
      return {
        show: allChapters.length > 1 && chapterIndex >= 0,
        element: (
          <ContinuityWidget
            chapters={allChapters}
            worldData={worldData}
            chapterIndex={chapterIndex}
            knowledgeStore={knowledgeStore}
            onKnewAlready={onKnowledgeKnewAlready}
            onGoodCatch={onKnowledgeGoodCatch}
          />
        ),
      };
    case "prose-profile":
      return { show: wordCount > 80, element: <ProseProfileWidget content={chapterContent} /> };
    case "style-watch":
      return { show: chapterContent.trim().length > 50, element: <StyleWatchWidget content={chapterContent} /> };
    case "rhythm":
      return { show: chapterContent.trim().length > 50, element: <RhythmWidget content={chapterContent} /> };
    case "repetition":
      return { show: chapterContent.length > 200, element: <RepetitionWidget content={chapterContent} /> };
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
  knowledgeStore, onKnowledgeKnewAlready, onKnowledgeGoodCatch,
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
  knowledgeStore?: KnowledgeLedgerStore;
  onKnowledgeKnewAlready?: (candidate: KnowledgeCandidate) => void;
  onKnowledgeGoodCatch?: (candidate: KnowledgeCandidate) => void;
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
    knowledgeStore,
    onKnowledgeKnewAlready,
    onKnowledgeGoodCatch,
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
        // The card chassis reads this to offer its "?" — copy lives once in
        // the registry, beside the widget's identity rather than its maths.
        const help = WIDGET_REGISTRY.find((meta) => meta.id === entry.id)?.help;
        return (
          <AnimatedWidget key={entry.id} order={order} show={slot.show}>
            <WidgetHelpContext.Provider value={help}>
              {slot.element}
            </WidgetHelpContext.Provider>
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
  storyGraph, knowledgeStore, onKnowledgeKnewAlready, onKnowledgeGoodCatch, onSelectChapter,
  reviewResult, onReviewComplete, onProjectLoaded, onNovelRefresh,
  onImportTools, onToolHighlights, onJumpToParagraph, onJumpToEvent,
  tier, onTierChange,
}: Props) {
  // ★ Widgets follow the DATA, not the mode toggle. High intelligence is the
  // default now (fast while typing, high on idle), so the deep analysis
  // always arrives — and a widget that hid because the SELECTOR was not on
  // "high" was hiding real, computed results. The old gate also had the
  // reverse bug: selector on "high" showed cross-arc widgets BEFORE the deep
  // pass landed, rendering them from fast-pass data. Presence of
  // highModeAnalysis is the one honest signal for both directions.
  const showCrossArc = !!result?.analysis.highModeAnalysis;
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
  const brief = useMemo(
    () => (displayed ? buildChapterBrief(displayed, prevResult, worldData) : null),
    [displayed, prevResult, worldData],
  );

  /**
   * The model's summary for THIS chapter, when one exists.
   *
   * ★ READ FROM THE STORY GRAPH, NOT RE-REQUESTED. The App effect already
   *   writes a summary per chapter for the timeline; the panel is a second
   *   reader of the same field, so opening it costs no inference and cannot
   *   race the scheduler. It is dropped the moment the chapter's events change
   *   (staleness by reconstruction), so a stale summary cannot outlive the
   *   text it describes.
   */
  const lmBrief = useMemo(() => {
    const entry = chapterId ? storyGraph?.entries[chapterId] : undefined;
    if (!entry?.lmSummary) return null;
    return { summary: entry.lmSummary, throughline: entry.lmThroughline };
  }, [chapterId, storyGraph]);

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
      "cross-arc": showCrossArc,
      "continuity": !!debouncedChapters && debouncedChapters.length > 1 && chapterIndex != null,
      "prose-profile": widgetWordCount > 80,
      "style-watch": !!widgetSnapshotContent && widgetSnapshotContent.trim().length > 50,
      "rhythm": !!widgetSnapshotContent && widgetSnapshotContent.trim().length > 50,
      "repetition": (widgetSnapshotContent?.length ?? 0) > 200,
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
              {brief && (
                <div
                  className="chapter-observation liquid-glass"
                  data-liquid-glass-scroll-adaptive="panel"
                >
                  <span className="chapter-observation-eyebrow">This chapter</span>

                  {/* The setting: who it is between, and where. */}
                  {brief.setting && (
                    <p className="chapter-observation-setting">{brief.setting}</p>
                  )}

                  {/* The lead line: what happens. Built from the detected events,
                      so it varies with the prose. The version this replaces chose
                      one of six templated sentences and gave a third of all
                      chapters the same one.

                      ★ ENHANCED MODE REPLACES THIS LINE, NOT THE SECTION. When
                      the local model has written a summary for this chapter it
                      says the same thing in prose a person would use, from the
                      same ranked moments the heuristic headline is assembled
                      from — so it belongs in the same slot rather than beside
                      it. Everything under it (the anchored lines, the jumpable
                      chips) is unchanged and still deterministic. Without a
                      summary this is byte-identical to before. */}
                  <p className="chapter-observation-text">{lmBrief?.summary ?? brief.headline}</p>
                  {lmBrief?.throughline && (
                    <p className="chapter-observation-setting">{lmBrief.throughline}</p>
                  )}

                  {/* Event chips. Each carries its own paragraph, so each is
                      individually jumpable — the source clause is the title, which
                      is the first time the panel has been able to show WHY an
                      event was called an event. */}
                  {brief.events.length > 0 && (
                    <div className="chapter-brief-events">
                      {/* Live brief events carry no lmChips, so this resolves to
                          the heuristic picks — routed through the ONE selector
                          anyway so no chip consumer can drift from the picker. */}
                      {selectDisplayChips({ majorEvents: brief.events }, 4).map((e, i) => (
                        <button
                          key={`${e.paragraphIndex}-${i}`}
                          type="button"
                          className="chapter-brief-chip"
                          data-narrative-type={e.type}
                          data-salience={e.salience}
                          title={`${e.type} · ${Math.round(e.confidence * 100)}% · ¶${e.paragraphIndex + 1}\n\n${e.sentence}`}
                          onClick={() => onJumpToParagraph?.(e.paragraphIndex)}
                          disabled={!onJumpToParagraph}
                        >
                          <span className="chapter-brief-chip__label">{e.label}</span>
                          <span className="chapter-brief-chip__at">¶{e.paragraphIndex + 1}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Supporting lines, each from a different dimension. */}
                  {brief.lines.length > 0 && (
                    <ul className="chapter-brief-lines">
                      {brief.lines.map((line, i) => (
                        <li key={i} className="chapter-brief-line" data-kind={line.kind}>
                          <span>{line.text}</span>
                          {line.paragraphIndex !== undefined && onJumpToParagraph && (
                            <button
                              type="button"
                              className="chapter-observation-jump"
                              onClick={() => onJumpToParagraph(line.paragraphIndex!)}
                            >
                              ¶{line.paragraphIndex + 1}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
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
                      knowledgeStore={knowledgeStore}
                      onKnowledgeKnewAlready={onKnowledgeKnewAlready}
                      onKnowledgeGoodCatch={onKnowledgeGoodCatch}
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
                    knowledgeStore={knowledgeStore}
                    onKnowledgeKnewAlready={onKnowledgeKnewAlready}
                    onKnowledgeGoodCatch={onKnowledgeGoodCatch}
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
              onJumpToEvent={onJumpToEvent ? (cid, evt) => { onJumpToEvent(cid, evt); setView(null); } : undefined}
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
