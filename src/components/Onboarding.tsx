import { useEffect, useState } from "react";
import { BookOpenIcon, ChevronRight, CloseIcon, PenLineIcon } from "./Icon";
import { activateCode } from "../lib/license";
import { OrbEngine } from "./orb/OrbEngine";
import { recordOnb } from "../lib/onboarding-log";

/**
 * The welcome screen. ONE screen, two doors, then the app teaches inside
 * itself.
 *
 * ★★ THE SEVEN-CARD TOUR IS RETIRED, NOT REDESIGNED. The research pass
 *    (plans/onboarding-reimagine-2026-08.md §4) was unanimous: no serious
 *    creative tool ships a card slideshow any more, auto-fired linear tours
 *    lose 2-3x to contextual help, and working memory holds an unused
 *    instruction about twenty seconds, so a gesture taught on card 4 is gone
 *    before the editor opens. What survives here is the one thing a full
 *    screen earns: the mental model (a reader built in, everything local)
 *    and a choice of where to learn it. The teaching itself now lives where
 *    the research says it works, in the real app at the moment of relevance:
 *    the sample story carries the material, the checklist carries the path,
 *    and the gesture hint fires when the gesture actually exists.
 *
 * ★ BOTH DOORS ARE REAL WORK. "Open the sample story" starts the sandbox
 *   (in-memory, never persisted, resets on reopen, and the copy SAYS so,
 *   because a safety that isn't advertised doesn't license exploration).
 *   "Start your own book" opens a first chapter ready to type into. There is
 *   no forced order, no Next, and closing is a guilt-free skip.
 */

// Each "mode" reuses the production orb's pre-saturated palette. Keeps the
// welcome experience visually identical to the toolbar orb users see later.
type IntelMode = "fast" | "default" | "high";

const MODE_ORDER: IntelMode[] = ["default", "high", "fast"];

// ─── HeroOrb ──────────────────────────────────────────────────────────────
// ★ THE TOOLBAR ORB, CLOSER. OrbEngine with the toolbar's own character
//   (vibrance, aberration) at hero size — the six-petal flower IS the
//   product's identity mark, so the welcome shows exactly what the writer
//   will find at the top-left of the editor a moment later. flowScale < 1
//   because at hero scale the toolbar flow speed reads frantic.
function HeroOrb({ mode, size = 150 }: { mode: IntelMode; size?: number }) {
  return (
    <div className="onb-orb" style={{ width: size, height: size }}>
      <OrbEngine mode={mode} size={size} flowScale={0.45} vibrance={0.9} aberration={0.45} />
    </div>
  );
}

function CyclingOrb({ size = 150 }: { size?: number }) {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setIdx((i) => (i + 1) % MODE_ORDER.length), 4000);
    return () => window.clearInterval(id);
  }, []);
  return <HeroOrb mode={MODE_ORDER[idx]} size={size} />;
}

/** A keyboard hint that only appears where the keystroke actually works —
 *  every accelerator in this app is owned by the native menu, so shortcuts
 *  are desktop-only facts. */
function Kbd({ children, desktop }: { children: React.ReactNode; desktop: boolean }) {
  if (!desktop) return null;
  return <kbd className="onb-inline-kbd">{children}</kbd>;
}

// ─── Onboarding ───────────────────────────────────────────────────────────
interface Props {
  /** Close without choosing a door — Esc, the X. A guilt-free skip. */
  onClose: () => void;
  /** Door 1 — enter the sandbox. */
  onOpenSample: () => void;
  /** Door 2 — start (or return to) the writer's own book. */
  onStartOwn: () => void;
  /** The writer already has words of their own; door 2 becomes a way back. */
  hasOwnWords: boolean;
  /** The sample is open right now; door 1's copy owns the reset semantics. */
  inSample: boolean;
  onTierChange?: (tier: import("../lib/license").Tier) => void;
}

const ONBOARDING_OVERLAY_BODY_CLASS = "onboarding-overlay-freeze";

export function Onboarding({ onClose, onOpenSample, onStartOwn, hasOwnWords, inSample, onTierChange }: Props) {
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
    recordOnb("welcome-seen");
  }, []);

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
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="onb-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Latent Write"
    >
      <div className="onb-card onb-card--welcome liquid-glass">

        <button
          className="onb-close icon-btn"
          onClick={onClose}
          aria-label="Close welcome"
          title="Close (Esc)"
        >
          <CloseIcon size={15} />
        </button>

        <div className="onb-welcome">
          <div className="onb-welcome-hero">
            <CyclingOrb size={150} />
          </div>

          <h1 className="onb-title">Write. It reads along.</h1>
          <p className="onb-subtitle onb-subtitle--welcome">
            {/* ★ THE ONE MENTAL MODEL, then doing. Names, speech, tension and
                the rest are shown by the app itself the moment a story is
                open, so the copy spends its sentences on the two facts the
                first screen must establish and nothing else can: there is a
                reader in the editor, and it lives on this machine. */}
            A novel editor with a reader built in. It marks names, speech and
            tension as you write, and answers from what you have written.
            Everything runs on this machine, and nothing you write is uploaded.
          </p>

          <div className="onb-doors">
            <button type="button" className="onb-door onb-door--primary" onClick={onOpenSample}>
              <span className="onb-door-icon" aria-hidden="true">
                <BookOpenIcon size={15} />
              </span>
              <span className="onb-door-text">
                <span className="onb-door-label">Open the sample story</span>
                <span className="onb-door-sub">
                  {inSample
                    ? "You are in it now. Opening it again starts a fresh copy."
                    : "A keeper, a stranger, and a ledger that does not agree with itself. Safe to break, and it resets when you leave."}
                </span>
              </span>
              <ChevronRight size={14} className="onb-door-go" aria-hidden="true" />
            </button>

            <button type="button" className="onb-door" onClick={onStartOwn}>
              <span className="onb-door-icon" aria-hidden="true">
                <PenLineIcon size={15} />
              </span>
              <span className="onb-door-text">
                <span className="onb-door-label">{hasOwnWords ? "Back to your book" : "Start your own book"}</span>
                <span className="onb-door-sub">
                  {hasOwnWords ? (
                    "Your words are where you left them."
                  ) : (
                    <>
                      A blank first chapter. Or bring a draft in
                      {isElectron ? <> with <Kbd desktop={isElectron}>⌘O</Kbd></> : " from the toolbar"}.
                    </>
                  )}
                </span>
              </span>
              <ChevronRight size={14} className="onb-door-go" aria-hidden="true" />
            </button>
          </div>

          <div className="onb-pro-row onb-pro-row--welcome">
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
        </div>
      </div>
    </div>
  );
}
