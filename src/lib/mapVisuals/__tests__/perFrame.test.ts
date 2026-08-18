// Tests for `buildPerFrameState` purity and per-mode source rules.
//
// Strategy: build a minimal point-intent timeline (no follow, no route) so
// the camera math is deterministic and viewport-free, then probe the per-
// frame builder at a handful of representative t values. The visited-
// waypoints filter is the most behavioral assertion here — everything else
// is purity / shape / null-safety.

import { describe, it, expect } from 'vitest';
import { buildPerFrameState } from '../perFrame';
import { PAINT_REFERENCE_WIDTH, SHAPE_CANONICAL_RADIUS } from '../styleSpec';
import { compileTimeline, type Viewport } from '../../cameraIntent';
import {
  DEFAULT_MAP_SETTINGS,
  DEFAULT_MARKER_HALO,
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
    // WS0 color metadata defaults.
    pix_fmt: null,
    color_primaries: null,
    color_trc: null,
    color_space: null,
    color_range: null,
    has_dolby_vision: false,
    camera_make: null,
    camera_model: null,
    source_color_class: 'unknown',
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
      settings,
      VIEWPORT,
    );
    expect(state.paints.waypointIconSize).toBeCloseTo(
      (settings.waypoints.size.circle_radius * PAINT_REFERENCE_WIDTH) /
        SHAPE_CANONICAL_RADIUS,
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
      overridden,
      VIEWPORT,
    );
    expect(state.paints.waypointIconSize).toBeCloseTo(
      (0.04 * PAINT_REFERENCE_WIDTH) / SHAPE_CANONICAL_RADIUS,
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
      POINT_SETTINGS,
      VIEWPORT,
    );
    expect(a.paints.waypointIconSize).toEqual(b.paints.waypointIconSize);
    expect(a.paints.pulseRadius).toBeCloseTo(b.paints.pulseRadius, 9);
    expect(a.paints.pulseOpacity).toBeCloseTo(b.paints.pulseOpacity, 9);
    expect(a.paints.waypointPrimaryColor).toEqual(
      b.paints.waypointPrimaryColor,
    );
    expect(a.paints.waypointSecondaryColor).toEqual(
      b.paints.waypointSecondaryColor,
    );
  });

  it('primary and secondary color expressions are independent of each other', () => {
    // After the descriptor refactor the two slots are independent inputs —
    // editing `secondary_color` must NOT change the primary color expression
    // (and vice versa). A regression here would silently re-couple the two
    // slots, defeating the whole point of the two-color model.
    const { clips, waypoints, timeline } = twoClipFixture();
    const a = buildPerFrameState(
      timeline,
      0,
      null,
      clips,
      waypoints,
      POINT_SETTINGS,
      POINT_SETTINGS,
      VIEWPORT,
    );
    const settingsWithDifferentSecondary: MapSettings = {
      ...POINT_SETTINGS,
      waypoints: {
        ...POINT_SETTINGS.waypoints,
        secondary_color: { mode: 'solid', solid: '#123456' },
      },
    };
    const b = buildPerFrameState(
      timeline,
      0,
      null,
      clips,
      waypoints,
      settingsWithDifferentSecondary,
      settingsWithDifferentSecondary,
      VIEWPORT,
    );
    expect(a.paints.waypointPrimaryColor).toEqual(
      b.paints.waypointPrimaryColor,
    );
    expect(a.paints.waypointSecondaryColor).not.toEqual(
      b.paints.waypointSecondaryColor,
    );
  });

  it('secondary color expression includes the override_secondary_color arm', () => {
    // The case expression `buildSlotColorExpr` emits for the secondary slot
    // must read the `override_secondary_color` feature property — otherwise
    // per-Waypoint secondary overrides fail silently. Serialize and look
    // for the property name in the expression body.
    const { clips, waypoints, timeline } = twoClipFixture();
    const state = buildPerFrameState(
      timeline,
      0,
      null,
      clips,
      waypoints,
      POINT_SETTINGS,
      POINT_SETTINGS,
      VIEWPORT,
    );
    expect(JSON.stringify(state.paints.waypointSecondaryColor)).toContain(
      'override_secondary_color',
    );
    // Sanity: primary doesn't reference the secondary feature property.
    expect(JSON.stringify(state.paints.waypointPrimaryColor)).not.toContain(
      'override_secondary_color',
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
      POINT_SETTINGS,
      VIEWPORT,
    );
    const expr = state.paints.waypointIconSize as unknown as unknown[];
    expect(Array.isArray(expr)).toBe(true);
    expect(expr[0]).toBe('case');
    // expr[1] is the predicate: ['==', ['get', 'id'], <waypoint-id>]
    const predicate = expr[1] as unknown[];
    expect(predicate[0]).toBe('==');
    expect(predicate[2]).toBe(waypoints[0].id);
    // expr[2] is the active icon-size, expr[3] is the default. Both flow
    // through `(radius × PAINT_REFERENCE_WIDTH) / SHAPE_CANONICAL_RADIUS`,
    // matching the static seed in `resolveStaticPaints`.
    expect(expr[2]).toBeCloseTo(
      (POINT_SETTINGS.waypoints.size.active_radius * PAINT_REFERENCE_WIDTH) /
        SHAPE_CANONICAL_RADIUS,
      9,
    );
    expect(expr[3]).toBeCloseTo(
      (POINT_SETTINGS.waypoints.size.circle_radius * PAINT_REFERENCE_WIDTH) /
        SHAPE_CANONICAL_RADIUS,
      9,
    );
  });

  it('symbol-sort-key (no active): emits `-index` so earliest upcoming waypoint paints on top', () => {
    // Before the playhead crosses any waypoint, every waypoint is "future."
    // By the user's rule for future waypoints (earlier on top), index=0 must
    // outscore index=N. The two-clip fixture seeds waypoints at the clip
    // start times; at t=-1 no waypoint has been passed, so active is null
    // and the sort-key expression should be `['-', 0, ['get', 'index']]`.
    const { clips, waypoints, timeline } = twoClipFixture();
    const noActiveSettings: MapSettings = {
      ...POINT_SETTINGS,
      waypoints: { ...POINT_SETTINGS.waypoints, active_mode: 'none' },
    };
    const state = buildPerFrameState(
      timeline,
      0,
      null,
      clips,
      waypoints,
      noActiveSettings,
      noActiveSettings,
      VIEWPORT,
    );
    const expr = state.paints.waypointSortKey as unknown as unknown[];
    expect(Array.isArray(expr)).toBe(true);
    expect(expr[0]).toBe('-');
    expect(expr[1]).toBe(0);
    // expr[2] is `['get', 'index']`.
    const arg = expr[2] as unknown[];
    expect(arg[0]).toBe('get');
    expect(arg[1]).toBe('index');
  });

  it('symbol-sort-key (active set): emits `-|index - activeIndex|` so closest-to-playhead waypoints win', () => {
    // With latest_passed mode + a marker past the first waypoint, the
    // expression should be `['-', 0, ['abs', ['-', ['get', 'index'], A]]]`
    // where A is the active waypoint's array index. The two-clip fixture
    // seeds waypoint[0] at clip a's start (project-time 0); at t=0 it's the
    // latest-passed, so activeIndex=0.
    const { clips, waypoints, timeline } = twoClipFixture();
    const state = buildPerFrameState(
      timeline,
      0,
      null,
      clips,
      waypoints,
      POINT_SETTINGS,
      POINT_SETTINGS,
      VIEWPORT,
    );
    const expr = state.paints.waypointSortKey as unknown as unknown[];
    expect(Array.isArray(expr)).toBe(true);
    expect(expr[0]).toBe('-');
    expect(expr[1]).toBe(0);
    const absExpr = expr[2] as unknown[];
    expect(absExpr[0]).toBe('abs');
    const subExpr = absExpr[1] as unknown[];
    expect(subExpr[0]).toBe('-');
    const getExpr = subExpr[1] as unknown[];
    expect(getExpr[0]).toBe('get');
    expect(getExpr[1]).toBe('index');
    // Active index is the position of the latest-passed waypoint in the
    // waypoints array. The fixture's first seeded waypoint is the one
    // anchored at project-time 0.
    expect(subExpr[2]).toBe(0);
  });

  it('placement key is the positive-distance inverse of the draw sort-key', () => {
    // Primary uses the negated draw key (allow-overlap: true → higher
    // wins draw order); secondary + label use the placement key directly
    // (allow-overlap: false → lower wins collision). Both have to share
    // the same `|index - activeIndex|` distance so the same waypoint
    // wins in every layer — otherwise the front fill, front outline, and
    // front label could disagree on who's "front."
    const { clips, waypoints, timeline } = twoClipFixture();
    const state = buildPerFrameState(
      timeline,
      0,
      null,
      clips,
      waypoints,
      POINT_SETTINGS,
      POINT_SETTINGS,
      VIEWPORT,
    );
    // Placement key shape: `['abs', ['-', ['get', 'index'], A]]`.
    const placement = state.paints.waypointPlacementKey as unknown as unknown[];
    expect(Array.isArray(placement)).toBe(true);
    expect(placement[0]).toBe('abs');
    // The draw sort-key wraps the same placement expression in `['-', 0, …]`.
    const draw = state.paints.waypointSortKey as unknown as unknown[];
    expect(draw[0]).toBe('-');
    expect(draw[1]).toBe(0);
    expect(draw[2]).toEqual(placement);
  });

  it('placement key (no active): emits bare get-index so the earliest upcoming waypoint wins placement', () => {
    const { clips, waypoints, timeline } = twoClipFixture();
    const noActiveSettings: MapSettings = {
      ...POINT_SETTINGS,
      waypoints: { ...POINT_SETTINGS.waypoints, active_mode: 'none' },
    };
    const state = buildPerFrameState(
      timeline,
      0,
      null,
      clips,
      waypoints,
      noActiveSettings,
      noActiveSettings,
      VIEWPORT,
    );
    const placement = state.paints.waypointPlacementKey as unknown as unknown[];
    expect(Array.isArray(placement)).toBe(true);
    expect(placement[0]).toBe('get');
    expect(placement[1]).toBe('index');
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
        settings,
        VIEWPORT,
      );
      expect(state.sources['waypoints']).toBeUndefined();
    }
  });
});

