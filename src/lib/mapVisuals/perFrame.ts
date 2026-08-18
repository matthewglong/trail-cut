// Top-level per-frame entry point. Composes camera + per-frame sources +
// paints into a single `PerFrameState` that the consumer applies. Pure in
// (timeline, projectTimeMs, activeClipId, indexedRoute, clips, mapSettings,
// viewport) — same inputs always produce the same output.
//
// Preview/export parity contract: this function is the single source of
// truth for what the map looks like at project-time `t`. Both the preview
// (per animation frame) and the export sampler (per output frame) call
// it with the playhead's actual `t` and apply the result directly — no
// smoothing, no lookahead, no `easeTo` interpolation in the apply step.
// Any time-based curve (e.g. transition arcs) lives inside `cameraAt`
// itself, where both pipelines see it.

import type {
  Clip,
  MapSettings,
  PovSettings,
  TransitionSettings,
  TravelSettings,
  Waypoint,
} from '../../types';
import {
  resolveMapSettings,
  travelDrawRoute,
  travelShowPlayhead,
  travelSync,
} from '../../types';
import {
  cameraAt,
  easeInOut,
  findTransitionSpanAt,
  resolveIntent,
  withDisplayScale,
  type CompiledTimeline,
  type TransitionSpan,
  type Viewport,
} from '../cameraIntent';
import {
  distanceAtWallClock,
  locationAt,
  wallClockAtDistance,
  type IndexedRoute,
} from '../routeLocation';
import {
  buildPerFrameSourceData,
  pickActiveWaypoint,
  type WallClockTrace,
} from './sources';
import { buildPerFramePaints } from './paints';
import {
  EASE_MAX_PHASE_MS,
  seamEnvelopeAt,
  type EaseEnvelope,
  type SeamInstant,
} from './animations';
import {
  haloCompositesFor,
  povStyleTuples,
  routeTrailVisibilityTuples,
  PAINT_REFERENCE_WIDTH,
} from './styleSpec';
import type { PerFrameState } from './types';

/** Project-time → wall-clock translation for the live marker and slime
 *  trail. Lifted verbatim from MapView.tsx's `markerTrace` useMemo so the
 *  marker tracks exactly the same position pre/post-refactor.
 *
 *  Three branches, in priority order:
 *    1. `t` past the end of the timeline → hold the last clip's terminal
 *       wall-clock (mediaOut).
 *    2. `t` inside any clip span → translate project-time → clip-local →
 *       wall-clock via the span's `speed` and `wallClockBaseMs`. This
 *       branch wins over a transition's pre-cut interval: the pre-cut
 *       region is contained inside the source clip's `[startMs, endMs)`,
 *       so the source clip's live position shows right up to the cut.
 *    3. `t` inside a transition's post-cut half (source media has ended
 *       but the camera arc is still landing) → hold the source clip's
 *       terminal position. Caught by the `transitionSpans` scan.
 *
 *  Returns null for empty timelines, negative `t`, or for `t` past the end
 *  with no clip spans (impossible if the totalDuration check above caught
 *  it, but defensive). */
function wallClockTrace(
  projectTimeMs: number | null,
  timeline: CompiledTimeline,
): WallClockTrace | null {
  if (projectTimeMs == null) return null;
  if (projectTimeMs < 0) return null;
  if (timeline.clipSpans.length === 0) return null;

  if (projectTimeMs >= timeline.totalDurationMs) {
    const last = timeline.clipSpans[timeline.clipSpans.length - 1];
    return {
      wallMs: last.wallClockBaseMs + last.mediaOutMs,
      clipId: last.clipId,
    };
  }

  for (let i = 0; i < timeline.clipSpans.length; i++) {
    const span = timeline.clipSpans[i];
    const isLast = i === timeline.clipSpans.length - 1;
    const inside =
      projectTimeMs >= span.startMs &&
      (isLast ? projectTimeMs <= span.endMs : projectTimeMs < span.endMs);
    if (inside) {
      const clipLocalMs =
        (projectTimeMs - span.startMs) * span.speed + span.mediaInMs;
      return {
        wallMs: span.wallClockBaseMs + clipLocalMs,
        clipId: span.clipId,
      };
    }
  }

  for (const ts of timeline.transitionSpans) {
    if (ts.effectiveDurationMs <= 0) continue;
    if (ts.fromClipId == null) continue;
    if (projectTimeMs >= ts.cutMs && projectTimeMs <= ts.endMs) {
      const prev = timeline.clipSpans.find((s) => s.clipId === ts.fromClipId);
      if (!prev) return null;
      return {
        wallMs: prev.wallClockBaseMs + prev.mediaOutMs,
        clipId: prev.clipId,
      };
    }
  }

  return null;
}

