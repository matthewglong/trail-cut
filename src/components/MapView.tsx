import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { convertFileSrc } from '@tauri-apps/api/core';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Clip, Route, MapSettings, Waypoint } from '../types';
import {
  resolveIntent,
  withDisplayScale,
  type CompiledTimeline,
  type Viewport,
} from '../lib/cameraIntent';
import {
  canonicalSlotCss,
  previewDisplayScale,
  type AspectRatio,
  type ProjectLayouts,
} from '../lib/layout';
import { indexRoute } from '../lib/routeLocation';
import { livePlayheadMs } from '../lib/livePlayhead';
import {
  buildStyleSpec,
  buildStaticSourceData,
  resolveStaticPaints,
  buildPerFrameState,
  buildAllShapeIcons,
  buildShapeIconsFor,
  buildMarkerImageIcon,
  markerImageIconId,
  outlineThicknessCanvasPx,
  transparentRasterEntry,
  transparentSdfEntry,
  BUILDINGS_LAYER_SPEC,
  LIVE_MARKER_PULSE_LAYER,
  LIVE_MARKER_PULSE_B_LAYER,
  LIVE_MARKER_DOT_LAYER,
  LIVE_MARKER_IMAGE_LAYER,
  LIVE_MARKER_SHAPE_PRIMARY_LAYER,
  LIVE_MARKER_SHAPE_SECONDARY_LAYER,
  MARKER_IMAGE_ICON_PREFIX,
  PAINT_REFERENCE_WIDTH,
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
  type HaloCompositeGroup,
  type RgbaBitmap,
} from '../lib/mapVisuals';
import { loadMarkerMasterRgba } from '../lib/markerImageBrowser';

/** The group-composite surface the vendored maplibre-gl patch adds
 *  (`patches/maplibre-gl+*.patch`, the GL JS twin of the native binding's
 *  patch 3). Declared locally because the patch modifies the shipped dist
 *  bundle, not the package's type declarations. */
interface GroupCompositeMap extends maplibregl.Map {
  setGroupComposite(groups: HaloCompositeGroup[]): void;
}

interface MapViewProps {
  /** The compiled project-time timeline. Single source of truth for camera
   *  scheduling — the per-frame loop below evaluates `cameraAt(timeline, t)`
   *  every animation frame. See `COMPILED_TIMELINE_PLAN.md` §"Data Model →
   *  Compiled Data". */
  timeline: CompiledTimeline;
  /** Project-time playhead (ms). null when no clip is selected or the
   *  selected clip is not compilable. The render loop falls back to the
   *  selected clip's `canonicalSeekMs` when this is null but a clip is
   *  selected, so the camera lands on the right initial frame even before
   *  the video element fires its first time-update. */
  playheadMs: number | null;
  mapSettings: MapSettings;
  /** The UNRESOLVED project-level MapSettings (never a clip resolve).
   *  `mapSettings` above arrives already resolved for the toolbar's scope
   *  (project base in project scope, selected-clip resolve in clip scope);
   *  the POV travel decision instead resolves against the project base +
   *  the DESTINATION clip of each transition inside `buildPerFrameState`,
   *  which needs the base available regardless of scope. */
  projectMapSettings: MapSettings;
  /** The user's persistent selection. Drives the playhead-bootstrap fallback
   *  in `currentProjectMs` (when no playhead has fired yet, the render loop
   *  targets this clip's `canonicalSeekMs`). For waypoint highlighting use
   *  `activeClipId` instead — the two diverge during an auto-advance
   *  transition. */
  selectedClipId: string | null;
  /** The clip whose camera state is current at this moment in project-time
   *  per `activeClipIdAt`. During a transition this is the destination clip;
   *  outside a transition it equals `selectedClipId`. Pre-v7 this drove
   *  waypoint highlighting; post-v7 the active-waypoint highlight is driven
   *  by `mapSettings.active_waypoint_mode` against the marker's wall-clock,
   *  so this prop is unused for highlighting. Kept for parity with the
   *  caller's existing wiring; the live-marker fallback chain reads the
   *  clip list directly. */
  activeClipId: string | null;
  route: Route | null;
  /** Per-clip data (id, gps) — used for the live-marker's GPS fallback when
   *  GPX is missing or out of range. The waypoints themselves are now first
   *  class (`waypoints` prop below) and carry their own fallback GPS, so
   *  this list is no longer the waypoint source of truth. */
  clips: Clip[];
  /** First-class waypoints (schema v7). Drives the `waypoints` GeoJSON
   *  source — replaces the old "iterate clips at render time" model. */
  waypoints: Waypoint[];
  /** Selected export aspect. Together with `layouts` it fixes the two
   *  display-side constants of the reference-space model:
   *  (1) the canonical map-slot CSS viewport camera intents resolve against
   *  (`canonicalSlotCss` — the same viewport the export renderer uses, so
   *  region fits produce the export band's zoom), and (2) the pane's fixed
   *  display scale (`previewDisplayScale` — the fullscreen-fit factor of
   *  the aspect's canonical frame on the current screen). The pane renders
   *  the reference space at that fixed scale: `zoom + log2(scale)` and
   *  decoration paints `× scale`, both threaded through mapVisuals. Making
   *  the pane wider or narrower reveals more / crops geography and never
   *  rescales it; perceived zoom and decoration size match the export as
   *  played fullscreen on this display. */
  aspect: AspectRatio;
  /** Per-aspect layout configs — `layouts[aspect]` (or the default layout
   *  when null) determines the canonical map-slot dims above. Passing the
   *  whole record keeps this component's derivation identical to the export
   *  pipeline's `resolve_slots` fallback semantics. */
  layouts: ProjectLayouts;
  /** The CURRENT aspect's map magnification factor `k` (see
   *  `MapMagnifications` in `lib/layout.ts`) — already resolved by the
   *  caller, since the preview's aspect fold ('1:1' → 4:5) is the caller's
   *  business. The export shrinks the renderer's css viewport by `k` and
   *  raises `pixelRatio` by `k`, magnifying the map render relative to the
   *  frame; the honest-preview contract (§2.6) says the pane must show that.
   *  So `k` enters here in exactly two places: the intent viewport
   *  (`canonicalSlotCss(..., magnification)` — same derivation the renderer
   *  runs) and the pane's effective scale (`displayScale × k`, threaded
   *  through mapVisuals as `surfaceScale`). `1` is the identity. */
  magnification: number;
  /** Project bundle directory — needed to resolve `pov.image`'s
   *  bundle-relative asset path for the custom POV marker. null before a
   *  project is open (the image effect no-ops). */
  projectDir?: string | null;
  onSelectClip?: (clipId: string) => void;
}