// -- surfaceScale (preview display factor) ------------------------------------
//
// The preview passes its fixed display scale; the export renderer omits the
// argument. Scale 1 must be an exact no-op (the golden-frame gate renders
// through the defaulted path), and any other factor must move zoom by
// log2(scale) and sizes by ×scale in lockstep — that pairing is what keeps a
// decoration's ground footprint identical between pane and export.

import { buildPerFramePaints } from '../paints';
import { withDisplayScale, type ResolvedCamera } from '../../cameraIntent';

describe('buildPerFrameState — surfaceScale', () => {
  it('omitting the argument is exactly scale 1 (renderer identity)', () => {
    const { clips, waypoints, timeline } = twoClipFixture();
    const t = 1234;
    const defaulted = buildPerFrameState(
      timeline, t, null, clips, waypoints, POINT_SETTINGS, POINT_SETTINGS, VIEWPORT,
    );
    const explicit = buildPerFrameState(
      timeline, t, null, clips, waypoints, POINT_SETTINGS, POINT_SETTINGS, VIEWPORT, 1,
    );
    expect(defaulted).toEqual(explicit);
  });

  it('scale 0.5 shifts zoom by exactly -1 and leaves center/bearing/pitch alone', () => {
    const { clips, waypoints, timeline } = twoClipFixture();
    const t = 1234;
    const ref = buildPerFrameState(
      timeline, t, null, clips, waypoints, POINT_SETTINGS, POINT_SETTINGS, VIEWPORT,
    );
    const scaled = buildPerFrameState(
      timeline, t, null, clips, waypoints, POINT_SETTINGS, POINT_SETTINGS, VIEWPORT, 0.5,
    );
    expect(scaled.camera.zoom).toBeCloseTo(ref.camera.zoom - 1, 12);
    expect(scaled.camera.center).toEqual(ref.camera.center);
    expect(scaled.camera.bearing).toBe(ref.camera.bearing);
    expect(scaled.camera.pitch).toBe(ref.camera.pitch);
    // Sources are geometry, not presentation — scale-free.
    expect(scaled.sources).toEqual(ref.sources);
  });
});

