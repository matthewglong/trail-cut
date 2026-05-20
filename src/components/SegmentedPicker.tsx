// SegmentedPicker — the cartographic in-panel picker used by the map
// DecorationPanel popovers. Replaces ModePicker for in-panel usage; the
// fan-style ModePicker is still used by toolbar triggers where its
// glass-pill aesthetic earns the attention.
//
// Concept: "trail blaze". Hiking blazes are crisp painted marks on rocks
// and trees — small, intentional, unmistakable. The active option is
// marked by a chartreuse blaze that animates between segments when the
// selection changes. All options are always visible (no popup), so the
// picker reads as a tight horizontal strip that sits cleanly inside the
// panel's existing section chrome.
//
// Two visual treatments:
//   • `trail`  — blaze rides the TOP edge of the strip, with a soft
//                downward glow bleeding into the active segment. Dashed
//                contour line along the bottom for cartographic texture.
//   • `summit` — the active segment lifts with an accent ink-stamp tint
//                and a tiny chartreuse triangle "summit marker" hovers
//                above the active label.
//
// Both variants share:
//   • JetBrains Mono labels (echoing the panel's section headers)
//   • A single animated chartreuse indicator (no per-segment redraw)
//   • Cartographic tick marks at segment boundaries (`trail`) or a
//     dashed baseline (`summit`)
//   • 26px tall, equal-width segments, no border radius beyond the
//     hairline corner of the outer container.

import { useState, type CSSProperties } from 'react';
import { semantic, fonts, radii, typeScale } from '../theme/tokens';

export type SegmentedVariant = 'trail' | 'summit';

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
  /** Visual treatment. Defaults to `trail`. */
  variant?: SegmentedVariant;
}

const HEIGHT = 26;
const ANIM_MS = 320;
const ANIM_EASING = 'cubic-bezier(0.6, 0, 0.2, 1)';

