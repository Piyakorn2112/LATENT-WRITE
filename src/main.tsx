import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { WorkspaceWindow } from "./components/WorkspaceWindow";
import "./styles.css";
import { initLiquidGlassFilter } from "./lib/liquid-glass-filter";

initLiquidGlassFilter();

// The standalone renderer-workspace window loads the same bundle with a
// #workspace hash, and renders only the workspace instead of the full editor.
const isWorkspaceWindow = window.location.hash.startsWith("#workspace");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isWorkspaceWindow ? <WorkspaceWindow /> : <App />}
  </StrictMode>
);