describe('buildPerFramePaints — surfaceScale', () => {
  it('no-active scalar sizes scale linearly; opacities and colors do not', () => {
    const ref = buildPerFramePaints(null, null, 500, POINT_SETTINGS);
    const scaled = buildPerFramePaints(null, null, 500, POINT_SETTINGS, 0.5);
    expect(typeof ref.waypointIconSize).toBe('number');
    expect(scaled.waypointIconSize).toBeCloseTo(
      (ref.waypointIconSize as number) * 0.5,
      12,
    );
    expect(scaled.pulseRadius).toBeCloseTo(ref.pulseRadius * 0.5, 12);
    expect(scaled.pulseRadiusB).toBeCloseTo(ref.pulseRadiusB * 0.5, 12);
    expect(scaled.pulseOpacity).toBe(ref.pulseOpacity);
    expect(scaled.pulseOpacityB).toBe(ref.pulseOpacityB);
    expect(scaled.dotOpacity).toBe(ref.dotOpacity);
    expect(scaled.waypointPrimaryColor).toEqual(ref.waypointPrimaryColor);
    expect(scaled.waypointSecondaryColor).toEqual(ref.waypointSecondaryColor);
  });

  it('active-state expressions carry scaled size arms (icon bump + halo)', () => {
    const ref = buildPerFramePaints('wp-1', 0, 500, POINT_SETTINGS);
    const scaled = buildPerFramePaints('wp-1', 0, 500, POINT_SETTINGS, 0.5);
    // icon-size case expression: ['case', <match>, activeSize, defaultSize]
    const refExpr = ref.waypointIconSize as unknown[];
    const scaledExpr = scaled.waypointIconSize as unknown[];
    expect(refExpr[0]).toBe('case');
    expect(scaledExpr[2]).toBeCloseTo((refExpr[2] as number) * 0.5, 12);
    expect(scaledExpr[3]).toBeCloseTo((refExpr[3] as number) * 0.5, 12);
    // halo radius case expression: ['case', <match>, radius, 0]
    const refHalo = ref.waypointHaloRadius as unknown[];
    const scaledHalo = scaled.waypointHaloRadius as unknown[];
    expect(scaledHalo[2]).toBeCloseTo((refHalo[2] as number) * 0.5, 12);
    expect(scaledHalo[3]).toBe(0);
  });
});

describe('withDisplayScale', () => {
  const cam: ResolvedCamera = {
    center: { lng: -122.4, lat: 37.77 },
    zoom: 15,
    bearing: 30,
    pitch: 60,
  };

  it('scale 1 returns the SAME reference (exact renderer no-op)', () => {
    expect(withDisplayScale(cam, 1)).toBe(cam);
  });

  it('offsets zoom by log2(scale), preserving everything else', () => {
    const out = withDisplayScale(cam, 0.5114583333333333);
    expect(out.zoom).toBeCloseTo(15 + Math.log2(0.5114583333333333), 12);
    expect(out.center).toEqual(cam.center);
    expect(out.bearing).toBe(cam.bearing);
    expect(out.pitch).toBe(cam.pitch);
  });

  it('a magnifying display (scale > 1) raises zoom', () => {
    const out = withDisplayScale(cam, 4 / 3);
    expect(out.zoom).toBeGreaterThan(cam.zoom);
  });
});

// -- POV playhead travel (transition window) ----------------------------------
//
// The travel trace replaces the cut-instant teleport with an eased,
// distance-parameterized sweep along the route between the wall-clocks the
// playhead occupies at the window edges. Continuity at both edges is by
// construction; every bail-out must reproduce the pre-travel behavior
// exactly.

import { easeInOut, type TransitionSpan } from '../../cameraIntent';
import { indexRoute } from '../../routeLocation';
import { mkPoint } from '../../__fixtures__/routes';
import type {
  MapOverrides,
  Route,
  TransitionSettings,
  TravelSettings,
} from '../../../types';
import { easeEnvelopeSample, EASE_PHASE_MS } from '../animations';

const T0 = Date.parse('2026-04-04T15:00:00Z');

/** 71 points, 1 Hz, uniform due-north movement — covers clip A
 *  (15:00:00–15:00:05), the inter-clip gap, and clip B (15:01:00–15:01:10)
 *  with no over-gap holes. */
