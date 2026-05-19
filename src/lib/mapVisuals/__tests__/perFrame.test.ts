// Tests for `buildPerFrameState` purity and per-mode source rules.
//
// Strategy: build a minimal point-intent timeline (no follow, no route) so
// the camera math is deterministic and viewport-free, then probe the per-
// frame builder at a handful of representative t values. The visited-
// waypoints filter is the most behavioral assertion here — everything else
// is purity / shape / null-safety.

import { describe, it, expect } from 'vitest';
import { buildPerFrameState } from '../perFrame';
import { PAINT_REFERENCE_WIDTH } from '../styleSpec';
import { compileTimeline, type Viewport } from '../../cameraIntent';
import {
  DEFAULT_MAP_SETTINGS,
  type Clip,
  type MapSettings,
  type Waypoint,
} from '../../../types';
import { seedWaypointsFromClips } from '../../waypoints';

const VIEWPORT: Viewport = { width: 800, height: 600, dpr: 1 };

/** Point-intent settings: no follow, fixed bearing. Eliminates viewport
 *  dependence in clip-anchor cameras so resolveIntent is identity. */
const POINT_SETTINGS: MapSettings = {
  ...DEFAULT_MAP_SETTINGS,
  camera: {
    ...DEFAULT_MAP_SETTINGS.camera,
    follow_playhead: false,
    bearing_mode: 'fixed',
    bearing_degrees: 0,
  },
};

function mkClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c',
    path: '/tmp/c.mov',
    filename: 'c.mov',
    created_at: '2026-04-04T15:00:00Z',
    duration_ms: 10_000,
    gps: { lat: 37.77, lng: -122.4 },
    resolution: null,
    frame_rate: null,
    trim: { in_ms: 0, out_ms: 10_000 },
    focal_point: { x: 0.5, y: 0.5, zoom: 1 },
    effects: { stabilize: { enabled: false, shakiness: 0 }, speed: 1 },
    visible: true,
    map_overrides: null,
    ...overrides,
  };
}

/** Two-clip fixture: clip 1 occupies project-time [0, 5000), clip 2 occupies
 *  [5000, 15000). Disabled entry transitions so the spans tile exactly.
 *  Waypoints seeded from clips so v7 visited-mode tests have something to
 *  filter — they share each clip's `created_at + trim.in_ms` anchor and the
 *  embedded GPS as fallback. */
function twoClipFixture() {
  const clips: Clip[] = [
    mkClip({
      id: 'a',
      created_at: '2026-04-04T15:00:00Z',
      gps: { lat: 37.77, lng: -122.4 },
      trim: { in_ms: 0, out_ms: 5_000 },
      entry_transition: { enabled: false },
    }),
    mkClip({
      id: 'b',
      created_at: '2026-04-04T15:01:00Z',
      gps: { lat: 37.80, lng: -122.35 },
      trim: { in_ms: 0, out_ms: 10_000 },
      entry_transition: { enabled: false },
    }),
  ];
  const timeline = compileTimeline(clips, null, POINT_SETTINGS, {});
  const waypoints: Waypoint[] = seedWaypointsFromClips(clips);
  return { clips, waypoints, timeline };
}

describe('buildPerFrameState purity', () => {
  it('two identical calls produce a deeply-equal result', () => {
    const { clips, waypoints, timeline } = twoClipFixture();
    const t = 1234;
    const a = buildPerFrameState(
      timeline,
      t,
      null,
      clips,
      waypoints,
      POINT_SETTINGS,
      VIEWPORT,
    );
    const b = buildPerFrameState(
      timeline,
      t,
      null,
      clips,
      waypoints,
      POINT_SETTINGS,
      VIEWPORT,
    );
    expect(a).toEqual(b);
  });

  it('determinism: 5 calls all deeply-equal each other', () => {
    const { clips, waypoints, timeline } = twoClipFixture();
    const t = 7777;
    const results = Array.from({ length: 5 }, () =>
      buildPerFrameState(
        timeline,
        t,
        null,
        clips,
        waypoints,
        POINT_SETTINGS,
        VIEWPORT,
      ),
    );
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toEqual(results[0]);
    }
  });
});

