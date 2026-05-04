import { useEffect, useRef, useState, type CSSProperties } from "react";

interface Props {
  value: string;
  onChange: (next: string) => void;
}

interface HSV { h: number; s: number; v: number; }

// ── Color math (HSV ↔ RGB ↔ hex) ──────────────────────────────────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = hex.replace("#", "");
  const n =
    m.length === 3 ? m.split("").map((c) => c + c).join("")
    : m.length >= 6 ? m.slice(0, 6)
    : m.padEnd(6, "0");
  return {
    r: parseInt(n.slice(0, 2), 16) || 0,
    g: parseInt(n.slice(2, 4), 16) || 0,
    b: parseInt(n.slice(4, 6), 16) || 0,
  };
}

function rgbToHsv(r: number, g: number, b: number): HSV {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  const v = max;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, v };
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const c = v * s;
  const hp = (h / 60) % 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; b = 0; }
  else if (hp < 2) { r = x; g = c; b = 0; }
  else if (hp < 3) { r = 0; g = c; b = x; }
  else if (hp < 4) { r = 0; g = x; b = c; }
  else if (hp < 5) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
}

function hsvToHex(h: number, s: number, v: number): string {
  return rgbToHex(hsvToRgb(h, s, v));
}

function hexToHsv(hex: string): HSV {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHsv(r, g, b);
}

// ── Component ────────────────────────────────────────────────────────────
//
// Click swatch → opens a glass popover with:
//   • Top: a circular hue/saturation cloud — a conic rainbow + radial
//     white-to-transparent overlay, blurred (filter: blur(8px)) and over-
//     saturated (filter: saturate(1.65)). The blur is what gives the
//     "soft glowing orb" feel asked for; the saturation compensation
//     keeps colours vivid despite the blur. The handle is a *sibling* of
//     the blurred cloud (not a child), so it stays sharp. Polar mapping:
//     angle = hue, radius = saturation.
//   • Bottom: small preview swatch + horizontal value (brightness)
//     slider, black → current-hue-at-full-saturation gradient track.
//
// The picker preserves hue when the user drags value to 0 (black) or
// up from a desaturated colour, so dragging the slider doesn't reset the
// chosen hue position the way naive hex round-trips do.

export function GlassColorPicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [hsv, setHsv] = useState<HSV>(() => hexToHsv(value));
  const rootRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);

  // External value sync. When the incoming hex maps to (almost) zero
  // saturation we keep the user's last hue angle so the handle stays
  // anchored as they slide value down to black and back up.
  useEffect(() => {
    const next = hexToHsv(value);
    setHsv((cur) => (next.s < 0.02 ? { h: cur.h, s: next.s, v: next.v } : next));
  }, [value]);

  // Outside-click + Escape close. Defer the mousedown registration by a
  // tick so the click that opened the popover doesn't immediately close
  // it through the document handler.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const t = window.setTimeout(() => window.addEventListener("mousedown", onDoc), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const updateFromAreaPoint = (clientX: number, clientY: number) => {
    const a = areaRef.current;
    if (!a) return;
    const rect = a.getBoundingClientRect();
    const cx = clientX - rect.left - rect.width / 2;
    const cy = clientY - rect.top - rect.height / 2;
    const radius = Math.min(rect.width, rect.height) / 2;
    const dist = Math.min(Math.hypot(cx, cy), radius);
    const s = radius > 0 ? dist / radius : 0;
    const angle = Math.atan2(cy, cx);
    const h = ((angle * 180) / Math.PI + 360) % 360;
    const next = { h, s, v: hsv.v < 0.02 ? 1 : hsv.v };
    setHsv(next);
    onChange(hsvToHex(next.h, next.s, next.v));
  };

  const updateFromSliderPoint = (clientX: number) => {
    const s = sliderRef.current;
    if (!s) return;
    const rect = s.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const next = { h: hsv.h, s: hsv.s, v: t };
    setHsv(next);
    onChange(hsvToHex(next.h, next.s, next.v));
  };

  const draggingArea = useRef(false);
  const onAreaDown = (e: React.PointerEvent) => {
    draggingArea.current = true;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    updateFromAreaPoint(e.clientX, e.clientY);
  };
  const onAreaMove = (e: React.PointerEvent) => {
    if (!draggingArea.current) return;
    updateFromAreaPoint(e.clientX, e.clientY);
  };
  const onAreaUp = (e: React.PointerEvent) => {
    draggingArea.current = false;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  };

  const draggingSlider = useRef(false);
  const onSliderDown = (e: React.PointerEvent) => {
    draggingSlider.current = true;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    updateFromSliderPoint(e.clientX);
  };
  const onSliderMove = (e: React.PointerEvent) => {
    if (!draggingSlider.current) return;
    updateFromSliderPoint(e.clientX);
  };
  const onSliderUp = (e: React.PointerEvent) => {
    draggingSlider.current = false;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  };

  // Handle position from HSV — polar mapping.
  const handleStyle: CSSProperties = (() => {
    const a = (hsv.h * Math.PI) / 180;
    const x = 50 + hsv.s * 50 * Math.cos(a);
    const y = 50 + hsv.s * 50 * Math.sin(a);
    return { left: `${x}%`, top: `${y}%` };
  })();

  // Slider track — black → fully saturated current-hue, so the slider
  // shows the user the value range for *their* hue rather than a blunt
  // black-to-white. Matches the macOS picker's "lightness for selected
  // hue" affordance.
  const sliderTrackStyle: CSSProperties = {
    background: `linear-gradient(to right, #000 0%, ${hsvToHex(hsv.h, hsv.s, 1)} 100%)`,
  };

  return (
    <div className="gcp-root" ref={rootRef}>
      <button
        type="button"
        className="gcp-swatch"
        style={{ background: value } as CSSProperties}
        onClick={() => setOpen((o) => !o)}
        aria-label="Pick color"
      />
      {open && (
        <div className="gcp-popover liquid-glass">
          <div
            className="gcp-area"
            ref={areaRef}
            onPointerDown={onAreaDown}
            onPointerMove={onAreaMove}
            onPointerUp={onAreaUp}
            onPointerCancel={onAreaUp}
          >
            {/* Blurred + saturated rainbow cloud (the "soft glowing orb"). */}
            <div className="gcp-area-cloud" aria-hidden="true" />
            {/* Handle is a sibling so it stays sharp despite the cloud's blur. */}
            <div className="gcp-handle" style={handleStyle as CSSProperties}>
              <div
                className="gcp-handle-inner"
                style={{ background: value } as CSSProperties}
              />
            </div>
          </div>
          <div className="gcp-bottom">
            <div
              className="gcp-preview"
              style={{ background: value } as CSSProperties}
            />
            <div
              className="gcp-slider"
              ref={sliderRef}
              onPointerDown={onSliderDown}
              onPointerMove={onSliderMove}
              onPointerUp={onSliderUp}
              onPointerCancel={onSliderUp}
            >
              <div className="gcp-slider-track" style={sliderTrackStyle as CSSProperties} />
              <div
                className="gcp-slider-knob"
                style={{ left: `${hsv.v * 100}%` } as CSSProperties}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
