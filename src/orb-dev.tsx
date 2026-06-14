/* Dev-only harness for tuning OrbEngine — served by Vite at /orb-dev.html,
   excluded from the production build (rollup input is index.html only).
   One theme per load (?theme=dark|light) — WebGL allows ~16 live contexts
   per renderer, and the engine's u_light follows prefers-color-scheme,
   which the Electron capture script drives via nativeTheme. */
import { createRoot } from "react-dom/client";
import { OrbEngine, type OrbEngineMode } from "./components/orb/OrbEngine";

const MODES: OrbEngineMode[] = ["auto", "default", "high", "fast", "off"];
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";

createRoot(document.getElementById("root")!).render(
  <div className={`half ${theme}`}>
    {MODES.map((m) => (
      <div className="row" key={m}>
        <b>{m}</b>
        <OrbEngine mode={m} size={20} />
        <OrbEngine mode={m} size={140} flowScale={0.6} />
        {m === "default" && <OrbEngine mode={m} size={20} analyzing />}
      </div>
    ))}
  </div>
);
