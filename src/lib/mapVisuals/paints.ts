// Per-frame paint + layout deltas for the waypoint symbol layers and the
// live-marker pulse pair. Two colors per waypoint feature flow through here:
//
//   primary   → tints the filled silhouette (every shape's primary SDF slot).
//               case arms: active_color (if active + set) > override_color
//                          > project base (solid OR gradient).
//   secondary → tints the outline / accent (every shape's secondary SDF slot;
//               transparent placeholder for one-color shapes).
//               case arms: active_secondary_color (if active + set) >
//                          override_secondary_color > project secondary base.
//
// Both arms are resolved as MapLibre `case` expressions and shipped to the
// consumer as one value each — preview and export apply the same expression
// to the same layer property, so paint logic stays bit-identical across the
// two pipelines.
//
// Active-state size lives here too: `waypointIconSize` is either a scalar
// (no active waypoint) or a `case` expression that bumps the active feature's
// `icon-size` from `circle_radius / SHAPE_CANONICAL_RADIUS` to
// `active_radius / SHAPE_CANONICAL_RADIUS`. Applied to BOTH symbol layers so
// the outline stays aligned with the fill.
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
import { PAINT_REFERENCE_WIDTH, SHAPE_CANONICAL_RADIUS } from './styleSpec';
import { MARKER_IMAGE_CANONICAL_SIZE } from './markerImage';
import type { PaintUpdates } from './types';

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

/** Resolve a `DecorationColor` to a paint value: either a flat hex (solid
 *  mode) or a MapLibre `interpolate` expression keyed off the feature's
 *  `progress` property (gradient mode). The interpolate uses the same
 *  parameterization MapLibre's `line-progress` evaluator uses on the route
 *  line, so waypoint dot colors agree with the line-gradient at the same
 *  fraction. Stops are sorted defensively; MapLibre throws on out-of-order
 *  interpolate input. Empty stops collapse to chartreuse so the layer keeps
 *  painting validly.
 *
 *  Used for both the primary and secondary base colors — the underlying
 *  per-feature `progress` is the same, so secondary gradients sample the
 *  same point on the route as primary gradients. */
