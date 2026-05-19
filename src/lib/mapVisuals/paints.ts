// Per-frame paint deltas. The waypoint `circle-color` is a TWO-arm `case`
// expression keyed off feature properties baked into the FeatureCollection by
// `buildWaypointsCollection` in `sources.ts`:
//
//   override_color (per-waypoint hex) > project base color
//
// Per [DECIDED] Q1 / Q2 in `IMPLEMENTATION-PLAN.md`, the active waypoint's
// visual signal lives on the dedicated halo layer (radius + color) plus the
// active-radius bump on the dot. The dot itself paints in its OWN resolved
// color (override > base) regardless of active state — the pre-v8 hardcoded
// blue active-highlight literal is gone. `Waypoint.color` ("force this one
// to be gold") still wins over the base via the override arm.
//
// "Active" semantics: v7 (the first-class waypoint refactor) replaced the
// prior "waypoint of the active clip" definition with "latest-passed
// waypoint" — see `pickActiveWaypoint` in `sources.ts`. `activeWaypointId`
// is matched against `wp.id`, not against `clipId` (first-class waypoints
// have their own identity); whatever id the caller passes is the one that
// gets the active-radius / halo treatment.

import type {
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
} from 'maplibre-gl';
import type { DecorationColor, MapSettings } from '../../types';
import { colors } from '../../theme/tokens';
import { pulsePairAt } from './animations';
import { PAINT_REFERENCE_WIDTH } from './styleSpec';
import type { PaintUpdates } from './types';

const DEFAULT_STROKE_COLOR = 'rgba(255, 255, 255, 0.85)';
const ACTIVE_STROKE_COLOR = 'rgba(255, 255, 255, 0.95)';
/** Active-waypoint halo opacity. The halo is a soft ring behind the dot —
 *  half-opaque keeps it visible without competing with the inner shape's
 *  fill. Constant rather than animated; the rendering spec calls for a
 *  steady "you are here" treatment, not a pulse. */
const ACTIVE_HALO_OPACITY = 0.5;
/** Halo radius multiplier over the active dot's radius. 1.6× chosen so the
 *  halo ring is clearly wider than the inner shape (the active dot is
 *  already enlarged to `active_radius`) without ballooning past the
 *  neighboring waypoints. `data-model.md` §5a / `shapes-pov.md` "Active
 *  treatment" describe this as a subtle ring, not a beacon — the factor
 *  stays modest. */
const ACTIVE_HALO_RADIUS_FACTOR = 1.6;

/** Resolve the project-level waypoint base color. Solid mode returns a
 *  flat hex; gradient mode returns a MapLibre `interpolate` expression
 *  keyed off the feature's `progress` property — the Mercator fraction
 *  `buildWaypointsCollection` bakes in via `progressUpTo`. Matches the
 *  parameterization MapLibre's `line-progress` evaluator uses on the
 *  route line so waypoint dot colors agree with the line-gradient at
 *  the same fraction. Stops are sorted defensively; MapLibre throws on
 *  out-of-order interpolate input. Empty stops collapse to chartreuse so
 *  the layer keeps painting validly. */
function baseWaypointColor(
  color: DecorationColor,
): string | ExpressionSpecification {
  if (color.mode === 'solid') return color.solid;
  const stops = [...color.stops].sort((a, b) => a.fraction - b.fraction);
  if (stops.length === 0) return colors.accent;
  if (stops.length === 1) return stops[0].color;
  const expr: unknown[] = ['interpolate', ['linear'], ['get', 'progress']];
  for (const stop of stops) {
    expr.push(stop.fraction, stop.color);
  }
  return expr as ExpressionSpecification;
}

/** Two-arm `circle-color` case: override_color > base. Override wins per
 *  `data-model.md` §2a — "force this one to be gold" stays gold whether or
 *  not the waypoint is currently active. The active state is signalled by
 *  the halo layer (radius + color) and the active-radius bump, not by a
 *  separate color arm on the dot — see [DECIDED] Q1 / Q2 in the plan. */
function buildWaypointColorExpr(
  baseColor: string | ExpressionSpecification,
): ExpressionSpecification {
  return [
    'case',
    ['!=', ['get', 'override_color'], null],
    ['get', 'override_color'],
    baseColor,
  ] as ExpressionSpecification;
}

/** Resolve the halo's color per [DECIDED] Q1: when `active_color` is set on
 *  the project's WaypointsSettings, the halo paints that flat hex; when
 *  unset, the halo mirrors the active waypoint's OWN resolved color
 *  (override > base) via the same case expression the dot uses. Mirroring
 *  the dot's expression keeps preview and export bit-identical and makes
 *  the halo visually agree with whatever the user sees on the active
 *  waypoint (gradient sample, per-waypoint override, etc.). */
function buildHaloColor(
  baseColor: string | ExpressionSpecification,
  activeColor: string | undefined,
): string | ExpressionSpecification {
  if (activeColor) return activeColor;
  return buildWaypointColorExpr(baseColor);
}

