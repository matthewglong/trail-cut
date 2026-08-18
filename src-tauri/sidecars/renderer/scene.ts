// Engine-agnostic scene construction for the renderer worker.
//
// SINGLE SOURCE OF TRUTH ROUTING — everything here flows through
// src/lib/mapVisuals/ (resolveStaticPaints / buildPerFrameState /
// buildStaticSourceData / buildStyleSpec), the same modules the preview's
// MapView.tsx applies. This module only re-shapes their outputs into the
// tuple arrays both backends apply; it never invents visual state.
//
// History: this logic lived inline in index.ts (applySetup + renderFrame)
// when chrome was the only backend. The Phase 5 renderer strangle extracted
// it VERBATIM so the native backend consumes the identical translation —
// the spike proved cross-engine decoration placement agrees to ≤0.05 CSS px
// precisely because both engines are fed by this one derivation
// (.spike/native-gl/MECHANICAL_VERDICT.md §3).

import {
  buildBasemapSpec,
  buildStaticSourceData,
  buildPerFrameState,
  outlineThicknessCanvasPx,
  resolveStaticPaints,
  type BasemapSpec,
  type HaloCompositeGroup,
  LIVE_MARKER_PULSE_LAYER,
  LIVE_MARKER_PULSE_B_LAYER,
  LIVE_MARKER_DOT_LAYER,
  LIVE_MARKER_IMAGE_LAYER,
  LIVE_MARKER_SHAPE_PRIMARY_LAYER,
  LIVE_MARKER_SHAPE_SECONDARY_LAYER,
  LIVE_MARKER_HALO_LAYER,
  LIVE_MARKER_HALO_CORE_LAYER,
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
} from '../../../src/lib/mapVisuals';
import { activeClipIdAt } from '../../../src/lib/cameraIntent';
import type { IndexedRoute } from '../../../src/lib/routeLocation';
import { resolveMapSettings, type MapSettings } from '../../../src/types';

import type { FramePayload, SetupCmd } from './backend';

// A decoration layer spec as mapVisuals ships it — an object with at least
// `id` and `source`. Kept loose (unknown fields ride along) exactly as the
// pre-split code treated layer specs.
export interface DecorationLayerSpec {
  id: string;
  source: string;
  [key: string]: unknown;
}