/** Below this much ground distance between the travel endpoints the window
 *  is treated as stationary and the wall-clock lerps directly in time —
 *  a distance-parameterized inversion would divide by ~0. */
const STATIONARY_WINDOW_METERS = 0.5;

/** The live travel state at `t`: the synthesized marker trace plus the
 *  governing travel settings, or null when no travel animation is active.
 *  Checked BEFORE `wallClockTrace` by `buildPerFrameState`, so travel wins
 *  over the clip-span branch inside the window; every bail-out below falls
 *  through to `wallClockTrace`'s existing branches (the pre-travel teleport
 *  behavior) — travel must never introduce a NEW boundary teleport, so it
 *  only engages when both endpoints resolve on the GPX route. */
interface TravelState {
  trace: WallClockTrace;
  travel: TravelSettings;
  /** The full POV-style block the traveling playhead wears for the whole
   *  window: the DESTINATION clip's resolved `pov` when synced (no
   *  mid-flight style flip at the cut — destination owns the window,
   *  CANON §2.9), or the travel block's custom `playhead` style when
   *  unsynced (defensively falling back to the destination's pov if the
   *  custom block is absent). */
  effectivePov: PovSettings;
}

/** The t-independent classification of one transition span: is it a LIVE
 *  travel window, and if so with what governing config and wall-clock
 *  anchors? Shared by `travelTraceAt` (which adds the eased position) and
 *  the seam-ease instant builder (which needs to know whether a seam
 *  teleports at the cut or style-swaps at the window edges) — ONE
 *  predicate, so the two can never disagree about whether a seam travels. */
interface TravelWindow {
  travel: TravelSettings;
  /** See `TravelState.effectivePov`. */
  effectivePov: PovSettings;
  wallA: number;
  wallB: number;
}

function classifyTravelWindow(
  ts: TransitionSpan | null | undefined,
  timeline: CompiledTimeline,
  indexedRoute: IndexedRoute | null,
  clips: Clip[],
  projectMapSettings: MapSettings,
): TravelWindow | null {
  if (indexedRoute == null) return null;
  // Project-start transitions (fromClipId null) have no travel origin;
  // zero-width windows have no room to animate (and would divide by zero).
  if (!ts || ts.fromClipId == null) return null;
  if (ts.endMs - ts.startMs <= 0) return null;

  // DESTINATION clip owns the window: the transition "into" a clip belongs
  // to that clip, so its resolved travel settings — and, when synced, its
  // resolved POV look — govern end to end (no mid-flight flips at the
  // cut). The full resolve (not just an atomic transition coalesce) is
  // needed because sync mode dresses the traveling playhead in the
  // destination's complete POV style.
  const toClip = clips.find((c) => c.id === ts.toClipId);
  const resolvedDest = resolveMapSettings(
    projectMapSettings,
    toClip?.map_overrides,
  );
  const travel = resolvedDest.transition?.travel;
  if (!travel?.enabled) return null;

  const fromSpan = timeline.clipSpans.find((s) => s.clipId === ts.fromClipId);
  const toSpan = timeline.clipSpans.find((s) => s.clipId === ts.toClipId);
  if (!fromSpan || !toSpan) return null;

  // Anchor the travel at the wall-clocks the playhead actually occupies at
  // the window edges — the SAME convention as the camera arc
  // (`evaluateTransitionSpan` in cameraIntent.ts): the source clip is still
  // playing until the cut and the destination has already played
  // `endMs - cutMs` by window exit, so mediaOut/mediaIn would travel
  // to/from positions the playhead never shows, producing a visible jolt
  // at the window edges. These endpoints make the marker continuous at
  // both edges by construction.
  const wallA =
    fromSpan.wallClockBaseMs +
    fromSpan.mediaInMs +
    (ts.startMs - fromSpan.startMs) * fromSpan.speed;
  const wallB =
    toSpan.wallClockBaseMs +
    toSpan.mediaInMs +
    (ts.endMs - toSpan.startMs) * toSpan.speed;

  // Both endpoints must resolve on the GPX route (in range, no over-gap
  // hole) or we skip travel entirely rather than animate between a
  // fallback-GPS position and a route position.
  if (
    locationAt(wallA, indexedRoute, null) == null ||
    locationAt(wallB, indexedRoute, null) == null
  ) {
    return null;
  }

  return {
    travel,
    effectivePov:
      !travelSync(travel) && travel.playhead
        ? travel.playhead
        : resolvedDest.pov,
    wallA,
    wallB,
  };
}