export default function MapView({
  timeline,
  clips,
  waypoints,
  selectedClipId,
  activeClipId,
  route,
  playheadMs,
  mapSettings,
  projectMapSettings,
  aspect,
  layouts,
  magnification,
  projectDir,
  onSelectClip,
}: MapViewProps) {
  const onSelectClipRef = useRef(onSelectClip);
  useEffect(() => {
    onSelectClipRef.current = onSelectClip;
  }, [onSelectClip]);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const styleReadyRef = useRef(false);
  const [styleVersion, setStyleVersion] = useState(0);
  const mapStyleId = mapSettings.camera.map_style;

  // Track window.devicePixelRatio so SDF shape icons can be re-rasterized at
  // the new density when the user drags the app between monitors of
  // different DPR (retina laptop ↔ standard external). MapLibre's framebuffer
  // already tracks DPR for vector tiles, but custom `addImage` SDF atlases
  // are baked at register time — without this listener, the atlas stays at
  // the original DPR and looks soft on the higher-DPR screen.
  //
  // `matchMedia('(resolution: Ndppx)')` flips `matches` to false when DPR
  // changes; we re-read `window.devicePixelRatio` and propagate via state so
  // the re-rasterize effect below re-runs.
  const [devicePixelRatio, setDevicePixelRatio] = useState(() =>
    typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
  );
  // Screen CSS dims feed `previewDisplayScale` (fullscreen-fit factor of the
  // aspect's canonical frame on THIS display). Tracked as state alongside
  // DPR: a cross-monitor drag flips the matchMedia below, which is also the
  // moment the screen dims can change. Same-DPR monitor moves are not
  // observable this way — the stale factor persists until the next DPR flip
  // or remount, an accepted approximation (the factor is a viewing-scale
  // convention, not a correctness input to exports).
  const [screenDims, setScreenDims] = useState(() =>
    typeof window === 'undefined'
      ? { w: 0, h: 0 }
      : { w: window.screen.width, h: window.screen.height },
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    const onChange = () => {
      setDevicePixelRatio(window.devicePixelRatio || 1);
      setScreenDims({ w: window.screen.width, h: window.screen.height });
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [devicePixelRatio]);
  // The pane's fixed display scale: CSS px per reference-space unit.
  // Depends only on (aspect, screen) — never the pane's size — so dragging
  // the pane reveals/crops geography at constant perceived scale.
  const displayScale = previewDisplayScale(aspect, screenDims.w, screenDims.h);
  // …times the aspect's magnification. Under magnification the export lays
  // the map out in a css viewport shrunk by k at pixelRatio × k, so every
  // reference-space unit occupies k× more output pixels; the pane matches
  // that by showing the reference space at k× the fullscreen-fit factor.
  // This is the ONE scale the map is rendered at — every surfaceScale /
  // withDisplayScale consumer below reads it, so nothing can be magnified
  // without its texture density following along.
  const effectiveScale = displayScale * magnification;

  // Tracks the last route reference we framed via the region-intent jumpTo
  // below. Idempotence guard: we only refit once per unique route.
  const appliedRouteRef = useRef<Route | null>(null);

  // Mirror props on refs so the per-frame render loop reads fresh values
  // without re-subscribing on every prop change. The loop only restarts when
  // `timeline` changes; everything else flows through refs. Refresh runs in
  // a passive useEffect (post-paint) so worst-case staleness is one frame.
  const mapSettingsRef = useRef(mapSettings);
  const projectMapSettingsRef = useRef(projectMapSettings);
  const clipsRef = useRef(clips);
  const waypointsRef = useRef(waypoints);
  const routeRef = useRef(route);
  const aspectRef = useRef(aspect);
  // Mirror devicePixelRatio onto a ref so the initial-style-load closure
  // (which runs inside the once-on-mount map init effect, and only reads
  // refs to avoid restarting the whole map on every prop tick) can register
  // SDF icons at the current DPR. The re-rasterize effect below reads the
  // state value directly and includes it in its dep list.
  const devicePixelRatioRef = useRef(devicePixelRatio);
  useEffect(() => {
    devicePixelRatioRef.current = devicePixelRatio;
  }, [devicePixelRatio]);
  const currentProjectMsRef = useRef<number | null>(null);
  // Diff cache for the per-frame layouts bucket (`layerId prop` →
  // JSON-encoded value). Lets the render loop skip redundant
  // `setLayoutProperty` writes (symbol re-layout isn't free); cleared by
  // the static-apply effect so a style swap / settings change always
  // re-asserts. See the apply site in the render loop below.
  const appliedLayoutRef = useRef(new Map<string, string>());
  // Same diff-cache treatment for the per-frame POV style PAINT bucket and
  // the per-frame halo group-composite config (travel-effective style —
  // see PerFrameState.povPaints / .haloComposites). Paint writes are
  // cheaper than layout writes but not free at rAF cadence, and the
  // composite is one engine call per change. Both cleared by the
  // static-apply effect for the same re-assert reason.
  const appliedPovPaintRef = useRef(new Map<string, string>());
  const appliedCompositeRef = useRef<string | null>(null);
  useEffect(() => {
    mapSettingsRef.current = mapSettings;
  }, [mapSettings]);
  useEffect(() => {
    projectMapSettingsRef.current = projectMapSettings;
  }, [projectMapSettings]);
  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);
  useEffect(() => {
    waypointsRef.current = waypoints;
  }, [waypoints]);
  useEffect(() => {
    routeRef.current = route;
  }, [route]);
  useEffect(() => {
    aspectRef.current = aspect;
  }, [aspect]);
  const layoutsRef = useRef(layouts);
  useEffect(() => {
    layoutsRef.current = layouts;
  }, [layouts]);
  const effectiveScaleRef = useRef(effectiveScale);
  useEffect(() => {
    effectiveScaleRef.current = effectiveScale;
  }, [effectiveScale]);
  const magnificationRef = useRef(magnification);
  useEffect(() => {
    magnificationRef.current = magnification;
  }, [magnification]);
  // `activeClipId` is no longer consumed by the render loop (v7 active-
  // waypoint logic uses `mapSettings.active_waypoint_mode` against the
  // marker's wall-clock instead). The prop is kept on `MapViewProps` for
  // parity with the existing call site.
  void activeClipId;
  // Effective project-time the render loop should target. When the video is
  // playing this mirrors the playhead. When no playhead has fired yet (e.g.
  // right after project load or a clip selection), fall back to the selected
  // clip span's `canonicalSeekMs` so the first frame targets the user's
  // intent rather than the previous clip's last frame.
  useEffect(() => {
    if (playheadMs != null) {
      currentProjectMsRef.current = playheadMs;
    } else if (selectedClipId) {
      const span = timeline.clipSpans.find((s) => s.clipId === selectedClipId);
      currentProjectMsRef.current = span ? span.canonicalSeekMs : null;
    } else {
      currentProjectMsRef.current = null;
    }
  }, [playheadMs, selectedClipId, timeline]);

  // ---- Initialize map ----
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const initial = buildStyleSpec(mapSettingsRef.current);
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: initial.style,
      center: [-122.4194, 37.7749],
      zoom: 10,
      bearing: 0,
      pitch: initial.defaultPitch,
      attributionControl: false,
    });
    // Defeat MapLibre's "we're at rest, take shortcuts" heuristics. Three
    // separate code paths read the map's motion flags via `painter.options`:
    //
    //  - `moving` (= map.isMoving()) gates `align` in draw_raster.ts:96 and
    //    its hillshade/color-relief siblings. align=true uses
    //    `_alignedProjMatrix`, which `Math.round`s camera position to integer
    //    CSS pixels (mercator_transform.ts:677–681) — visible as 1-pixel
    //    raster wobble under our per-frame jumpTo loop.
    //  - `zooming` and `rotating` (= map.isZooming/isRotating) gate the icon
    //    atlas texture filter in draw_symbol.ts:365,370. At rest the engine
    //    picks `gl.NEAREST`, which aliases against the texel grid as the
    //    icon's screen position drifts sub-pixel between frames — visible as
    //    POI shimmer/jitter on the default vector style.
    //
    // Our deterministic per-frame jumpTo loop never enters easeTo/flyTo, so
    // every frame reads as at-rest. Forcing all three true keeps the
    // unsnapped raster matrix AND `gl.LINEAR` icon sampling. Camera math
    // (jumpTo, cameraAt) is unchanged, so determinism is preserved.
    map.isMoving = () => true;
    map.isZooming = () => true;
    map.isRotating = () => true;
    // Halo group compositing is engine-level (the vendored maplibre-gl
    // patch — the GL JS twin of the native binding's patch 3): each halo
    // layer pair renders into a transparent offscreen target and composites
    // over the map ONCE at the group opacity, so translucent self-overlap
    // (out-and-back retraces, GPS-jitter sunbursts) can't double-blend.
    // `resolveStaticPaints` emits IN-FBO halo opacities on the assumption
    // that the composite is applied — an unpatched engine would render
    // falloff halos visibly wrong. Fail loud, mirroring the native
    // backend's capability gates (nativeBackend.ts): a missing patch is a
    // build defect, never a degrade-gracefully condition.
    if (typeof (map as unknown as Partial<GroupCompositeMap>).setGroupComposite !== 'function') {
      throw new Error(
        'maplibre-gl lacks setGroupComposite — the vendored group-composite ' +
        'patch is not applied. Run `npm install` (postinstall runs ' +
        'patch-package) and restart; do not render halos on an unpatched engine.',
      );
    }
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }));

    // Notify MapLibre when the container's CSS box changes so its internal
    // transform width/height stay in sync. Paint sizes and camera zoom are
    // both pane-invariant under the current model (anchored at the
    // canonical 1080), so this observer no longer needs to publish width
    // anywhere — it's purely a MapLibre housekeeping signal.
    const resizeObserver = new ResizeObserver(() => {
      map.resize();
    });
    resizeObserver.observe(containerRef.current);
    mapRef.current = map;

    const emptyLine: GeoJSON.Feature<GeoJSON.LineString> = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [] },
    };
    const emptyFc: GeoJSON.FeatureCollection<GeoJSON.Point> = {
      type: 'FeatureCollection',
      features: [],
    };

    const onStyleLoad = () => {
      styleReadyRef.current = true;

      // 3D-buildings layer for `'3d'` mode. The buildings source only exists
      // in the OpenFreeMap liberty style — guarded + try/catch so satellite
      // and other raster styles silently skip it.
      if (mapSettingsRef.current.camera.map_style === '3d') {
        try {
          if (!map.getLayer('3d-buildings') && map.getSource('openmaptiles')) {
            map.addLayer(BUILDINGS_LAYER_SPEC);
          }
        } catch {
          // building source not available in this style — ignore
        }
      }

      // Pre-create source/layer pairs. Stacking order: routes → waypoints →
      // live-marker (marker on top).
      //
      // `lineMetrics: true` on both route sources is mandatory for the
      // `line-gradient` paint expression `resolveStaticPaints` emits in
      // gradient mode — it tells MapLibre to compute per-vertex
      // `line-progress` metrics at tile load. It MUST be set at `addSource`
      // time; adding it later is a no-op. `setStyle()` drops sources, so
      // this `onStyleLoad` re-add path covers cross-style swaps.
      if (!map.getSource('route-full')) {
        map.addSource('route-full', {
          type: 'geojson',
          data: emptyLine,
          lineMetrics: true,
        });
        // Halo beneath its line (add order = paint order). Interleaved
        // per-source — the full-route halo must stay below the trail line,
        // which itself draws above everything route-full paints. The
        // falloff core twin sits between the outer band and the line.
        map.addLayer(ROUTE_FULL_HALO_LAYER);
        map.addLayer(ROUTE_FULL_HALO_CORE_LAYER);
        map.addLayer(ROUTE_FULL_LAYER);
      }
      if (!map.getSource('route-trail')) {
        map.addSource('route-trail', {
          type: 'geojson',
          data: emptyLine,
          lineMetrics: true,
        });
        map.addLayer(ROUTE_TRAIL_HALO_LAYER);
        map.addLayer(ROUTE_TRAIL_HALO_CORE_LAYER);
        map.addLayer(ROUTE_TRAIL_LAYER);
      }
      if (!map.getSource('waypoints')) {
        map.addSource('waypoints', { type: 'geojson', data: emptyFc });
        // Layer stack on the shared `waypoints` source (bottom → top):
        //   waypoints-halo(-core) (optional user halo behind EVERY marker —
        //                          `waypoints.halo`)
        //   waypoints-active-halo (semi-transparent ring behind the active
        //                          waypoint's shape)
        //   waypoints-primary     (filled silhouette SDF; tinted by primary color)
        //   waypoints-secondary   (outline SDF + label text co-placed as one
        //                          MapLibre placement unit, so the label
        //                          can't block the outline of its own
        //                          waypoint — see the layer spec for why)
        // The halo sits BELOW the shape layers so the shape paints over it.
        // Primary paints the body; secondary overpaints the outermost band
        // (or whatever the shape descriptor's secondary rasterizer defines)
        // so the user-visible stroke matches the shape silhouette exactly.
        // The label rides the secondary's symbol so the two compose as a
        // single drawable unit during collision detection.
        map.addLayer(WAYPOINTS_HALO_LAYER);
        map.addLayer(WAYPOINTS_HALO_CORE_LAYER);
        map.addLayer(WAYPOINTS_ACTIVE_HALO_LAYER);
        map.addLayer(WAYPOINTS_PRIMARY_LAYER);
        map.addLayer(WAYPOINTS_SECONDARY_LAYER);
        // Library-image markers — non-SDF twin of the shape pair, directly
        // above waypoints-secondary (labels stay on secondary, so
        // image-marked waypoints keep their labels).
        map.addLayer(WAYPOINTS_IMAGE_LAYER);
      }
      if (!map.getSource('live-marker')) {
        map.addSource('live-marker', { type: 'geojson', data: emptyFc });
        // POV halo pair at the bottom of the live-marker stack — pulse
        // rings and the marker body all paint over it.
        map.addLayer(LIVE_MARKER_HALO_LAYER);
        map.addLayer(LIVE_MARKER_HALO_CORE_LAYER);
        map.addLayer(LIVE_MARKER_PULSE_LAYER);
        map.addLayer(LIVE_MARKER_PULSE_B_LAYER);
        map.addLayer(LIVE_MARKER_DOT_LAYER);
        // POV marker alternates — always seeded (visibility 'none' until
        // resolveStaticPaints flips one on), stacked above the dot they
        // replace: SDF shape pair, then the library-image symbol.
        map.addLayer(LIVE_MARKER_SHAPE_PRIMARY_LAYER);
        map.addLayer(LIVE_MARKER_SHAPE_SECONDARY_LAYER);
        map.addLayer(LIVE_MARKER_IMAGE_LAYER);
      }

      // Register SDF icons for every waypoint shape × both slots
      // (primary + secondary). Order: addSource → addLayer → addImage →
      // seed paints. Images are added AFTER the symbol layers are added
      // so the layers' `icon-image` expression has a registered image to
      // resolve to on its first paint.
      //
      // Re-register on every style.load — `setStyle()` clears the image
      // atlas along with sources/layers, and this callback runs on the
      // `style.load` event for each base-style swap (default ↔ satellite ↔
      // 3d). `hasImage` guards a redundant re-register on the initial
      // style load when the source-add branch above also took place.
      //
      // Pixels come from `buildAllShapeIcons` in `shapes.ts` (pure, no
      // DOM/Canvas). The export renderer runs the SAME function in its own
      // Chrome page (init.ts) with the same outlineThickness + pixelRatio
      // inputs, so both sides bake a bit-identical atlas — preview/export
      // parity by construction, with no pixel buffers crossing the wire.
      // `outlineThickness` is sourced from the
      // current `mapSettings` ref so a style swap mid-session re-registers
      // at the right thickness; settings changes between swaps are handled
      // by the dedicated re-register effect below.
      const initialThickness = outlineThicknessCanvasPx(
        mapSettingsRef.current.waypoints.size.stroke_width,
        mapSettingsRef.current.waypoints.size.circle_radius,
      );
      // POV shape presets rasterize with the POV's own outline geometry
      // (dot stroke over dot radius), not the waypoint stroke — the two
      // decorations' size systems are independent.
      const initialPovThickness = outlineThicknessCanvasPx(
        mapSettingsRef.current.pov.size.dot_stroke_width,
        mapSettingsRef.current.pov.size.dot_radius,
      );
      for (const { id, icon, options } of [
        ...buildAllShapeIcons({
          outlineThickness: initialThickness,
          pixelRatio: devicePixelRatioRef.current,
        }),
        ...buildShapeIconsFor('pov', 'pov-', {
          outlineThickness: initialPovThickness,
          pixelRatio: devicePixelRatioRef.current,
        }),
        // Transparent placeholders — the "hidden" arm of the SDF/raster
        // layer split (see WAYPOINTS_IMAGE_LAYER's spec).
        transparentSdfEntry(devicePixelRatioRef.current),
        transparentRasterEntry(),
      ]) {
        if (map.hasImage(id)) map.removeImage(id);
        map.addImage(
          id,
          { width: icon.width, height: icon.height, data: icon.data },
          options,
        );
      }
      // Marker-image textures re-register through their dedicated effect
      // below (it depends on styleVersion, which the style.load handler
      // bumps at the end of this callback).

      // Seed static data once. Route-fit + waypoint-seed effects below redo
      // this on subsequent route/clips/styleVersion changes.
      const staticData = buildStaticSourceData({
        route: routeRef.current,
        waypoints: waypointsRef.current,
        mapSettings: mapSettingsRef.current,
      });
      (map.getSource('route-full') as maplibregl.GeoJSONSource | undefined)
        ?.setData(staticData['route-full']);
      (map.getSource('waypoints') as maplibregl.GeoJSONSource | undefined)
        ?.setData(staticData.waypoints);

      // Trigger data effects to re-seed sources after a (re)style.
      setStyleVersion((v) => v + 1);
    };
    map.on('style.load', onStyleLoad);

    // Register layer event listeners once — they resolve the layer by name
    // at dispatch time, so they survive setStyle().
    // Click target is the primary symbol layer (the filled silhouette).
    // Hits on the secondary outline composite as the primary too since the
    // two layers share a source — but the primary is the natural hit
    // surface and avoids double-firing on overlapping pixels at the edge.
    map.on('click', 'waypoints-primary', (e) => {
      const f = e.features?.[0];
      // The feature's `id` is the waypoint id (v7); read `clipId` (set when
      // the waypoint is clip-sourced) to recover the clip selection.
      // Manual or GPX-sourced waypoints have no `clipId` — clicks no-op.
      const clipId = f?.properties?.clipId;
      if (typeof clipId === 'string') onSelectClipRef.current?.(clipId);
    });
    map.on('mouseenter', 'waypoints-primary', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'waypoints-primary', () => {
      map.getCanvas().style.cursor = '';
    });

    return () => {
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
      styleReadyRef.current = false;
    };
  }, []);

  // ---- Switch base map style ----
  const lastAppliedStyleRef = useRef(mapStyleId);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const { style, defaultPitch } = buildStyleSpec(mapSettings);
    if (lastAppliedStyleRef.current === mapStyleId) {
      // First mount: style was set in the constructor; just sync pitch.
      map.easeTo({ pitch: defaultPitch, duration: 0 });
      return;
    }
    lastAppliedStyleRef.current = mapStyleId;
    styleReadyRef.current = false;
    map.setStyle(style);
    map.easeTo({ pitch: defaultPitch, duration: 400 });
  }, [mapStyleId, mapSettings]);

  // ---- Update full-route line + region-intent fit when route changes ----
  // On a new route, frame the full bounds via a `region` CameraIntent
  // resolved through the same pipeline the ease loop uses. jumpTo (not
  // easeTo) is intentional: the initial fit has no continuity to preserve,
  // and the ease loop picks up smoothly from this state on the next tick
  // once anchors exist. Padding 0.06 matches the follow-anchor default — at
  // a typical map pane this is comparable to today's 60 px inset.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const apply = () => {
      const src = map.getSource('route-full') as maplibregl.GeoJSONSource | undefined;
      if (!src) return;

      // Source data comes from the shared module — preserves visual parity
      // with the export renderer and keeps LineString construction in one
      // place.
      const staticData = buildStaticSourceData({ route, waypoints, mapSettings });
      src.setData(staticData['route-full']);

      if (!route || route.trackpoints.length === 0) return;

      if (appliedRouteRef.current !== route) {
        appliedRouteRef.current = route;
        let minLng = Infinity;
        let minLat = Infinity;
        let maxLng = -Infinity;
        let maxLat = -Infinity;
        for (const tp of route.trackpoints) {
          if (tp.lng < minLng) minLng = tp.lng;
          if (tp.lng > maxLng) maxLng = tp.lng;
          if (tp.lat < minLat) minLat = tp.lat;
          if (tp.lat > maxLat) maxLat = tp.lat;
        }
        // Skip degenerate routes (single point or zero extent on either axis)
        // — `cameraForBounds` would return -Infinity zoom on a zero span.
        if (Number.isFinite(minLng) && maxLng > minLng && maxLat > minLat) {
          // Resolve the region intent against the aspect's canonical MAP
          // SLOT CSS dims — the same viewport the export renderer resolves
          // intents against (its cssViewport is the slot shape under the
          // lever model), so this fit lands on the zoom the export band
          // will use. Then re-express the resulting reference-space camera
          // at the pane's fixed display scale.
          const slot = canonicalSlotCss(layouts[aspect], aspect, magnification);
          const slotCssViewport: Viewport = {
            width: slot.w,
            height: slot.h,
            dpr: 1,
          };
          const target = withDisplayScale(
            resolveIntent(
              {
                kind: 'region',
                bounds: {
                  sw: { lng: minLng, lat: minLat },
                  ne: { lng: maxLng, lat: maxLat },
                },
                padding: 0.06,
                bearing: 0,
                pitch: 0,
              },
              slotCssViewport,
            ),
            effectiveScale,
          );
          map.jumpTo({
            center: [target.center.lng, target.center.lat],
            zoom: target.zoom,
            bearing: target.bearing,
            pitch: target.pitch,
          });
        }
      }
    };

    // `magnification` rides the dep list alongside `aspect`: changing the
    // factor reframes the map exactly like switching aspect does.
    if (styleReadyRef.current) apply();
  }, [
    route,
    clips,
    mapSettings,
    styleVersion,
    aspect,
    layouts,
    magnification,
    effectiveScale,
  ]);

  // ---- Apply static layer paints + layouts ----
  // `resolveStaticPaints(mapSettings)` is the single source of truth for
  // every `setPaintProperty` / `setLayoutProperty` write that derives from
  // `mapSettings` — paint sizes, label text-size, the label text-field
  // expression (`label_mode`), and route-line `visibility` (`route_mode`).
  // The renderer worker calls the same resolver and applies the same tuples
  // page-side; that's how preview/export parity is guaranteed for anything
  // tunable through `MapSettings`. If you find yourself reaching for a new
  // `map.setPaintProperty` / `map.setLayoutProperty` call in this file,
  // add it to `resolveStaticPaints` instead — anything that lives only
  // here is a divergence waiting to happen.
  //
  // Re-runs on style swap (`styleVersion`) and on any `mapSettings` change
  // — including the swap from one clip's resolved settings to another when
  // the active clip changes (the prop already arrives resolved —
  // `Project.map_settings` merged with the active clip's `map_overrides` —
  // so this effect picks up per-clip overrides automatically).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      // Invalidate the per-frame diff caches: this effect re-asserts the
      // STATIC tuples below (paints, layouts, composites), so the render
      // loop must re-assert its per-frame values on the next tick (they
      // may differ mid-travel).
      appliedLayoutRef.current.clear();
      appliedPovPaintRef.current.clear();
      appliedCompositeRef.current = null;
      // The pane's effective scale (fixed display scale × the aspect's
      // magnification) rides through the resolver — both surfaces still
      // apply exactly what mapVisuals returns (the renderer resolves at
      // scale 1, its magnification living in the css viewport / pixelRatio
      // pair instead); see resolveStaticPaints' surfaceScale doc.
      const resolved = resolveStaticPaints(mapSettings, effectiveScale);
      for (const [layerId, prop, value] of resolved.paints) {
        if (!map.getLayer(layerId)) continue;
        map.setPaintProperty(layerId, prop, value);
      }
      for (const [layerId, prop, value] of resolved.layouts) {
        if (!map.getLayer(layerId)) continue;
        map.setLayoutProperty(layerId, prop, value);
      }
      // Line gradients (route-full + route-trail). Gradient mode pushes an
      // `interpolate` expression on `line-progress`; solid mode pushes
      // `null` to clear any stale gradient from a prior resolve. This is
      // the ONLY allowed `setPaintProperty(layer, 'line-gradient', …)`
      // site preview-side — same single-source-of-truth contract as paints
      // and layouts above.
      for (const [layerId, value] of resolved.gradients) {
        if (!map.getLayer(layerId)) continue;
        map.setPaintProperty(layerId, 'line-gradient', value);
      }
      // Halo group composites — the fourth resolver bucket, same contract
      // as paints/layouts/gradients: mapVisuals computes each decoration's
      // composite opacity `g` while the member layers carry remapped in-FBO
      // opacities (see `haloGroupPolicy`). The engine matches member ids at
      // render time and ignores absent/hidden layers, so asserting before
      // onStyleLoad seeds the decoration stack is safe; re-runs here cover
      // style swaps and per-clip halo-opacity overrides. This is the ONLY
      // allowed `setGroupComposite` site preview-side.
      (map as GroupCompositeMap).setGroupComposite(resolved.haloComposites);
    };
    if (styleReadyRef.current) apply();
  }, [styleVersion, mapSettings, effectiveScale]);

  // ---- Re-rasterize SDF outline icons on stroke / radius change ----
  // The outline thickness is baked into the secondary SDF icon at rasterize
  // time, not driven by a MapLibre paint property — there is no
  // `icon-stroke-width` for symbol layers, and parameterizing the stroke
  // via two stacked icons would double the atlas size. So we rebuild the
  // affected icons and re-`addImage` them whenever the user changes
  // `stroke_width` or `circle_radius`. The cost is a one-off ~ms of
  // canvas-pixel iteration (10 shapes × 128² pixels each, mostly small
  // bounding boxes) — fine to do on every settings tick during a slider
  // drag.
  //
  // `styleVersion` is in the dep list so a style swap (which clears the
  // image atlas) also triggers a re-register at the current thickness.
  const strokeWidth = mapSettings.waypoints.size.stroke_width;
  const circleRadius = mapSettings.waypoints.size.circle_radius;
  const povDotStrokeWidth = mapSettings.pov.size.dot_stroke_width;
  const povDotRadius = mapSettings.pov.size.dot_radius;
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const thickness = outlineThicknessCanvasPx(strokeWidth, circleRadius);
      const povThickness = outlineThicknessCanvasPx(
        povDotStrokeWidth,
        povDotRadius,
      );
      for (const { id, icon, options } of [
        ...buildAllShapeIcons({
          outlineThickness: thickness,
          pixelRatio: devicePixelRatio,
        }),
        // POV shape-preset atlas — its outline geometry rides the POV size
        // fields, so it re-rasterizes on those deps too.
        ...buildShapeIconsFor('pov', 'pov-', {
          outlineThickness: povThickness,
          pixelRatio: devicePixelRatio,
        }),
        transparentSdfEntry(devicePixelRatio),
        transparentRasterEntry(),
      ]) {
        if (map.hasImage(id)) map.removeImage(id);
        map.addImage(
          id,
          { width: icon.width, height: icon.height, data: icon.data },
          options,
        );
      }
      // Force the symbol layers to re-fetch their icons. MapLibre caches
      // resolved sprites internally; `triggerRepaint` is enough because
      // `addImage` already invalidates the atlas for the affected ids.
      map.triggerRepaint();
    };
    if (styleReadyRef.current) apply();
  }, [
    strokeWidth,
    circleRadius,
    povDotStrokeWidth,
    povDotRadius,
    styleVersion,
    devicePixelRatio,
  ]);

  // ---- Register / refresh the marker-image library textures ----
  // Decodes each library entry's baked render asset
  // (assets/marker-icon-<hash>.png; legacy pov-icon-<hash>.png) once per
  // file and re-registers every `marker-image-<id>` texture whenever
  // anything that determines density changes: the library itself, the POV
  // image_size, the waypoint radii, the pane's effective scale (display
  // scale × magnification), the monitor DPR, or a style swap (which clears
  // the image atlas). The WHOLE library registers (not just
  // currently-selected images) so tile clicks and per-clip/per-waypoint
  // override switches are instant. Each texture is
  // built at the LARGEST size any use can request — POV image_size or the
  // waypoint diameter (2 × circle_radius, active bump included) — so one
  // registration covers every use.
  //
  // Decoded masters are cached by URL so slider drags only pay the
  // resample, not a fetch+decode. The async chain is guarded by an epoch
  // token so a stale decode can never register over a newer one.
  // Defensive `?? []`: the Rust model omits `marker_images` from the wire
  // payload while the library is empty (`skip_serializing_if = "Vec::is_empty"`)
  // — every existing project bundle predates this schema-v11 field, so this
  // is the common case, not an edge case. Every other `mapSettings.marker_images`
  // read in the codebase (types.ts's `resolveMapSettings`, projectPersistence's
  // `mergeMapSettings`, styleSpec.ts) already guards this; this one didn't,
  // and the unguarded `.map()` below threw on first mount for such a project
  // (uncaught in a passive effect, no ErrorBoundary anywhere in the app →
  // blank screen).
  const markerImages = mapSettings.marker_images ?? [];
  const povImageSize = mapSettings.pov.size.image_size;
  const waypointActiveRadius = mapSettings.waypoints.size.active_radius;
  const markerMasterCacheRef = useRef<Map<string, RgbaBitmap>>(new Map());
  const markerImageEpochRef = useRef(0);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // Gate the WHOLE body on style readiness like every sibling effect: the
    // synchronous cleanup below calls `map.listImages()`, which throws
    // "Style is not done loading" (via MapLibre's `_checkLoaded`) before the
    // style finishes. `styleVersion` is in the dep list and the `style.load`
    // handler bumps it right after flipping `styleReadyRef`, so this re-runs
    // and registers the textures the moment the style is ready.
    if (!styleReadyRef.current) return;
    const epoch = ++markerImageEpochRef.current;

    // Drop registrations for entries no longer in the library (deleted
    // markers) so a stale texture can't linger in the atlas.
    const wanted = new Set(markerImages.map((m) => markerImageIconId(m.id)));
    for (const id of map.listImages()) {
      if (id.startsWith(MARKER_IMAGE_ICON_PREFIX) && !wanted.has(id)) {
        map.removeImage(id);
      }
    }
    if (markerImages.length === 0 || !projectDir) return;

    // Magnification is part of the density input, not just the layout: a
    // magnified pane draws the same marker across k× more css px, and a
    // texture baked at the unmagnified size would resample up and go soft.
    const displayCssLongest =
      Math.max(povImageSize, 2 * circleRadius, 2 * waypointActiveRadius) *
      PAINT_REFERENCE_WIDTH *
      effectiveScale;

    const apply = async () => {
      for (const ref of markerImages) {
        const url = convertFileSrc(`${projectDir}/${ref.icon_file}`);
        let master = markerMasterCacheRef.current.get(url);
        if (!master) {
          const decoded = await loadMarkerMasterRgba(url).then(
            (m) => m,
            (err: unknown) => {
              // Loud per-image; the remaining entries still register. A
              // selected marker with a missing/corrupt file renders nothing
              // (visibly wrong rather than a silent fallback); the export
              // sidecar separately fails LOUD at setup.
              console.error(
                `[MapView] marker image ${ref.id} (${ref.icon_file}) failed to decode:`,
                err,
              );
              return null;
            },
          );
          if (!decoded) continue;
          master = decoded;
          markerMasterCacheRef.current.set(url, decoded);
        }
        if (epoch !== markerImageEpochRef.current || !mapRef.current) return;
        const entry = buildMarkerImageIcon(
          ref.id,
          master,
          displayCssLongest,
          devicePixelRatio,
        );
        if (map.hasImage(entry.id)) map.removeImage(entry.id);
        map.addImage(
          entry.id,
          { width: entry.icon.width, height: entry.icon.height, data: entry.icon.data },
          entry.options,
        );
      }
      map.triggerRepaint();
    };
    void apply().catch((err) => {
      console.error('[MapView] marker image registration failed:', err);
    });
  }, [
    markerImages,
    povImageSize,
    circleRadius,
    waypointActiveRadius,
    effectiveScale,
    devicePixelRatio,
    styleVersion,
    projectDir,
  ]);

  // ---- Waypoint static seed ----
  // Whenever waypoints/route/mapSettings/styleVersion changes, push the full
  // waypoints FeatureCollection. Per-frame `visited` filtering happens in
  // the ease-loop tick automatically (the module returns a 'waypoints' key
  // in `sources` when mode is 'visited').
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource('waypoints') as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      const staticData = buildStaticSourceData({ route, waypoints, mapSettings });
      src.setData(staticData.waypoints);
    };
    if (styleReadyRef.current) apply();
  }, [waypoints, route, mapSettings, styleVersion]);

  // ---- Per-frame render loop ----
  // Each animation frame we compose a per-frame snapshot via
  // `buildPerFrameState(timeline, projectTimeMs, …)` and apply it:
  // `jumpTo` for camera, `setData` for sources, `setPaintProperty` for
  // paints. No smoothing in the apply step — the only allowed source of
  // visual smoothness is `cameraAt(t)` itself, since export samples the
  // same function per frame. Anything we layered on top here (e.g.
  // `easeTo`'s default interpolation) would be preview-only and would
  // diverge from the export. Refs feed per-frame inputs; loop only
  // restarts on timeline change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    let rafId = 0;
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      // Empty timeline → don't push the camera. The route region-fit jumpTo
      // and the constructor's initial framing remain authoritative until
      // compilable clips exist.
      if (timeline.clipSpans.length === 0) {
        rafId = window.requestAnimationFrame(tick);
        return;
      }
      // Prefer livePlayheadMs — it's written from inside usePlayback's rAF
      // tick (no React state in between), so during follow playback the map
      // reads the same frame's playhead instead of one set two commits ago.
      // Fall back to currentProjectMsRef for the bootstrap case (no playhead
      // has fired yet — selected clip's canonicalSeekMs) and the seek case
      // (user clicks a clip without playing).
      const projectTimeMs =
        livePlayheadMs.current ?? currentProjectMsRef.current ?? 0;
      // Resolve intents against the aspect's canonical MAP SLOT CSS dims —
      // the identical viewport the export renderer resolves against (its
      // cssViewport is the slot shape under the lever model), so region
      // fits produce the export band's zoom. `mapSettings.zoom` means
      // "MapLibre zoom in the canonical 1080p-class reference space";
      // `buildPerFrameState` re-expresses the resolved camera and paints at
      // the pane's fixed display scale (surfaceScale). Pane reshape still
      // reveals/crops geography rather than scaling it — the scale depends
      // only on (aspect, screen).
      const currentAspect = aspectRef.current;
      const slot = canonicalSlotCss(
        layoutsRef.current[currentAspect],
        currentAspect,
        magnificationRef.current,
      );
      const slotCssViewport: Viewport = {
        width: slot.w,
        height: slot.h,
        dpr: 1,
      };
      const state = buildPerFrameState(
        timeline,
        projectTimeMs,
        indexRoute(routeRef.current),
        clipsRef.current,
        waypointsRef.current,
        mapSettingsRef.current,
        projectMapSettingsRef.current,
        slotCssViewport,
        effectiveScaleRef.current,
      );

      map.jumpTo({
        center: [state.camera.center.lng, state.camera.center.lat],
        zoom: state.camera.zoom,
        bearing: state.camera.bearing,
        pitch: state.camera.pitch,
      });

      // Sources / paints. Guard with styleReadyRef — setStyle() drops
      // sources/layers and the loop fires before they're re-added.
      if (styleReadyRef.current) {
        for (const [id, data] of Object.entries(state.sources)) {
          const src = map.getSource(id) as
            | maplibregl.GeoJSONSource
            | undefined;
          // Module returns `GeoJSON.GeoJsonObject`; `setData` wants
          // `GeoJSON.GeoJSON`. Runtime-equivalent — cast through unknown.
          if (src) src.setData(data as unknown as GeoJSON.GeoJSON);
        }
        // Per-frame POV style paints (travel-effective — see
        // PerFrameState.povPaints). NOT ad-hoc writes: the tuples come
        // verbatim from `povStyleTuples`, the same derivation the static
        // apply uses, and equal the static values outside a travel window
        // (the diff cache then no-ops every write). Applied BEFORE the
        // pulse scalars below so the per-frame pulse animation overrides
        // the style block's pulse-radius seeds.
        for (const [layerId, prop, value] of state.povPaints) {
          if (!map.getLayer(layerId)) continue;
          const cacheKey = `${layerId} ${prop}`;
          const encoded = JSON.stringify(value);
          if (appliedPovPaintRef.current.get(cacheKey) === encoded) continue;
          appliedPovPaintRef.current.set(cacheKey, encoded);
          map.setPaintProperty(layerId, prop, value);
        }
        // Per-frame halo group-composite (the live-marker entry follows the
        // travel-effective style). Re-asserted only on change — one JSON
        // compare per frame, one engine call per actual change. Equals the
        // static-apply value outside a travel window.
        {
          const encoded = JSON.stringify(state.haloComposites);
          if (appliedCompositeRef.current !== encoded) {
            appliedCompositeRef.current = encoded;
            (map as GroupCompositeMap).setGroupComposite(state.haloComposites);
          }
        }
        if (map.getLayer('waypoints-primary')) {
          // Primary slot: tinted by `waypointPrimaryColor` (three-arm case:
          // active > override > base). Icon-size lives on layout, so it
          // goes through `setLayoutProperty` rather than the paint channel.
          // `symbol-sort-key` (also layout) stacks features so the
          // closest-to-playhead waypoint paints on top — see
          // `waypointSortKey` in `paints.ts`.
          map.setPaintProperty('waypoints-primary', 'icon-color',
            state.paints.waypointPrimaryColor);
          map.setLayoutProperty('waypoints-primary', 'icon-size',
            state.paints.waypointIconSize);
          map.setLayoutProperty('waypoints-primary', 'symbol-sort-key',
            state.paints.waypointSortKey);
        }
        if (map.getLayer('waypoints-secondary')) {
          // Secondary slot: tinted by `waypointSecondaryColor` (same case
          // shape as primary, against secondary base / override / active).
          // Icon-size mirrors primary so the outline stays aligned with
          // the fill. Sort-key uses the PLACEMENT key (positive distance,
          // lower = wins) because this layer has `allow-overlap: false`
          // on both icon and text — closer-to-playhead outline+label wins
          // the collision; back markers (outline + label together) are
          // culled so they don't paint over the front fill.
          map.setPaintProperty('waypoints-secondary', 'icon-color',
            state.paints.waypointSecondaryColor);
          map.setLayoutProperty('waypoints-secondary', 'icon-size',
            state.paints.waypointIconSize);
          map.setLayoutProperty('waypoints-secondary', 'symbol-sort-key',
            state.paints.waypointPlacementKey);
        }
        if (map.getLayer('waypoints-image')) {
          // Image-marker twin of the primary slot: same sort-key (draw
          // order — allow-overlap layer), image-bridged icon-size (divisor
          // MARKER_IMAGE_CANONICAL_SIZE/2 instead of
          // SHAPE_CANONICAL_RADIUS). No icon-color — bitmaps draw verbatim.
          map.setLayoutProperty('waypoints-image', 'icon-size',
            state.paints.waypointImageIconSize);
          map.setLayoutProperty('waypoints-image', 'symbol-sort-key',
            state.paints.waypointSortKey);
        }
        if (map.getLayer('waypoints-active-halo')) {
          // Halo radius/opacity collapse to 0 when no waypoint is active so
          // the always-seeded layer stays invisible without `visibility`
          // toggling. Color tracks the dot's resolved color (or the
          // user-set `mapSettings.waypoints.active_color`) — see
          // `buildHaloColor` in paints.ts.
          map.setPaintProperty('waypoints-active-halo', 'circle-radius',
            state.paints.waypointHaloRadius);
          map.setPaintProperty('waypoints-active-halo', 'circle-color',
            state.paints.waypointHaloColor);
          map.setPaintProperty('waypoints-active-halo', 'circle-opacity',
            state.paints.waypointHaloOpacity);
        }
        if (map.getLayer('live-marker-pulse')) {
          map.setPaintProperty('live-marker-pulse', 'circle-radius',
            state.paints.pulseRadius);
          map.setPaintProperty('live-marker-pulse', 'circle-opacity',
            state.paints.pulseOpacity);
        }
        if (map.getLayer('live-marker-pulse-b')) {
          // B ring always seeded; opacity stays 0 except in heartbeat style.
          map.setPaintProperty('live-marker-pulse-b', 'circle-radius',
            state.paints.pulseRadiusB);
          map.setPaintProperty('live-marker-pulse-b', 'circle-opacity',
            state.paints.pulseOpacityB);
        }
        if (map.getLayer('live-marker-dot')) {
          // Dot opacity oscillates in the `throb` pulse style (sine wave
          // 0.35 → 1.0); held at 1.0 in steady / sonar / heartbeat per
          // `shapes-pov.md` Part 2 §2.
          map.setPaintProperty('live-marker-dot', 'circle-opacity',
            state.paints.dotOpacity);
          // The stroke is a SEPARATE opacity channel in MapLibre
          // (`circle-stroke-opacity`, default 1) — drive it with the same
          // value or the seam-ease fade / throb dims only the fill and
          // leaves the ring at full strength. Mirrored in scene.ts.
          map.setPaintProperty('live-marker-dot', 'circle-stroke-opacity',
            state.paints.dotOpacity);
        }
        if (map.getLayer('live-marker-image')) {
          // Every alternate POV marker body inherits the dot's opacity
          // animation — whichever layer is visible IS the marker body
          // (three-way visibility swap via resolveStaticPaints), so
          // `throb` breathes them identically. Mirrored in scene.ts for
          // the export renderer.
          map.setPaintProperty('live-marker-image', 'icon-opacity',
            state.paints.dotOpacity);
        }
        if (map.getLayer('live-marker-shape-primary')) {
          map.setPaintProperty('live-marker-shape-primary', 'icon-opacity',
            state.paints.dotOpacity);
        }
        if (map.getLayer('live-marker-shape-secondary')) {
          map.setPaintProperty('live-marker-shape-secondary', 'icon-opacity',
            state.paints.dotOpacity);
        }
        // Per-frame POV marker identity (travel-transition swap). NOT an
        // ad-hoc setLayoutProperty — the tuples come verbatim from the
        // mapVisuals `layouts` bucket (see PerFrameState.layouts), which
        // equals resolveStaticPaints' marker tuples outside a travel
        // window. The diff cache skips redundant writes: layout writes on
        // symbol layers can trigger re-layout, so per-rAF re-assertion of
        // unchanged values is not free. The cache is cleared whenever the
        // static-apply effect runs (style swap / settings change), so a
        // static re-apply is always followed by a fresh per-frame assert
        // and the two channels can't fight.
        for (const [layerId, prop, value] of state.layouts) {
          if (!map.getLayer(layerId)) continue;
          const cacheKey = `${layerId}\0${prop}`;
          const encoded = JSON.stringify(value);
          if (appliedLayoutRef.current.get(cacheKey) === encoded) continue;
          appliedLayoutRef.current.set(cacheKey, encoded);
          map.setLayoutProperty(layerId, prop, value);
        }
      }

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      stopped = true;
      window.cancelAnimationFrame(rafId);
    };
  }, [timeline]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        minHeight: '300px',
        position: 'relative',
      }}
    />
  );
}