const travelRoute: Route = {
  source_path: '/fixtures/travel.gpx',
  format: 'gpx',
  trackpoints: Array.from({ length: 71 }, (_, i) =>
    mkPoint(37.0 + i * 0.0001, -122.0, new Date(T0 + i * 1000).toISOString()),
  ),
};

interface TravelFixtureOpts {
  projectTravel?: TravelSettings;
  /** Project-level seam eases, merged into the transition blob alongside
   *  `projectTravel`. */
  projectEases?: Pick<TransitionSettings, 'ease_in' | 'ease_out'>;
  clipBTravel?: TravelSettings;
  /** Extra map_overrides for clip B, merged with the travel override —
   *  lets sync-mode tests give the destination clip its own POV look. */
  clipBOverrides?: MapOverrides;
  reversed?: boolean;
  markerImages?: MapSettings['marker_images'];
}

function travelFixture(opts: TravelFixtureOpts = {}) {
  const settings: MapSettings = {
    ...POINT_SETTINGS,
    marker_images: opts.markerImages ?? [],
    transition:
      opts.projectTravel || opts.projectEases
        ? { travel: opts.projectTravel, ...opts.projectEases }
        : undefined,
  };
  const clipA = mkClip({
    id: 'a',
    created_at: '2026-04-04T15:00:00Z',
    gps: { lat: 37.0, lng: -122.0 },
    trim: { in_ms: 0, out_ms: 5_000 },
  });
  const clipBMapOverrides: MapOverrides | null =
    opts.clipBTravel || opts.clipBOverrides
      ? {
          ...(opts.clipBOverrides ?? {}),
          ...(opts.clipBTravel
            ? { transition: { travel: opts.clipBTravel } }
            : {}),
        }
      : null;
  const clipB = mkClip({
    id: 'b',
    created_at: '2026-04-04T15:01:00Z',
    gps: { lat: 37.006, lng: -122.0 },
    trim: { in_ms: 0, out_ms: 10_000 },
    map_overrides: clipBMapOverrides,
  });
  const clips = opts.reversed ? [clipB, clipA] : [clipA, clipB];
  const indexed = indexRoute(travelRoute)!;
  const timeline = compileTimeline(clips, indexed, settings, {});
  // The inter-clip transition (fromClipId non-null).
  const span = timeline.transitionSpans.find(
    (s): s is TransitionSpan & { fromClipId: string } => s.fromClipId != null,
  )!;
  return { clips, settings, indexed, timeline, span };
}

function markerLngLat(state: PerFrameStateT): [number, number] | null {
  const fc = state.sources['live-marker'] as GeoJSON.FeatureCollection<GeoJSON.Point>;
  if (!fc || fc.features.length === 0) return null;
  return fc.features[0].geometry.coordinates as [number, number];
}

function markerClipId(state: PerFrameStateT): string | null {
  const fc = state.sources['live-marker'] as GeoJSON.FeatureCollection<GeoJSON.Point>;
  if (!fc || fc.features.length === 0) return null;
  return (fc.features[0].properties as { clipId: string }).clipId;
}

type PerFrameStateT = ReturnType<typeof buildPerFrameState>;

function stateAt(
  f: ReturnType<typeof travelFixture>,
  t: number,
  waypoints: Waypoint[] = [],
): PerFrameStateT {
  return buildPerFrameState(
    f.timeline,
    t,
    f.indexed,
    f.clips,
    waypoints,
    f.settings,
    f.settings,
    VIEWPORT,
  );
}

