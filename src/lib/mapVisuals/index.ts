// Public surface of the shared mapVisuals module. Anything not re-exported
// here is module-private. The export and preview consumers should import
// from `'../lib/mapVisuals'` (this file), not from individual sub-modules,
// so the public boundary stays explicit.

export {
  buildStyleSpec,
  resolveStaticPaints,
  haloGroupPolicy,
  PAINT_REFERENCE_WIDTH,
  SHAPE_CANONICAL_RADIUS,
} from './styleSpec';
export {
  BUILDINGS_LAYER_SPEC,
  LIVE_MARKER_HALO_LAYER,
  LIVE_MARKER_HALO_CORE_LAYER,
  LIVE_MARKER_PULSE_LAYER,
  LIVE_MARKER_PULSE_B_LAYER,
  LIVE_MARKER_DOT_LAYER,
  LIVE_MARKER_IMAGE_LAYER,
  LIVE_MARKER_SHAPE_PRIMARY_LAYER,
  LIVE_MARKER_SHAPE_SECONDARY_LAYER,
  ROUTE_FULL_HALO_LAYER,
  ROUTE_FULL_HALO_CORE_LAYER,
  ROUTE_FULL_LAYER,
  ROUTE_TRAIL_HALO_LAYER,
  ROUTE_TRAIL_HALO_CORE_LAYER,
  ROUTE_TRAIL_LAYER,
  WAYPOINTS_ACTIVE_HALO_LAYER,
  WAYPOINTS_HALO_LAYER,
  WAYPOINTS_HALO_CORE_LAYER,
  WAYPOINTS_IMAGE_LAYER,
  WAYPOINTS_PRIMARY_LAYER,
  WAYPOINTS_SECONDARY_LAYER,
} from './styleSpec';

export {
  MARKER_IMAGE_ICON_PREFIX,
  MARKER_IMAGE_CANONICAL_SIZE,
  MARKER_IMAGE_MAX_PIXEL_RATIO,
  MAX_MASTER_TEXELS,
  TRANSPARENT_RASTER_ICON_ID,
  markerImageIconId,
  buildMarkerImageIcon,
  markerImagePixelRatio,
  resampleRgba,
  transparentRasterEntry,
} from './markerImage';
export type { MarkerImageRegistryEntry, RgbaBitmap } from './markerImage';

export {
  WAYPOINT_SHAPE_NAMES,
  WAYPOINT_ICON_SIZE,
  SHAPES,
  DEFAULT_OUTLINE_THICKNESS,
  TRANSPARENT_SDF_ICON_ID,
  shapesFor,
  getShape,
  shapeHasSecondary,
  buildAllShapeIcons,
  buildShapeIconsFor,
  transparentSdfEntry,
  outlineThicknessCanvasPx,
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
  HaloCompositeGroup,
} from './types';
