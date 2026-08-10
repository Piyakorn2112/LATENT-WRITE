/**
 * Dev-only harness: the REAL <Onboarding/>, so the welcome tour can be read
 * and photographed rather than reasoned about.
 *
 * ★ WHY NOT BOOT THE WHOLE APP. index.html under a bare Electron window never
 *   renders: the preload exposes the IPC surface but electron/main.cjs is not
 *   the process running, so nothing answers the project load and App sits at
 *   an empty root forever. Driving the packaged app instead would mean not
 *   owning the window. The tour is a self-contained overlay with two props and
 *   the same global styles.css, so mounting it directly tests the same pixels.
 *
 * ?browser=1 forces the browser-build copy (no keyboard hints, export page
 * instead of the renderer), which is otherwise unreachable under Electron and
 * is half of what this component renders.
 *
 * Driven by scripts/verify-onboarding.cjs. Not imported by the app.
 */
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Onboarding } from "./components/Onboarding";

/**
 * ★★ DESKTOP IS THE DEFAULT, AND THE FIRST RUN GOT THIS BACKWARDS. This page
 *    loads with no preload, so `window.electronAPI` is absent and the
 *    component renders its BROWSER copy — which is how six screenshots of the
 *    wrong build got taken and read as if they were the app. The desktop copy
 *    is the one most writers see and the only one with the local-model page,
 *    so it is what the harness stubs in unless `?browser=1` asks otherwise.
 */
const forceBrowser = typeof location !== "undefined"
  && new URLSearchParams(location.search).has("browser");

if (forceBrowser) {
  delete (window as { electronAPI?: unknown }).electronAPI;
} else if (!window.electronAPI) {
  (window as { electronAPI?: unknown }).electronAPI = { isElectron: true };
}

document.body.style.margin = "0";
createRoot(document.getElementById("stage")!).render(
  <Onboarding onClose={() => {}} />,
);