describe('POV travel trace', () => {
  it('regression: travel absent and travel disabled are byte-identical to each other everywhere', () => {
    const off = travelFixture();
    const disabled = travelFixture({ projectTravel: { enabled: false } });
    for (const t of [0, 100, off.span.startMs, off.span.cutMs - 1, off.span.cutMs, off.span.endMs, 9_000]) {
      expect(stateAt(disabled, t).sources).toEqual(stateAt(off, t).sources);
    }
  });

  it('teleports at the cut when travel is off (the pre-travel behavior)', () => {
    const f = travelFixture();
    const before = markerLngLat(stateAt(f, f.span.cutMs - 16))!;
    const after = markerLngLat(stateAt(f, f.span.cutMs))!;
    // ~55s of route (≈0.0055° lat) jumps in one frame.
    expect(Math.abs(after[1] - before[1])).toBeGreaterThan(0.004);
  });

  it('travels continuously through the window when enabled', () => {
    const on = travelFixture({ projectTravel: { enabled: true } });
    const off = travelFixture();
    // Continuity at both edges: equal to the clip-span branch's position.
    expect(markerLngLat(stateAt(on, on.span.startMs))!).toEqual(
      markerLngLat(stateAt(off, on.span.startMs))!,
    );
    expect(markerLngLat(stateAt(on, on.span.endMs))!).toEqual(
      markerLngLat(stateAt(off, on.span.endMs))!,
    );
    // No teleport-sized step anywhere inside the window.
    const N = 40;
    let prevLat = markerLngLat(stateAt(on, on.span.startMs))![1];
    let maxStep = 0;
    for (let k = 1; k <= N; k++) {
      const t = on.span.startMs + ((on.span.endMs - on.span.startMs) * k) / N;
      const lat = markerLngLat(stateAt(on, t))![1];
      maxStep = Math.max(maxStep, Math.abs(lat - prevLat));
      // Forward travel on a due-north route: monotone non-decreasing.
      expect(lat).toBeGreaterThanOrEqual(prevLat - 1e-12);
      prevLat = lat;
    }
    // Eased steps stay a small fraction of the total sweep.
    expect(maxStep).toBeLessThan(0.0055 * 0.15);
  });

  it('midpoint follows the camera-arc easing curve (distance-parameterized)', () => {
    const on = travelFixture({ projectTravel: { enabled: true } });
    const tMid = (on.span.startMs + on.span.endMs) / 2;
    const latMid = markerLngLat(stateAt(on, tMid))![1];
    const latA = markerLngLat(stateAt(on, on.span.startMs))![1];
    const latB = markerLngLat(stateAt(on, on.span.endMs))![1];
    // easeInOut(0.5) = 0.5 exactly, and the route is uniform-speed.
    expect(easeInOut(0.5, 'natural')).toBeCloseTo(0.5, 12);
    expect(latMid).toBeCloseTo(latA + 0.5 * (latB - latA), 6);
    // Quarter point: eased fraction, NOT linear.
    const tQ = on.span.startMs + (on.span.endMs - on.span.startMs) * 0.25;
    const latQ = markerLngLat(stateAt(on, tQ))![1];
    const u = easeInOut(0.25, 'natural');
    expect(latQ).toBeCloseTo(latA + u * (latB - latA), 6);
    expect(u).toBeLessThan(0.25);
  });

  it('destination clip owns the window (override wins both directions)', () => {
    const projectOnClipOff = travelFixture({
      projectTravel: { enabled: true },
      clipBTravel: { enabled: false },
    });
    const off = travelFixture();
    const tMid = (projectOnClipOff.span.startMs + projectOnClipOff.span.endMs) / 2;
    expect(markerLngLat(stateAt(projectOnClipOff, tMid))).toEqual(
      markerLngLat(stateAt(off, tMid)),
    );

    const projectOffClipOn = travelFixture({ clipBTravel: { enabled: true } });
    const on = travelFixture({ projectTravel: { enabled: true } });
    expect(markerLngLat(stateAt(projectOffClipOn, tMid))).toEqual(
      markerLngLat(stateAt(on, tMid)),
    );
  });

  it('no travel for the project-start transition (fromClipId null)', () => {
    const on = travelFixture({ projectTravel: { enabled: true } });
    const off = travelFixture();
    const startSpan = on.timeline.transitionSpans.find((s) => s.fromClipId == null);
    if (startSpan && startSpan.effectiveDurationMs > 0) {
      const tMid = (startSpan.startMs + startSpan.endMs) / 2;
      expect(stateAt(on, tMid).sources).toEqual(stateAt(off, tMid).sources);
    }
  });

  it('no travel without a route', () => {
    const on = travelFixture({ projectTravel: { enabled: true } });
    const off = travelFixture();
    const tMid = (on.span.startMs + on.span.endMs) / 2;
    const noRouteOn = buildPerFrameState(
      on.timeline, tMid, null, on.clips, [], on.settings, on.settings, VIEWPORT,
    );
    const noRouteOff = buildPerFrameState(
      off.timeline, tMid, null, off.clips, [], off.settings, off.settings, VIEWPORT,
    );
    expect(noRouteOn.sources).toEqual(noRouteOff.sources);
  });

  it('no travel when an endpoint is outside GPX coverage', () => {
    // Route covering only clip A's range — clip B's endpoint can't resolve.
    const shortRoute = indexRoute({
      source_path: '/fixtures/short.gpx',
      format: 'gpx',
      trackpoints: Array.from({ length: 11 }, (_, i) =>
        mkPoint(37.0 + i * 0.0001, -122.0, new Date(T0 + i * 1000).toISOString()),
      ),
    })!;
    const on = travelFixture({ projectTravel: { enabled: true } });
    const off = travelFixture();
    const tMid = (on.span.startMs + on.span.endMs) / 2;
    const a = buildPerFrameState(
      on.timeline, tMid, shortRoute, on.clips, [], on.settings, on.settings, VIEWPORT,
    );
    const b = buildPerFrameState(
      off.timeline, tMid, shortRoute, off.clips, [], off.settings, off.settings, VIEWPORT,
    );
    expect(a.sources).toEqual(b.sources);
  });

  it('backward travel (reversed clip order) retraces the route monotonically', () => {
    const f = travelFixture({ projectTravel: { enabled: true }, reversed: true });
    let prevLat = Infinity;
    for (let k = 0; k <= 20; k++) {
      const t = f.span.startMs + ((f.span.endMs - f.span.startMs) * k) / 20;
      const lat = markerLngLat(stateAt(f, t))![1];
      expect(lat).toBeLessThanOrEqual(prevLat + 1e-12);
      prevLat = lat;
    }
  });

  it('marker clipId flips at the cut (matches activeClipIdAt)', () => {
    const f = travelFixture({ projectTravel: { enabled: true } });
    expect(markerClipId(stateAt(f, f.span.cutMs - 1))).toBe('a');
    expect(markerClipId(stateAt(f, f.span.cutMs))).toBe('b');
  });

  it('visited trail head tracks the traveling marker', () => {
    const f = travelFixture({ projectTravel: { enabled: true } });
    const settings: MapSettings = {
      ...f.settings,
      route: { ...f.settings.route, mode: 'visited' },
    };
    const tMid = (f.span.startMs + f.span.endMs) / 2;
    const state = buildPerFrameState(
      f.timeline, tMid, f.indexed, f.clips, [], settings, settings, VIEWPORT,
    );
    const trail = state.sources['route-trail'] as GeoJSON.Feature<GeoJSON.LineString>;
    const head = trail.geometry.coordinates[trail.geometry.coordinates.length - 1];
    const marker = markerLngLat(state)!;
    expect(head[0]).toBeCloseTo(marker[0], 9);
    expect(head[1]).toBeCloseTo(marker[1], 9);
  });

  it('waypoint activation sweeps mid-window with the synthesized wall-clock', () => {
    const f = travelFixture({ projectTravel: { enabled: true } });
    // Anchored 30s into the inter-clip gap — unpassed at window entry,
    // passed by window exit.
    const wp: Waypoint = {
      id: 'wp-mid',
      position: { kind: 'wall_clock_ms', ms: T0 + 30_000 },
      label: 'mid-gap',
      source: 'manual',
    } as Waypoint;
    const visitedSettings: MapSettings = {
      ...f.settings,
      waypoints: { ...f.settings.waypoints, mode: 'visited' },
    };
    const count = (t: number) => {
      const s = buildPerFrameState(
        f.timeline, t, f.indexed, f.clips, [wp], visitedSettings, visitedSettings, VIEWPORT,
      );
      const fc = s.sources['waypoints'] as GeoJSON.FeatureCollection<GeoJSON.Point>;
      return fc.features.length;
    };
    expect(count(f.span.startMs)).toBe(0);
    expect(count(f.span.endMs)).toBe(1);
  });
});

