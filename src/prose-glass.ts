/**
 * Dev-only: fills /prose-glass.html with deterministic prose carrying coloured
 * entity/action spans, then starts the real glass engine. Driven by the
 * scratch capture script; not imported by the app.
 */
import "./styles.css";
import { initLiquidGlassFilter } from "./lib/liquid-glass-filter";
import { initEdgeColor } from "./lib/edge-color/edge-color";

const SENTENCE =
  "The lantern swung once against the doorframe and went still she counted " +
  "the boats again the way she had every evening since the tide turned and " +
  "found the same answer she had found the night before the cove was quiet ";
const words = SENTENCE.trim().split(" ");

const prose = document.getElementById("prose")!;
let html = "";
for (let i = 0; i < 460; i++) {
  const w = words[i % words.length];
  // Deterministic, and spaced so both card and popover cover several of each.
  if (i % 19 === 4) html += `<span class="pg-blue edge-color-src">${w}</span> `;
  else if (i % 27 === 9) html += `<span class="pg-warm edge-color-src">${w}</span> `;
  else if (i % 23 === 3) html += `<span class="pg-teal edge-color-src">${w}</span> `;
  else html += `${w} `;
}
prose.innerHTML = html;

initLiquidGlassFilter();
// Same selector the app uses, so the specular rim under test is the shipping one.
// ?norim disables the specular rim, so a capture pair isolates the rim's OWN
// contribution — the only honest way to ask "is it visible", since measuring
// rim-band vs interior just measures the backdrop showing through the glass.
initEdgeColor({
  selector: ".liquid-glass, .analysis-tab, .analysis-action-group, .liquid-glass-control-knob",
  ...(new URLSearchParams(location.search).has("norim") ? { rimWidth: 0 } : {}),
});

interface W extends Window { __glassReady?: boolean }
// ★ READINESS, NOT A SLEEP. Two things bind asynchronously here — the glass
// engine (worker map, then an idle callback) and the edge-colour loop (which
// settles over several frames). An A/B that captures early silently compares
// "filter bound" against "filter not bound yet" and reports a huge difference
// that has nothing to do with the change under test; that is exactly what one
// run of this harness did. So: require EVERY surface to carry a url() filter,
// then require the rims to be populated, then hold for a few settle frames.
//
// Read the COMPUTED value — the inline one serialises as url("#id") and is
// easy to miss with a naive check.
const start = Date.now();
const iv = window.setInterval(() => {
  const specs = [...document.querySelectorAll<HTMLElement>(".spec")];
  const filtered = specs.filter((el) =>
    (getComputedStyle(el).backdropFilter || "").includes("url("));
  const rims = [...document.querySelectorAll(".lqg-edge-rim")];
  const lit = rims.filter((r) => [...r.children].some((c) =>
    (c as HTMLElement).style.boxShadow));
  const wantRims = !new URLSearchParams(location.search).has("norim");
  const ok = specs.length > 0 && filtered.length === specs.length
    && (!wantRims || (rims.length === specs.length && lit.length === rims.length));
  if (ok || Date.now() - start > 20000) {
    window.clearInterval(iv);
    if (!ok) console.warn("[prose-glass] timed out before everything settled");
    // Let the edge-colour loop reach its settled frame before anyone captures.
    window.setTimeout(() => { (window as W).__glassReady = true; }, 600);
  }
}, 100);
