import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, CloseIcon } from "./Icon";
import { TensionWidget } from "./widgets/TensionWidget";
import { ProseProfileWidget } from "./widgets/ProseProfileWidget";
import rendererLogoUrl from "../assets/renderer-logo.svg";
import type { ChapterAnalysis } from "../lib/use-analysis";
import { activateCode } from "../lib/license";

// Each "mode" reuses the production orb's pre-saturated palette. Keeps the
// welcome experience visually identical to the toolbar orb users see later.
type IntelMode = "fast" | "default" | "high" | "auto";

const ORB_COLORS: Record<Exclude<IntelMode, "auto">, { a: string; b: string; c: string }> = {
  fast:    { a: "#FFAE00", b: "#FF6500", c: "#FFDE5E" },
  default: { a: "#1066FF", b: "#33E9FF", c: "#AADAFF" },
  high:    { a: "#C50DFF", b: "#FF64FF", c: "#FFA4FF" },
};

const MODE_ORDER: Exclude<IntelMode, "auto">[] = ["default", "high", "fast"];

// ─── HeroOrb ──────────────────────────────────────────────────────────────
function HeroOrb({ mode, size = 220 }: { mode: IntelMode; size?: number }) {
  const isAuto = mode === "auto";
  const single = !isAuto ? ORB_COLORS[mode] : null;
  const styleVars = !isAuto && single
    ? ({ "--orb-a": single.a, "--orb-b": single.b, "--orb-c": single.c } as CSSProperties)
    : undefined;
  const scale = size / 20;
  return (
    <div className="onb-orb" style={{ width: size, height: size }}>
      <div
        className="onb-orb-stage"
        style={{ transform: `scale(${scale})`, transformOrigin: "center" }}
      >
        <span className="intel-mesh-dot" data-mode={mode} style={styleVars}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span key={i} className="intel-mesh-dot-orb" />
          ))}
        </span>
        <span
          className="intel-mesh-dot intel-mesh-dot--ghost"
          data-mode={mode}
          style={styleVars}
          aria-hidden="true"
        >
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span key={i} className="intel-mesh-dot-orb" />
          ))}
        </span>
      </div>
    </div>
  );
}

function CyclingOrb({ active, size = 220 }: { active: boolean; size?: number }) {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setIdx((i) => (i + 1) % MODE_ORDER.length), 4000);
    return () => window.clearInterval(id);
  }, [active]);
  return <HeroOrb mode={MODE_ORDER[idx]} size={size} />;
}

// ─── Mock data ────────────────────────────────────────────────────────────
// Static, hand-tuned snapshot — renders the actual production widgets so
// what users see here is exactly what they'll see in the analysis panel.
const MOCK_TENSION_ANALYSIS = {
  tensionCurve: [
    0.22, 0.55, 0.30, 0.48, 0.18, 0.62, 0.35, 0.78, 0.55, 0.88,
    0.40, 0.30, 0.72, 0.96, 0.58, 0.82, 0.42, 0.55,
  ],
  peakTension: "high",
  arcShape: "double-peak",
  peakLabel: "confrontation",
  guidance: { peakPosition: 78 },
  highModeAnalysis: undefined,
} as unknown as ChapterAnalysis;

const MOCK_PROSE_TEXT = `The rain caught him at the bridge. He pulled his coat tight and pressed forward into the wind. Sarah's voice still echoed in his head — soft, unsure, the way she had said his name. A car hissed past, headlights bleached against wet stone. He thought of turning back. He did not turn back. The river beneath ran black and silver, swollen with the storm. Somewhere downstream a bell tolled three quick beats, then silence. He counted his steps to the far end and walked them without looking up.`;

function MockTensionWidget() {
  return <TensionWidget analysis={MOCK_TENSION_ANALYSIS} />;
}

function MockProseProfileWidget() {
  return <ProseProfileWidget content={MOCK_PROSE_TEXT} />;
}

