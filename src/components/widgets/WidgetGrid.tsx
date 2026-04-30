import type { ChapterAnalysisResult } from "../../lib/use-analysis";
import { TensionWidget } from "./TensionWidget";
import { RoleWidget } from "./RoleWidget";
import { PacingWidget } from "./PacingWidget";
import { RegisterWidget } from "./RegisterWidget";
import { DialogueWidget } from "./DialogueWidget";
import { DiagnosticsWidget } from "./DiagnosticsWidget";
import { ComparativeWidget } from "./ComparativeWidget";

interface Props {
  result: ChapterAnalysisResult;
  isAnalyzing: boolean;
}

export function WidgetGrid({ result, isAnalyzing }: Props) {
  const { analysis, paragraphs } = result;
  const hasContent = paragraphs.length > 0;

  if (!hasContent) return null;

  return (
    <div className={`widget-grid-section ${isAnalyzing ? "widget-grid-analyzing" : ""}`}>
      <div className="widget-grid">
        <TensionWidget analysis={analysis} />
        <RoleWidget analysis={analysis} />
        <PacingWidget analysis={analysis} />
        <RegisterWidget analysis={analysis} />
        <DialogueWidget analysis={analysis} />
        <DiagnosticsWidget analysis={analysis} />
        <ComparativeWidget analysis={analysis} />
      </div>
    </div>
  );
}
