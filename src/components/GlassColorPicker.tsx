import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { GlassRange } from "./GlassRange";

interface Props {
  value: string;
  onChange: (next: string) => void;
}

interface HSV { h: number; s: number; v: number; }

const GCP_POPOVER_WIDTH = 256;
const GCP_POPOVER_GAP = 8;

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

// ── Wheel geometry ───────────────────────────────────────────────────────
//
// ★★ THE WHEEL HAS TWO HALVES AND THEY MUST SHARE A ZERO ANGLE.
//
//    painter — `conic-gradient(from 0deg, …)` in `.gcp-area-cloud`. A CSS
//              conic gradient starts at TWELVE O'CLOCK and runs clockwise, so
//              hue 0 (red) is painted at the TOP of the wheel.
//    reader  — `Math.atan2(dy, dx)`, which is 0 at THREE O'CLOCK. Screen y
//              grows downward, so it also runs clockwise.
//
//    Same direction, zero angles 90° apart. For a long time the reader used
//    the raw atan2 result as the hue, so clicking the red at the top of the
//    wheel handed back hue 270 — violet. Measured over 24 points against the
//    rendered pixels: slope +1.04 (so not a mirror) and a median delta of
//    +90.3° (a pure rotation). scripts/test-color-wheel.cjs is that
//    measurement, and it reads the real stylesheet so it cannot drift.
//
//    The offset lives in ONE constant used by BOTH directions below. If you
//    ever change `from 0deg` in the CSS, change only this number — and do not
//    hand-inline it into either function, because the bug was precisely that
//    the two ends were free to disagree.
const WHEEL_ZERO_OFFSET_DEG = 90;

/** Hue (0–360) for a point offset (dx, dy) from the wheel's centre, in screen
 *  coordinates where y grows downward. Exact inverse of `hueToUnit`. */
export function pointToHue(dx: number, dy: number): number {
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  return ((deg + WHEEL_ZERO_OFFSET_DEG) % 360 + 360) % 360;
}

/** Unit vector on the wheel for a hue, in the same screen coordinates.
 *  Exact inverse of `pointToHue`. */
export function hueToUnit(h: number): { x: number; y: number } {
  const a = ((h - WHEEL_ZERO_OFFSET_DEG) * Math.PI) / 180;
  return { x: Math.cos(a), y: Math.sin(a) };
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
  const swatchRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({ visibility: "hidden" });

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
      const target = e.target as Node;
      if (swatchRef.current?.contains(target) || popoverRef.current?.contains(target)) {
        return;
      }
        setOpen(false);
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

  useLayoutEffect(() => {
    if (!open) return;

    let frame = 0;
    const refreshPosition = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const swatch = swatchRef.current;
        if (!swatch) return;

        const rect = swatch.getBoundingClientRect();
        const popoverWidth = popoverRef.current?.offsetWidth ?? GCP_POPOVER_WIDTH;
        const popoverHeight = popoverRef.current?.offsetHeight ?? 0;
        let left = rect.right - popoverWidth;
        left = Math.max(12, Math.min(window.innerWidth - popoverWidth - 12, left));

        const below = rect.bottom + GCP_POPOVER_GAP;
        const above = rect.top - popoverHeight - GCP_POPOVER_GAP;
        const top = below + popoverHeight > window.innerHeight - 12 && above >= 12 ? above : below;

        setPopoverStyle({
          position: "fixed",
          top: Math.max(12, top),
          left,
          width: popoverWidth,
          visibility: "visible",
        });
      });
    };

    refreshPosition();
    window.addEventListener("resize", refreshPosition);
    window.addEventListener("scroll", refreshPosition, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", refreshPosition);
      window.removeEventListener("scroll", refreshPosition, true);
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
    const h = pointToHue(cx, cy);
    const next = { h, s, v: hsv.v < 0.02 ? 1 : hsv.v };
    setHsv(next);
    onChange(hsvToHex(next.h, next.s, next.v));
  };

  const updateBrightness = (nextValue: number) => {
    const next = { h: hsv.h, s: hsv.s, v: nextValue };
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

  // Handle position from HSV — polar mapping. Uses `hueToUnit` so the handle
  // is placed by the exact inverse of the function that reads the click; the
  // two must never be written out separately again.
  const handleStyle: CSSProperties = (() => {
    const u = hueToUnit(hsv.h);
    const x = 50 + hsv.s * 50 * u.x;
    const y = 50 + hsv.s * 50 * u.y;
    return { left: `${x}%`, top: `${y}%` };
  })();

  // Slider track — black → fully saturated current-hue, so the slider
  // shows the user the value range for *their* hue rather than a blunt
  // black-to-white. Matches the macOS picker's "lightness for selected
  // hue" affordance.
  const sliderTrackStyle: CSSProperties = {
    background: `linear-gradient(to right, #000 0%, ${hsvToHex(hsv.h, hsv.s, 1)} 100%)`,
  };

  const popover = (
    <div
      ref={popoverRef}
      className="gcp-popover liquid-glass"
      style={popoverStyle}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="gcp-area-shell">
        <div
          className="gcp-area"
          ref={areaRef}
          onPointerDown={onAreaDown}
          onPointerMove={onAreaMove}
          onPointerUp={onAreaUp}
          onPointerCancel={onAreaUp}
        >
          <div className="gcp-area-cloud" aria-hidden="true" />
        </div>
        <div className="gcp-handle-layer" aria-hidden="true">
          <div className="gcp-handle" style={handleStyle as CSSProperties}>
            <div
              className="gcp-handle-inner"
              style={{ background: value } as CSSProperties}
            />
          </div>
        </div>
      </div>
      <div className="gcp-bottom">
        <div
          className="gcp-preview"
          style={{ background: value } as CSSProperties}
        />
        <GlassRange
          min={0}
          max={1}
          step={0.01}
          value={hsv.v}
          onChange={updateBrightness}
          enableGlass
          className="gcp-slider"
          trackUnderlayStyle={sliderTrackStyle}
          showFill={false}
          ariaLabel="Brightness"
        />
      </div>
    </div>
  );

  return (
    <div className="gcp-root">
      <button
        type="button"
        ref={swatchRef}
        className="gcp-swatch"
        style={{ background: value } as CSSProperties}
        onClick={() => setOpen((o) => !o)}
        aria-label="Pick color"
      />
      {open && typeof document !== "undefined" && createPortal(popover, document.body)}
    </div>
  );
}
