// Public surface of the shared mapVisuals module. Anything not re-exported
// here is module-private. The export and preview consumers should import
// from `'../lib/mapVisuals'` (this file), not from individual sub-modules,
// so the public boundary stays explicit.

export {
  buildStyleSpec,
  resolveStaticPaints,
  resolveStaticPaintsForPreview,
  PAINT_SIZE_FRACTIONS,
  PAINT_REFERENCE_WIDTH,
} from './styleSpec';
export {
  BUILDINGS_LAYER_SPEC,
  LIVE_MARKER_PULSE_LAYER,
  LIVE_MARKER_DOT_LAYER,
  ROUTE_FULL_LAYER,
  ROUTE_TRAIL_LAYER,
  WAYPOINTS_CIRCLE_LAYER,
  WAYPOINTS_LABEL_LAYER,
} from './styleSpec';

export { buildStaticSourceData } from './sources';

export {
  buildPerFrameState,
  buildPerFrameStateForPreview,
} from './perFrame';

export { pulseAt, pulseAtScaled, PULSE_PERIOD_MS } from './animations';

export type { ResolvedStaticPaints } from './styleSpec';

export type {
  PerFrameState,
  PaintUpdates,
  PulseState,
  StyleSpecResult,
  StaticSourceData,
} from './types';