describe('travel — traveling playhead style (per-frame buckets)', () => {
  function visibility(state: PerFrameStateT, layer: string): unknown {
    return state.layouts.find(([l, p]) => l === layer && p === 'visibility')?.[2];
  }
  function povPaint(state: PerFrameStateT, layer: string, prop: string): unknown {
    return state.povPaints.find(([l, p]) => l === layer && p === prop)?.[2];
  }
  /** A custom (unsynced) travel style differing from the default playhead
   *  in marker identity AND color. */
  const CUSTOM_RING: TravelSettings = {
    enabled: true,
    sync: false,
    playhead: {
      ...DEFAULT_MAP_SETTINGS.pov,
      color: '#ff715b',
      marker: { kind: 'shape', shape: 'ring' },
    },
  };

  it('equals the static tuples outside a travel window', () => {
    const f = travelFixture({ projectTravel: CUSTOM_RING });
    const state = stateAt(f, 100); // inside clip A, before the window
    expect(visibility(state, 'live-marker-dot')).toBe('visible');
    expect(visibility(state, 'live-marker-shape-primary')).toBe('none');
    // Colors are the clip's own POV config, not the travel style's.
    expect(povPaint(state, 'live-marker-shape-primary', 'icon-color')).toBe(
      DEFAULT_MAP_SETTINGS.pov.color,
    );
  });

  it('custom style swaps identity AND colors inside the window, restores after', () => {
    const f = travelFixture({ projectTravel: CUSTOM_RING });
    const tMid = (f.span.startMs + f.span.endMs) / 2;
    const inWindow = stateAt(f, tMid);
    expect(visibility(inWindow, 'live-marker-shape-primary')).toBe('visible');
    expect(visibility(inWindow, 'live-marker-dot')).toBe('none');
    expect(
      inWindow.layouts.find(
        ([l, p]) => l === 'live-marker-shape-primary' && p === 'icon-image',
      )?.[2],
    ).toBe('pov-ring-primary');
    // The full style rides along: shape tint and pulse color are the
    // custom block's, not the clip playhead's.
    expect(povPaint(inWindow, 'live-marker-shape-primary', 'icon-color')).toBe(
      '#ff715b',
    );
    expect(povPaint(inWindow, 'live-marker-pulse', 'circle-color')).toBe(
      '#ff715b',
    );
    const after = stateAt(f, f.span.endMs + 100);
    expect(visibility(after, 'live-marker-dot')).toBe('visible');
    expect(visibility(after, 'live-marker-shape-primary')).toBe('none');
    expect(povPaint(after, 'live-marker-pulse', 'circle-color')).toBe(
      DEFAULT_MAP_SETTINGS.pov.color,
    );
  });

  it('synced: the traveling playhead wears the DESTINATION clip\'s resolved POV look for the whole window', () => {
    const f = travelFixture({
      projectTravel: { enabled: true },
      clipBOverrides: { pov: { color: '#123456' } },
    });
    // Pre-cut frame: the active clip is still A, but the traveling
    // playhead already wears B's color — destination owns the window, no
    // mid-flight style flip at the cut.
    const preCut = stateAt(f, f.span.cutMs - 1);
    expect(povPaint(preCut, 'live-marker-pulse', 'circle-color')).toBe('#123456');
    // Outside the window, clip A's frames paint A's own resolved color.
    const before = stateAt(f, 100);
    expect(povPaint(before, 'live-marker-pulse', 'circle-color')).toBe(
      DEFAULT_MAP_SETTINGS.pov.color,
    );
  });

  it('custom style with an unregistered image id collapses to the dot', () => {
    const f = travelFixture({
      projectTravel: {
        enabled: true,
        sync: false,
        playhead: {
          ...DEFAULT_MAP_SETTINGS.pov,
          marker: { kind: 'image', image_id: 'not-in-library' },
        },
      },
    });
    const tMid = (f.span.startMs + f.span.endMs) / 2;
    const state = stateAt(f, tMid);
    expect(visibility(state, 'live-marker-dot')).toBe('visible');
    expect(state.layouts.some(([, p]) => p === 'icon-image')).toBe(false);
  });

  it('unsynced without a stored playhead style falls back to sync behavior', () => {
    const f = travelFixture({ projectTravel: { enabled: true, sync: false } });
    const tMid = (f.span.startMs + f.span.endMs) / 2;
    expect(visibility(stateAt(f, tMid), 'live-marker-dot')).toBe('visible');
  });

  it('haloComposites: the live-marker entry follows the travel style inside the window', () => {
    // Distinctive opacity so the travel style's composite `g` (0.25 at
    // falloff 0) is distinguishable from the disabled-halo default params.
    const f = travelFixture({
      projectTravel: {
        enabled: true,
        sync: false,
        playhead: {
          ...DEFAULT_MAP_SETTINGS.pov,
          halo: { ...DEFAULT_MARKER_HALO, opacity: 0.25 },
        },
      },
    });
    const tMid = (f.span.startMs + f.span.endMs) / 2;
    const liveGroup = (s: PerFrameStateT) =>
      s.haloComposites.find((g) => g.layers[0] === 'live-marker-halo')!;
    // Inside the window the travel style's halo drives the composite.
    expect(liveGroup(stateAt(f, tMid)).opacity).toBeCloseTo(0.25, 10);
    // Outside it equals the static resolution for the clip's own settings.
    expect(liveGroup(stateAt(f, 100)).opacity).not.toBeCloseTo(0.25, 10);
  });
});

