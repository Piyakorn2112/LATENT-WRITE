/**
 * Dev harness for the liquid-glass edge-colour layer. Standalone — imports only
 * the new module, touches no app code. Builds a colourful scene + draggable
 * glass cards so the oversized-backdrop colour catching can be evaluated and
 * tuned in isolation.
 */
import { initEdgeColor, type EdgeColorOptions } from "./lib/edge-color/edge-color";

const root = document.getElementById("root")!;

// ── Scene: scattered coloured blocks ───────────────────────────────────────
const blocks: Array<{ x: number; y: number; w: number; h: number; color: string }> = [
  { x: 60, y: 90, w: 240, h: 300, color: "#e23b3b" },
  { x: 330, y: 60, w: 260, h: 180, color: "#2f6bff" },
  { x: 360, y: 300, w: 300, h: 260, color: "#23c552" },
  { x: 700, y: 80, w: 220, h: 240, color: "#ff8a00" },
  { x: 720, y: 360, w: 260, h: 220, color: "#b341e0" },
  { x: 980, y: 120, w: 240, h: 360, color: "#10c4c4" },
  { x: 120, y: 430, w: 200, h: 200, color: "#f5d000" },
  // a couple of neutral blocks — the wash should stay near-grey over these
  { x: 520, y: 560, w: 220, h: 130, color: "#3a3a3e" },
  { x: 1000, y: 520, w: 200, h: 150, color: "#cfcfcf" },
];

for (const b of blocks) {
  const el = document.createElement("div");
  el.className = "block";
  Object.assign(el.style, {
    left: `${b.x}px`,
    top: `${b.y}px`,
    width: `${b.w}px`,
    height: `${b.h}px`,
    background: b.color,
  });
  root.appendChild(el);
}

// ── Draggable glass cards (opt-in via the `liquid-glass-color` class) ───────
function makeCard(left: number, top: number, label: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "glass liquid-glass-color";
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  card.textContent = label;

  let dragging = false;
  let ox = 0;
  let oy = 0;
  card.addEventListener("pointerdown", (e) => {
    dragging = true;
    ox = e.clientX - card.offsetLeft;
    oy = e.clientY - card.offsetTop;
    card.setPointerCapture(e.pointerId);
  });
  card.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    card.style.left = `${e.clientX - ox}px`;
    card.style.top = `${e.clientY - oy}px`;
    // The engine wakes on scroll/resize/transition/content changes, not on a
    // JS-driven drag — nudge it so the overlay tracks while dragging here.
    document.dispatchEvent(new Event("scroll"));
  });
  card.addEventListener("pointerup", (e) => {
    dragging = false;
    card.releasePointerCapture(e.pointerId);
  });
  root.appendChild(card);
  return card;
}

makeCard(430, 200, "drag me");
makeCard(760, 230, "near the edges");

// ── Engine + live controls ─────────────────────────────────────────────────
let handle = initEdgeColor(readOptions());

function readOptions(): EdgeColorOptions {
  return {
    colorSources: ".block", // the harness swatches are the colour sources
    saturate: num("saturate"),
    brightness: num("brightness"),
    opacity: num("opacity"),
    glowRadius: num("glowRadius"),
    edgeBias: num("edgeBias"),
    resolutionScale: num("resolutionScale"),
    reach: num("reach"),
    rimWidth: num("rimWidth"),
    rimIntensity: num("rimIntensity"),
    rimBrightness: num("rimBrightness"),
    blendMode: (document.getElementById("blend") as HTMLSelectElement).value,
  };
}

function num(id: string): number {
  return parseFloat((document.getElementById(id) as HTMLInputElement).value);
}

function reinit() {
  handle.destroy();
  handle = initEdgeColor(readOptions());
}

for (const [id, out] of [
  ["saturate", "saturate-v"],
  ["brightness", "brightness-v"],
  ["opacity", "opacity-v"],
  ["glowRadius", "glowRadius-v"],
  ["edgeBias", "edgeBias-v"],
  ["resolutionScale", "resolutionScale-v"],
  ["reach", "reach-v"],
  ["rimWidth", "rimWidth-v"],
  ["rimIntensity", "rimIntensity-v"],
  ["rimBrightness", "rimBrightness-v"],
] as const) {
  const input = document.getElementById(id) as HTMLInputElement;
  const output = document.getElementById(out) as HTMLOutputElement;
  input.addEventListener("input", () => {
    output.textContent = input.value;
    reinit();
  });
}
(document.getElementById("blend") as HTMLSelectElement).addEventListener("change", reinit);
