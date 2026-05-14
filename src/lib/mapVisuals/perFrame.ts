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

import type { Clip, MapSettings } from '../../types';
import {
  cameraAt,
  resolveIntent,
  type CompiledTimeline,
  type Viewport,
} from '../cameraIntent';
import type { AspectRatio } from '../layout';
import type { IndexedRoute } from '../routeLocation';
import { buildPerFrameSourceData, type WallClockTrace } from './sources';
import {
  buildPerFramePaints,
  buildPerFramePaintsForPreview,
} from './paints';
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

/** Compose a single per-frame snapshot. The export worker calls this
 *  per-frame; the preview's render loop calls `buildPerFrameStateForPreview`
 *  so the paints compose with the pane reshape factor.
 *
 *  Camera: `cameraAt(timeline, projectTimeMs)` → `resolveIntent(intent,
 *  viewport)`.
 *
 *  Sources: `route-trail`, `live-marker`, and (when `waypoints_mode ===
 *  'visited'`) `waypoints`. See `buildPerFrameSourceData` for the
 *  visibility predicate.
 *
 *  Paints: data-driven highlight on `waypoints-circle` keyed off
 *  `activeClipId` plus pulse values for `live-marker-pulse`. Under the lever
 *  model the renderer-side paints anchor to `PAINT_REFERENCE_WIDTH` (1080
 *  CSS px) — no width input is required here. See `buildPerFramePaints` for
 *  details. */
export function buildPerFrameState(
  timeline: CompiledTimeline,
  projectTimeMs: number,
  activeClipId: string | null,
  indexedRoute: IndexedRoute | null,
  clips: Clip[],
  mapSettings: MapSettings,
  viewport: Viewport,
): PerFrameState {
  const { camera, sources } = composeCameraAndSources(
    timeline,
    projectTimeMs,
    indexedRoute,
    clips,
    mapSettings,
    viewport,
  );
  const paints = buildPerFramePaints(activeClipId, projectTimeMs);
  return { camera, sources, paints };
}

/** Preview variant of `buildPerFrameState`. Same camera + sources as the
 *  renderer-side call; paints scale with `paneCssWidth /
 *  canonicalMapCssWidth(aspect)` via `buildPerFramePaintsForPreview` so the
 *  per-frame paints compose with the pane reshape factor exactly like the
 *  static paints from `resolveStaticPaintsForPreview`. See
 *  `MAP_RENDERING_PLAN.md` §"Preview behavior". */
export function buildPerFrameStateForPreview(
  timeline: CompiledTimeline,
  projectTimeMs: number,
  activeClipId: string | null,
  indexedRoute: IndexedRoute | null,
  clips: Clip[],
  mapSettings: MapSettings,
  viewport: Viewport,
  paneCssWidth: number,
  aspect: AspectRatio,
): PerFrameState {
  const { camera, sources } = composeCameraAndSources(
    timeline,
    projectTimeMs,
    indexedRoute,
    clips,
    mapSettings,
    viewport,
  );
  const paints = buildPerFramePaintsForPreview(
    activeClipId,
    projectTimeMs,
    paneCssWidth,
    aspect,
  );
  return { camera, sources, paints };
}

function composeCameraAndSources(
  timeline: CompiledTimeline,
  projectTimeMs: number,
  indexedRoute: IndexedRoute | null,
  clips: Clip[],
  mapSettings: MapSettings,
  viewport: Viewport,
): Pick<PerFrameState, 'camera' | 'sources'> {
  const intent = cameraAt(timeline, projectTimeMs);
  const camera = resolveIntent(intent, viewport);

  const trace = wallClockTrace(projectTimeMs, timeline);

  const sources = buildPerFrameSourceData({
    markerTrace: trace,
    indexedRoute,
    clips,
    mapSettings,
    timeline,
    projectTimeMs,
  });

  return { camera, sources };
}