function travelTraceAt(
  projectTimeMs: number | null,
  timeline: CompiledTimeline,
  indexedRoute: IndexedRoute | null,
  clips: Clip[],
  projectMapSettings: MapSettings,
): TravelState | null {
  if (projectTimeMs == null || projectTimeMs < 0) return null;

  const ts = findTransitionSpanAt(timeline.transitionSpans, projectTimeMs);
  // Re-checked here (classify also guards) so TypeScript narrows the types
  // the position math below relies on.
  if (!ts || ts.fromClipId == null || indexedRoute == null) return null;
  const win = classifyTravelWindow(
    ts,
    timeline,
    indexedRoute,
    clips,
    projectMapSettings,
  );
  if (!win) return null;
  const { travel, effectivePov, wallA, wallB } = win;

  // Eased fraction — the identical curve the camera arc rides, so the
  // marker and the camera accelerate/decelerate together.
  const lengthMs = ts.endMs - ts.startMs;
  const rawLocalT = (projectTimeMs - ts.startMs) / lengthMs;
  const localT = rawLocalT < 0 ? 0 : rawLocalT > 1 ? 1 : rawLocalT;
  const u = easeInOut(localT, timeline.transitionFeel);

  // Distance-parameterized travel: constant eased GROUND speed along the
  // route, regardless of how fast the hiker actually covered the stretch
  // (time-linear travel would replay the hiker's pace — imperceptible over
  // a long real-time gap, absurd over a short one). One synthesized
  // wall-clock then drives marker position, trail head, gradient progress,
  // and waypoint activation consistently through the existing consumers.
  const dA = distanceAtWallClock(wallA, indexedRoute);
  const dB = distanceAtWallClock(wallB, indexedRoute);
  let wallMs: number;
  if (Math.abs(dB - dA) < STATIONARY_WINDOW_METERS) {
    // Stationary window (clips shot at the same spot): plain time-lerp.
    wallMs = wallA + u * (wallB - wallA);
  } else {
    wallMs = wallClockAtDistance(dA + u * (dB - dA), indexedRoute);
    // `wallClockAtDistance` returns the EARLIEST time at a distance, which
    // on a stationary plateau can precede wallA (u=0) or wallB (u=1).
    // Clamp into the window's wall-clock range so time-keyed state (trail,
    // gradient, waypoint activation) can't jump at the window edges — the
    // POSITION is identical either way. Backward travel (non-chronological
    // clips, wallB < wallA) works unchanged via min/max.
    const lo = Math.min(wallA, wallB);
    const hi = Math.max(wallA, wallB);
    wallMs = wallMs < lo ? lo : wallMs > hi ? hi : wallMs;
  }

  return {
    trace: {
      wallMs,
      // Matches `activeClipIdAt`: source until the cut, destination after —
      // preserves today's GPS-fallback and marker `clipId` property
      // semantics at both boundary instants.
      clipId: projectTimeMs < ts.cutMs ? ts.fromClipId : ts.toClipId,
    },
    travel,
    effectivePov,
  };
}

/** Resolve one clip's effective TRANSITION block — the atomic coalesce
 *  `resolveMapSettings` performs for the `transition` field, extracted so
 *  the seam-instant builder doesn't pay for a full settings resolve per
 *  neighboring clip per frame. */
function transitionOf(
  clip: Clip | undefined,
  projectMapSettings: MapSettings,
): TransitionSettings | undefined {
  return clip?.map_overrides?.transition ?? projectMapSettings.transition;
}

