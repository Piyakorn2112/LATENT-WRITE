import { Component, memo, useEffect, useState } from "react";
import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import type { RegisteredTool } from "../../lib/tool-registry";
import * as ToolKit from "../../tools/tool-kit";

interface Props {
  tool: RegisteredTool;
  widgetData: unknown;
  chapterTitle: string;
  isAnalyzing: boolean;
  surface?: "widget" | "sidebar";
}

type ToolWidgetComponent = React.ComponentType<{
  data: unknown;
  chapterTitle: string;
  isAnalyzing: boolean;
}>;

const MODULE_MAP: Record<string, unknown> = {
  "glass-editor/tool-kit": ToolKit,
  "react": React,
  "react/jsx-runtime": JsxRuntime,
};

function toolRequire(id: string): unknown {
  const mod = MODULE_MAP[id];
  if (!mod) throw new Error(`Tool widget cannot import "${id}"`);
  return mod;
}

interface ToolExports {
  default?: ToolWidgetComponent;
  SidePanel?: ToolWidgetComponent;
}

function evaluateWidget(compiledCode: string): ToolExports | null {
  const exports: Record<string, unknown> = {};
  const module = { exports };
  try {
    const fn = new Function("require", "exports", "module", compiledCode);
    fn(toolRequire, exports, module);
  } catch (e) {
    console.error("[tool-widget] eval error:", e);
    return null;
  }
  return module.exports as ToolExports;
}

// ── Error boundary — contains tool crashes to a single widget ──────────────

interface EBProps { toolName: string; children: React.ReactNode }
interface EBState { error: string | null }

class ToolErrorBoundary extends Component<EBProps, EBState> {
  state: EBState = { error: null };

  static getDerivedStateFromError(err: unknown): EBState {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(err: unknown) {
    console.error(`[tool:${this.props.toolName}] render error:`, err);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="wg-tool-error">
          <span className="wg-tool-error-label">{this.props.toolName}</span>
          <span className="wg-tool-error-msg">{this.state.error}</span>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Slot ────────────────────────────────────────────────────────────────────

function ToolWidgetSlotInner({ tool, widgetData, chapterTitle, isAnalyzing, surface = "widget" }: Props) {
  const [exports, setExports] = useState<ToolExports | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toolKey = `${tool.dirPath}@${tool.manifest.version}`;

  useEffect(() => {
    const api = window.electronAPI;
    if (!api || !tool.hasWidget) return;

    let cancelled = false;
    setExports(null);
    setError(null);

    (async () => {
      const source = await api.projectReadFile(`${tool.dirPath}/widget.tsx`);
      if (cancelled) return;
      if (!source.ok || !source.content) {
        setError("Failed to read widget.tsx");
        return;
      }
      const compiled = await api.toolCompile({ code: source.content, format: "tsx" });
      if (cancelled) return;
      if (!compiled.ok || !compiled.code) {
        setError(compiled.error ?? "Compilation failed");
        return;
      }
      const result = evaluateWidget(compiled.code);
      if (cancelled) return;
      if (!result) {
        setError("Widget module failed to load");
        return;
      }
      setExports(result);
    })();

    return () => { cancelled = true; };
  }, [toolKey]);

  if (error) {
    return (
      <div className="wg-tool-error">
        <span className="wg-tool-error-label">{tool.manifest.display}</span>
        <span className="wg-tool-error-msg">{error}</span>
      </div>
    );
  }

  if (!exports) return null;

  const Widget = surface === "sidebar"
    ? (exports.SidePanel ?? exports.default)
    : (exports.default ?? null);

  if (!Widget || typeof Widget !== "function") {
    if (surface === "sidebar" && !exports.SidePanel) {
      return (
        <div className="wg-tool-error">
          <span className="wg-tool-error-label">{tool.manifest.display}</span>
          <span className="wg-tool-error-msg">Missing SidePanel export in widget.tsx</span>
        </div>
      );
    }
    return null;
  }

  return (
    <ToolErrorBoundary toolName={tool.manifest.display}>
      <Widget data={widgetData} chapterTitle={chapterTitle} isAnalyzing={isAnalyzing} />
    </ToolErrorBoundary>
  );
}

export const ToolWidgetSlot = memo(ToolWidgetSlotInner);