export interface StaticScene {
  /** The basemap the PROJECT defaults resolve to — style (a URL string for
   *  default/3d, an inline StyleSpecification for satellite; the backend
   *  fetches + parses URL styles through the tile cache before `map.load`),
   *  its `styleId`, and the conditional 3D-buildings layer.
   *
   *  Setup-time seed only. `map_style` is per-clip overridable, so the
   *  BASEMAP IN FORCE at any given frame is `FramePayload.basemap` (see
   *  `buildFramePayload`), and a backend that can swap basemaps mid-export
   *  must follow that, not this. Same seed-vs-per-frame split as
   *  `staticPaints` / `haloComposites` below. */
  basemap: BasemapSpec;
  /** Static sources in add order. Data is the init-time seed; the dynamic
   *  sources (route-trail, live-marker) seed empty and are replaced per
   *  frame. `lineMetrics: true` on both route sources is mandatory for the
   *  `line-gradient` paint expression — it MUST be set at addSource time. */
  staticSources: Array<[string, Record<string, unknown>]>;
  /** Decoration layer stack, bottom → top. Stacking order is part of the
   *  visual contract (mirrors MapView.tsx):
   *  route-full-halo → route-full-halo-core → route-full →
   *  route-trail-halo → route-trail-halo-core → route-trail →
   *  waypoints-halo → waypoints-halo-core → waypoints-active-halo →
   *  waypoints-primary → waypoints-secondary → waypoints-image →
   *  live-marker-halo → live-marker-halo-core → live-marker-pulse →
   *  live-marker-pulse-b → live-marker-dot → live-marker-shape-primary →
   *  live-marker-shape-secondary → live-marker-image. */
  staticLayers: DecorationLayerSpec[];
  staticPaints: Array<[string, string, unknown]>;
  staticLayouts: Array<[string, string, unknown]>;
  staticGradients: Array<[string, unknown]>;
  /** Setup-time seed for the engine-level halo group-opacity composite,
   *  resolved from project-DEFAULT `mapSettings` (`resolveStaticPaints`'s
   *  `haloComposites` bucket — always the four groups in fixed order, same
   *  convention as `staticPaints`/`staticGradients` above). Halo opacity is
   *  per-clip overridable (`MapOverrides.route/waypoints/pov.halo`), so this
   *  seed is only correct for frames at the project defaults; each frame's
   *  `buildFramePayload` re-resolves against the active clip's merged
   *  settings and backends re-apply whenever that value changes. */
  haloComposites: HaloCompositeGroup[];
  /** Outline thickness (canvas px) for the waypoint shapes' secondary slot,
   *  resolved from the active MapSettings — the same derivation MapView
   *  uses. Backends rasterize the SDF atlas themselves via
   *  `buildAllShapeIcons({ outlineThickness, pixelRatio })`. */
  shapeOutlineThickness: number;
  /** Outline thickness (canvas px) for the POV shape presets' secondary
   *  slot — the POV's own geometry (dot stroke over dot radius), resolved
   *  from PROJECT settings like `shapeOutlineThickness`. Backends rasterize
   *  the `pov-*` atlas via `buildShapeIconsFor('pov', 'pov-', …)`. Same
   *  setup-only limitation as the waypoint atlas: per-clip stroke/radius
   *  overrides re-resolve icon-size per frame but do NOT re-rasterize the
   *  outline band mid-export. */
  povShapeOutlineThickness: number;
}

/** Empty-LineString placeholder for the dynamic route-trail source. GL JS
 *  accepts it; the NATIVE boundary must normalize it to an empty
 *  FeatureCollection (native's GeoJSON conversion rejects <2-point
 *  LineStrings). The normalization lives in nativeBackend.ts — sources.ts
 *  and this seed stay untouched because they also feed the preview. */
export function emptyLineFeature(): Record<string, unknown> {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: [] },
  };
}

export function emptyPointCollection(): Record<string, unknown> {
  return { type: 'FeatureCollection', features: [] };
}