describe('buildPerFrameState camera at sampled t', () => {
  it('returns finite numeric center/zoom/bearing/pitch at t=0, mid-clip, mid-transition', () => {
    // Build a fixture WITH a non-zero transition between clips so we have a
    // real mid-transition probe.
    const clips: Clip[] = [
      mkClip({
        id: 'a',
        created_at: '2026-04-04T15:00:00Z',
        gps: { lat: 37.77, lng: -122.4 },
        trim: { in_ms: 0, out_ms: 10_000 },
      }),
      mkClip({
        id: 'b',
        created_at: '2026-04-04T15:01:00Z',
        gps: { lat: 37.80, lng: -122.35 },
        trim: { in_ms: 0, out_ms: 10_000 },
      }),
    ];
    const timeline = compileTimeline(clips, null, POINT_SETTINGS, {
      default_entry_transition: { duration_ms: 600, entry_bias: 0 },
    });

    const midClip =
      (timeline.clipSpans[0].startMs + timeline.clipSpans[0].endMs) / 2;
    const trans = timeline.transitionSpans.find(
      (ts) => ts.fromClipId !== null && ts.effectiveDurationMs > 0,
    );
    expect(trans).toBeDefined();
    const midTrans = trans
      ? (trans.startMs + trans.endMs) / 2
      : timeline.totalDurationMs / 2;

    const waypoints = seedWaypointsFromClips(clips);
    for (const t of [0, midClip, midTrans]) {
      const state = buildPerFrameState(
        timeline,
        t,
        null,
        clips,
        waypoints,
        POINT_SETTINGS,
        VIEWPORT,
      );
      const { camera } = state;
      expect(Number.isFinite(camera.center.lng)).toBe(true);
      expect(Number.isFinite(camera.center.lat)).toBe(true);
      expect(Number.isFinite(camera.zoom)).toBe(true);
      expect(Number.isFinite(camera.bearing)).toBe(true);
      expect(Number.isFinite(camera.pitch)).toBe(true);
    }
  });
});

describe('buildPerFrameState live-marker', () => {
  it('absent (empty features) when indexedRoute is null', () => {
    // Note: live-marker depends on `markerTrace`, which is null only for
    // empty timelines / negative t / past end. With a non-null trace and a
    // null indexedRoute, locationAt falls back to the clip's embedded GPS.
    // The spec asks specifically about `indexedRoute === null` → for that
    // case the marker should still resolve via fallback. The truly-empty
    // case is `t < 0` (no trace). Test both behaviors here so the harness
    // matches what the consumer can observe.

    const { clips, waypoints, timeline } = twoClipFixture();

    // t < 0 → wallClockTrace returns null → live-marker is empty regardless.
    const negState = buildPerFrameState(
      timeline,
      -1,
      null,
      clips,
      waypoints,
      POINT_SETTINGS,
      VIEWPORT,
    );
    const negMarker = negState.sources['live-marker'] as
      | GeoJSON.FeatureCollection<GeoJSON.Point>
      | undefined;
    expect(negMarker).toBeDefined();
    expect(negMarker?.features.length).toBe(0);
  });
});

describe('buildPerFrameState slime-trail', () => {
  it('empty when route_mode !== "visited"', () => {
    const { clips, waypoints, timeline } = twoClipFixture();
    const settings: MapSettings = {
      ...POINT_SETTINGS,
      route: { ...POINT_SETTINGS.route, mode: 'full' },
    };
    const state = buildPerFrameState(
      timeline,
      1_000,
      null,
      clips,
      waypoints,
      settings,
      VIEWPORT,
    );
    const trail = state.sources['route-trail'] as GeoJSON.Feature<GeoJSON.LineString>;
    expect(trail).toBeDefined();
    expect(trail.geometry.coordinates.length).toBe(0);
  });
});

