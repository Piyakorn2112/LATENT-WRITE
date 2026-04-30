'use client';

import React from 'react';

// ---------------------------------------------------------------------------
// ScrollEdge — fixed viewport edge that separates static UI from scrollable
// content. Provides multiple visual styles for the transition between fixed
// elements (headers, tab bars) and the scrolling area underneath.
//
// Progressive blur technique: stacked strips with decreasing backdrop-filter
// blur and gradient masks create a smooth, physically-plausible transition.
// The blur values follow a gentle exponential curve (base 1.6) so the
// transition feels natural — strong at the anchored edge, fading smoothly
// toward the content with no visible stepping in the middle.
// ---------------------------------------------------------------------------

/** Total number of blur strips for the progressive blur effect */
const STRIP_COUNT = 18;

/** Maximum blur radius (px) at the anchored edge */
const MAX_BLUR = 10;

/**
 * Exponential base — controls the steepness of the blur curve.
 * Lower = gentler rolloff (more blur lingers in the middle).
 * 1.6 gives a natural, perception-matched falloff.
 */
const EXP_BASE = 2;

/**
 * Generate blur strips programmatically using a gentle exponential curve.
 *  blur(i) = MAX_BLUR × ((STRIP_COUNT - i) / STRIP_COUNT) ^ EXP_BASE
 * Strip 0 (anchored edge) gets MAX_BLUR, last strip → ~0.
 * The first strip is taller (flex 2.5) so the strongest blur covers more area.
 */
const BLUR_STRIPS: { blur: number; flex: number }[] = Array.from(
  { length: STRIP_COUNT },
  (_, i) => ({
    blur: +(MAX_BLUR * ((STRIP_COUNT - i) / STRIP_COUNT) ** EXP_BASE).toFixed(2),
    flex: 1,
  }),
);

/**
 * Mask gradient for strip blending.
 * A wider transparent-to-opaque ramp produces smoother overlap between
 * neighbouring strips, eliminating the visible "shelf" artefact.
 */
const STRIP_MASK =
  'linear-gradient(to bottom, transparent 0%, black 20%, black 80%, transparent 100%)';

/** Overlap (negative margin) between strips — larger = smoother blend */
const STRIP_OVERLAP = -12;

const LEGACY_NAMED_HEIGHTS: Record<string, string> = {
  'h-px': '1px',
  'h-full': '100%',
  'h-screen': '100vh',
};

interface ScrollEdgeProps {
  /**
   * Which viewport edge the component sticks to.
   * - `top`    — fixed at the top of the viewport (e.g. below a header)
   * - `bottom` — fixed at the bottom of the viewport (e.g. above a tab bar)
   */
  position?: 'top' | 'bottom';

  /**
   * Visual style of the edge:
   * - `solid`         — opaque fill using the app background color
   * - `solid-line`    — same as solid + a subtle border line at the content edge
   * - `colored-glass` — backdrop blur with a slight tint of the background color
   * - `clear-glass`   — pure backdrop blur (no tint)
   * - `soft`          — gradient fade from background color to transparent
   * - `soft-blur`     — progressive blur combined with a gradient fade
   *
   * Glass variants support an additional `line` prop for an edge border.
   */
  variant?:
    | 'solid'
    | 'solid-line'
    | 'colored-glass'
    | 'clear-glass'
    | 'soft'
    | 'soft-blur';

  /**
   * Edge height as CSS length/value (e.g. "90px", "6rem", "10vh").
   * Legacy Tailwind-style class values are still accepted for backward
   * compatibility (e.g. "h-[90px]", "h-24").
   */
  height?: string;

  /**
   * Show a subtle border line at the content-facing edge.
   * Applies to `colored-glass` and `clear-glass` variants.
   * Always true for `solid-line`.
   */
  line?: boolean;

  className?: string;
  children?: React.ReactNode;

  /**
   * Positioning scope:
   * - `viewport`  — fixed to the viewport edge (default behavior)
   * - `container` — absolutely positioned within a relative parent container
   */
  scope?: 'viewport' | 'container';

  /**
   * Base color used by solid and gradient variants.
   * Defaults to app background for backward compatibility.
   */
  edgeColor?: string;
}

