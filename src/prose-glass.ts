/**
 * Dev-only: fills /prose-glass.html with deterministic prose carrying coloured
 * entity/action spans, then starts the real glass engine. Driven by the
 * scratch capture script; not imported by the app.
 */
import "./styles.css";
import { initLiquidGlassFilter } from "./lib/liquid-glass-filter";

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
  if (i % 19 === 4) html += `<span class="pg-blue">${w}</span> `;
  else if (i % 27 === 9) html += `<span class="pg-warm">${w}</span> `;
  else if (i % 23 === 3) html += `<span class="pg-teal">${w}</span> `;
  else html += `${w} `;
}
prose.innerHTML = html;

initLiquidGlassFilter();

interface W extends Window { __glassReady?: boolean }
// The engine builds maps in a worker and binds on idle; the capture waits on
// this rather than a fixed sleep, which is what confounded an earlier A/B.
const start = Date.now();
const iv = window.setInterval(() => {
  const bound = document.querySelectorAll<HTMLElement>(".spec").length;
  const done = [...document.querySelectorAll<HTMLElement>(".spec")]
    .filter((el) => (el.style.backdropFilter || "").includes("url(")).length;
  if (done === bound || Date.now() - start > 15000) {
    window.clearInterval(iv);
    (window as W).__glassReady = true;
  }
}, 100);
