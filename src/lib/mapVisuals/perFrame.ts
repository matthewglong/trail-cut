// Top-level per-frame entry point. Composes camera + per-frame sources +
// paints into a single `PerFrameState` that the consumer applies. Pure in
// (timeline, projectTimeMs, activeClipId, indexedRoute, clips, mapSettings,
// viewport) — same inputs always produce the same output.
//
// IMPORTANT for preview/export parity: the caller is responsible for any
// project-time offset (e.g. preview's ease-loop "lookahead = duration"
// trick). This function evaluates strictly at the supplied
// `projectTimeMs` so the export sampler's frame-by-frame stepping produces
// the exact state the preview shows when the playhead is at that t.

import type { Clip, MapSettings } from '../../types';
import {
  cameraAt,
  resolveIntent,
  type CompiledTimeline,
  type Viewport,
} from '../cameraIntent';
import type { IndexedRoute } from '../routeLocation';
import { buildPerFrameSourceData, type WallClockTrace } from './sources';
import { buildPerFramePaints } from './paints';
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
 *  per-frame; the preview's ease loop calls it per-tick.
 *
 *  Camera: `cameraAt(timeline, projectTimeMs)` → `resolveIntent(intent,
 *  viewport)`. The preview ease loop's lookahead (`t + duration`) is the
 *  caller's responsibility — pass an already-offset `t` if the consumer
 *  wants the lookahead behavior.
 *
 *  Sources: `route-trail`, `live-marker`, and (when `waypoints_mode ===
 *  'visited'`) `waypoints`. See `buildPerFrameSourceData` for the
 *  visibility predicate.
 *
 *  Paints: data-driven highlight on `waypoints-circle` keyed off
 *  `activeClipId` plus pulse values for `live-marker-pulse`. */
export function buildPerFrameState(
  timeline: CompiledTimeline,
  projectTimeMs: number,
  activeClipId: string | null,
  indexedRoute: IndexedRoute | null,
  clips: Clip[],
  mapSettings: MapSettings,
  viewport: Viewport,
): PerFrameState {
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

  const paints = buildPerFramePaints(activeClipId, projectTimeMs);

  return { camera, sources, paints };
}