export function ScrollEdge({
  position = 'top',
  variant = 'soft',
  height = '96px',
  line = false,
  className = '',
  children,
  scope = 'viewport',
  edgeColor = 'var(--color-background)',
}: ScrollEdgeProps) {
  const isTop = position === 'top';
  const isViewportScope = scope === 'viewport';
  const resolvedHeight = resolveHeight(height);

  // ---------- shared classes ----------
  const positionClass = isViewportScope
    ? isTop
      ? '-top-2'
      : '-bottom-2'
    : isTop
      ? 'top-0'
      : 'bottom-0';
  const anchorClass = isViewportScope ? 'fixed' : 'absolute';
  const baseClasses = `${anchorClass} left-0 right-0 z-20 ${positionClass}`;

  /**
   * Safe-area extension — on iOS 26+ Safari's floating toolbar no longer
   * covers the full edge. Content behind the system chrome is visible,
   * so the ScrollEdge must extend PAST the safe area to fully mask it.
   * We use negative inset + matching padding so the visual effect area
   * stays in the same place while the background/blur covers the unsafe zone.
   */
  const safeAreaStyle: React.CSSProperties = isViewportScope
    ? isTop
      ? {
          top: 'calc(-1 * env(safe-area-inset-top, 0px) - 8px)',
          paddingTop: 'env(safe-area-inset-top, 0px)',
        }
      : {
          bottom: 'calc(-1 * env(safe-area-inset-bottom, 0px) - 8px)',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }
    : {};

  const baseStyle: React.CSSProperties = {
    ...safeAreaStyle,
    height: resolvedHeight,
  };

  // ---------- edge line ----------
  const showLine = line || variant === 'solid-line';
  const lineClasses = showLine
    ? isTop
      ? 'border-b border-[var(--color-border)]'
      : 'border-t border-[var(--color-border)]'
    : '';

  // ---------- gradient direction ----------
  const gradientDir = isTop ? 'to bottom' : 'to top';

  // ========================== VARIANTS ==========================

  // Solid — uses inline style for background so the CSS variable is read
  // correctly (Tailwind arbitrary values can't resolve --color-background
  // through the opacity modifier pipeline).
  if (variant === 'solid' || variant === 'solid-line') {
    return (
      <div
        className={`${baseClasses} ${lineClasses} ${className}`}
        style={{ ...baseStyle, backgroundColor: edgeColor }}
      >
        {children}
      </div>
    );
  }

  if (variant === 'colored-glass') {
    return (
      <div
        className={`${baseClasses} backdrop-blur-xl ${lineClasses} ${className}`}
        style={{ ...baseStyle, backgroundColor: `color-mix(in srgb, ${edgeColor} 30%, transparent)` }}
      >
        {children}
      </div>
    );
  }

  if (variant === 'clear-glass') {
    return (
      <div className={`${baseClasses} backdrop-blur-xl ${lineClasses} ${className}`} style={baseStyle}>
        {children}
      </div>
    );
  }

  if (variant === 'soft') {
    return (
      <div
        className={`${baseClasses} pointer-events-none ${className}`}
        style={{
          ...baseStyle,
          background: `linear-gradient(${gradientDir}, ${edgeColor} 0%, ${edgeColor} 25%, transparent 100%)`,
        }}
      >
        {children}
      </div>
    );
  }

  if (variant === 'soft-blur') {
    return (
      <div className={`${baseClasses} overflow-hidden pointer-events-none ${className}`} style={baseStyle}>
        {/* Progressive blur strips — flipped via scaleY for bottom position */}
        <div
          className="flex flex-col h-full"
          style={!isTop ? { transform: 'scaleY(-1)' } : undefined}
        >
          {BLUR_STRIPS.map((strip, i) => (
            <div
              key={i}
              style={{
                flex: strip.flex,
                backdropFilter: `blur(${strip.blur}px)`,
                WebkitBackdropFilter: `blur(${strip.blur}px)`,
                ...(i > 0
                  ? {
                      marginTop: `${STRIP_OVERLAP}px`,
                      WebkitMaskImage: STRIP_MASK,
                      maskImage: STRIP_MASK,
                    }
                  : {}),
              }}
            />
          ))}
        </div>

        {/* Gradient overlay — more opaque near the anchored edge for solidity */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: `linear-gradient(${gradientDir}, ${edgeColor} 0%, ${edgeColor} 15%, transparent 95%)`,
            opacity: 0.8,
          }}
        />

        {children}
      </div>
    );
  }

  return null;
}

function resolveHeight(value: string): string {
  if (!value) {
    return '96px';
  }

  const legacyArbitraryMatch = value.match(/^h-\[(.+)\]$/);
  if (legacyArbitraryMatch) {
    return legacyArbitraryMatch[1];
  }

  const legacyScaleMatch = value.match(/^h-(\d+)$/);
  if (legacyScaleMatch) {
    return `${Number(legacyScaleMatch[1]) / 4}rem`;
  }

  const legacyNamed = LEGACY_NAMED_HEIGHTS[value];
  if (legacyNamed) {
    return legacyNamed;
  }

  return value;
}