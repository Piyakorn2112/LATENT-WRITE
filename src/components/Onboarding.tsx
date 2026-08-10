import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, CloseIcon } from "./Icon";
import { TensionWidget } from "./widgets/TensionWidget";
import { ProseProfileWidget } from "./widgets/ProseProfileWidget";
import rendererLogoUrl from "../assets/renderer-logo.svg";
import type { ChapterAnalysis } from "../lib/use-analysis";
import { activateCode } from "../lib/license";
import { OrbEngine } from "./orb/OrbEngine";

// Mirrors the flag in Toolbar.tsx — flip to false to restore the legacy
// CSS mesh-dot hero orb below, which is left fully intact.
const USE_ORB_ENGINE: boolean = true;

// Each "mode" reuses the production orb's pre-saturated palette. Keeps the
// welcome experience visually identical to the toolbar orb users see later.
type IntelMode = "fast" | "default" | "high" | "auto";

type OrbPalette = { a: string; b: string; c: string };

const ORB_COLORS: Record<Exclude<IntelMode, "auto">, OrbPalette> = {
  fast:    { a: "#FFAE00", b: "#FF6500", c: "#FFDE5E" },
  default: { a: "#1066FF", b: "#33E9FF", c: "#AADAFF" },
  high:    { a: "#C50DFF", b: "#FF64FF", c: "#FFA4FF" },
};

const ORB_ACCENT_COLORS: Record<Exclude<IntelMode, "auto">, OrbPalette> = {
  fast:    { a: "#34A8FF", b: "#7DE8FF", c: "#C7FFD0" },
  default: { a: "#7080FF", b: "#9FEEFF", c: "#FFAB92" },
  high:    { a: "#5B79FF", b: "#8CE5FF", c: "#FFC38E" },
};

const MODE_ORDER: Exclude<IntelMode, "auto">[] = ["default", "high", "fast"];

const paletteStyleVars = (palette?: OrbPalette): CSSProperties | undefined => palette
  ? ({ "--orb-a": palette.a, "--orb-b": palette.b, "--orb-c": palette.c } as CSSProperties)
  : undefined;

// ─── HeroOrb ──────────────────────────────────────────────────────────────
function HeroOrb({
  mode,
  size = 220,
  topPalette,
  underPalette,
  accentPalette,
}: {
  mode: IntelMode;
  size?: number;
  topPalette?: OrbPalette;
  underPalette?: OrbPalette;
  accentPalette?: OrbPalette;
}) {
  const isAuto = mode === "auto";
  const resolvedPalette = !isAuto ? ORB_COLORS[mode] : undefined;
  const resolvedAccentPalette = !isAuto ? ORB_ACCENT_COLORS[mode] : undefined;
  const topStyleVars = paletteStyleVars(topPalette ?? resolvedPalette);
  const underStyleVars = paletteStyleVars(underPalette ?? resolvedPalette);
  const accentStyleVars = paletteStyleVars(accentPalette ?? resolvedAccentPalette);
  const scale = size / 20;
  if (USE_ORB_ENGINE) {
    return (
      <div className="onb-orb" style={{ width: size, height: size }}>
        {/* flowScale < 1 — at hero scale the toolbar flow speed reads
            frantic, same reason the legacy orbits were slowed ~2.6×. */}
        <OrbEngine mode={mode} size={size} flowScale={0.45} />
      </div>
    );
  }
  return (
    <div className="onb-orb" style={{ width: size, height: size }}>
      <div
        className="onb-orb-stage"
        style={{ transform: `scale(${scale})`, transformOrigin: "center" }}
      >
        <span className="intel-mesh-dot" data-mode={mode} style={topStyleVars}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span key={i} className="intel-mesh-dot-orb" />
          ))}
        </span>
        <span
          className="intel-mesh-dot intel-mesh-dot--ghost"
          data-mode={mode}
          style={underStyleVars}
          aria-hidden="true"
        >
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span key={i} className="intel-mesh-dot-orb" />
          ))}
        </span>
        <span
          className="intel-mesh-dot intel-mesh-dot--accent"
          data-mode={mode}
          style={accentStyleVars}
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

/** Kept beside the tension mock because the two are a pair in the panel, even
 *  though the tour now shows one at a time. */