describe('travel — show_playhead / draw_route toggles', () => {
  function trailCoords(state: PerFrameStateT): number[][] {
    const trail = state.sources['route-trail'] as GeoJSON.Feature<GeoJSON.LineString>;
    return trail.geometry.coordinates as number[][];
  }
  function trailVisibility(state: PerFrameStateT): unknown {
    return state.layouts.find(
      ([l, p]) => l === 'route-trail-line' && p === 'visibility',
    )?.[2];
  }

  it('show_playhead: false empties the live-marker source ONLY inside the window', () => {
    const f = travelFixture({
      projectTravel: { enabled: true, show_playhead: false },
    });
    const tMid = (f.span.startMs + f.span.endMs) / 2;
    expect(markerLngLat(stateAt(f, tMid))).toBeNull();
    expect(markerLngLat(stateAt(f, 100))).not.toBeNull();
    expect(markerLngLat(stateAt(f, f.span.endMs + 100))).not.toBeNull();
  });

  it('show_playhead: false still draws the route (independent toggles)', () => {
    const f = travelFixture({
      projectTravel: { enabled: true, show_playhead: false },
    });
    const settings: MapSettings = {
      ...f.settings,
      route: { ...f.settings.route, mode: 'visited' },
    };
    const tMid = (f.span.startMs + f.span.endMs) / 2;
    const state = buildPerFrameState(
      f.timeline, tMid, f.indexed, f.clips, [], settings, settings, VIEWPORT,
    );
    expect(markerLngLat(state)).toBeNull();
    // Trail head mid-window sits mid-sweep — strictly past the departure
    // point, so the trail IS advancing with the hidden traveling position.
    // (Departure sampled just BEFORE the window — at startMs the marker
    // source is already emptied by show_playhead: false.)
    const head = trailCoords(state)[trailCoords(state).length - 1];
    const departure = markerLngLat(stateAt(f, f.span.startMs - 1))!;
    expect(head[1]).toBeGreaterThan(departure[1] + 0.001);
  });

  it('draw_route: false keeps the trail on the pre-travel clock while the marker travels', () => {
    const off = travelFixture(); // travel disabled = the pre-travel behavior
    const f = travelFixture({
      projectTravel: { enabled: true, draw_route: false },
    });
    const visited = (fx: ReturnType<typeof travelFixture>, t: number) => {
      const settings: MapSettings = {
        ...fx.settings,
        route: { ...fx.settings.route, mode: 'visited' },
      };
      return buildPerFrameState(
        fx.timeline, t, fx.indexed, fx.clips, [], settings, settings, VIEWPORT,
      );
    };
    const tMid = (f.span.startMs + f.span.endMs) / 2;
    // Trail geometry matches the travel-disabled trail exactly…
    expect(trailCoords(visited(f, tMid))).toEqual(trailCoords(visited(off, tMid)));
    // …while the marker is mid-sweep (diverged from the trail head).
    const marker = markerLngLat(visited(f, tMid))!;
    const coords = trailCoords(visited(f, tMid));
    const head = coords[coords.length - 1];
    expect(Math.abs(marker[1] - head[1])).toBeGreaterThan(0.001);
  });

  it('draw_route with route mode \'none\': trail is force-drawn during the window only', () => {
    const f = travelFixture({ projectTravel: { enabled: true } });
    const noneSettings: MapSettings = {
      ...f.settings,
      route: { ...f.settings.route, mode: 'none' },
    };
    const at = (t: number) =>
      buildPerFrameState(
        f.timeline, t, f.indexed, f.clips, [], noneSettings, noneSettings, VIEWPORT,
      );
    const tMid = (f.span.startMs + f.span.endMs) / 2;
    // Inside the window: trail data + forced visibility.
    expect(trailCoords(at(tMid)).length).toBeGreaterThan(1);
    expect(trailVisibility(at(tMid))).toBe('visible');
    // Outside: empty and hidden, exactly the static 'none' emission.
    expect(trailCoords(at(100)).length).toBe(0);
    expect(trailVisibility(at(100))).toBe('none');
  });
});

