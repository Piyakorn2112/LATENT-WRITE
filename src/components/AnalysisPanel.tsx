import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ChapterAnalysisResult } from "../lib/use-analysis";
import { TensionWidget } from "./widgets/TensionWidget";
import { DiagnosticsWidget } from "./widgets/DiagnosticsWidget";
import { ShapingWidget } from "./widgets/ShapingWidget";
import { StructureWidget } from "./widgets/StructureWidget";
import { VoiceWidget } from "./widgets/VoiceWidget";
import { CastWidget } from "./widgets/CastWidget";
import { RoleWidget } from "./widgets/RoleWidget";
import { CrossArcWidget } from "./widgets/CrossArcWidget";
import { PlaceholderWidget } from "./widgets/PlaceholderWidget";
import { ChevronRight as ChevronIcon, SettingsIcon } from "./Icon";
import { IOS_COLORS } from "../lib/palette";

type IntelMode = "off" | "low" | "default" | "high" | "auto";

interface Props {
  result: ChapterAnalysisResult | null;
  prevResult: ChapterAnalysisResult | null;
  nextResult: ChapterAnalysisResult | null;
  isAnalyzing: boolean;
  intelMode: IntelMode;
  onSetIntelMode: (m: IntelMode) => void;
}

const INTEL_LEVELS: { value: IntelMode; label: string; desc: string; color: string }[] = [
  { value: "off",     label: "Off",     desc: "No highlighting",            color: "#888888" },
  { value: "auto",    label: "Auto",    desc: "Adapts to chapter content",  color: IOS_COLORS.green.text  },
  { value: "low",     label: "Low",     desc: "Fast, ~85% accuracy",        color: IOS_COLORS.orange.text },
  { value: "default", label: "Default", desc: "Balanced analysis",          color: IOS_COLORS.blue.text   },
  { value: "high",    label: "High",    desc: "Max accuracy",               color: IOS_COLORS.purple.text },
];

function SettingsPanel({ intelMode, onSetIntelMode }: { intelMode: IntelMode; onSetIntelMode: (m: IntelMode) => void }) {
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
      <p className="settings-hint">
        Higher intelligence uses wider context windows and more precise pronoun resolution.
      </p>
    </div>
  );
}

function WidgetSet({ result, prevResult, nextResult, showCrossArc }: {
  result: ChapterAnalysisResult;
  prevResult: ChapterAnalysisResult | null;
  nextResult: ChapterAnalysisResult | null;
  /** Cross-arc widget gated to high-intelligence mode only — matches the
   *  reader's `analysis.highModeAnalysis`-gated Arc row. */
  showCrossArc: boolean;
}) {
  return (
    <>
      <DiagnosticsWidget analysis={result.analysis} />
      <ShapingWidget analysis={result.analysis} />
      <TensionWidget analysis={result.analysis} />
      <StructureWidget analysis={result.analysis} />
      {showCrossArc && (
        <CrossArcWidget current={result} prev={prevResult} next={nextResult} />
      )}
      <VoiceWidget analysis={result.analysis} />
      <CastWidget analysis={result.analysis} />
      <RoleWidget analysis={result.analysis} />
    </>
  );
}

export function AnalysisPanel({
  result, prevResult, nextResult, isAnalyzing, intelMode, onSetIntelMode,
}: Props) {
  // High-mode gating mirrors the reader: cross-arc data is only meaningful
  // under high intelligence. Auto resolves dynamically per chapter, so we
  // permit it whenever the resolved analysis itself includes highModeAnalysis.
  const showCrossArc =
    intelMode === "high" ||
    (intelMode === "auto" && !!result?.analysis.highModeAnalysis);
  const [view, setView] = useState<"widgets" | "settings" | null>(null);

  // Cross-fade state: when result changes, old result animates out while new one reveals.
  const [displayed, setDisplayed] = useState<ChapterAnalysisResult | null>(result);
  const [exiting, setExiting] = useState<ChapterAnalysisResult | null>(null);
  const [revealKey, setRevealKey] = useState(0);
  const exitTimer = useRef<number | null>(null);

  useEffect(() => {
    if (result === displayed) return;
    // Only push to "exiting" if we had a populated result before
    if (displayed && displayed.paragraphs.length > 0) {
      setExiting(displayed);
      if (exitTimer.current) window.clearTimeout(exitTimer.current);
      exitTimer.current = window.setTimeout(() => setExiting(null), 300);
      setRevealKey((k) => k + 1);
    }
    setDisplayed(result);
  }, [result, displayed]);

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
    return n;
  })();

  const placeholderVariant: "empty" | "processing" = isAnalyzing ? "processing" : "empty";

  return (
    <div className={`analysis-panel ${isOpen ? "analysis-panel--open" : ""}`}>
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
                    <WidgetSet result={exiting} prevResult={prevResult} nextResult={nextResult} showCrossArc={showCrossArc} />
                  </div>
                )}
                <div className="widget-list" key={revealKey}>
                  <WidgetSet result={displayed!} prevResult={prevResult} nextResult={nextResult} showCrossArc={showCrossArc} />
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
            <SettingsPanel intelMode={intelMode} onSetIntelMode={onSetIntelMode} />
          </div>
        )}
      </div>
    </div>
  );
}