export function buildStaticScene(payload: SetupCmd): StaticScene {
  const staticData = buildStaticSourceData({
    route: payload.route,
    waypoints: payload.waypoints,
    mapSettings: payload.mapSettings,
  });

  // Static sources/layers — order matters and is identical on both
  // backends so stacking is identical.
  const staticSources: Array<[string, Record<string, unknown>]> = [
    ['route-full', { type: 'geojson', data: staticData['route-full'], lineMetrics: true }],
    ['route-trail', { type: 'geojson', data: emptyLineFeature(), lineMetrics: true }],
    ['waypoints', { type: 'geojson', data: staticData.waypoints }],
    ['live-marker', { type: 'geojson', data: emptyPointCollection() }],
  ];
  // Layer stack on the shared `waypoints` source mirrors MapView.tsx
  // (bottom → top): halo → primary → secondary(+label). Both primary and
  // secondary are SDF symbol layers; the halo sits BELOW the shape layers;
  // the label rides on the secondary symbol layer so icon + text share one
  // placement unit (see WAYPOINTS_SECONDARY_LAYER).
  const staticLayers = [
    // Route halos interleave beneath their lines (full halo must stay below
    // the trail line, so per-source pairs rather than both halos first).
    // Each halo's falloff core twin sits between the outer band and the
    // line it glows under.
    ROUTE_FULL_HALO_LAYER,
    ROUTE_FULL_HALO_CORE_LAYER,
    ROUTE_FULL_LAYER,
    ROUTE_TRAIL_HALO_LAYER,
    ROUTE_TRAIL_HALO_CORE_LAYER,
    ROUTE_TRAIL_LAYER,
    // User halo (all waypoints) beneath the active "you are here" ring.
    WAYPOINTS_HALO_LAYER,
    WAYPOINTS_HALO_CORE_LAYER,
    WAYPOINTS_ACTIVE_HALO_LAYER,
    WAYPOINTS_PRIMARY_LAYER,
    WAYPOINTS_SECONDARY_LAYER,
    // Library-image waypoint markers — non-SDF twin of the shape pair.
    WAYPOINTS_IMAGE_LAYER,
    // POV halo pair at the bottom of the live-marker stack — pulse rings
    // and the marker body all paint over it.
    LIVE_MARKER_HALO_LAYER,
    LIVE_MARKER_HALO_CORE_LAYER,
    LIVE_MARKER_PULSE_LAYER,
    LIVE_MARKER_PULSE_B_LAYER,
    LIVE_MARKER_DOT_LAYER,
    // POV marker alternates — always seeded (visibility 'none' until
    // resolveStaticPaints flips one on), above the dot they replace.
    // Mirrors MapView's onStyleLoad stack.
    LIVE_MARKER_SHAPE_PRIMARY_LAYER,
    LIVE_MARKER_SHAPE_SECONDARY_LAYER,
    LIVE_MARKER_IMAGE_LAYER,
  ] as unknown as DecorationLayerSpec[];

  // Outline thickness resolved from the active MapSettings so the baked
  // outline band tracks the user's stroke-width / dot-radius — same
  // derivation MapView uses, keeping preview and export bit-identical.
  const shapeOutlineThickness = outlineThicknessCanvasPx(
    payload.mapSettings.waypoints.size.stroke_width,
    payload.mapSettings.waypoints.size.circle_radius,
  );
  const povShapeOutlineThickness = outlineThicknessCanvasPx(
    payload.mapSettings.pov.size.dot_stroke_width,
    payload.mapSettings.pov.size.dot_radius,
  );

  // Static paint sizing + layouts — layer specs ship placeholder values for
  // every paint/layout property that derives from `mapSettings`. Real
  // values come from `resolveStaticPaints(mapSettings)`; this is the
  // *initial seed* using project defaults — per-frame `buildFramePayload`
  // re-resolves with each active clip's `map_overrides`.
  const staticPaintResolution = resolveStaticPaints(payload.mapSettings);

  return {
    basemap: buildBasemapSpec(payload.mapSettings),
    staticSources,
    staticLayers,
    staticPaints: staticPaintResolution.paints as Array<[string, string, unknown]>,
    staticLayouts: staticPaintResolution.layouts as Array<[string, string, unknown]>,
    staticGradients: staticPaintResolution.gradients as Array<[string, unknown]>,
    haloComposites: staticPaintResolution.haloComposites,
    shapeOutlineThickness,
    povShapeOutlineThickness,
  };
}

/** The engine-agnostic per-frame translation — VERBATIM the pre-split
 *  renderFrame body: resolve the active clip's merged MapSettings, run
 *  buildPerFrameState, and flatten into the tuple arrays. */