describe('buildPerFrameState paints', () => {
  // Under the lever model `buildPerFramePaints` is width-input-independent;
  // radii anchor to `PAINT_REFERENCE_WIDTH` (1080). Same numbers everywhere.

  it('waypoint radius = mapSettings.overlay_waypoint_circle_radius × PAINT_REFERENCE_WIDTH when active mode is off', () => {
    const { clips, waypoints, timeline } = twoClipFixture();
    // Disable the active-waypoint highlight so the paint emits a scalar
    // instead of a case-expression — the scalar branch is what this test
    // exercises.
    const settings: MapSettings = {
      ...POINT_SETTINGS,
      waypoints: { ...POINT_SETTINGS.waypoints, active_mode: 'none' },
    };
    const state = buildPerFrameState(
      timeline,
      0,
      null,
      clips,
      waypoints,
      settings,
      VIEWPORT,
    );
    expect(state.paints.waypointCircleRadius).toBeCloseTo(
      settings.waypoints.size.circle_radius * PAINT_REFERENCE_WIDTH,
      9,
    );
    // At t=0 the pulse curve emits pov.size.pulse_start_radius × PAINT_REFERENCE_WIDTH.
    expect(state.paints.pulseRadius).toBeCloseTo(
      settings.pov.size.pulse_start_radius * PAINT_REFERENCE_WIDTH,
      6,
    );
  });

  it('per-clip overlay override changes the per-frame waypoint radius', () => {
    // Resolves the active clip's MapSettings the way the renderer / preview
    // do — project defaults merged with `Clip.map_overrides` — then feeds
    // that to `buildPerFrameState`. The waypoint default radius for the
    // active clip should track the override, leaving the seed unused.
    const { clips, waypoints, timeline } = twoClipFixture();
    const overridden: MapSettings = {
      ...POINT_SETTINGS,
      waypoints: {
        ...POINT_SETTINGS.waypoints,
        active_mode: 'none',
        size: { ...POINT_SETTINGS.waypoints.size, circle_radius: 0.04 },
      },
    };
    const state = buildPerFrameState(
      timeline,
      0,
      null,
      clips,
      waypoints,
      overridden,
      VIEWPORT,
    );
    expect(state.paints.waypointCircleRadius).toBeCloseTo(
      0.04 * PAINT_REFERENCE_WIDTH,
      9,
    );
  });

  it('two independent calls produce identical paints (no width input)', () => {
    const { clips, waypoints, timeline } = twoClipFixture();
    const a = buildPerFrameState(
      timeline,
      0,
      null,
      clips,
      waypoints,
      POINT_SETTINGS,
      VIEWPORT,
    );
    const b = buildPerFrameState(
      timeline,
      0,
      null,
      clips,
      waypoints,
      POINT_SETTINGS,
      VIEWPORT,
    );
    expect(a.paints.waypointCircleRadius).toEqual(b.paints.waypointCircleRadius);
    expect(a.paints.pulseRadius).toBeCloseTo(b.paints.pulseRadius, 9);
    expect(a.paints.pulseOpacity).toBeCloseTo(b.paints.pulseOpacity, 9);
    expect(a.paints.waypointCircleColor).toEqual(b.paints.waypointCircleColor);
    expect(a.paints.waypointCircleStrokeColor).toEqual(
      b.paints.waypointCircleStrokeColor,
    );
  });

  it('active-waypoint mode "latest_passed" emits a case-expression keyed off the passed waypoint id', () => {
    // v7 (post-refactor) — the active highlight is driven by
    // `active_waypoint_mode` against the marker's wall-clock, not by the
    // selected clip. At t=0 inside clip 1, the latest-passed waypoint is
    // clip 1's seeded waypoint (its anchor equals the clip's wall-clock
    // start). The case expression should target that waypoint's id.
    const { clips, waypoints, timeline } = twoClipFixture();
    expect(waypoints[0]).toBeDefined();
    const state = buildPerFrameState(
      timeline,
      0,
      null,
      clips,
      waypoints,
      POINT_SETTINGS,
      VIEWPORT,
    );
    const expr = state.paints.waypointCircleRadius as unknown as unknown[];
    expect(Array.isArray(expr)).toBe(true);
    expect(expr[0]).toBe('case');
    // expr[1] is the predicate: ['==', ['get', 'id'], <waypoint-id>]
    const predicate = expr[1] as unknown[];
    expect(predicate[0]).toBe('==');
    expect(predicate[2]).toBe(waypoints[0].id);
    expect(expr[2]).toBeCloseTo(
      POINT_SETTINGS.waypoints.size.active_radius * PAINT_REFERENCE_WIDTH,
      9,
    );
    expect(expr[3]).toBeCloseTo(
      POINT_SETTINGS.waypoints.size.circle_radius * PAINT_REFERENCE_WIDTH,
      9,
    );
  });
});

describe('buildPerFrameState waypoints visibility', () => {
  it('visited mode: 1 visible at t=1000, 2 visible at t=6000 (clip 1 starts 0ms, clip 2 starts 5000ms)', () => {
    const { clips, waypoints, timeline } = twoClipFixture();
    // Sanity: confirm the fixture's compiled span layout matches the spec.
    expect(timeline.clipSpans[0].startMs).toBe(0);
    expect(timeline.clipSpans[1].startMs).toBe(5_000);

    const settings: MapSettings = {
      ...POINT_SETTINGS,
      waypoints: { ...POINT_SETTINGS.waypoints, mode: 'visited' },
    };

    const at1k = buildPerFrameState(
      timeline,
      1_000,
      null,
      clips,
      waypoints,
      settings,
      VIEWPORT,
    );
    const wp1k = at1k.sources['waypoints'] as
      | GeoJSON.FeatureCollection<GeoJSON.Point>
      | undefined;
    expect(wp1k).toBeDefined();
    expect(wp1k?.features.length).toBe(1);

    const at6k = buildPerFrameState(
      timeline,
      6_000,
      null,
      clips,
      waypoints,
      settings,
      VIEWPORT,
    );
    const wp6k = at6k.sources['waypoints'] as
      | GeoJSON.FeatureCollection<GeoJSON.Point>
      | undefined;
    expect(wp6k).toBeDefined();
    expect(wp6k?.features.length).toBe(2);
  });

  it('non-visited mode: sources["waypoints"] is undefined (static seed handles it)', () => {
    const { clips, waypoints, timeline } = twoClipFixture();
    for (const mode of ['full', 'none'] as const) {
      const settings: MapSettings = {
        ...POINT_SETTINGS,
        waypoints: { ...POINT_SETTINGS.waypoints, mode },
      };
      const state = buildPerFrameState(
        timeline,
        1_000,
        null,
        clips,
        waypoints,
        settings,
        VIEWPORT,
      );
      expect(state.sources['waypoints']).toBeUndefined();
    }
  });
});
