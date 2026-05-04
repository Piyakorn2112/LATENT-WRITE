import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, CloseIcon } from "./Icon";
import { TensionWidget } from "./widgets/TensionWidget";
import { ProseProfileWidget } from "./widgets/ProseProfileWidget";
import type { ChapterAnalysis } from "../lib/use-analysis";

// Each "mode" reuses the production orb's pre-saturated palette. Keeps the
// welcome experience visually identical to the toolbar orb users see later.
type IntelMode = "low" | "default" | "high" | "auto";

const ORB_COLORS: Record<Exclude<IntelMode, "auto">, { a: string; b: string; c: string }> = {
  low:     { a: "#FFAE00", b: "#FF6500", c: "#FFDE5E" },
  default: { a: "#1066FF", b: "#33E9FF", c: "#AADAFF" },
  high:    { a: "#C50DFF", b: "#FF64FF", c: "#FFA4FF" },
};

// Cycle only low/default/high on page 1 — skipping "auto" lets the colour
// crossfade ride a CSS transition on the @property-typed --orb-a/b/c
// variables, instead of fighting the auto-cycle's @keyframes animation.
// Page 2 still shows all four modes side-by-side, including auto.
const MODE_ORDER: Exclude<IntelMode, "auto">[] = ["default", "high", "low"];

// ─── HeroOrb ──────────────────────────────────────────────────────────────
// Re-renders the toolbar's 6-orb mesh at large scale. Uses transform:scale
// so internal animations (orbits, blurs) stay proportional to the original
// 20px geometry — no need to duplicate keyframes for a bigger size.
function HeroOrb({ mode, size = 220 }: { mode: IntelMode; size?: number }) {
  const isAuto = mode === "auto";
  const single = !isAuto ? ORB_COLORS[mode] : null;
  const styleVars = !isAuto && single
    ? ({ "--orb-a": single.a, "--orb-b": single.b, "--orb-c": single.c } as CSSProperties)
    : undefined;

  // 20px is the production size; scale up to `size`.
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

function CyclingOrb({ active }: { active: boolean }) {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    // Only run the colour cycle while page 1 is the visible page. With the
    // interval running while the user is on page 2/3/4, the orb's colour
    // would tick every 4 s in an off-screen page, triggering a full
    // CyclingOrb → HeroOrb subtree re-render. Pausing here keeps the
    // onboarding render budget free for whatever the user is actually
    // looking at and avoids a stale colour on return (it just resumes
    // from wherever it was, which is fine — same orb, same palette).
    if (!active) return;
    // 4 s dwell on each colour; the CSS transition on --orb-a/b/c is 1.4 s,
    // so the eye sees ~2.6 s of solid colour and ~1.4 s of crossfade.
    const id = window.setInterval(() => {
      setIdx((i) => (i + 1) % MODE_ORDER.length);
    }, 4000);
    return () => window.clearInterval(id);
  }, [active]);
  return <HeroOrb mode={MODE_ORDER[idx]} size={220} />;
}

// ─── Welcome demo data ───────────────────────────────────────────────────
// Static, hand-tuned snapshot — the welcome screen now renders the actual
// production widgets (TensionWidget, ProseProfileWidget) with this mock
// data, so what the user sees here is exactly what they'll see in the
// analysis panel once they're writing. No synthetic mock components, no
// drift animation: the curve below is shaped to read as a turbulent
// chapter with multiple ups-and-downs, and a peak around 96 %.

const MOCK_TENSION_ANALYSIS = {
  // Two distinct peaks (around index 9 / 13) separated by a trough at
  // index 10–11 — clearly a "double-peak" arc to the eye.
  tensionCurve: [
    0.22, 0.55, 0.30, 0.48, 0.18, 0.62, 0.35, 0.78, 0.55, 0.88,
    0.40, 0.30, 0.72, 0.96, 0.58, 0.82, 0.42, 0.55,
  ],
  peakTension: "high",
  arcShape: "double-peak",
  peakLabel: "confrontation",
  guidance: { peakPosition: 78 },
  // No highModeAnalysis — keeps the card clean of structure segments
  // (those are a high-mode-only band; the welcome card stays readable).
  highModeAnalysis: undefined,
} as unknown as ChapterAnalysis;

// Sample paragraph — past, third-person, varied rhythm, sensory-heavy.
// profileChapter() should classify it as 3rd-past-varied-showing.
const MOCK_PROSE_TEXT = `The rain caught him at the bridge. He pulled his coat tight and pressed forward into the wind. Sarah's voice still echoed in his head — soft, unsure, the way she had said his name. A car hissed past, headlights bleached against wet stone. He thought of turning back. He did not turn back. The river beneath ran black and silver, swollen with the storm. Somewhere downstream a bell tolled three quick beats, then silence. He counted his steps to the far end and walked them without looking up. The far bank waited, dark and patient, full of whatever he had come there to find.`;

// Just a thin wrapper so the widgets get the same scale as the rest of
// the welcome layout. Real .widget-card defaults to its source size
// (480 px equivalent at zoom 1); the welcome card is ~720 px wide so we
// scale slightly up via CSS, not via a transform — keeping all internal
// metrics intact.
function MockTensionWidget() {
  return <TensionWidget analysis={MOCK_TENSION_ANALYSIS} />;
}