/** Seam-ease instants whose phases could touch project-time `t`. Each
 *  instant marks a place the marker visually jumps or swaps style:
 *
 *  - NON-traveled seam (travel off / bailed / zero window): the teleport at
 *    `cutMs` — out-phase = the SOURCE clip's `ease_out`, in-phase = the
 *    DESTINATION clip's `ease_in` (two clips, two behaviors — per-clip
 *    resolution doing its normal job).
 *  - TRAVELED seam: position is continuous but the STYLE swaps at the two
 *    window edges. Entry (clip marker → traveling marker) is one visual
 *    crossfade governed by the source's `ease_out` on both phases; exit
 *    (traveling marker → clip marker) by the destination's `ease_in`. The
 *    ease layer STACKS onto travel — one envelope mechanism decorating
 *    every discontinuity, never a second animation system.
 *  - Project start / end: the first clip's `ease_in` at t = 0, the last
 *    clip's `ease_out` at `totalDurationMs`.
 *
 *  The horizon prefilter (`EASE_MAX_PHASE_MS`) skips spans whose phases
 *  can't overlap `t`, so steady-state frames resolve nothing. */
function seamInstantsNear(
  t: number,
  timeline: CompiledTimeline,
  indexedRoute: IndexedRoute | null,
  clips: Clip[],
  projectMapSettings: MapSettings,
): SeamInstant[] {
  const out: SeamInstant[] = [];
  const clipById = (id: string | null | undefined) =>
    id == null ? undefined : clips.find((c) => c.id === id);
  const push = (inst: SeamInstant) => {
    if (inst.out || inst.in) out.push(inst);
  };

  for (const ts of timeline.transitionSpans) {
    if (t < ts.startMs - EASE_MAX_PHASE_MS || t > ts.endMs + EASE_MAX_PHASE_MS) {
      continue;
    }
    const destTransition = transitionOf(clipById(ts.toClipId), projectMapSettings);
    if (ts.fromClipId == null) {
      // Project start: the marker exists from the first frame — the first
      // clip's ease_in plays over the opening D ms.
      push({ t: 0, in: destTransition?.ease_in });
      continue;
    }
    const srcTransition = transitionOf(clipById(ts.fromClipId), projectMapSettings);
    const traveled =
      classifyTravelWindow(ts, timeline, indexedRoute, clips, projectMapSettings) != null;
    if (traveled) {
      push({ t: ts.startMs, out: srcTransition?.ease_out, in: srcTransition?.ease_out });
      push({ t: ts.endMs, out: destTransition?.ease_in, in: destTransition?.ease_in });
    } else {
      push({ t: ts.cutMs, out: srcTransition?.ease_out, in: destTransition?.ease_in });
    }
  }

  // Project end: the last clip's ease_out plays over the closing D ms.
  const lastSpan = timeline.clipSpans[timeline.clipSpans.length - 1];
  if (lastSpan && t > timeline.totalDurationMs - EASE_MAX_PHASE_MS) {
    push({
      t: timeline.totalDurationMs,
      out: transitionOf(clipById(lastSpan.clipId), projectMapSettings)?.ease_out,
    });
  }

  return out;
}

/** Scale a POV style block's size-like values by the envelope's scale —
 *  every field is linear in the rendered footprint (dot/stroke/icon/pulse
 *  radii; halo body follows via `pov.size`, halo SPREAD via `halo.size`).
 *  Halo offsets are deliberately untouched (screen-space placement, not
 *  footprint). */
function scalePovStyle(pov: PovSettings, scale: number): PovSettings {
  return {
    ...pov,
    size: {
      pulse_radius: pov.size.pulse_radius * scale,
      dot_radius: pov.size.dot_radius * scale,
      dot_stroke_width: pov.size.dot_stroke_width * scale,
      pulse_start_radius: pov.size.pulse_start_radius * scale,
      pulse_end_radius: pov.size.pulse_end_radius * scale,
      image_size: pov.size.image_size * scale,
    },
    halo: pov.halo ? { ...pov.halo, size: pov.halo.size * scale } : pov.halo,
  };
}