/** Build the per-frame paint deltas. The waypoint `circle-color` is always
 *  the three-arm `case` so per-`Waypoint.color` overrides paint correctly
 *  whether or not a waypoint is currently active. Radius and stroke-color
 *  keep the no-active-id fast path (scalars; cheaper for MapLibre's
 *  same-value diff than expression trees). The halo layer ([DECIDED] Q2)
 *  paints behind the dot for the active waypoint only; when no waypoint is
 *  active the halo's radius and opacity are both 0 (the layer stays
 *  invisible without needing a `visibility` toggle). Pulse always comes
 *  from `pulsePairAt`.
 *
 *  Both renderer and preview call this: radii anchor to
 *  `PAINT_REFERENCE_WIDTH` (1080 CSS px) × the relevant
 *  `mapSettings.waypoints.size.*` fraction; the renderer's `pixelRatio`
 *  lever absorbs the export-resolution shift, and the preview consumes the
 *  same CSS-px values directly (pane-invariant). */
export function buildPerFramePaints(
  activeWaypointId: string | null,
  projectTimeMs: number,
  mapSettings: MapSettings,
): PaintUpdates {
  const pulse = pulsePairAt(projectTimeMs, mapSettings);
  const defaultRadius =
    mapSettings.waypoints.size.circle_radius * PAINT_REFERENCE_WIDTH;
  const activeRadius =
    mapSettings.waypoints.size.active_radius * PAINT_REFERENCE_WIDTH;
  const baseColor = baseWaypointColor(mapSettings.waypoints.color);
  const colorExpr = buildWaypointColorExpr(baseColor);
  const haloColor = buildHaloColor(
    baseColor,
    mapSettings.waypoints.active_color,
  );
  const haloColorOut = (
    typeof haloColor === 'string'
      ? haloColor
      : (haloColor as DataDrivenPropertyValueSpecification<string>)
  );

  if (!activeWaypointId) {
    return {
      waypointCircleRadius: defaultRadius,
      waypointCircleColor:
        colorExpr as DataDrivenPropertyValueSpecification<string>,
      waypointCircleStrokeColor: DEFAULT_STROKE_COLOR,
      // No active waypoint → halo is invisible. Radius/opacity scalars
      // (cheap same-value diff); color still tracks the base so the
      // layer keeps a coherent paint if the user activates a waypoint
      // mid-frame before the next builder call.
      waypointHaloColor: haloColorOut,
      waypointHaloRadius: 0,
      waypointHaloOpacity: 0,
      pulseRadius: pulse.a.radius,
      pulseOpacity: pulse.a.opacity,
      pulseRadiusB: pulse.b.radius,
      pulseOpacityB: pulse.b.opacity,
      dotOpacity: pulse.a.dotOpacity,
    };
  }

  const radiusExpr: ExpressionSpecification = [
    'case',
    ['==', ['get', 'id'], activeWaypointId],
    activeRadius,
    defaultRadius,
  ];
  const strokeExpr: ExpressionSpecification = [
    'case',
    ['==', ['get', 'id'], activeWaypointId],
    ACTIVE_STROKE_COLOR,
    DEFAULT_STROKE_COLOR,
  ];
  // Halo radius / opacity: data-driven `case` so only the active feature
  // paints. Radius scales the already-enlarged active dot by
  // `ACTIVE_HALO_RADIUS_FACTOR`; opacity is `ACTIVE_HALO_OPACITY` on the
  // active feature and 0 on every other (so the layer keeps a uniform
  // shape across features without needing `visibility`).
  const haloRadiusExpr: ExpressionSpecification = [
    'case',
    ['==', ['get', 'id'], activeWaypointId],
    activeRadius * ACTIVE_HALO_RADIUS_FACTOR,
    0,
  ];
  const haloOpacityExpr: ExpressionSpecification = [
    'case',
    ['==', ['get', 'id'], activeWaypointId],
    ACTIVE_HALO_OPACITY,
    0,
  ];

  return {
    waypointCircleRadius:
      radiusExpr as DataDrivenPropertyValueSpecification<number>,
    waypointCircleColor:
      colorExpr as DataDrivenPropertyValueSpecification<string>,
    waypointCircleStrokeColor:
      strokeExpr as DataDrivenPropertyValueSpecification<string>,
    waypointHaloColor: haloColorOut,
    waypointHaloRadius:
      haloRadiusExpr as DataDrivenPropertyValueSpecification<number>,
    waypointHaloOpacity:
      haloOpacityExpr as DataDrivenPropertyValueSpecification<number>,
    pulseRadius: pulse.a.radius,
    pulseOpacity: pulse.a.opacity,
    pulseRadiusB: pulse.b.radius,
    pulseOpacityB: pulse.b.opacity,
    dotOpacity: pulse.a.dotOpacity,
  };
}