/** Cartographic in-panel picker. See module docstring for design notes. */
export default function SegmentedPicker<T extends string>({
  value,
  options,
  onChange,
  disabledValues = [],
  ariaLabel,
  title,
  variant = 'trail',
}: SegmentedPickerProps<T>) {
  const [hoveredValue, setHoveredValue] = useState<T | null>(null);

  // Resolve the active index — clamp to 0 if `value` doesn't match any
  // option (shouldn't happen in practice, but keeps the blaze in-bounds).
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const segmentPct = 100 / options.length;
  const activeLeftPct = activeIndex * segmentPct;

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      title={title}
      data-testid="segmented-picker"
      data-variant={variant}
      style={containerStyle(variant)}
    >
      {variant === 'trail' && (
        <TrailDecorations
          activeLeftPct={activeLeftPct}
          segmentPct={segmentPct}
          segmentCount={options.length}
        />
      )}
      {variant === 'summit' && (
        <SummitDecorations
          activeLeftPct={activeLeftPct}
          segmentPct={segmentPct}
          segmentCount={options.length}
        />
      )}

      {options.map((opt, i) => {
        const isActive = i === activeIndex;
        const isDisabled = disabledValues.includes(opt.value);
        const isHovered = hoveredValue === opt.value && !isDisabled;
        const isLast = i === options.length - 1;
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
            style={segmentStyle({
              variant,
              isActive,
              isDisabled,
              isHovered,
              isLast,
            })}
          >
            <span style={segmentLabelStyle(isActive)}>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------- Trail variant decorations -------------------------------------
//
// Layered absolute children that sit BENEATH the segment buttons (z-index 0)
// while the segment text rides on z-index 2. The single moving piece is
// the chartreuse blaze + its glow; everything else is static chrome that
// stays put as the user toggles. Keeping motion to one element keeps the
// composition feeling intentional rather than busy.

function TrailDecorations({
  activeLeftPct,
  segmentPct,
  segmentCount,
}: {
  activeLeftPct: number;
  segmentPct: number;
  segmentCount: number;
}) {
  // Tick marks between segments — small inward-facing notches at top + bottom
  // edges, like a USGS scale bar. Rendered as a flex row of empty cells so
  // they auto-distribute exactly with the segment buttons above.
  const interiorTicks = Array.from({ length: segmentCount - 1 }, (_, i) => i);

  return (
    <>
      {/* Static: dashed contour line along the BOTTOM, very low contrast. */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 6,
          right: 6,
          bottom: 3,
          height: 1,
          backgroundImage:
            'repeating-linear-gradient(to right, rgba(76, 91, 92, 0.32) 0 3px, transparent 3px 6px)',
          pointerEvents: 'none',
        }}
      />

      {/* Static: tiny tick marks at segment boundaries (top + bottom). */}
      {interiorTicks.map((i) => (
        <div
          key={`tick-${i}`}
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: `${segmentPct * (i + 1)}%`,
            top: 0,
            bottom: 0,
            width: 1,
            pointerEvents: 'none',
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: 1,
              height: 3,
              backgroundColor: 'rgba(76, 91, 92, 0.55)',
            }}
          />
          <span
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              width: 1,
              height: 3,
              backgroundColor: 'rgba(76, 91, 92, 0.55)',
            }}
          />
        </div>
      ))}

      {/* Animated: soft chartreuse glow that fades downward into the
       *  active segment. Sits behind the blaze and the segment text. */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 0,
          height: HEIGHT - 4,
          left: `${activeLeftPct}%`,
          width: `${segmentPct}%`,
          backgroundImage:
            'linear-gradient(180deg, rgba(188, 237, 9, 0.16) 0%, rgba(188, 237, 9, 0.04) 50%, rgba(188, 237, 9, 0) 100%)',
          transition: `left ${ANIM_MS}ms ${ANIM_EASING}, width ${ANIM_MS}ms ${ANIM_EASING}`,
          pointerEvents: 'none',
          zIndex: 1,
        }}
      />

      {/* Animated: the BLAZE itself — a chartreuse strip at the very top,
       *  inset 6px from each edge of the active segment so it reads as a
       *  paint mark rather than spanning the full segment width. */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 0,
          height: 2,
          left: `calc(${activeLeftPct}% + 6px)`,
          width: `calc(${segmentPct}% - 12px)`,
          backgroundColor: semantic.accent,
          boxShadow: '0 0 6px rgba(188, 237, 9, 0.55)',
          transition: `left ${ANIM_MS}ms ${ANIM_EASING}, width ${ANIM_MS}ms ${ANIM_EASING}`,
          pointerEvents: 'none',
          zIndex: 1,
        }}
      />
    </>
  );
}

// ---------- Summit variant decorations ------------------------------------
//
// Inverted emphasis: instead of a blaze on the edge, the active segment
// gets an accent-tinted "card" surface and a tiny chartreuse triangle
// hovers above its label like a topographic summit marker. The triangle
// is the moving punctuation — it slides between segments while the card
// crossfades.

