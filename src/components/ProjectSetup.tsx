/**
 * Project Setup flow — shown when Renderer Ops is opened but no project is open,
 * or when user wants to configure Claude Code connection.
 * Design: glass card with step indicators, matching the liquid-glass system.
 */
import { useState, useEffect } from "react";
import type { CSSProperties } from "react";
import {
  type ClaudeStatus,
  getClaudeStatus,
  isDesktopApp,
} from "../lib/project-manager";

interface Props {
  onOpenProject: () => void;
  onCreateProject: () => void;
}

export function ProjectSetup({ onOpenProject, onCreateProject }: Props) {
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    getClaudeStatus().then((s) => { setClaude(s); setChecking(false); });
  }, []);

  if (!isDesktopApp()) {
    return (
      <div style={containerStyle}>
        <div className="liquid-glass" style={cardStyle}>
          <span style={eyebrowStyle}>Web mode</span>
          <h3 style={titleStyle}>Directory access unavailable</h3>
          <p style={bodyStyle}>
            The Renderer pipeline requires filesystem access to manage project files.
            Use the desktop app for full pipeline integration, or continue with
            import/export in the editor.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      {/* Claude Code status card */}
      <div className="liquid-glass" style={cardStyle}>
        <span style={eyebrowStyle}>Prerequisites</span>
        <h3 style={titleStyle}>Claude Code</h3>
        {checking ? (
          <p style={bodyStyle}>Checking...</p>
        ) : claude?.installed ? (
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "8px" }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e" }} />
            <span style={{ fontSize: "0.82rem", color: "var(--text-secondary)" }}>
              Installed at {claude.path}
            </span>
          </div>
        ) : (
          <div style={{ marginTop: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#ef4444" }} />
              <span style={{ fontSize: "0.82rem", color: "var(--text-secondary)" }}>Not found</span>
            </div>
            <p style={{ ...bodyStyle, marginBottom: "8px" }}>
              Install Claude Code to use the pipeline. Run in your terminal:
            </p>
            <code style={codeStyle}>npm install -g @anthropic-ai/claude-code</code>
            <p style={{ ...bodyStyle, fontSize: "0.72rem", marginTop: "8px", color: "var(--text-tertiary)" }}>
              Then run <code style={{ ...codeStyle, display: "inline", padding: "1px 5px" }}>claude</code> once to complete login.
            </p>
          </div>
        )}
      </div>

      {/* Project actions */}
      <div className="liquid-glass" style={cardStyle}>
        <span style={eyebrowStyle}>Project</span>
        <h3 style={titleStyle}>Open or create a novel project</h3>
        <p style={bodyStyle}>
          A Renderer project is a directory containing your novel files — story primary,
          chapters, anchors, and the novel-writing-system reference. Claude Code
          operates directly on these files.
        </p>
        <div style={{ display: "flex", gap: "10px", marginTop: "16px", flexWrap: "wrap" }}>
          <button
            onClick={onOpenProject}
            className="liquid-glass"
            style={actionBtnStyle}
            onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.96)")}
            onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
            onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
              <path d="M2 5l2-3h4l1 1.5H14v9.5H2V5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill="none"/>
            </svg>
            Open Existing
          </button>
          <button
            onClick={onCreateProject}
            className="liquid-glass"
            style={actionBtnStyle}
            onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.96)")}
            onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
            onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            Create New
          </button>
        </div>
      </div>

      {/* Directory structure reference */}
      <div className="liquid-glass" style={cardStyle}>
        <span style={eyebrowStyle}>Structure</span>
        <h3 style={titleStyle}>Project directory layout</h3>
        <pre style={preStyle}>{`MyNovel/
        novel.txt                ← Editable manuscript (same text format as export)
  novel-writing-system/    ← Framework docs (read-only)
  NOVEL_CONFIGURATION.md   ← Voice rules, targets, weights
        MyNovel_STORY_PRIMARY.txt ← Single source of truth
  NAMING_REFERENCE.md      ← Every proper noun locked
  anchors/                 ← Narrative state snapshots
  drafts/                  ← Working chapter files
  canon/                   ← Assembled final text
  scene-bank/              ← Scene planning
  review-logs/             ← Pass outputs
  temp/                    ← Context packets`}
        </pre>
      </div>
    </div>
  );
}

// ── Styles (design system tokens) ────────────────────────────────────────────

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  padding: "24px",
  maxWidth: 560,
  margin: "0 auto",
};

const cardStyle: CSSProperties = {
  padding: "20px 22px",
  borderRadius: "22px",
};

const eyebrowStyle: CSSProperties = {
  fontSize: "10px",
  fontWeight: 500,
  letterSpacing: "0.3em",
  textTransform: "uppercase",
  color: "var(--accent)",
};

const titleStyle: CSSProperties = {
  fontFamily: "var(--font-ui)",
  fontSize: "1rem",
  fontWeight: 500,
  color: "var(--text)",
  marginTop: "6px",
  letterSpacing: "-0.01em",
};

const bodyStyle: CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: "0.82rem",
  lineHeight: 1.65,
  color: "var(--text-secondary)",
  marginTop: "8px",
};

const codeStyle: CSSProperties = {
  display: "block",
  fontFamily: "\"SF Mono\", \"Fira Code\", monospace",
  fontSize: "0.78rem",
  padding: "8px 12px",
  borderRadius: "10px",
  background: "var(--bg-glass)",
  color: "var(--text)",
  border: "1px solid var(--divider-line)",
};

const actionBtnStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "8px",
  padding: "10px 18px",
  borderRadius: "9999px",
  fontSize: "0.82rem",
  fontWeight: 500,
  cursor: "pointer",
  color: "var(--text)",
  transition: "transform 0.15s ease, box-shadow 0.2s ease",
};

const preStyle: CSSProperties = {
  fontFamily: "\"SF Mono\", \"Fira Code\", monospace",
  fontSize: "0.72rem",
  lineHeight: 1.7,
  color: "var(--text-secondary)",
  marginTop: "10px",
  padding: "12px 14px",
  borderRadius: "12px",
  background: "var(--bg-glass)",
  border: "1px solid var(--divider-line)",
  overflow: "auto",
};
