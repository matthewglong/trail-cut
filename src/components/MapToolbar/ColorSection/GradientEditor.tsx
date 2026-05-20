// GradientEditor — the bar + stop rail + distance axis that replaces
// ColorSection's swatch row when mode === 'gradient'.
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
  insertStop,
  moveStop,
  removeStop,
  snapToTicks,
  stopsToCssLinearGradient,
} from './gradientMath';

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
  /** Waypoint progress fractions in [0, 1] (Web Mercator). Used as snap
   *  targets when dragging a stop along the bar. Empty when no waypoints
   *  exist. */
  waypointProgress: number[];
  /** @deprecated unused — drag label now displays a percentage of the route
   *  rather than a distance. Kept on the interface for backward compat. */
  totalDistMeters?: number;
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
      // Reject clicks within snap distance of an existing stop — leave the
      // current selection alone so the picker doesn't collapse when the
      // user misses a handle by a few pixels.
      for (const s of stops) {
        if (Math.abs(s.fraction - fraction) < MIN_STOP_SEPARATION) {
          return;
        }
      }
      const next = insertStop(stops, fraction);
      if (next === stops) return;
      // Find the new stop's index by fraction match (rounded equal).
      const newIdx = next.findIndex(
        (s) => Math.abs(s.fraction - Math.round(fraction * 10000) / 10000) < 1e-9,
      );
      onStopsChange(next);
      if (newIdx >= 0) onSelectedIndexChange(newIdx);
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
      // Keep a stop selected at all times so the color picker stays open.
      // If the deleted stop was selected, pick the stop now occupying the
      // slot (or the new last stop if we deleted the trailing one).
      if (selectedIndex === index) {
        onSelectedIndexChange(Math.min(index, next.length - 1));
      } else if (selectedIndex != null && selectedIndex > index) {
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
      />

      {/* Stop rail — dashed guide line with handles centered on it and
          A/B/n position labels below. */}
      <div style={sectionStyles.stopRail} data-testid="stop-rail">
        <div style={sectionStyles.stopRailDashedLine} />
        {stops.map((stop, idx) => {
          const isEndpoint = idx === 0 || idx === stops.length - 1;
          const isSelected = selectedIndex === idx;
          const isHovered = hoveredHandleIdx === idx;
          const isDragging = dragState?.index === idx;
          const label = String(idx + 1);
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
                  {Math.round((dragLabelFraction ?? stop.fraction) * 100)}%
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
              <span
                style={sectionStyles.stopLabel}
                data-testid={`gradient-stop-label-${idx}`}
              >
                {label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