// ─── Page 1 hero: Editor mock ─────────────────────────────────────────────
// A CSS-art illustration of the writing editor — toolbar strip + prose lines.
// The tiny cycling orb in the toolbar matches what the user will see after
// they start writing.
function EditorMockHero({ active }: { active: boolean }) {
  return (
    <div className="onb-editor-mock">
      <div className="onb-editor-mock-toolbar">
        <div className="onb-editor-mock-toolbar-dots">
          <span className="onb-editor-mock-dot" />
          <span className="onb-editor-mock-dot" />
          <span className="onb-editor-mock-dot" />
        </div>
        <span className="onb-editor-mock-chapter-nav">Chapter 1 · The Bridge</span>
        <div className="onb-editor-mock-toolbar-orb">
          <CyclingOrb active={active} size={20} />
        </div>
      </div>
      <div className="onb-editor-mock-body">
        <div className="onb-editor-mock-title-line" />
        <div className="onb-editor-mock-lines">
          {[88, 72, 94, 48, 83, 66, 91, 57].map((w, i) => (
            <div
              key={i}
              className="onb-editor-mock-line"
              style={{ width: `${w}%` } as CSSProperties}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Page 2 hero: Structure (Chapter Index + World Data) ──────────────────
const STRUCT_CHAPTERS = ["The Bridge", "City Plaza", "Glass Tower", "The Storm"];
const STRUCT_CHARS    = ["Nora", "Mira"];
const STRUCT_PLACES   = ["Myrhold Bridge", "Glass Tower"];

function StructureHero() {
  return (
    <div className="onb-struct-panels">
      <div className="onb-struct-panel">
        <div className="onb-struct-panel-header">Chapter Index</div>
        {STRUCT_CHAPTERS.map((title, i) => (
          <div key={i} className={`onb-struct-row${i === 0 ? " onb-struct-row--active" : ""}`}>
            <span className="onb-struct-num">{i + 1}</span>
            <span className="onb-struct-label">{title}</span>
          </div>
        ))}
      </div>
      <div className="onb-struct-panel">
        <div className="onb-struct-panel-header">World Data</div>
        <div className="onb-struct-section-label">Characters</div>
        {STRUCT_CHARS.map((name) => (
          <div key={name} className="onb-struct-row">
            <span className="onb-struct-icon">◉</span>
            <span className="onb-struct-label">{name}</span>
          </div>
        ))}
        <div className="onb-struct-section-label">Places</div>
        {STRUCT_PLACES.map((name) => (
          <div key={name} className="onb-struct-row">
            <span className="onb-struct-icon">◎</span>
            <span className="onb-struct-label">{name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Page 3 hero: Entity highlight mock ───────────────────────────────────
// A prose snippet with color-coded entity/speech spans — mirrors what the
// intelligence layer renders over the actual text in the editor.
function EntityHighlightMock() {
  return (
    <div className="onb-intel-highlight">
      <p className="onb-intel-highlight-text">
        <span className="onb-ent-speech">"It's not safe,"</span>
        {" said "}
        <span className="onb-ent-char">Nora</span>
        {", stepping back from "}
        <span className="onb-ent-place">Myrhold Bridge</span>
        {". "}
        <span className="onb-ent-char">Mira</span>
        {" said nothing. "}
        <span className="onb-ent-action">She turned and walked into the dark.</span>
      </p>
    </div>
  );
}

// ─── Page 5 hero: Export formats (browser only) ───────────────────────────
const EXPORT_FORMATS = [
  { fmt: "PDF",      desc: "6 format presets, professional typesetting, custom covers" },
  { fmt: "Markdown", desc: "Portable .md — opens in Bear, Obsidian, iA Writer, anywhere" },
  { fmt: "DOCX",     desc: "Double-spaced manuscript — for editors, agents, and reviewers" },
];

function ExportHero() {
  return (
    <div className="onb-export-cards">
      {EXPORT_FORMATS.map(({ fmt, desc }) => (
        <div key={fmt} className="onb-export-card">
          <div className="onb-export-card-fmt">{fmt}</div>
          <div className="onb-export-card-desc">{desc}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Page 6 hero: Getting-started checklist ───────────────────────────────
const CHECKLIST_ITEMS = [
  "Add a chapter title and write at least one paragraph",
  "Open the Intelligence panel and let it analyse your chapter",
  "Add one character to World Data so the editor can track them",
];

function ChecklistHero({ active }: { active: boolean }) {
  return (
    <div className="onb-checklist" aria-label="Getting started checklist">
      {CHECKLIST_ITEMS.map((text, i) => (
        <div
          key={i}
          className={`onb-checklist-item${active ? " onb-checklist-item--visible" : ""}`}
          style={{ animationDelay: `${i * 0.14}s` } as CSSProperties}
        >
          <div className="onb-checklist-circle" aria-hidden="true" />
          <span className="onb-checklist-text">{text}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Renderer preview data (page 5, desktop) ─────────────────────────────
const RENDERER_FILES = [
  "novel.txt",
  "drafts/ch012.md",
  "review-logs/review_ch012.md",
  "anchors/ch012_anchor.md",
];
const RENDERER_COMMANDS = ["/draft 12", "/review 12", "/assemble 12"];

// ─── Page component ───────────────────────────────────────────────────────
interface OnbPageProps {
  active: boolean;
  widthPercent: number;
  children: React.ReactNode;
}
function OnbPage({ active, widthPercent, children }: OnbPageProps) {
  return (
    <div
      className={`onb-page ${active ? "onb-page--active" : ""}`}
      aria-hidden={!active}
      style={{ flexBasis: `${widthPercent}%` }}
    >
      {children}
    </div>
  );
}

// ─── Onboarding ───────────────────────────────────────────────────────────
interface Props {
  onClose: () => void;
  onTierChange?: (tier: import("../lib/license").Tier) => void;
}

const ONBOARDING_OVERLAY_BODY_CLASS = "onboarding-overlay-freeze";

export function Onboarding({ onClose, onTierChange }: Props) {
  const [page, setPage] = useState(0);
  const total = 6;
  const pageWidth = 100 / total;
  const isElectron = !!window.electronAPI;

  const [proOpen, setProOpen] = useState(false);
  const [proCodeInput, setProCodeInput] = useState("");
  const [proCodeError, setProCodeError] = useState<string | null>(null);
  const [proCodeSuccess, setProCodeSuccess] = useState(false);
  const [proActivating, setProActivating] = useState(false);

  const handleProActivate = async () => {
    if (proActivating) return;
    setProActivating(true);
    const result = await activateCode(proCodeInput);
    setProActivating(false);
    if (result.ok) {
      setProCodeInput("");
      setProCodeSuccess(true);
      setProCodeError(null);
      onTierChange?.("pro");
    } else {
      setProCodeError(result.error ?? "Invalid code.");
    }
  };

  useEffect(() => {
    const body = document.body;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const prevBodyOverflow = body.style.overflow;
    const prevBodyPosition = body.style.position;
    const prevBodyTop = body.style.top;
    const prevBodyLeft = body.style.left;
    const prevBodyWidth = body.style.width;
    const prevBodyTouchAction = body.style.touchAction;

    body.classList.add(ONBOARDING_OVERLAY_BODY_CLASS);
    body.style.position = "fixed";
    body.style.top = `${-scrollY}px`;
    body.style.left = `${-scrollX}px`;
    body.style.width = "100%";
    body.style.overflow = "hidden";
    body.style.touchAction = "none";

    return () => {
      body.classList.remove(ONBOARDING_OVERLAY_BODY_CLASS);
      body.style.overflow = prevBodyOverflow;
      body.style.position = prevBodyPosition;
      body.style.top = prevBodyTop;
      body.style.left = prevBodyLeft;
      body.style.width = prevBodyWidth;
      body.style.touchAction = prevBodyTouchAction;
      window.scrollTo(scrollX, scrollY);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setPage((p) => Math.min(total - 1, p + 1));
      if (e.key === "ArrowLeft")  setPage((p) => Math.max(0, p - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const slideStyle = useMemo<CSSProperties>(() => ({
    width: `${total * 100}%`,
    transform: `translate3d(${-page * pageWidth}%, 0, 0)`,
  }), [page, pageWidth]);

  const isLast = page === total - 1;

  return (
    <div
      className="onb-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Latent Write"
    >
      <div className="onb-card liquid-glass">

        <button
          className="onb-close icon-btn"
          onClick={onClose}
          aria-label="Close welcome"
          title="Close (Esc)"
        >
          <CloseIcon size={15} />
        </button>

        <div className="onb-stage">
          <div className="onb-track" style={slideStyle}>

            {/* PAGE 1 — Write your novel */}
            <OnbPage active={page === 0} widthPercent={pageWidth}>
              <div className="onb-hero onb-hero--editor">
                <EditorMockHero active={page === 0} />
              </div>
              <h1 className="onb-title">Write your novel</h1>
              <p className="onb-subtitle">
                Latent Write is an editor that reads as you write. Start with a chapter title
                and some prose — the intelligence panel runs quietly in the background, building
                a live picture of the chapter as it grows.
              </p>
            </OnbPage>

            {/* PAGE 2 — Your novel's structure */}
            <OnbPage active={page === 1} widthPercent={pageWidth}>
              <div className="onb-hero onb-hero--structure">
                <StructureHero />
              </div>
              <h1 className="onb-title onb-title--small">Your novel's structure</h1>
              <p className="onb-subtitle">
                Every chapter lives in the <strong>Chapter Index</strong> — add, reorder, and
                navigate from there. The <strong>World panel</strong> stores characters, places,
                and factions so the editor can track who's speaking and what's present in each scene.
              </p>
            </OnbPage>

            {/* PAGE 3 — Intelligence that adapts */}
            <OnbPage active={page === 2} widthPercent={pageWidth}>
              <div className="onb-hero onb-hero--intel">
                <CyclingOrb active={page === 2} size={100} />
                <EntityHighlightMock />
              </div>
              <h1 className="onb-title onb-title--small">Intelligence that adapts</h1>
              <p className="onb-subtitle">
                The intelligence layer highlights speech, actions, and named entities in real time.
                Use <strong>Auto</strong> to let the app choose the right depth per chapter —
                or pin a mode when you need deep analysis.
              </p>
            </OnbPage>

            {/* PAGE 4 — The Analysis Panel */}
            <OnbPage active={page === 3} widthPercent={pageWidth}>
              <div className="onb-hero onb-hero--widgets">
                <MockTensionWidget />
                <MockProseProfileWidget />
              </div>
              <h1 className="onb-title onb-title--small">The Analysis Panel</h1>
              <p className="onb-subtitle">
                Open the panel with the <strong>◫</strong> button in the toolbar
                (or <kbd className="onb-inline-kbd">⌘⇧A</kbd>). Start with{" "}
                <strong>Tension</strong> — it shows where the chapter's energy rises and falls.
                Each widget has a <strong>?</strong> button that explains the metric.
              </p>
            </OnbPage>

            {/* PAGE 5 — Renderer (desktop) / Export (browser) */}
            <OnbPage active={page === 4} widthPercent={pageWidth}>
              {isElectron ? (
                <>
                  <div className="onb-hero onb-hero--renderer">
                    <div className="onb-renderer-preview">
                      <div className="onb-renderer-preview-top">
                        <div className="onb-renderer-brand">
                          <img src={rendererLogoUrl} alt="" className="onb-renderer-brand-logo" />
                          <span className="onb-renderer-brand-title">Workspace</span>
                        </div>
                        <div className="onb-renderer-runtime">
                          <span className="onb-renderer-pill">sonnet-4</span>
                          <span className="onb-renderer-pill">high</span>
                          <span className="onb-renderer-status" aria-hidden="true" />
                        </div>
                      </div>
                      <div className="onb-renderer-preview-body">
                        <div className="onb-renderer-tree">
                          {RENDERER_FILES.map((file, index) => (
                            <div
                              key={file}
                              className={`onb-renderer-tree-row${index === 1 ? " onb-renderer-tree-row--active" : ""}`}
                            >
                              {file}
                            </div>
                          ))}
                        </div>
                        <div className="onb-renderer-viewer">
                          <div className="onb-renderer-viewer-file">drafts/ch012.md</div>
                          <p className="onb-renderer-copy">
                            A full-screen desktop workspace for Claude sessions, slash commands,
                            markdown responses, and file previews tied to the current project.
                          </p>
                          <div className="onb-renderer-command-row">
                            {RENDERER_COMMANDS.map((command) => (
                              <span key={command} className="onb-renderer-command">{command}</span>
                            ))}
                          </div>
                        </div>
                        <div className="onb-renderer-chat">
                          <div className="onb-renderer-bubble onb-renderer-bubble--user">/review 12</div>
                          <div className="onb-renderer-bubble onb-renderer-bubble--assistant">
                            Keeps the chat session alive and streams tool activity alongside the
                            changed files instead of hiding them behind another app.
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <h1 className="onb-title onb-title--small">Renderer keeps the project in context</h1>
                  <p className="onb-subtitle">
                    The desktop renderer keeps a Claude session inside the same project: persistent
                    sessions, slash commands, and file previews. Use <strong>/review</strong> for
                    a prose critique or <strong>/draft</strong> to generate from your outline.
                  </p>
                </>
              ) : (
                <>
                  <div className="onb-hero onb-hero--export">
                    <ExportHero />
                  </div>
                  <h1 className="onb-title onb-title--small">Export when you're ready</h1>
                  <p className="onb-subtitle">
                    Export as <strong>PDF</strong> with professional typesetting presets and custom
                    covers, <strong>DOCX</strong> for editor and agent hand-off (double-spaced
                    manuscript), or <strong>Markdown</strong> to take your draft anywhere.
                  </p>
                </>
              )}
            </OnbPage>

            {/* PAGE 6 — Three things to do first */}
            <OnbPage active={page === 5} widthPercent={pageWidth}>
              <div className="onb-hero onb-hero--checklist">
                <ChecklistHero active={page === 5} />
              </div>
              <h1 className="onb-title onb-title--small">Three things to do first</h1>
              <p className="onb-subtitle">
                Once you're in the editor, try these to see the app come alive. Each one
                unlocks a new layer of the intelligence system.
              </p>
              <div className="onb-pro-row">
                <button
                  type="button"
                  className="onb-pro-toggle"
                  onClick={() => setProOpen((v) => !v)}
                >
                  <ChevronRight
                    size={13}
                    className={`onb-pro-toggle-chevron${proOpen ? " onb-pro-toggle-chevron--open" : ""}`}
                  />
                  Have a Pro code?
                </button>
                <div className={`onb-pro-expand${proOpen ? " onb-pro-expand--open" : ""}`}>
                  <div className="onb-pro-form">
                    <input
                      type="text"
                      className="settings-code-input"
                      placeholder="LATENT-XXXXX-XXXXX-XXXXX"
                      value={proCodeInput}
                      spellCheck={false}
                      onChange={(e) => { setProCodeInput(e.target.value); setProCodeError(null); setProCodeSuccess(false); }}
                      onKeyDown={(e) => { if (e.key === "Enter") { void handleProActivate(); } }}
                    />
                    <button
                      type="button"
                      className={`settings-code-submit${proCodeInput.trim() ? " settings-code-submit--active" : ""}`}
                      disabled={proActivating}
                      onClick={() => { void handleProActivate(); }}
                    >
                      {proActivating ? "…" : "Activate"}
                    </button>
                  </div>
                  {proCodeError && <p className="onb-pro-status onb-pro-status--error">{proCodeError}</p>}
                  {proCodeSuccess && <p className="onb-pro-status onb-pro-status--success">Pro activated! You're all set.</p>}
                </div>
              </div>
            </OnbPage>

          </div>
        </div>

        {/* Footer: skip · dots · back/next */}
        <div className="onb-footer">
          <button
            className="onb-skip"
            onClick={onClose}
            aria-label={isLast ? "Close welcome" : "Skip welcome"}
          >
            {isLast ? "Close" : "Skip"}
          </button>

          <div className="onb-dots" role="tablist" aria-label="Page indicator">
            {Array.from({ length: total }, (_, i) => (
              <button
                key={i}
                role="tab"
                aria-selected={i === page}
                aria-label={`Go to page ${i + 1}`}
                className={`onb-dot ${i === page ? "onb-dot--active" : ""}`}
                onClick={() => setPage(i)}
              />
            ))}
          </div>

          <div className="onb-nav">
            {page > 0 && (
              <button
                className="onb-nav-btn"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                aria-label="Previous page"
              >
                <ChevronLeft size={16} />
                <span>Back</span>
              </button>
            )}
            <button
              className="onb-nav-btn onb-nav-btn--primary"
              onClick={() => {
                if (isLast) onClose();
                else setPage((p) => p + 1);
              }}
            >
              <span>{isLast ? "Open the editor" : "Next"}</span>
              {!isLast && <ChevronRight size={16} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
