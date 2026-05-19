// GradientEditor — the bar + stop rail + distance axis + trail preview that
// replaces ColorSection's swatch row when mode === 'gradient'.
//
// Storage contract (per `color-gradient.md` §13):
//  • The component is fully controlled by its parent. `stops` is the source
//    of truth; every drag, click, or button press calls `onStopsChange` with
//    the next stop array. The parent writes it into
//    `mapSettings.{route|waypoints}.color.stops` so the live map (via
//    `resolveStaticPaints` → `setPaintProperty('line-gradient', …)`) picks it
//    up the same React tick.
//  • The component never reads or writes `color_stops_cache`. That is a UI
//    affordance on the Color section level — ColorSection.tsx is responsible
//    for stashing/restoring it on mode toggle.
//
// Stop fractions are Web Mercator line-progress fractions (NOT geodesic).
// The distance label is a display-only linear approximation derived from
// `totalDistMeters × fraction` per `color-gradient.md` §1.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { GradientStop } from '../../../types';
import { sectionStyles } from './styles';
import {
  MAX_STOPS,
  MIN_STOP_SEPARATION,
  SNAP_PX,
  formatDistanceLabel,
  formatTotalDistance,
  insertStop,
  moveStop,
  removeStop,
  sampleStopsAt,
  snapToTicks,
  stopsToCssLinearGradient,
} from './gradientMath';

/** Static decorative S-curve path for the trail preview SVG. Drawn in a
 *  100×28 viewBox so the editor can scale it to fit the panel width. The
 *  path is intentionally not GPS-derived — per `color-gradient.md` §8 it's a
 *  schematic that gives the gradient + waypoint dots a "trail-ish" backbone
 *  without committing to actual geography. */
const PREVIEW_VIEWBOX_W = 100;
const PREVIEW_VIEWBOX_H = 28;
const PREVIEW_PATH_D = 'M 2 22 C 18 22, 30 6, 50 14 S 82 22, 98 6';

/** SVG path-coordinate sample of `PREVIEW_PATH_D` at a normalized parameter
 *  in [0, 1]. Returns the `y` (vertical) value for that fractional position
 *  along the path so the waypoint dots can lift off the path's actual
 *  vertical position rather than sitting at a flat baseline. Lightweight
 *  cubic-bezier interpolation between the four anchor points the path
 *  defines. */
function previewPathY(fraction: number): number {
  // S-curve constructed as two cubic segments. First segment runs from x=2
  // to x=50 (which is x-fraction 0..0.5); second runs from x=50 to x=98
  // (fraction 0.5..1.0). Mirroring the analytic form is enough for a
  // schematic — we don't need pixel-perfect bezier evaluation.
  const f = Math.max(0, Math.min(1, fraction));
  const segT = f < 0.5 ? f * 2 : (f - 0.5) * 2;
  if (f < 0.5) {
    // Cubic from (2, 22) to (50, 14) via control points (18, 22) and (30, 6).
    const t = segT;
    const mt = 1 - t;
    return (
      mt * mt * mt * 22 +
      3 * mt * mt * t * 22 +
      3 * mt * t * t * 6 +
      t * t * t * 14
    );
  }
  // Cubic from (50, 14) to (98, 6) via the smoothed control (70, 22).
  const t = segT;
  const mt = 1 - t;
  return (
    mt * mt * mt * 14 +
    3 * mt * mt * t * 22 +
    3 * mt * t * t * 22 +
    t * t * t * 6
  );
}

export interface GradientEditorProps {
  /** Current stop array. Endpoints (fraction 0 and 1) must exist. */
  stops: GradientStop[];
  /** Receives the next stop array on any user edit. */
  onStopsChange: (next: GradientStop[]) => void;
  /** Currently-selected stop index. The parent owns this state because the
   *  stop color picker (rendered below the editor by `ColorSection`) needs
   *  to read the same selection. */
  selectedIndex: number | null;
  onSelectedIndexChange: (idx: number | null) => void;
  /** Waypoint progress fractions in [0, 1] (Web Mercator). Used for snap
   *  ticks on the gradient bar and as dot positions on the trail preview
   *  SVG. Empty when no waypoints exist. */
  waypointProgress: number[];
  /** Total route distance in metres — display-only label derivation. */
  totalDistMeters: number;
  /** Editor disabled (no GPX, degenerate route). Renders the bar in a
   *  read-only state. */
  disabled?: boolean;
}

