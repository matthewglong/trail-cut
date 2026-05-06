// Per-frame paint deltas. The active-clip highlight on `waypoints-circle` is
// expressed as MapLibre `case` expressions keyed off the feature's `id`
// property so the highlight is data-driven (no layer churn, no per-feature
// rebuild). The pulse values come from `pulseAt(projectTimeMs)`.
//
// Magic literal `'#4a9eff'` — the active-waypoint blue — lives here, not at
// the consumer. Anywhere else and it would drift between preview and export.

import type {
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
} from 'maplibre-gl';
import { colors } from '../../theme/tokens';
import { pulseAt } from './animations';
import type { PaintUpdates } from './types';

const ACTIVE_WAYPOINT_COLOR = '#4a9eff';
const DEFAULT_WAYPOINT_COLOR = colors.accent;
const DEFAULT_STROKE_COLOR = 'rgba(255, 255, 255, 0.85)';
const ACTIVE_STROKE_COLOR = 'rgba(255, 255, 255, 0.95)';
const DEFAULT_RADIUS = 11;
const ACTIVE_RADIUS = 14;

/** Build the per-frame paint deltas. When `activeClipId` is non-null, returns
 *  data-driven `case` expressions that bump radius/color/stroke for the
 *  feature whose `id` property matches. When null, returns scalar defaults
 *  (no feature is highlighted). Pulse always comes from `pulseAt`. */
export function buildPerFramePaints(
  activeClipId: string | null,
  projectTimeMs: number,
): PaintUpdates {
  const pulse = pulseAt(projectTimeMs);

  if (!activeClipId) {
    return {
      waypointCircleRadius: DEFAULT_RADIUS,
      waypointCircleColor: DEFAULT_WAYPOINT_COLOR,
      waypointCircleStrokeColor: DEFAULT_STROKE_COLOR,
      pulseRadius: pulse.radius,
      pulseOpacity: pulse.opacity,
    };
  }

  const radiusExpr: ExpressionSpecification = [
    'case',
    ['==', ['get', 'id'], activeClipId],
    ACTIVE_RADIUS,
    DEFAULT_RADIUS,
  ];
  const colorExpr: ExpressionSpecification = [
    'case',
    ['==', ['get', 'id'], activeClipId],
    ACTIVE_WAYPOINT_COLOR,
    DEFAULT_WAYPOINT_COLOR,
  ];
  const strokeExpr: ExpressionSpecification = [
    'case',
    ['==', ['get', 'id'], activeClipId],
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
