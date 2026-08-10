/**
 * Dev-only harness for GlassModeSelector, driven by scripts/verify-mode-ui.cjs.
 *
 * The thing worth looking at is the PRESS state: the knob swells, turns
 * translucent, and KnobGlass paints the label underneath it refracted. A
 * screenshot of the idle state proves nothing about the material.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { GlassModeSelector, type ModeOption } from "./components/GlassModeSelector";

type Mode = "off" | "on" | "max";
const OPTIONS: ReadonlyArray<ModeOption<Mode>> = [
  { value: "off", label: "Off", note: "Deterministic engines only. Nothing is downloaded." },
  { value: "on",  label: "On",  note: "Qwen3 1.7B · 1.1 GB · marks and classifies as you write." },
  { value: "max", label: "Max", note: "Qwen3 4B Thinking · 2.5 GB · reads for meaning. Needs ~3.7 GB free." },
];

function Harness() {
  const [mode, setMode] = useState<Mode>("on");
  /**
   * ★ THE LOCKED TRACK KEEPS ITS OWN STATE AND REFUSES, exactly as
   *   AnalysisPanel's handleMode does. A harness that let the press through
   *   would prove the badge renders and nothing about whether the gate holds,
   *   which is the half that matters.
   */
  const [lockedMode, setLockedMode] = useState<Mode>("on");
  const [refused, setRefused] = useState(0);
  return (
    <div style={{ padding: 40, display: "flex", flexDirection: "column", gap: 28, width: 380 }}>
      <GlassModeSelector value={mode} options={OPTIONS} onChange={setMode} ariaLabel="Assistant mode" />
      <GlassModeSelector
        value={mode}
        options={OPTIONS.map((o) => (o.value === "max" ? { ...o, disabled: true, note: "Needs ~3.7 GB free · you have 1.2 GB" } : o))}
        onChange={setMode}
        ariaLabel="Assistant mode, max unavailable"
      />
      {/* The free tier: Max stays pressable, is marked PRO, and is refused. */}
      <div id="locked-track" data-refused={refused} data-mode={lockedMode}>
        <GlassModeSelector
          value={lockedMode}
          options={OPTIONS.map((o) => (o.value === "max" ? { ...o, locked: true } : o))}
          onChange={(next) => {
            if (next === "max") { setRefused((n) => n + 1); return; }
            setLockedMode(next);
          }}
          ariaLabel="Assistant mode, max is pro"
        />
      </div>
    </div>
  );
}

document.body.style.margin = "0";
document.body.style.background = "var(--bg)";
createRoot(document.getElementById("stage")!).render(<StrictMode><Harness /></StrictMode>);

interface W extends Window { __probe?: () => Record<string, unknown> }
(window as W).__probe = () => {
  const track = document.querySelector(".glass-mode");
  const knob = document.querySelector<HTMLElement>(".glass-mode-knob");
  const canvas = document.querySelector<HTMLCanvasElement>(".glass-mode-knob .knob-glass-canvas");
  const labels = [...document.querySelectorAll(".glass-mode-label")];
  return {
    optionCount: document.querySelectorAll(".glass-mode-option").length,
    labels: labels.map((l) => l.textContent ?? ""),
    refractable: document.querySelectorAll(".glass-mode-label.glass-refract-text").length,
    knobLabel: document.querySelector(".glass-mode-knob-label")?.textContent ?? "",
    painting: !!canvas,
    canvasPx: canvas ? `${canvas.width}x${canvas.height}` : "",
    knobRect: knob ? knob.getBoundingClientRect().toJSON() : null,
    trackRect: track ? track.getBoundingClientRect().toJSON() : null,
    checked: [...document.querySelectorAll('[role="radio"]')].map((r) => r.getAttribute("aria-checked")),
    disabled: [...document.querySelectorAll(".glass-mode-option")].map((b) => (b as HTMLButtonElement).disabled),
    note: document.querySelector(".glass-mode-note")?.textContent ?? "",
    knobLabelOpacity: getComputedStyle(document.querySelector(".glass-mode-knob-label")!).opacity,
  };
};