/** Compose a single per-frame snapshot. Both renderer and preview call
 *  this and consume the result directly.
 *
 *  `viewport` is the REFERENCE-SPACE viewport intents resolve against — the
 *  aspect's canonical map-slot CSS dims on both surfaces (the renderer's
 *  cssViewport; `canonicalSlotCss` preview-side), never the live pane.
 *  `surfaceScale` is the consuming surface's CSS-px-per-reference-unit
 *  factor: the renderer omits it (scale 1 — camera and paints come back
 *  byte-identical to the pre-scale behavior), the preview passes its fixed
 *  `previewDisplayScale`. The returned camera carries the `+ log2(scale)`
 *  display offset and the returned paints the matching `× scale`, so a
 *  consumer just applies the snapshot — decoration ground footprints and
 *  geographic framing then agree across surfaces by construction.
 *
 *  Camera: `cameraAt(timeline, projectTimeMs)` → `resolveIntent(intent,
 *  viewport)` → `withDisplayScale(camera, surfaceScale)`.
 *
 *  Sources: `route-trail`, `live-marker`, and (when `waypoints_mode ===
 *  'visited'`) `waypoints`. See `buildPerFrameSourceData` for the
 *  visibility predicate.
 *
 *  Paints: data-driven highlight expressions on the waypoint primary +
 *  secondary symbol layers keyed off the active waypoint id, plus pulse
 *  values for `live-marker-pulse`. Sizes anchor to `PAINT_REFERENCE_WIDTH`
 *  (1080 CSS px) × the relevant `mapSettings.waypoints.size.*` fraction,
 *  normalized by `SHAPE_CANONICAL_RADIUS` for the icon-size space.
 *  See `buildPerFramePaints` for details. */
