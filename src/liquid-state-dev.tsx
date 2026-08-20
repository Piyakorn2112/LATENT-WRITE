/* Dev-only harness for the liquid state indicator — served by Vite at
 * /liquid-state-dev.html, never bundled into the app.
 *
 * The contact sheets (film:liquid-state) are stills and the Electron gate reads
 * pixels; neither lets anyone WATCH the thing, and a transition is the one part of
 * this that only exists in time. Here the states are buttons, both schemes are on
 * screen at once, and the sizes run from the 18px it ships at up to 160.
 */
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { LiquidState, type LiquidStateName } from "./components/liquid-state/LiquidState";

const STATES: LiquidStateName[] = ["reading", "thinking", "writing"];
const SIZES = [18, 28, 48, 96, 160];

function Panel({ scheme, state }: { scheme: "light" | "dark"; state: LiquidStateName }) {
  return (
    <div className={`half ${scheme}`}>
      <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.55 }}>
        {scheme}
      </div>
      <div style={{ display: "flex", gap: 28, alignItems: "flex-end", marginTop: 24, flexWrap: "wrap" }}>
        {SIZES.map((s) => (
          <div key={s} style={{ textAlign: "center" }}>
            <LiquidState state={state} size={s} />
            <div style={{ fontSize: 10, opacity: 0.5, marginTop: 8 }}>{s}px</div>
          </div>
        ))}
      </div>
      {/* The row it actually ships in, so the 18px instance is judged beside real text
          rather than on its own in the middle of a page. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 40, fontSize: 13 }}>
        <LiquidState state={state} size={18} />
        <span>
          {state === "reading" ? "Reading chapter 3 of 12…"
            : state === "thinking" ? "Turning it over…"
            : "Writing the card…"}
        </span>
      </div>
    </div>
  );
}

function Harness() {
  const [state, setState] = useState<LiquidStateName>("thinking");
  const [auto, setAuto] = useState(false);

  /* ★ THE CYCLE IS THE POINT. Every transition is authored per (from → to) pair, so
   *   the only way to see the tear and the collision is to walk the ring. */
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => {
      setState((s) => STATES[(STATES.indexOf(s) + 1) % STATES.length]);
    }, 2200);
    return () => clearInterval(t);
  }, [auto]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const i = ["1", "2", "3"].indexOf(e.key);
      if (i >= 0) { setAuto(false); setState(STATES[i]); }
      if (e.key === " ") { e.preventDefault(); setAuto((v) => !v); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <div style={{
        position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", zIndex: 2,
        display: "flex", gap: 6, padding: 6, borderRadius: 999,
        background: "rgba(128,128,128,0.22)", backdropFilter: "blur(12px)",
      }}>
        {STATES.map((s, i) => (
          <button
            key={s}
            onClick={() => { setAuto(false); setState(s); }}
            style={{
              font: "12px system-ui", padding: "6px 14px", borderRadius: 999, cursor: "pointer",
              border: "none", color: state === s && !auto ? "#fff" : "inherit",
              background: state === s && !auto ? "rgba(59,130,246,0.9)" : "transparent",
            }}
          >
            {s} <span style={{ opacity: 0.5 }}>{i + 1}</span>
          </button>
        ))}
        <button
          onClick={() => setAuto((v) => !v)}
          style={{
            font: "12px system-ui", padding: "6px 14px", borderRadius: 999, cursor: "pointer",
            border: "none", color: auto ? "#fff" : "inherit",
            background: auto ? "rgba(59,130,246,0.9)" : "transparent",
          }}
        >
          cycle <span style={{ opacity: 0.5 }}>space</span>
        </button>
      </div>
      <Panel scheme="light" state={state} />
      <Panel scheme="dark" state={state} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
