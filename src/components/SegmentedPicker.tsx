// SegmentedPicker — the horizontal in-panel radio strip used by the
// DecorationPanel popovers and other tight inline pickers.
//
// Visual language: "Inverse" (Norton Commander selection bar). The active
// option is a SOLID chartreuse block with canvas-dark text inside — a
// backlit hardware key rendered as DOS inverse video. The fill is a single
// sliding element so the indicator animates between segments rather than
// each cell repainting.
//
//   ┌─────────────────────────────────────────┐
//   │ NUMBERED │ ▓▓▓▓▓ LABELED ▓▓▓▓▓ │ FULL    │
//   └─────────────────────────────────────────┘
//
// Mechanics:
//   • One `.fill` element absolutely positioned over the active segment,
//     transitioning `left` + `width` on selection change.
//   • Segment text rides above the fill (z-index 2). Active text flips to
//     canvas color so it reads cleanly on the chartreuse.
//   • 1px wire dividers at interior segment boundaries — hidden on the
//     edges that touch the active fill (left edge of active, right edge
//     of active) so we never draw a wire on top of the chartreuse.
//   • Equal-width segments via `flex: 1`. Height 26px. JetBrains Mono
//     labels echo the panel's section headers.

import { useState, type CSSProperties } from 'react';
import { semantic, fonts, radii, typeScale } from '../theme/tokens';

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedPickerProps<T extends string> {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (next: T) => void;
  disabledValues?: T[];
  /** Accessible label for the radiogroup. */
  ariaLabel?: string;
  /** Native title attribute on the group; per-option `title` comes from label. */
  title?: string;
}

const HEIGHT = 26;
const ANIM_MS = 320;
const ANIM_EASING = 'cubic-bezier(0.6, 0, 0.2, 1)';

/** Inverse-style segmented radio picker. See module docstring. */
export default function SegmentedPicker<T extends string>({
  value,
  options,
  onChange,
  disabledValues = [],
  ariaLabel,
  title,
}: SegmentedPickerProps<T>) {
  const [hoveredValue, setHoveredValue] = useState<T | null>(null);

  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const segmentPct = 100 / options.length;
  const activeLeftPct = activeIndex * segmentPct;

  // Interior boundaries — one wire per gap between two adjacent segments.
  // Hide the wires that touch the active segment (i === activeIndex is the
  // boundary to the LEFT of active; i === activeIndex - 1 is the boundary
  // to the right of the previous-to-active, i.e. the active's left edge;
  // i === activeIndex is the active's right edge). Both should disappear
  // under the chartreuse fill.
  const interiorBoundaries = Array.from({ length: options.length - 1 }, (_, i) => i);

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      title={title}
      data-testid="segmented-picker"
      style={containerStyle}
    >
      {/* Single sliding chartreuse fill behind the active segment. */}
      <div aria-hidden="true" style={fillStyle(activeLeftPct, segmentPct)} />

      {/* Interior dividers — drawn as absolutely positioned wires so they
       *  don't push segment text around. Wires that touch the active fill
       *  are skipped (they'd paint on top of the chartreuse). Boundary `i`
       *  sits at the right edge of segment `i` / left edge of segment
       *  `i + 1`. Active's left edge = boundary (activeIndex - 1); active's
       *  right edge = boundary activeIndex. */}
      {interiorBoundaries.map((i) => {
        const hidden = i === activeIndex - 1 || i === activeIndex;
        return (
          <span
            key={`div-${i}`}
            aria-hidden="true"
            style={dividerStyle(segmentPct * (i + 1), hidden)}
          />
        );
      })}

      {options.map((opt, i) => {
        const isActive = i === activeIndex;
        const isDisabled = disabledValues.includes(opt.value);
        const isHovered = hoveredValue === opt.value && !isDisabled;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            disabled={isDisabled}
            tabIndex={isActive ? 0 : -1}
            onClick={() => {
              if (isDisabled || isActive) return;
              onChange(opt.value);
            }}
            onMouseEnter={() => setHoveredValue(opt.value)}
            onMouseLeave={() => setHoveredValue(null)}
            data-testid={`segmented-option-${opt.value}`}
            style={segmentStyle({ isActive, isDisabled, isHovered })}
          >
            <span style={labelStyle}>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------- styles --------------------------------------------------------

const containerStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'stretch',
  width: '100%',
  height: HEIGHT,
  boxSizing: 'border-box',
  overflow: 'hidden',
  borderRadius: radii.base,
  backgroundColor: 'rgba(8, 12, 14, 0.7)',
  border: '1px solid rgba(76, 91, 92, 0.55)',
  userSelect: 'none',
};

function fillStyle(leftPct: number, widthPct: number): CSSProperties {
  return {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: `${leftPct}%`,
    width: `${widthPct}%`,
    zIndex: 1,
    backgroundColor: semantic.accent,
    boxShadow:
      'inset 0 1px 0 rgba(255, 255, 255, 0.45), inset 0 -1px 0 rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(188, 237, 9, 0.55)',
    transition: `left ${ANIM_MS}ms ${ANIM_EASING}, width ${ANIM_MS}ms ${ANIM_EASING}`,
    pointerEvents: 'none',
  };
}

function dividerStyle(leftPct: number, hidden: boolean): CSSProperties {
  return {
    position: 'absolute',
    left: `${leftPct}%`,
    top: 4,
    bottom: 4,
    width: 1,
    backgroundColor: 'rgba(76, 91, 92, 0.45)',
    opacity: hidden ? 0 : 1,
    transition: `opacity ${ANIM_MS}ms ${ANIM_EASING}`,
    pointerEvents: 'none',
    zIndex: 1,
  };
}

function segmentStyle({
  isActive,
  isDisabled,
  isHovered,
}: {
  isActive: boolean;
  isDisabled: boolean;
  isHovered: boolean;
}): CSSProperties {
  return {
    flex: 1,
    position: 'relative',
    zIndex: 2,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    padding: '0 6px',
    background: 'transparent',
    border: 'none',
    cursor: isDisabled ? 'not-allowed' : 'pointer',
    color: isActive
      ? semantic.bg
      : isHovered
        ? semantic.fg
        : semantic.fgMuted,
    opacity: isDisabled ? 0.35 : 1,
    transition: 'color 0.18s ease',
    fontFamily: fonts.mono,
    fontSize: typeScale.eyebrow,
    fontWeight: isActive ? 700 : 500,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    boxSizing: 'border-box',
    textShadow: isActive ? '0 1px 0 rgba(188, 237, 9, 0.6)' : undefined,
  };
}

const labelStyle: CSSProperties = {
  display: 'inline-block',
  maxWidth: '100%',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