function SummitDecorations({
  activeLeftPct,
  segmentPct,
  segmentCount,
}: {
  activeLeftPct: number;
  segmentPct: number;
  segmentCount: number;
}) {
  const interiorBoundaries = Array.from(
    { length: segmentCount - 1 },
    (_, i) => i,
  );
  const summitCenterPct = activeLeftPct + segmentPct / 2;

  return (
    <>
      {/* Static: hairline dashed baseline along the bottom edge. */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: 1,
          backgroundImage:
            'repeating-linear-gradient(to right, rgba(76, 91, 92, 0.45) 0 4px, transparent 4px 7px)',
          pointerEvents: 'none',
        }}
      />

      {/* Static: 1px vertical dividers at segment boundaries. */}
      {interiorBoundaries.map((i) => (
        <div
          key={`bnd-${i}`}
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 6,
            bottom: 6,
            left: `${segmentPct * (i + 1)}%`,
            width: 1,
            backgroundColor: 'rgba(76, 91, 92, 0.32)',
            pointerEvents: 'none',
          }}
        />
      ))}

      {/* Animated: accent-tinted CARD covering the active segment.
       *  Uses an inset top highlight + a faint chartreuse fill so the
       *  active segment reads as gently lifted out of the strip. */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 1,
          bottom: 1,
          left: `${activeLeftPct}%`,
          width: `${segmentPct}%`,
          backgroundColor: 'rgba(188, 237, 9, 0.08)',
          borderTop: `1px solid ${semantic.accent}`,
          boxShadow:
            'inset 0 1px 0 rgba(188, 237, 9, 0.18), 0 1px 0 rgba(0, 0, 0, 0.35)',
          transition: `left ${ANIM_MS}ms ${ANIM_EASING}, width ${ANIM_MS}ms ${ANIM_EASING}`,
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />

      {/* Animated: SUMMIT MARKER — a small chartreuse triangle that hovers
       *  just above the active label. Implemented as a CSS triangle so
       *  it tracks crisp at any zoom. */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 3,
          left: `${summitCenterPct}%`,
          width: 0,
          height: 0,
          marginLeft: -4,
          borderLeft: '4px solid transparent',
          borderRight: '4px solid transparent',
          borderTop: `5px solid ${semantic.accent}`,
          filter: 'drop-shadow(0 0 3px rgba(188, 237, 9, 0.55))',
          transition: `left ${ANIM_MS}ms ${ANIM_EASING}`,
          pointerEvents: 'none',
          zIndex: 1,
        }}
      />
    </>
  );
}

// ---------- shared styles -------------------------------------------------

function containerStyle(variant: SegmentedVariant): CSSProperties {
  const shared: CSSProperties = {
    position: 'relative',
    display: 'flex',
    alignItems: 'stretch',
    width: '100%',
    height: HEIGHT,
    boxSizing: 'border-box',
    overflow: 'hidden',
    borderRadius: radii.base,
    backgroundColor: 'rgba(14, 20, 22, 0.55)',
    border: `1px solid ${semantic.border}`,
    boxShadow:
      'inset 0 1px 0 rgba(255, 255, 255, 0.03), inset 0 -1px 0 rgba(0, 0, 0, 0.28)',
  };
  if (variant === 'summit') {
    return {
      ...shared,
      // Summit variant uses the dashed baseline as its main horizon, so
      // soften the outer container chrome.
      backgroundColor: 'rgba(14, 20, 22, 0.42)',
    };
  }
  return shared;
}

function segmentStyle({
  variant,
  isActive,
  isDisabled,
  isHovered,
  isLast,
}: {
  variant: SegmentedVariant;
  isActive: boolean;
  isDisabled: boolean;
  isHovered: boolean;
  isLast: boolean;
}): CSSProperties {
  const base: CSSProperties = {
    flex: 1,
    position: 'relative',
    zIndex: 2,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    padding: '0 8px',
    background: 'transparent',
    border: 'none',
    cursor: isDisabled ? 'not-allowed' : 'pointer',
    color: isActive
      ? semantic.fg
      : isHovered
        ? semantic.fg
        : semantic.fgMuted,
    opacity: isDisabled ? 0.35 : 1,
    transition: 'color 0.18s ease',
    fontFamily: fonts.mono,
    fontSize: typeScale.eyebrow,
    fontWeight: isActive ? 600 : 500,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    userSelect: 'none',
    boxSizing: 'border-box',
    // Cursor-following hover affordance — a faint warm wash for inactive
    // segments. The active segment already owns the chartreuse channel,
    // so hover stays neutral on it.
    backgroundImage:
      isHovered && !isActive
        ? 'linear-gradient(180deg, rgba(230, 236, 236, 0.04) 0%, transparent 100%)'
        : 'none',
    // The variants don't need per-segment borders — the decorations layer
    // owns dividers. `isLast` retained for future variants without churn.
  };
  void isLast;
  void variant;
  return base;
}

function segmentLabelStyle(isActive: boolean): CSSProperties {
  return {
    display: 'inline-block',
    maxWidth: '100%',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    transform: isActive ? 'translateY(1px)' : 'translateY(0)',
    transition: 'transform 0.18s ease',
    // Slight downward shift on active so the chartreuse mark (blaze or
    // summit triangle) has visual room to breathe above the label.
  };
}
