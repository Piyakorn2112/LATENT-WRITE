/* Dev-only harness for diagnosing the real LoadingLens component over text,
   with the liquid-glass engine running. Served by Vite at /lens-dev.html. */
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { initLiquidGlassFilter } from "./lib/liquid-glass-filter";
import { LoadingLens } from "./components/LoadingLens";
import "./styles.css";

initLiquidGlassFilter();

const PARA =
  "The rain caught him at the bridge. He pulled his coat tight and pressed " +
  "forward into the wind. Sarah's voice still echoed in his head, soft and " +
  "unsure, the way she had said his name. A car hissed past, headlights " +
  "bleached against wet stone. He thought of turning back. He did not turn back. ";

function Harness() {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setActive(true), 400);
    return () => clearTimeout(t);
  }, []);
  return (
    <>
      <div
        style={{
          position: "fixed", inset: 0, padding: "60px 90px", zIndex: 1,
          fontFamily: "Georgia, serif", fontSize: 19, lineHeight: 1.85,
          color: "#cfcfca", pointerEvents: "none",
        }}
      >
        {PARA.repeat(40)}
      </div>
      {/* Bright colour band behind the lens centre — to verify the lens no
          longer amplifies / shows mode colour (saturate 0). */}
      <div style={{
        position: "fixed", left: "50%", top: "50%", transform: "translate(-50%,-50%)",
        width: 420, height: 90, zIndex: 1, pointerEvents: "none",
        background: "linear-gradient(90deg,#1a5bff,#a02bf5,#ff5e2a)", opacity: 0.9,
      }} />
      <LoadingLens active={active} label="Inserting scene breaks…" />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