export function buildPerFrameState(
  timeline: CompiledTimeline,
  projectTimeMs: number,
  indexedRoute: IndexedRoute | null,
  clips: Clip[],
  waypoints: Waypoint[],
  mapSettings: MapSettings,
  projectMapSettings: MapSettings,
  viewport: Viewport,
  surfaceScale: number = 1,
): PerFrameState {
  const intent = cameraAt(timeline, projectTimeMs);
  const camera = withDisplayScale(resolveIntent(intent, viewport), surfaceScale);

  // Travel first: inside an enabled travel window the synthesized trace
  // wins over the clip-span branch; any travel bail-out falls through to
  // the pre-travel behavior. `mapSettings` is the ACTIVE-resolved settings
  // (whichever clip owns the frame for colors/sizes); the travel DECISION
  // resolves against the project base + the DESTINATION clip inside
  // `travelTraceAt`, which is why both are parameters.
  const travelState = travelTraceAt(
    projectTimeMs,
    timeline,
    indexedRoute,
    clips,
    projectMapSettings,
  );
  const trace = travelState
    ? travelState.trace
    : wallClockTrace(projectTimeMs, timeline);

  // Travel toggles (normalized absent-as-default reads). Outside a window
  // everything collapses to the identity behavior: marker shown, trail on
  // the same clock as the marker, no forcing.
  const showPlayhead = travelState
    ? travelShowPlayhead(travelState.travel)
    : true;
  const drawRoute = travelState ? travelDrawRoute(travelState.travel) : true;
  // Trail clock: with `draw_route` the trail head rides the SAME
  // synthesized clock as the traveling playhead; without it the trail
  // keeps the pre-travel clock (advances with the source clip until the
  // cut, holds through the post-cut half, snaps at window exit — exactly
  // the travel-disabled behavior), so only the playhead travels.
  const trailTrace =
    travelState && !drawRoute
      ? wallClockTrace(projectTimeMs, timeline)
      : trace;
  // Force the trail during a draw-route window while the route decoration
  // is 'none' — "draw the route along with it" even when the route is
  // otherwise hidden. 'visited' already follows (no force needed) and
  // 'full' already shows the whole line (nothing to draw).
  const forceTrail =
    travelState != null && drawRoute && mapSettings.route.mode === 'none';

  const sources = buildPerFrameSourceData({
    markerTrace: trace,
    trailTrace,
    forceTrail,
    // `show_playhead: false` empties the live-marker source for the window
    // — every marker-stack layer (dot/shape/image, pulse rings, halo pair)
    // renders from it, so one empty collection hides them all and the next
    // out-of-window frame restores them.
    hideMarker: travelState != null && !showPlayhead,
    indexedRoute,
    clips,
    waypoints,
    mapSettings,
    timeline,
    projectTimeMs,
  });

  // Active waypoint is now derived from the marker trace + the
  // `active_waypoint_mode` setting (replaces the prior `activeClipId` →
  // waypoint mapping). When mode is 'none' or no waypoint has been passed
  // yet, this is null and `buildPerFramePaints` returns scalar defaults.
  const activeWaypointId = pickActiveWaypoint(waypoints, trace, mapSettings);
  // Active waypoint's position in the `waypoints` array — same value the
  // GeoJSON `index` property carries on each feature. Used by
  // `buildPerFramePaints` to build the `symbol-sort-key` expression
  // (`-|index - activeIndex|`). Null when no active id, or when the id
  // doesn't resolve to a current waypoint (defensive — shouldn't happen
  // since `pickActiveWaypoint` returns ids from this same array).
  const activeWaypointIndex =
    activeWaypointId == null
      ? null
      : (() => {
          const i = waypoints.findIndex((w) => w.id === activeWaypointId);
          return i < 0 ? null : i;
        })();
  // Seam-ease envelope — the Transition decoration's ease_in/ease_out as
  // one multiplicative {scale, opacity} LAYER over the whole marker stack,
  // anchored wherever the marker jumps or swaps style (see
  // `seamInstantsNear`). Identity everywhere no ease is configured, so the
  // default is byte-identical to pre-ease output.
  const envelope: EaseEnvelope = seamEnvelopeAt(
    projectTimeMs,
    seamInstantsNear(
      projectTimeMs,
      timeline,
      indexedRoute,
      clips,
      projectMapSettings,
    ),
  );

  // Travel-effective style: inside a live travel window the traveling
  // playhead wears `travelState.effectivePov` (the destination clip's
  // resolved POV when synced; the custom `travel.playhead` block when
  // not); every other frame uses the active clip's own POV. The ease
  // envelope's SCALE is folded into the style block itself (every size
  // field is linear), so the pulse animation, the marker identity, the
  // colors/sizes, and the halo (composite included) all flow through ONE
  // settings object and can never mix configs.
  const basePov = travelState ? travelState.effectivePov : mapSettings.pov;
  const easedPov =
    envelope.scale === 1 ? basePov : scalePovStyle(basePov, envelope.scale);
  const effectiveSettings: MapSettings =
    easedPov === mapSettings.pov
      ? mapSettings
      : { ...mapSettings, pov: easedPov };

  const paints = buildPerFramePaints(
    activeWaypointId,
    activeWaypointIndex,
    projectTimeMs,
    effectiveSettings,
    surfaceScale,
  );
  // Envelope OPACITY rides the marker stack's existing opacity channels:
  // `dotOpacity` (which every marker-body layer consumes), the pulse-ring
  // opacities, and — below — the live-marker halo composite's group
  // opacity. `paints` is freshly built above, so in-place adjustment is
  // safe.
  if (envelope.opacity !== 1) {
    paints.dotOpacity *= envelope.opacity;
    paints.pulseOpacity *= envelope.opacity;
    paints.pulseOpacityB *= envelope.opacity;
  }

  // Per-frame POV style buckets (paints + layouts + composite). Outside a
  // travel window / ease phase these equal `resolveStaticPaints`' tuples
  // exactly, so consumers restore automatically — there is no entry/exit
  // handshake to desynchronize. The layouts bucket additionally carries
  // the route-trail visibility trio so `draw_route` can force the trail
  // during a window (equal to the static emission whenever `forceTrail`
  // is false).
  const povStyle = povStyleTuples(
    effectiveSettings.pov,
    effectiveSettings.marker_images ?? [],
    PAINT_REFERENCE_WIDTH * surfaceScale,
  );
  const layouts = [
    ...povStyle.layouts,
    ...routeTrailVisibilityTuples(mapSettings.route, forceTrail),
  ];
  const haloComposites = haloCompositesFor(effectiveSettings).map((g) =>
    envelope.opacity !== 1 && g.layers[0] === 'live-marker-halo'
      ? { ...g, opacity: g.opacity * envelope.opacity }
      : g,
  );

  return {
    camera,
    sources,
    paints,
    layouts,
    povPaints: povStyle.paints,
    haloComposites,
  };
}