export function buildFramePayload(
  payload: SetupCmd,
  indexedRoute: IndexedRoute | null,
  t: number,
): FramePayload {
  // Camera math runs in CSS-pixel space, matching the preview MapView. dpr
  // is the export pixelRatio so any zoom-correction helpers downstream that
  // multiply by dpr get the framebuffer's actual scale.
  const viewport = {
    width: payload.cssViewport.w,
    height: payload.cssViewport.h,
    dpr: payload.pixelRatio,
  };

  const activeClipId = activeClipIdAt(payload.timeline, t);

  // Resolve the active clip's MapSettings (project defaults merged with
  // that clip's `map_overrides`), so per-clip overlay-size variations
  // render correctly. Outside a clip (gap, pre-roll), fall back to project
  // defaults — those frames are typically held end-states between
  // transitions.
  const activeClip = activeClipId
    ? payload.clips.find((c) => c.id === activeClipId) ?? null
    : null;
  const resolvedMapSettings: MapSettings = resolveMapSettings(
    payload.mapSettings,
    activeClip?.map_overrides,
  );

  const state = buildPerFrameState(
    payload.timeline,
    t,
    indexedRoute,
    payload.clips,
    payload.waypoints,
    resolvedMapSettings,
    // Project base (never a clip resolve): the POV travel decision resolves
    // against this + the DESTINATION clip's overrides inside
    // buildPerFrameState — the active clip (which flips at the cut) must
    // not decide whether the marker travels.
    payload.mapSettings,
    viewport,
  );

  // Re-resolve static paints from the active clip's settings so any
  // per-clip overlay-size override (route line width, waypoint stroke,
  // dot radius / stroke, label size) takes effect at the cut. Engines
  // no-op same-value writes internally.
  const staticResolution = resolveStaticPaints(resolvedMapSettings);

  const sources: Array<[string, unknown]> = Object.entries(state.sources);
  const paints: Array<[string, string, unknown]> = [
    ...staticResolution.paints,
    // Per-frame POV style paints (travel-effective: destination-resolved
    // when synced, the custom travel playhead block when not) — appended
    // after the statics so they win last-write inside a travel window, and
    // BEFORE the pulse/dot scalars below so the per-frame pulse animation
    // still overrides the style block's pulse-radius seeds. Outside a
    // window this bucket equals the static POV tuples (no-op writes).
    ...state.povPaints,
    // Primary + secondary `icon-color` flow as data-driven case expressions
    // from buildPerFramePaints (override > active > base for each slot).
    ['waypoints-primary', 'icon-color', state.paints.waypointPrimaryColor],
    ['waypoints-secondary', 'icon-color', state.paints.waypointSecondaryColor],
    // Active-waypoint halo ([DECIDED] Q2). Always-seeded layer; radius and
    // opacity collapse to 0 when no waypoint is active.
    ['waypoints-active-halo', 'circle-radius', state.paints.waypointHaloRadius],
    ['waypoints-active-halo', 'circle-color', state.paints.waypointHaloColor],
    ['waypoints-active-halo', 'circle-opacity', state.paints.waypointHaloOpacity],
    ['live-marker-pulse', 'circle-radius', state.paints.pulseRadius],
    ['live-marker-pulse', 'circle-opacity', state.paints.pulseOpacity],
    // B-ring always seeded; opacity 0 outside heartbeat style.
    ['live-marker-pulse-b', 'circle-radius', state.paints.pulseRadiusB],
    ['live-marker-pulse-b', 'circle-opacity', state.paints.pulseOpacityB],
    // Dot opacity oscillates in `throb`; held at 1.0 in steady / sonar /
    // heartbeat per shapes-pov.md Part 2 §2.
    ['live-marker-dot', 'circle-opacity', state.paints.dotOpacity],
    // The dot's stroke is a SEPARATE opacity channel in MapLibre
    // (`circle-stroke-opacity`, default 1) — it must ride `dotOpacity` too
    // or the seam-ease fade / throb only dims the fill and leaves the ring
    // at full strength. Mirrors MapView's per-frame tick.
    ['live-marker-dot', 'circle-stroke-opacity', state.paints.dotOpacity],
    // Every alternate POV marker body inherits the dot's opacity animation
    // — whichever layer is visible IS the marker body (three-way visibility
    // swap via resolveStaticPaints). Mirrors MapView's per-frame tick.
    ['live-marker-image', 'icon-opacity', state.paints.dotOpacity],
    ['live-marker-shape-primary', 'icon-opacity', state.paints.dotOpacity],
    ['live-marker-shape-secondary', 'icon-opacity', state.paints.dotOpacity],
  ];
  // `icon-size` is a layout property (not paint), so the active-state size
  // bump rides the layouts channel. Both symbol layers get the same value
  // so the outline tracks the fill at every size.
  const layouts: Array<[string, string, unknown]> = [
    ...staticResolution.layouts,
    ['waypoints-primary', 'icon-size', state.paints.waypointIconSize],
    ['waypoints-secondary', 'icon-size', state.paints.waypointIconSize],
    // Image-marker twin: image-bridged icon-size (see paints.ts).
    ['waypoints-image', 'icon-size', state.paints.waypointImageIconSize],
    // Primary uses the DRAW key (negative distance — paints later, on top;
    // allow-overlap true), secondary the PLACEMENT key (lower wins
    // placement; allow-overlap false). See `paints.ts`. The image layer
    // shares the primary's DRAW key (it also allow-overlaps).
    ['waypoints-primary', 'symbol-sort-key', state.paints.waypointSortKey],
    ['waypoints-secondary', 'symbol-sort-key', state.paints.waypointPlacementKey],
    ['waypoints-image', 'symbol-sort-key', state.paints.waypointSortKey],
    // Per-frame POV marker identity (travel-transition swap) — appended
    // LAST so these tuples win last-write over `staticResolution.layouts`'
    // marker tuples (the backend applies the array sequentially and no-ops
    // same-value writes). Outside a travel window the bucket equals the
    // static tuples, so this is a no-op except mid-travel with a differing
    // transition marker. Mirrors MapView's per-frame layouts apply block.
    ...state.layouts,
  ];
  // Per-frame line-gradient expressions — today always equal to the static
  // seed (no per-clip route-color overrides exist); the wiring stays
  // consistent with paints/layouts so a future override path lands without
  // a renderer-side change.
  const gradients: Array<[string, unknown]> =
    staticResolution.gradients as Array<[string, unknown]>;

  // Halo group-opacity composite — taken from the per-frame state (NOT the
  // static resolution) so both per-clip halo-opacity overrides AND the
  // travel-effective POV halo land through one channel: outside a travel
  // window `state.haloComposites` equals the active clip's static groups,
  // inside one the live-marker entry reflects the traveling playhead's
  // halo. `g` can differ frame-to-frame; the backend re-asserts it only
  // when it changes.
  const haloComposites = state.haloComposites;

  // The BASEMAP in force at `t`. `camera.map_style` is per-clip overridable
  // like everything else, so it resolves off `resolvedMapSettings` — i.e.
  // off the clip `activeClipIdAt` reports, which flips at the transition
  // span's `cutMs`. That makes the basemap change land on the same frame
  // the video hard-cuts to the destination clip.
  //
  // [DECIDED 2026-08-15] Swap AT THE CUT, no cross-fade between basemaps.
  // Blending two styles would need two live engines plus an FFmpeg-side
  // blend of their outputs (out of scope); the camera arc is typically near
  // its zoomed-out apex at the cut, which is the least jarring instant for
  // a hard basemap change, and it is the one instant where a discontinuity
  // is already expected because the picture cuts there too.
  //
  // Backends compare `basemap.styleId` against what they have loaded and
  // rebuild only on a change (nativeBackend's `maybeSwapBasemap`). Note the
  // pitch asymmetry: `defaultPitch` here is informational for the export
  // path — export pitch comes from the compiled timeline's per-clip camera
  // (`anchorIntentForClip` already resolves the clip's own map_style), so
  // pitch EASES across a 3d↔default seam while the buildings layer pops at
  // the cut.
  const basemap = buildBasemapSpec(resolvedMapSettings);

  return {
    t,
    basemap,
    sources,
    paints,
    layouts,
    gradients,
    haloComposites,
    camera: {
      center: { lng: state.camera.center.lng, lat: state.camera.center.lat },
      zoom: state.camera.zoom,
      bearing: state.camera.bearing,
      pitch: state.camera.pitch,
    },
  };
}