export function MockProseProfileWidget() {
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

// ─── Local model hero: the three modes, with their real sizes ─────────────
//
// ★ THE NUMBERS ARE THE ONES IN THE SETTINGS ROW, because a writer who reads
//   "1.1 GB" here and sees a different figure at the moment of downloading has
//   been told a story rather than a fact. Kept in step with MODE_OPTIONS and
//   MODE_SIZE in AnalysisPanel.tsx.
const LOCAL_MODES = [
  { name: "Off", size: "no download", desc: "Rules only. Instant.", isSize: false },
  { name: "On", size: "1.1 GB", desc: "Names, continuity, summaries.", isSize: true },
  { name: "Max", size: "2.5 GB", desc: "Reads for meaning.", isSize: true },
] as const;

function LocalModelHero() {
  return (
    <div className="onb-modes-wrap">
      <div className="onb-modes" aria-label="Local model options">
        {LOCAL_MODES.map((m, i) => (
          <div
            key={m.name}
            className={`onb-mode-card${i === 1 ? " onb-mode-card--pick" : ""}`}
          >
            <div className="onb-mode-card-name">{m.name}</div>
            {/* ★ ONLY A REAL SIZE GETS THE ACCENT. "no download" in the same
                blue read as a figure of the same kind, which is the one thing
                the Off card is saying it is not. */}
            <div className={`onb-mode-card-size${m.isSize ? " onb-mode-card-size--real" : ""}`}>
              {m.size}
            </div>
            <div className="onb-mode-card-desc">{m.desc}</div>
          </div>
        ))}
      </div>
      <p className="onb-modes-note">
        Downloaded once, run here, and never uploaded. No account and no key.
      </p>
    </div>
  );
}

// ─── Page 6 hero: Getting-started checklist ───────────────────────────────
//
// ★ EACH ONE NAMES THE CONTROL IT MEANS. The previous list said "open the
//   Intelligence panel", and no panel has that name — a first step a writer
//   cannot find is worse than no list at all.
interface ChecklistItem { do: string; where: string }

function ChecklistHero({ active, items }: { active: boolean; items: readonly ChecklistItem[] }) {
  return (
    <div className="onb-checklist" aria-label="Getting started checklist">
      {items.map((item, i) => (
        <div
          key={i}
          className={`onb-checklist-item${active ? " onb-checklist-item--visible" : ""}`}
          style={{ animationDelay: `${i * 0.14}s` } as CSSProperties}
        >
          <div className="onb-checklist-circle" aria-hidden="true" />
          <span className="onb-checklist-text">
            {item.do}
            <span className="onb-checklist-where">{item.where}</span>
          </span>
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

/**
 * A keyboard hint that only appears where the keystroke actually works.
 *
 * ★★ EVERY ACCELERATOR IN THIS APP IS OWNED BY THE NATIVE MENU. App.tsx's
 *    browser key handler returns immediately under Electron and covers only a
 *    few keys otherwise, so ⌘I, ⌘J and ⌘O are DESKTOP-ONLY. Printing them in
 *    the browser build would teach a shortcut that does nothing, which is how
 *    a writer decides the app is broken. Same audit found the previous copy
 *    promising ⌘⇧A for the analysis panel, a shortcut that exists nowhere.
 */
function Kbd({ children, desktop }: { children: React.ReactNode; desktop: boolean }) {
  if (!desktop) return null;
  return <kbd className="onb-inline-kbd">{children}</kbd>;
}

// ─── Page component ───────────────────────────────────────────────────────
interface OnbPageProps {
  active: boolean;
  widthPercent: number;
  /** `dense` buys back top padding on a page whose hero is a real widget. */
  variant?: "dense";
  children: React.ReactNode;
}
function OnbPage({ active, widthPercent, variant, children }: OnbPageProps) {
  return (
    <div
      className={`onb-page ${active ? "onb-page--active" : ""}${variant ? ` onb-page--${variant}` : ""}`}
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

  /** Named controls, not verbs in the abstract, and the last one differs by
   *  build because the browser has no local model to switch on. */
  const checklist: ChecklistItem[] = [
    { do: "Write or paste one scene", where: "the marks appear as you go" },
    { do: "Open World and press Auto-Scan", where: isElectron ? "⌘J, then tick your cast" : "tick the names it finds" },
    isElectron
      ? { do: "Turn on Local enhancements", where: "Analysis panel, Settings" }
      : { do: "Open the Analysis panel", where: "read the Tension curve" },
  ];

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

            {/* PAGE 1 — Write, and it reads along */}
            <OnbPage active={page === 0} widthPercent={pageWidth}>
              <div className="onb-hero onb-hero--editor">
                <EditorMockHero active={page === 0} />
              </div>
              <h1 className="onb-title">Write. It reads along.</h1>
              <p className="onb-subtitle">
                A novel editor with a reader built in. Start typing, or bring an existing draft
                in from the <strong>toolbar</strong> <Kbd desktop={isElectron}>⌘O</Kbd>.
                Your book is saved as plain text in a folder you choose, and it never leaves
                this machine.
              </p>
            </OnbPage>

            {/* PAGE 2 — Chapters and cast */}
            <OnbPage active={page === 1} widthPercent={pageWidth}>
              <div className="onb-hero onb-hero--structure">
                <StructureHero />
              </div>
              <h1 className="onb-title onb-title--small">Your chapters, and your cast</h1>
              <p className="onb-subtitle">
                The <strong>Chapter Index</strong> <Kbd desktop={isElectron}>⌘I</Kbd> holds the
                book. The <strong>World panel</strong> <Kbd desktop={isElectron}>⌘J</Kbd> holds who
                and what is in it. Press <strong>Auto-Scan</strong> there and the app reads your
                draft, finds the names, and sorts them into the same four tabs you see in the
                panel, for you to tick.
              </p>
            </OnbPage>

            {/* PAGE 3 — What it shows you (highlights + analysis, merged) */}
            <OnbPage active={page === 2} widthPercent={pageWidth} variant="dense">
              {/* ★ ONE WIDGET, NOT TWO. The production widgets render at their
                  real size here, and two of them stacked on the marked-up
                  paragraph pushed the body copy clean off the bottom of the
                  card — the tour explained itself to nobody. Tension is the one
                  the copy names, so it is the one shown. */}
              <div className="onb-hero onb-hero--intel">
                <EntityHighlightMock />
                <div className="onb-intel-widgets">
                  <MockTensionWidget />
                </div>
              </div>
              <h1 className="onb-title onb-title--small">What it shows you</h1>
              <p className="onb-subtitle">
                Speech and names are marked as you type, and a deeper pass refines them when you
                pause. The <strong>Analysis panel</strong> adds tension, pacing and prose shape,
                and every widget has a <strong>?</strong> that explains what it measures.
              </p>
            </OnbPage>

            {/* PAGE 4 — The local model.
                ★ THE PAGE THIS ONBOARDING WAS MISSING. Three modes, their real
                  download sizes, and the two promises that make the choice safe:
                  the rules answer first, and the model reads snippets rather
                  than the book. Desktop only, because the browser build has no
                  runtime to opt into. */}
            <OnbPage active={page === 3} widthPercent={pageWidth}>
              <div className="onb-hero onb-hero--modes">
                <LocalModelHero />
              </div>
              <h1 className="onb-title onb-title--small">Your book stays on this machine</h1>
              <p className="onb-subtitle">
                {isElectron ? (
                  <>
                    Most of the app is plain rules and needs no model at all. For deeper reading,
                    add a local one under <strong>Settings</strong> in the Analysis panel. It sees
                    short passages rather than your whole book, and only sharpens what the rules
                    already found, so turning it off never breaks anything.
                  </>
                ) : (
                  <>
                    Everything here is plain rules running in your own browser. The desktop app
                    adds an optional language model for deeper reading, and that runs on your
                    machine too.
                  </>
                )}
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
                          {/* ★ THE ALIAS, NOT A PINNED VERSION. "sonnet-4" was
                              printed here long after the aliases became the
                              thing the writer types; a version number in a
                              mock is a date stamp that nobody remembers to
                              update. `sonnet` is what /model accepts. */}
                          <span className="onb-renderer-pill">sonnet</span>
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
                          {/* ★ SHOW THE SESSION, DO NOT DESCRIBE IT. This panel
                              used to hold a sentence about what a workspace is,
                              directly above a caption saying the same thing
                              twice. A draft file should contain draft. */}
                          <p className="onb-renderer-copy">
                            The bridge took the wind badly that evening. Nora went first, one hand
                            on the rail, and did not look back to see whether Mira had followed.
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
                            Two continuity flags. Nora's coat is grey here and green in Chapter 9,
                            and this bridge is stone where Chapter 4 made it iron.
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <h1 className="onb-title onb-title--small">And one door to the cloud</h1>
                  <p className="onb-subtitle">
                    The <strong>Renderer</strong> runs a Claude session against your project, with
                    slash commands like <strong>/review</strong> for a prose critique
                    and <strong>/draft</strong> from your outline. It is the one part of the app
                    that sends anything anywhere, it uses the Claude login you already have, and
                    if you never open it, it never runs.
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
                <ChecklistHero active={page === 5} items={checklist} />
              </div>
              <h1 className="onb-title onb-title--small">Three things to do first</h1>
              <p className="onb-subtitle">
                In order, and they take about five minutes. The third one is where the app
                stops looking like a text box.
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