describe('transition — seam eases (envelope)', () => {
  const FAST = EASE_PHASE_MS.fast;

  function dotRadius(state: PerFrameStateT): number {
    return state.povPaints.find(
      ([l, p]) => l === 'live-marker-dot' && p === 'circle-radius',
    )?.[2] as number;
  }

  it('easeEnvelopeSample endpoints: v=1 is identity, v=0 is fully hidden on the style channel', () => {
    expect(easeEnvelopeSample('fade', 1)).toEqual({ scale: 1, opacity: 1 });
    expect(easeEnvelopeSample('fade', 0)).toEqual({ scale: 1, opacity: 0 });
    expect(easeEnvelopeSample('grow', 0)).toEqual({ scale: 0, opacity: 1 });
    expect(easeEnvelopeSample('grow', 1)).toEqual({ scale: 1, opacity: 1 });
    expect(easeEnvelopeSample('pop', 0).scale).toBeCloseTo(0, 12);
    expect(easeEnvelopeSample('pop', 1).scale).toBeCloseTo(1, 10);
    // Pop overshoots past 1 mid-arrival — the point of the style.
    expect(easeEnvelopeSample('pop', 0.85).scale).toBeGreaterThan(1);
  });

  it('no eases configured → identity at every seam probe (byte-identical defaults)', () => {
    const f = travelFixture();
    for (const t of [f.span.cutMs - 50, f.span.cutMs + 50, 50]) {
      const state = stateAt(f, t);
      expect(state.paints.dotOpacity).toBe(1);
      expect(dotRadius(state)).toBeCloseTo(
        DEFAULT_MAP_SETTINGS.pov.size.dot_radius * PAINT_REFERENCE_WIDTH,
        9,
      );
    }
  });

  it('non-traveled seam: ease_out anchors before the cut, ease_in after — fixed duration', () => {
    const f = travelFixture({
      projectEases: {
        ease_out: { style: 'grow', speed: 'fast' },
        ease_in: { style: 'fade', speed: 'fast' },
      },
    });
    const cut = f.span.cutMs;
    const steady = dotRadius(stateAt(f, cut - 1000));
    // OUT phase (grow → scale shrinks toward the cut); opacity untouched.
    const nearCut = stateAt(f, cut - 50);
    expect(dotRadius(nearCut)).toBeLessThan(steady * 0.25);
    expect(nearCut.paints.dotOpacity).toBe(1);
    // IN phase (fade → opacity ramps, scale untouched).
    const justAfter = stateAt(f, cut + 50);
    expect(dotRadius(justAfter)).toBeCloseTo(steady, 9);
    expect(justAfter.paints.dotOpacity).toBeLessThan(0.6);
    expect(justAfter.paints.pulseOpacity).toBeLessThanOrEqual(
      stateAt(f, cut + FAST + 200).paints.pulseOpacity + 1e-9,
    );
    // Both phases end after the fixed duration — window length irrelevant.
    expect(stateAt(f, cut + FAST + 1).paints.dotOpacity).toBe(1);
    expect(dotRadius(stateAt(f, cut - FAST - 1))).toBeCloseTo(steady, 9);
  });

  it('traveled seam: eases anchor at the window EDGES (style swaps), not the cut', () => {
    const f = travelFixture({
      projectTravel: { enabled: true },
      projectEases: {
        ease_out: { style: 'grow', speed: 'fast' },
        ease_in: { style: 'grow', speed: 'fast' },
      },
    });
    const { startMs, endMs, cutMs } = f.span;
    const steady = dotRadius(stateAt(f, startMs - 1000));
    // Mid-window (at the cut): no ease — position is continuous there.
    expect(dotRadius(stateAt(f, cutMs))).toBeCloseTo(steady, 9);
    // Entry crossfade: shrunken just before AND just after startMs.
    expect(dotRadius(stateAt(f, startMs - 50))).toBeLessThan(steady * 0.25);
    expect(dotRadius(stateAt(f, startMs + 50))).toBeLessThan(steady * 0.25);
    // Exit crossfade at endMs, restored after the phase.
    expect(dotRadius(stateAt(f, endMs - 50))).toBeLessThan(steady * 0.25);
    expect(dotRadius(stateAt(f, endMs + 50))).toBeLessThan(steady * 0.25);
    expect(dotRadius(stateAt(f, endMs + FAST + 1))).toBeCloseTo(steady, 9);
  });

  it('project start plays the first clip\'s ease_in; project end the last clip\'s ease_out', () => {
    const f = travelFixture({
      projectEases: {
        ease_in: { style: 'fade', speed: 'fast' },
        ease_out: { style: 'fade', speed: 'fast' },
      },
    });
    expect(stateAt(f, 50).paints.dotOpacity).toBeLessThan(0.6);
    expect(stateAt(f, FAST + 100).paints.dotOpacity).toBe(1);
    const total = f.timeline.totalDurationMs;
    expect(stateAt(f, total - 50).paints.dotOpacity).toBeLessThan(0.6);
    expect(stateAt(f, total - FAST - 100).paints.dotOpacity).toBe(1);
  });

  it('fade opacity also dims the live-marker halo composite (whole stack fades as one)', () => {
    const f = travelFixture({
      projectEases: { ease_in: { style: 'fade', speed: 'fast' } },
    });
    const settings: MapSettings = {
      ...f.settings,
      pov: { ...f.settings.pov, halo: DEFAULT_MARKER_HALO },
    };
    const at = (t: number) =>
      buildPerFrameState(
        f.timeline, t, f.indexed, f.clips, [], settings, settings, VIEWPORT,
      );
    const liveG = (t: number) =>
      at(t).haloComposites.find((g) => g.layers[0] === 'live-marker-halo')!
        .opacity;
    const steadyG = liveG(f.span.cutMs - 1000);
    expect(liveG(f.span.cutMs + 50)).toBeLessThan(steadyG);
    expect(liveG(f.span.cutMs + FAST + 1)).toBeCloseTo(steadyG, 9);
  });
});
