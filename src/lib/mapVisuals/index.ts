// Public surface of the shared mapVisuals module. Anything not re-exported
// here is module-private. The export and preview consumers should import
// from `'../lib/mapVisuals'` (this file), not from individual sub-modules,
// so the public boundary stays explicit.

export {
  buildStyleSpec,
  resolveStaticPaints,
  PAINT_REFERENCE_WIDTH,
  SHAPE_CANONICAL_RADIUS,
} from './styleSpec';
export {
  BUILDINGS_LAYER_SPEC,
  LIVE_MARKER_PULSE_LAYER,
  LIVE_MARKER_PULSE_B_LAYER,
  LIVE_MARKER_DOT_LAYER,
  ROUTE_FULL_LAYER,
  ROUTE_TRAIL_LAYER,
  WAYPOINTS_ACTIVE_HALO_LAYER,
  WAYPOINTS_PRIMARY_LAYER,
  WAYPOINTS_SECONDARY_LAYER,
} from './styleSpec';

export {
  WAYPOINT_SHAPE_NAMES,
  WAYPOINT_ICON_SIZE,
  SHAPES,
  shapesFor,
  getShape,
  shapeHasSecondary,
  buildAllShapeIcons,
} from './shapes';
export type {
  SdfIcon,
  ShapeDescriptor,
  ShapeDomain,
  ShapeRegistryEntry,
} from './shapes';

export { buildStaticSourceData } from './sources';

export { buildPerFrameState } from './perFrame';

export { pulseAt, pulsePairAt, PULSE_PERIOD_MS, PULSE_RATE_MS } from './animations';

export type { ResolvedStaticPaints } from './styleSpec';

export type {
  PerFrameState,
  PaintUpdates,
  PulseState,
  PulseStatePair,
  StyleSpecResult,
  StaticSourceData,
} from './types';
