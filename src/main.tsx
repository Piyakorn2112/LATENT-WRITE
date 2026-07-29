import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { WorkspaceWindow } from "./components/WorkspaceWindow";
import "./styles.css";
import { initLiquidGlassFilter } from "./lib/liquid-glass-filter";
import { initEdgeColor } from "./lib/edge-color/edge-color";

initLiquidGlassFilter();
// Edge colour layer (two parts, opt-in by class, no main-app code changes):
//   · BODY GLOW — a sibling inserted just BEHIND each glass surface, so the
//     glass's OWN backdrop-filter refracts + blurs it (zero extra GPU passes).
//     A shape-aware mesh glow (elliptical blobs sized to each nearby source's
//     facing extent) masked to an edge band so it hugs the rim, not the centre.
//   · SPECULAR RIM — a thin, bright conic ring child on top (crisp, un-refracted)
//     that catches the nearest colours on the very edge.
// Colour is read directly from the highlight layer by geometry; the loop is
// event-driven and idle-free, and tracks scroll in real time by translating the
// cached source positions per frame. Applied to the full glass class list.
initEdgeColor({
  selector: ".liquid-glass, .analysis-tab, .analysis-action-group, .liquid-glass-control-knob",
});

// The standalone renderer-workspace window loads the same bundle with a
// #workspace hash, and renders only the workspace instead of the full editor.
const isWorkspaceWindow = window.location.hash.startsWith("#workspace");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isWorkspaceWindow ? <WorkspaceWindow /> : <App />}
  </StrictMode>
);