function decorationColorToBase(
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

/** Build the three-arm color expression for one slot:
 *
 *    active && activeId match && activeOverride set → activeOverride
 *    else override-property set                     → override-property
 *    else                                            → base color
 *
 *  Used identically for primary (`override_color` + `active_color`) and
 *  secondary (`override_secondary_color` + `active_secondary_color`).
 *  Centralizing the structure here keeps the two slots truly symmetrical —
 *  if someone changes the precedence (e.g. swaps override and active), both
 *  slots get the new behavior in lockstep. */
function buildSlotColorExpr(
  activeWaypointId: string | null,
  baseColor: string | ExpressionSpecification,
  overrideProperty: 'override_color' | 'override_secondary_color',
  activeOverride: string | undefined,
): ExpressionSpecification {
  // Base layer first — every shape gets at least "override > base."
  const overrideArm: ExpressionSpecification = [
    'case',
    ['!=', ['get', overrideProperty], null],
    ['get', overrideProperty],
    baseColor,
  ] as ExpressionSpecification;
  // Active arm wraps the override arm when both an active id AND an
  // active-color override are set. Without an active override, the active
  // waypoint paints whatever its per-feature / base color would have been —
  // halo + size bump carry the active signal in that case.
  if (!activeWaypointId || activeOverride === undefined) {
    return overrideArm;
  }
  return [
    'case',
    ['==', ['get', 'id'], activeWaypointId],
    activeOverride,
    overrideArm,
  ] as ExpressionSpecification;
}

/** Resolve the halo's color per [DECIDED] Q1: when `active_color` is set on
 *  the project's WaypointsSettings, the halo paints that flat hex; when
 *  unset, the halo mirrors the active waypoint's OWN resolved PRIMARY color
 *  (override > base) via the same case expression the primary slot uses.
 *  Mirroring the primary keeps preview and export bit-identical and makes
 *  the halo visually agree with whatever the user sees on the active
 *  waypoint (gradient sample, per-waypoint override, etc.). */
function buildHaloColor(
  primaryBase: string | ExpressionSpecification,
  activeColor: string | undefined,
): string | ExpressionSpecification {
  if (activeColor) return activeColor;
  return [
    'case',
    ['!=', ['get', 'override_color'], null],
    ['get', 'override_color'],
    primaryBase,
  ] as ExpressionSpecification;
}

/** Build the per-frame paint + layout deltas. The two color slots and the
 *  icon-size both flow through this single function so the active-state
 *  signal (size bump + optional color flip + halo) propagates consistently.
 *
 *  Both renderer and preview call this: sizes anchor to
 *  `PAINT_REFERENCE_WIDTH` (1080 CSS px) × the relevant
 *  `mapSettings.waypoints.size.*` fraction, normalized by
 *  `SHAPE_CANONICAL_RADIUS` to land in MapLibre's `icon-size` space.
 *  The renderer's `pixelRatio` lever absorbs the export-resolution shift,
 *  and the preview consumes the same CSS-px values directly (pane-invariant). */
export function buildPerFramePaints(
  activeWaypointId: string | null,
  activeWaypointIndex: number | null,
  projectTimeMs: number,
  mapSettings: MapSettings,
  surfaceScale: number = 1,
): PaintUpdates {
  const pulse = pulsePairAt(projectTimeMs, mapSettings);

  // ---- Size / icon-size ----
  // The user-facing knob is `circle_radius` (in 1080-anchored fractions).
  // For SDF symbols, the equivalent rendered size is
  // `(target_radius / SHAPE_CANONICAL_RADIUS)` (icon-size multiplier).
  // `surfaceScale` rides the same anchor as in `resolveStaticPaints`: the
  // export renderer omits it (scale 1, byte-identical values); the preview
  // passes its fixed display scale so per-frame sizes (icon bumps, halo,
  // pulse rings) minify in lockstep with the statically-seeded ones.
  const anchor = PAINT_REFERENCE_WIDTH * surfaceScale;
  const defaultIconSize =
    (mapSettings.waypoints.size.circle_radius * anchor) /
    SHAPE_CANONICAL_RADIUS;
  const activeIconSize =
    (mapSettings.waypoints.size.active_radius * anchor) /
    SHAPE_CANONICAL_RADIUS;
  // Image-marker sizes for the `waypoints-image` layer: longest side =
  // shape diameter, so the divisor is the image canonical size halved
  // (see the `defaultImageIconSize` derivation in styleSpec.ts).
  const defaultImageIconSize =
    (mapSettings.waypoints.size.circle_radius * anchor) /
    (MARKER_IMAGE_CANONICAL_SIZE / 2);
  const activeImageIconSize =
    (mapSettings.waypoints.size.active_radius * anchor) /
    (MARKER_IMAGE_CANONICAL_SIZE / 2);

  // ---- Color slots ----
  const primaryBase = decorationColorToBase(mapSettings.waypoints.color);
  const secondaryBase = decorationColorToBase(
    mapSettings.waypoints.secondary_color,
  );
  const primaryColorExpr = buildSlotColorExpr(
    activeWaypointId,
    primaryBase,
    'override_color',
    mapSettings.waypoints.active_color,
  );
  const secondaryColorExpr = buildSlotColorExpr(
    activeWaypointId,
    secondaryBase,
    'override_secondary_color',
    mapSettings.waypoints.active_secondary_color,
  );

  // ---- Halo ----
  const haloColor = buildHaloColor(primaryBase, mapSettings.waypoints.active_color);
  const haloColorOut = (
    typeof haloColor === 'string'
      ? haloColor
      : (haloColor as DataDrivenPropertyValueSpecification<string>)
  );

  // ---- Sort keys ----
  // The waypoint stack is split across THREE symbol layers — primary (filled
  // silhouette), secondary (outline), and label. Symbol-sort-key only
  // governs ordering WITHIN a layer, so even with the primaries stacked
  // correctly, a back waypoint's outline (drawn entirely after every primary)
  // paints on top of the front waypoint's fill. To hide back outlines and
  // labels we rely on MapLibre's collision detection — toggle `allow-overlap:
  // false` on those two layers so colliding back features are culled.
  //
  // Two sort-key expressions fall out of that split because MapLibre's
  // sort-key semantics depend on `allow-overlap`:
  //
  //   - `allow-overlap: true` (primary): every fill renders; higher sort-key
  //     paints later (on top). Closer-to-playhead → HIGHER sort-key.
  //     Expression: `-|index - activeIndex|` (active scores 0, neighbors
  //     trail).
  //
  //   - `allow-overlap: false` (secondary, label): lower sort-key wins
  //     placement (gets placed first; colliders are culled). Closer-to-
  //     playhead → LOWER sort-key. Expression: `|index - activeIndex|`
  //     (active scores 0, the smallest distance).
  //
  // No-active branch (playhead hasn't reached any waypoint yet): every
  // waypoint is "future." By the rule for future waypoints (earlier on top),
  // index 0 wins — `-index` for draw order, `index` for placement.
  const placementKeyExpr: ExpressionSpecification =
    activeWaypointIndex == null
      ? ['get', 'index']
      : ['abs', ['-', ['get', 'index'], activeWaypointIndex]];
  const sortKeyExpr: ExpressionSpecification = ['-', 0, placementKeyExpr];

  if (!activeWaypointId) {
    return {
      waypointPrimaryColor:
        primaryColorExpr as DataDrivenPropertyValueSpecification<string>,
      waypointSecondaryColor:
        secondaryColorExpr as DataDrivenPropertyValueSpecification<string>,
      waypointIconSize: defaultIconSize,
      waypointImageIconSize: defaultImageIconSize,
      waypointHaloColor: haloColorOut,
      waypointHaloRadius: 0,
      waypointHaloOpacity: 0,
      waypointSortKey:
        sortKeyExpr as DataDrivenPropertyValueSpecification<number>,
      waypointPlacementKey:
        placementKeyExpr as DataDrivenPropertyValueSpecification<number>,
      pulseRadius: pulse.a.radius * surfaceScale,
      pulseOpacity: pulse.a.opacity,
      pulseRadiusB: pulse.b.radius * surfaceScale,
      pulseOpacityB: pulse.b.opacity,
      dotOpacity: pulse.a.dotOpacity,
    };
  }

  // Active-state expressions. Icon-size bumps the matched feature to the
  // active size. Halo lights up at the matched feature only (radius +
  // opacity collapse to 0 elsewhere so the layer needs no visibility flip).
  const iconSizeExpr: ExpressionSpecification = [
    'case',
    ['==', ['get', 'id'], activeWaypointId],
    activeIconSize,
    defaultIconSize,
  ];
  const imageIconSizeExpr: ExpressionSpecification = [
    'case',
    ['==', ['get', 'id'], activeWaypointId],
    activeImageIconSize,
    defaultImageIconSize,
  ];
  const haloRadiusExpr: ExpressionSpecification = [
    'case',
    ['==', ['get', 'id'], activeWaypointId],
    activeIconSize * SHAPE_CANONICAL_RADIUS * ACTIVE_HALO_RADIUS_FACTOR,
    0,
  ];
  const haloOpacityExpr: ExpressionSpecification = [
    'case',
    ['==', ['get', 'id'], activeWaypointId],
    ACTIVE_HALO_OPACITY,
    0,
  ];

  return {
    waypointPrimaryColor:
      primaryColorExpr as DataDrivenPropertyValueSpecification<string>,
    waypointSecondaryColor:
      secondaryColorExpr as DataDrivenPropertyValueSpecification<string>,
    waypointIconSize:
      iconSizeExpr as DataDrivenPropertyValueSpecification<number>,
    waypointImageIconSize:
      imageIconSizeExpr as DataDrivenPropertyValueSpecification<number>,
    waypointHaloColor: haloColorOut,
    waypointHaloRadius:
      haloRadiusExpr as DataDrivenPropertyValueSpecification<number>,
    waypointHaloOpacity:
      haloOpacityExpr as DataDrivenPropertyValueSpecification<number>,
    waypointSortKey:
      sortKeyExpr as DataDrivenPropertyValueSpecification<number>,
    waypointPlacementKey:
      placementKeyExpr as DataDrivenPropertyValueSpecification<number>,
    pulseRadius: pulse.a.radius,
    pulseOpacity: pulse.a.opacity,
    pulseRadiusB: pulse.b.radius,
    pulseOpacityB: pulse.b.opacity,
    dotOpacity: pulse.a.dotOpacity,
  };
}
