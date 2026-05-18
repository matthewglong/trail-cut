// Per-frame paint deltas. The active-waypoint highlight on `waypoints-circle`
// is expressed as MapLibre `case` expressions keyed off the feature's `id`
// property so the highlight is data-driven (no layer churn, no per-feature
// rebuild). The pulse values come from `pulseAt(projectTimeMs)`.
//
// "Active" semantics: v7 (the first-class waypoint refactor) replaced the
// prior "waypoint of the active clip" definition with "latest-passed
// waypoint" — see `pickActiveWaypoint` in `sources.ts`. The case expression
// here doesn't know or care which strategy produced the id; whatever id the
// caller passes is the one that gets the active treatment.
//
// Magic literal `'#4a9eff'` — the active-waypoint blue — lives here, not at
// the consumer. Anywhere else and it would drift between preview and export.

import type {
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
} from 'maplibre-gl';
import type { MapSettings } from '../../types';
import { colors } from '../../theme/tokens';
import { pulseAt } from './animations';
import { PAINT_REFERENCE_WIDTH } from './styleSpec';
import type { PaintUpdates } from './types';

const ACTIVE_WAYPOINT_COLOR = '#4a9eff';
const DEFAULT_WAYPOINT_COLOR = colors.accent;
const DEFAULT_STROKE_COLOR = 'rgba(255, 255, 255, 0.85)';
const ACTIVE_STROKE_COLOR = 'rgba(255, 255, 255, 0.95)';

/** Build the per-frame paint deltas. When `activeWaypointId` is non-null,
 *  returns data-driven `case` expressions that bump radius/color/stroke for
 *  the feature whose `id` property matches. When null (either because mode
 *  is `'none'` or no waypoint has been passed yet), returns scalar
 *  defaults — every waypoint paints uniformly. Pulse always comes from
 *  `pulseAt`.
 *
 *  Both renderer and preview call this: radii anchor to
 *  `PAINT_REFERENCE_WIDTH` (1080 CSS px) × the relevant `mapSettings.overlay_*`
 *  fraction; the renderer's `pixelRatio` lever absorbs the export-resolution
 *  shift, and the preview consumes the same CSS-px values directly
 *  (pane-invariant). Color, stroke color, and opacity outputs are untouched. */
export function buildPerFramePaints(
  activeWaypointId: string | null,
  projectTimeMs: number,
  mapSettings: MapSettings,
): PaintUpdates {
  const pulse = pulseAt(projectTimeMs, mapSettings);
  const defaultRadius =
    mapSettings.overlay_waypoint_circle_radius * PAINT_REFERENCE_WIDTH;
  const activeRadius =
    mapSettings.overlay_waypoint_active_radius * PAINT_REFERENCE_WIDTH;
  return composePaints(activeWaypointId, pulse, defaultRadius, activeRadius);
}

function composePaints(
  activeWaypointId: string | null,
  pulse: { radius: number; opacity: number },
  defaultRadius: number,
  activeRadius: number,
): PaintUpdates {
  if (!activeWaypointId) {
    return {
      waypointCircleRadius: defaultRadius,
      waypointCircleColor: DEFAULT_WAYPOINT_COLOR,
      waypointCircleStrokeColor: DEFAULT_STROKE_COLOR,
      pulseRadius: pulse.radius,
      pulseOpacity: pulse.opacity,
    };
  }

  const radiusExpr: ExpressionSpecification = [
    'case',
    ['==', ['get', 'id'], activeWaypointId],
    activeRadius,
    defaultRadius,
  ];
  const colorExpr: ExpressionSpecification = [
    'case',
    ['==', ['get', 'id'], activeWaypointId],
    ACTIVE_WAYPOINT_COLOR,
    DEFAULT_WAYPOINT_COLOR,
  ];
  const strokeExpr: ExpressionSpecification = [
    'case',
    ['==', ['get', 'id'], activeWaypointId],
    ACTIVE_STROKE_COLOR,
    DEFAULT_STROKE_COLOR,
  ];

  return {
    waypointCircleRadius:
      radiusExpr as DataDrivenPropertyValueSpecification<number>,
    waypointCircleColor:
      colorExpr as DataDrivenPropertyValueSpecification<string>,
    waypointCircleStrokeColor:
      strokeExpr as DataDrivenPropertyValueSpecification<string>,
    pulseRadius: pulse.radius,
    pulseOpacity: pulse.opacity,
  };
}