export function GradientEditor({
  stops,
  onStopsChange,
  selectedIndex,
  onSelectedIndexChange,
  waypointProgress,
  totalDistMeters,
  disabled,
}: GradientEditorProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const [dragState, setDragState] = useState<{
    index: number;
    activeSnapFraction: number | null;
    currentFraction: number;
  } | null>(null);
  const [hoveredHandleIdx, setHoveredHandleIdx] = useState<number | null>(null);

  const gradientCss = useMemo(() => stopsToCssLinearGradient(stops), [stops]);

  // ---- Drag handling -----------------------------------------------------
  // Pointer events on a mid-stop handle initiate a drag. The handler
  // promotes the document to listening for mousemove/mouseup so dragging
  // past the bar still updates the stop.
  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>, index: number) => {
      if (disabled) return;
      e.stopPropagation();
      if (index === 0 || index === stops.length - 1) {
        // Endpoint — selection only, no drag.
        onSelectedIndexChange(index);
        return;
      }
      onSelectedIndexChange(index);
      setDragState({
        index,
        activeSnapFraction: null,
        currentFraction: stops[index].fraction,
      });
    },
    [disabled, onSelectedIndexChange, stops],
  );

  // Track drag globally so leaving the bar doesn't drop the gesture.
  useEffect(() => {
    if (!dragState) return;
    const bar = barRef.current;
    if (!bar) return;
    const { index } = dragState;

    const onMove = (e: PointerEvent) => {
      const rect = bar.getBoundingClientRect();
      if (rect.width <= 0) return;
      const rawFraction = (e.clientX - rect.left) / rect.width;
      const snapThresholdFraction = SNAP_PX / rect.width;
      const { fraction: snappedFraction, snappedTo } = snapToTicks(
        Math.max(0, Math.min(1, rawFraction)),
        waypointProgress,
        snapThresholdFraction,
      );
      const next = moveStop(stops, index, snappedFraction);
      // moveStop returns the original array if the move is rejected (e.g.
      // endpoint); we still update the displayed drag tooltip from the
      // requested fraction so the tooltip is responsive.
      onStopsChange(next);
      setDragState({
        index,
        activeSnapFraction: snappedTo,
        currentFraction: next[index].fraction,
      });
    };

    const onUp = () => {
      setDragState(null);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
  }, [dragState, onStopsChange, stops, waypointProgress]);

  // ---- Bar click (add stop) ---------------------------------------------
  const onBarClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (disabled) return;
      if (stops.length >= MAX_STOPS) return;
      const bar = barRef.current;
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      if (rect.width <= 0) return;
      const fraction = (e.clientX - rect.left) / rect.width;
      // Reject clicks within snap distance of an existing stop — the click
      // should not produce a no-op-and-deselect when the user meant to grab
      // the existing stop. Editor selection clears separately on a click of
      // the bar background.
      for (const s of stops) {
        if (Math.abs(s.fraction - fraction) < MIN_STOP_SEPARATION) {
          onSelectedIndexChange(null);
          return;
        }
      }
      const next = insertStop(stops, fraction);
      if (next === stops) {
        onSelectedIndexChange(null);
        return;
      }
      // Find the new stop's index by fraction match (rounded equal).
      const newIdx = next.findIndex(
        (s) => Math.abs(s.fraction - Math.round(fraction * 10000) / 10000) < 1e-9,
      );
      onStopsChange(next);
      onSelectedIndexChange(newIdx >= 0 ? newIdx : null);
    },
    [disabled, stops, onSelectedIndexChange, onStopsChange],
  );

  // `+ Stop` button click handler lives in ColorSection's action row —
  // the button is part of the surrounding shell, not the editor body.
  // GradientEditor only handles direct interactions with the bar / rail.

  const onDeleteStop = useCallback(
    (e: React.MouseEvent, index: number) => {
      e.stopPropagation();
      if (disabled) return;
      const next = removeStop(stops, index);
      if (next === stops) return;
      onStopsChange(next);
      // After deletion, drop the selection so the panel collapses to the
      // gradient-only view.
      if (selectedIndex === index) onSelectedIndexChange(null);
      else if (selectedIndex != null && selectedIndex > index) {
        onSelectedIndexChange(selectedIndex - 1);
      }
    },
    [disabled, stops, onStopsChange, onSelectedIndexChange, selectedIndex],
  );

  // ---- Rendering --------------------------------------------------------

  const dragLabelFraction = dragState?.currentFraction ?? null;

  return (
    <div style={sectionStyles.gradientBody} data-testid="gradient-editor">
      {/* Gradient bar */}
      <div
        ref={barRef}
        onClick={onBarClick}
        style={{
          ...sectionStyles.gradientBar,
          background: gradientCss,
          ...(disabled ? sectionStyles.gradientBarDisabled : null),
        }}
        data-testid="gradient-bar"
      >
        {waypointProgress.map((p, i) => (
          <div
            key={i}
            style={{
              ...sectionStyles.gradientBarTick,
              left: `${p * 100}%`,
              ...(dragState?.activeSnapFraction === p
                ? sectionStyles.gradientBarTickActive
                : null),
            }}
          />
        ))}
      </div>

      {/* Stop rail */}
      <div style={sectionStyles.stopRail} data-testid="stop-rail">
        {stops.map((stop, idx) => {
          const isEndpoint = idx === 0 || idx === stops.length - 1;
          const isSelected = selectedIndex === idx;
          const isHovered = hoveredHandleIdx === idx;
          const isDragging = dragState?.index === idx;
          return (
            <div
              key={idx}
              style={{ position: 'absolute', left: `${stop.fraction * 100}%`, top: 0 }}
              onMouseEnter={() => setHoveredHandleIdx(idx)}
              onMouseLeave={() => setHoveredHandleIdx(null)}
            >
              {!isEndpoint && (isHovered || isDragging || isSelected) && (
                <button
                  type="button"
                  onClick={(e) => onDeleteStop(e, idx)}
                  style={sectionStyles.stopDeleteAffordance}
                  title="Delete stop"
                  data-testid={`gradient-stop-delete-${idx}`}
                  aria-label={`Delete stop ${idx + 1}`}
                >
                  ×
                </button>
              )}
              {isDragging && (
                <span style={sectionStyles.stopDragLabel}>
                  {formatDistanceLabel(dragLabelFraction ?? stop.fraction, totalDistMeters)}
                </span>
              )}
              <button
                type="button"
                onPointerDown={(e) => onHandlePointerDown(e, idx)}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectedIndexChange(idx);
                }}
                title={
                  isEndpoint
                    ? `Endpoint stop ${idx + 1}`
                    : `Stop ${idx + 1} — drag to move`
                }
                data-testid={`gradient-stop-handle-${idx}`}
                aria-label={`Gradient stop ${idx + 1}`}
                style={{
                  ...sectionStyles.stopHandle,
                  backgroundColor: stop.color,
                  ...(isEndpoint ? sectionStyles.stopHandleEndpoint : null),
                  ...(isSelected ? sectionStyles.stopHandleSelected : null),
                }}
              />
            </div>
          );
        })}
      </div>

      {/* Distance axis */}
      {totalDistMeters > 0 && (
        <div style={sectionStyles.distanceAxis} data-testid="gradient-distance-axis">
          {stops.map((stop, idx) => (
            <span
              key={idx}
              style={{
                ...sectionStyles.distanceAxisLabel,
                left: `${stop.fraction * 100}%`,
              }}
            >
              {formatDistanceLabel(stop.fraction, totalDistMeters)}
            </span>
          ))}
        </div>
      )}

      {/* Trail preview — header + SVG. Header always present; SVG dots
          omitted when no waypoints (path-only). */}
      <div style={sectionStyles.previewBlock} data-testid="gradient-preview">
        <div style={sectionStyles.previewHeader}>
          <span>TRAIL PREVIEW</span>
          {totalDistMeters > 0 && <span>{formatTotalDistance(totalDistMeters)}</span>}
        </div>
        <svg
          viewBox={`0 0 ${PREVIEW_VIEWBOX_W} ${PREVIEW_VIEWBOX_H}`}
          preserveAspectRatio="none"
          style={sectionStyles.previewSvg}
          data-testid="gradient-preview-svg"
        >
          <defs>
            <linearGradient
              id="gradient-editor-preview-stroke"
              x1="0"
              y1="0"
              x2="1"
              y2="0"
            >
              {stops.map((stop, idx) => (
                <stop
                  key={idx}
                  offset={stop.fraction}
                  stopColor={stop.color}
                />
              ))}
            </linearGradient>
          </defs>
          <path
            d={PREVIEW_PATH_D}
            stroke="url(#gradient-editor-preview-stroke)"
            strokeWidth={2}
            fill="none"
            strokeLinecap="round"
          />
          {waypointProgress.map((p, idx) => {
            const cx = p * PREVIEW_VIEWBOX_W;
            const cy = previewPathY(p);
            return (
              <circle
                key={idx}
                cx={cx}
                cy={cy}
                r={2.5}
                fill={sampleStopsAt(stops, p)}
                stroke="#0e1416"
                strokeWidth={0.75}
                data-testid={`gradient-preview-dot-${idx}`}
              />
            );
          })}
        </svg>
      </div>
    </div>
  );
}