function MockProseProfileWidget() {
  return <ProseProfileWidget content={MOCK_PROSE_TEXT} />;
}

// ─── Pages ────────────────────────────────────────────────────────────────

interface OnbPageProps {
  active: boolean;
  children: React.ReactNode;
}
function OnbPage({ active, children }: OnbPageProps) {
  return (
    <div className={`onb-page ${active ? "onb-page--active" : ""}`} aria-hidden={!active}>
      {children}
    </div>
  );
}

const MODE_DESCRIPTIONS: Array<{ mode: IntelMode; title: string; sub: string }> = [
  { mode: "low",     title: "Low",     sub: "Fast skim · ~85% accuracy" },
  { mode: "default", title: "Default", sub: "Balanced — most chapters" },
  { mode: "high",    title: "High",    sub: "Cross-arc · prose texture" },
  { mode: "auto",    title: "Auto",    sub: "Adapts per chapter" },
];

const TIPS = [
  { keys: ["⌘", "⏎"],       label: "New chapter" },
  { keys: ["⌘", "F"],        label: "Find in chapter" },
  { keys: ["⌘", "⇧", "F"],   label: "Find across project" },
  { keys: ["⌘", "."],        label: "Focus mode" },
  { keys: ["⌘", "⇧", "P"],   label: "Export PDF" },
];

interface Props {
  onClose: () => void;
}

export function Onboarding({ onClose }: Props) {
  const [page, setPage] = useState(0);
  const total = 4;

  // Mount-only escape handler — Esc dismisses with the same effect as Skip,
  // matching the macOS Creator-Studio onboarding pattern.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setPage((p) => Math.min(total - 1, p + 1));
      if (e.key === "ArrowLeft")  setPage((p) => Math.max(0, p - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Compute slide transform — keeps all 4 pages mounted but only the active
  // one visible. The track is 400% of the stage width and each page is
  // 25% of the track, so one "page step" is -25% of the track's own width
  // (which is -100% of the stage, i.e. one full page-width of slide).
  const slideStyle = useMemo<CSSProperties>(() => ({
    transform: `translate3d(${-page * 25}%, 0, 0)`,
  }), [page]);

  const isLast = page === total - 1;

  return (
    <div
      className="onb-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Latent Write"
    >
      <div className="onb-card liquid-glass">

        {/* Top-right close — discreet escape hatch */}
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

            {/* PAGE 1 — Welcome */}
            <OnbPage active={page === 0}>
              <div className="onb-hero onb-hero--orb">
                <CyclingOrb active={page === 0} />
              </div>
              <h1 className="onb-title">Welcome to Latent Write</h1>
              <p className="onb-subtitle">
                A focused, intelligent home for your novel.
                Built so the analysis sits beside the work — never in front of it.
              </p>
            </OnbPage>

            {/* PAGE 2 — Intelligence modes */}
            <OnbPage active={page === 1}>
              <div className="onb-hero onb-hero--modes">
                {MODE_DESCRIPTIONS.map(({ mode, title, sub }) => (
                  <div className="onb-mode" key={mode}>
                    <HeroOrb mode={mode} size={68} />
                    <div className="onb-mode-title">{title}</div>
                    <div className="onb-mode-sub">{sub}</div>
                  </div>
                ))}
              </div>
              <h1 className="onb-title onb-title--small">Adaptive intelligence</h1>
              <p className="onb-subtitle">
                Pick how deep the analysis should run. <strong>Auto</strong> reads each
                chapter's dialogue density and dials itself up or down so heavy chapters
                get full treatment without slowing the others.
              </p>
            </OnbPage>

            {/* PAGE 3 — Live analysis */}
            <OnbPage active={page === 2}>
              <div className="onb-hero onb-hero--widgets">
                <MockTensionWidget />
                <MockProseProfileWidget />
              </div>
              <h1 className="onb-title onb-title--small">It reads as you write</h1>
              <p className="onb-subtitle">
                Tension arc, prose profile, voice fingerprint, continuity, style watch — every
                chapter gets a live pass. Numbers stay quiet until something interesting changes.
              </p>
            </OnbPage>

            {/* PAGE 4 — Ready */}
            <OnbPage active={page === 3}>
              <div className="onb-hero onb-hero--tips">
                <div className="onb-tip-grid">
                  {TIPS.map((t) => (
                    <div className="onb-tip" key={t.label}>
                      <div className="onb-tip-keys">
                        {t.keys.map((k, i) => (
                          <span key={i} className="onb-key">{k}</span>
                        ))}
                      </div>
                      <div className="onb-tip-label">{t.label}</div>
                    </div>
                  ))}
                </div>
              </div>
              <h1 className="onb-title onb-title--small">Ready when you are</h1>
              <p className="onb-subtitle">
                Open the index <kbd className="onb-inline-kbd">⌘ I</kbd> to add the book's
                title and author, then press <kbd className="onb-inline-kbd">⌘ ⏎</kbd> to
                start a chapter. The intelligence layer follows along quietly.
              </p>
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
              <span>{isLast ? "Get started" : "Next"}</span>
              {!isLast && <ChevronRight size={16} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
