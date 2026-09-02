// Clip groups (camera glide) in the EXPORT path — Phase C parity.
//
// The compiled timeline crosses to the sidecar as JSON (`setup` cmd), and
// the sidecar evaluates it through the SAME shared `cameraAt` the preview
// uses (`scene.ts` → `buildPerFrameState` → `cameraAt`). Nothing in the
// sidecar knows about groups; it only has to (1) receive `groupSpans` /
// `cameraAuthority` intact and (2) hand the timeline to the shared
// evaluator. This file pins both, plus the "ungrouped compiles are
// unchanged except additive fields" invariant from
// `docs/CLIP_GROUPS_HANDOFF.md` §7.
//
// Pure — no engine, no GPU, no network. Run via `npm run test:renderer`.

import { describe, it, expect } from 'vitest';

import { buildSetupPayload } from './setupFixture';
import { buildFramePayload } from '../scene';
import type { SetupCmd } from '../backend';
import {
  cameraAt,
  compileTimeline,
  findCameraTransitionSpanAt,
  findTransitionSpanAt,
  groupCameraAt,
  resolveIntent,
  type CompiledTimeline,
  type GroupSpan,
  type ResolvedCamera,
  type TransitionSpan,
  type Viewport,
} from '../../../../src/lib/cameraIntent';
import { indexRoute, parseTimestamp } from '../../../../src/lib/routeLocation';
import { mkPoint } from '../../../../src/lib/__fixtures__/routes';
import type { Clip, ClipGroup, MapSettings, Route } from '../../../../src/types';

// -- Fixtures (mirror `src/lib/cameraIntent.groups.test.ts`) ----------------

const TEN_S = 10_000;
const ROUTE_START_ISO = '2026-04-04T15:00:00Z';
const ROUTE_START_MS = parseTimestamp(ROUTE_START_ISO);

/** 1 Hz route, 0..180 s: a gentle arc so location varies smoothly. */
function syntheticRoute(): Route {
  const trackpoints = [];
  for (let s = 0; s <= 180; s++) {
    const lat = 37.77 + s * 0.0002;
    const lng = -122.4 + 0.000004 * s * s;
    trackpoints.push(
      mkPoint(lat, lng, new Date(ROUTE_START_MS + s * 1000).toISOString()),
    );
  }
  return { source_path: '/tmp/r.gpx', format: 'gpx', trackpoints };
}

function clip(id: string, i: number): Clip {
  return {
    id,
    path: `/tmp/${id}.mov`,
    filename: `${id}.mov`,
    created_at: new Date(ROUTE_START_MS + i * TEN_S).toISOString(),
    duration_ms: TEN_S,
    gps: { lat: 37.77 + i * 0.002, lng: -122.4 + i * 0.001 },
    resolution: null,
    frame_rate: null,
    trim: { in_ms: 0, out_ms: TEN_S },
    focal_point: { x: 0.5, y: 0.5, zoom: 1 },
    effects: { stabilize: { enabled: false, shakiness: 0 }, speed: 1 },
    visible: true,
    map_overrides: null,
    pix_fmt: null,
    color_primaries: null,
    color_trc: null,
    color_space: null,
    color_range: null,
    has_dolby_vision: false,
    camera_make: null,
    camera_model: null,
    source_color_class: 'unknown',
  };
}

/** Five contiguous 10 s clips; the group covers the middle three so the
 *  fixture has an authoritative ENTRY seam (a→b), two intra-group seams
 *  (b→c, c→d) and an authoritative EXIT seam (d→e). */
const IDS = ['a', 'b', 'c', 'd', 'e'];
const GROUP: ClipGroup = { id: 'g', clip_ids: ['b', 'c', 'd'] };

/** Follow camera, fixed bearing 0 — merged over the fixture's defaults. */
const FOLLOW: Partial<MapSettings> = {
  camera: {
    follow_playhead: true,
    bearing_mode: 'fixed',
    bearing_degrees: 0,
    zoom: 14,
  } as MapSettings['camera'],
};

function fixture(clipGroups?: ClipGroup[]) {
  const payload = buildSetupPayload({
    clips: IDS.map(clip),
    route: syntheticRoute(),
    mapSettings: FOLLOW,
    clipGroups,
  });
  const indexedRoute = indexRoute(payload.route);
  if (!indexedRoute) throw new Error('fixture route failed to index');
  return { payload, indexedRoute };
}

/** The exact transport the orchestrator uses: one JSON line on stdin. */
function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The viewport `scene.ts` resolves the camera against (css px, export dpr). */
function sceneViewport(payload: SetupCmd): Viewport {
  return {
    width: payload.cssViewport.w,
    height: payload.cssViewport.h,
    dpr: payload.pixelRatio,
  };
}

/** What the source evaluator says the export camera is at `t`. Mirrors
 *  `buildPerFrameState` exactly: `cameraAt` → `resolveIntent`; the renderer
 *  runs at surfaceScale 1 so `withDisplayScale` is the identity. */
function sourceCamera(timeline: CompiledTimeline, viewport: Viewport, t: number) {
  const cam = resolveIntent(cameraAt(timeline, t), viewport);
  return {
    center: { lng: cam.center.lng, lat: cam.center.lat },
    zoom: cam.zoom,
    bearing: cam.bearing,
    pitch: cam.pitch,
  };
}

function onlyGroup(tl: CompiledTimeline): GroupSpan {
  expect(tl.groupSpans).toHaveLength(1);
  return tl.groupSpans[0];
}

function seam(tl: CompiledTimeline, from: string, to: string): TransitionSpan {
  const s = tl.transitionSpans.find((x) => x.fromClipId === from && x.toClipId === to);
  if (!s) throw new Error(`no ${from}→${to} transition span`);
  return s;
}

function stripAuthority(spans: TransitionSpan[]) {
  return spans.map(({ cameraAuthority: _ignored, ...rest }) => rest);
}

/** Sample times: every intra-group cut (± a frame at 30 fps, ± 1 ms), each
 *  anchor, the glide's quartiles, and the group's last frame. */
function sampleTimes(g: GroupSpan, intraCuts: number[]): number[] {
  const frame = 1000 / 30;
  const ts = new Set<number>();
  for (const cut of intraCuts) {
    for (const d of [-frame, -1, 0, 1, frame]) ts.add(cut + d);
  }
  for (const a of g.anchors) ts.add(a.tMs);
  for (const f of [0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9]) {
    ts.add(g.startMs + f * (g.endMs - g.startMs));
  }
  ts.add(g.endMs - 1);
  return [...ts].sort((x, y) => x - y);
}

// -- (a) The wire carries the glide ----------------------------------------

describe('clip groups — wire transport', () => {
  it('groupSpans and cameraAuthority survive JSON round-trip intact', () => {
    const { payload } = fixture([GROUP]);
    const wire = roundTrip(payload);

    expect(wire.timeline).toEqual(payload.timeline);

    const g = onlyGroup(wire.timeline);
    expect(g.groupId).toBe('g');
    expect(g.memberClipIds).toEqual(['b', 'c', 'd']);
    expect(g.anchors).toHaveLength(3);
    expect(g.anchors).toStrictEqual(payload.timeline.groupSpans[0].anchors);

    expect(seam(wire.timeline, 'a', 'b').cameraAuthority).toBe(true);
    expect(seam(wire.timeline, 'b', 'c').cameraAuthority).toBe(false);
    expect(seam(wire.timeline, 'c', 'd').cameraAuthority).toBe(false);
    expect(seam(wire.timeline, 'd', 'e').cameraAuthority).toBe(true);
    // `false` must be a literal on the wire, never dropped as a default —
    // a consumer defaulting a missing key to `true` would re-arm the seam.
    const raw = JSON.parse(JSON.stringify(payload.timeline)) as {
      transitionSpans: Array<Record<string, unknown>>;
    };
    for (const s of raw.transitionSpans) {
      expect(Object.prototype.hasOwnProperty.call(s, 'cameraAuthority')).toBe(true);
      expect(typeof s.cameraAuthority).toBe('boolean');
    }
  });
});

// -- (b) The sidecar's per-frame camera IS the source evaluator's ----------

describe('clip groups — sidecar / source cameraAt parity', () => {
  const { payload, indexedRoute } = fixture([GROUP]);
  const wire = roundTrip(payload) as SetupCmd;
  const viewport = sceneViewport(wire);
  const g = onlyGroup(wire.timeline);
  const intraCuts = [seam(wire.timeline, 'b', 'c').cutMs, seam(wire.timeline, 'c', 'd').cutMs];
  const samples = sampleTimes(g, intraCuts);

  it('samples cover both intra-group cuts and lie inside the group', () => {
    expect(samples.length).toBeGreaterThan(10);
    for (const cut of intraCuts) expect(samples).toContain(cut);
    // Closed interval: the last anchor sits exactly at `g.endMs`.
    for (const t of samples) {
      expect(t).toBeGreaterThanOrEqual(g.startMs);
      expect(t).toBeLessThanOrEqual(g.endMs);
    }
  });

  it('buildFramePayload(...).camera deep-equals cameraAt() on the round-tripped timeline', () => {
    for (const t of samples) {
      const sidecar = buildFramePayload(wire, indexedRoute, t).camera;
      expect(sidecar, `t=${t}`).toEqual(sourceCamera(wire.timeline, viewport, t));
    }
  });

  it('at every intra-group cut the sidecar camera is the glide, not a transition arc', () => {
    for (const cut of intraCuts) {
      // The seam exists for the marker layer…
      expect(findTransitionSpanAt(wire.timeline.transitionSpans, cut)).not.toBeNull();
      // …but has no camera authority, so the glide answers.
      expect(findCameraTransitionSpanAt(wire.timeline.transitionSpans, cut)).toBeNull();
      const glide: ResolvedCamera = groupCameraAt(g, cut);
      const sidecar = buildFramePayload(wire, indexedRoute, cut).camera;
      expect(sidecar.center.lng).toBe(glide.center.lng);
      expect(sidecar.center.lat).toBe(glide.center.lat);
      expect(sidecar.zoom).toBe(glide.zoom);
      expect(sidecar.bearing).toBe(glide.bearing);
      expect(sidecar.pitch).toBe(glide.pitch);
    }
  });

  it('the glide is continuous across each intra-group cut (no camera pop)', () => {
    const frame = 1000 / 30;
    for (const cut of intraCuts) {
      const before = buildFramePayload(wire, indexedRoute, cut - frame).camera;
      const at = buildFramePayload(wire, indexedRoute, cut).camera;
      const after = buildFramePayload(wire, indexedRoute, cut + frame).camera;
      // One frame of glide moves the center by a tiny fraction of a degree;
      // an ungrouped arc at the same seam would be mid-Van-Wijk (zoomed out).
      const step = Math.hypot(at.center.lng - before.center.lng, at.center.lat - before.center.lat);
      const step2 = Math.hypot(after.center.lng - at.center.lng, after.center.lat - at.center.lat);
      expect(step).toBeLessThan(1e-3);
      expect(step2).toBeLessThan(1e-3);
      expect(at.zoom).toBe(14);
      expect(before.zoom).toBe(14);
      expect(after.zoom).toBe(14);
    }
  });

  it('grouping actually changes what the sidecar renders at the intra-group cuts', () => {
    // Guard against a vacuous pass: the same fixture compiled UNGROUPED must
    // put the camera on a transition arc at those cuts, and that arc must
    // differ from the glide the grouped payload renders.
    const { payload: ungrouped, indexedRoute: ungroupedRoute } = fixture();
    const wireU = roundTrip(ungrouped) as SetupCmd;
    for (const cut of intraCuts) {
      expect(findCameraTransitionSpanAt(wireU.timeline.transitionSpans, cut)).not.toBeNull();
      const arc = buildFramePayload(wireU, ungroupedRoute, cut).camera;
      const glide = buildFramePayload(wire, indexedRoute, cut).camera;
      expect(arc).not.toEqual(glide);
      // Parity holds on the ungrouped side too — same evaluator, same result.
      expect(arc).toEqual(sourceCamera(wireU.timeline, sceneViewport(wireU), cut));
    }
  });
});

// -- (c) Ungrouped compiles are unchanged except additive fields -----------

describe('clip groups — ungrouped fixtures are untouched', () => {
  const TIMELINE_KEYS = [
    'clipSpans',
    'groupSpans',
    'startCamera',
    'totalDurationMs',
    'transitionFeel',
    'transitionSpans',
  ];
  const TRANSITION_KEYS = [
    'cameraAuthority',
    'cutMs',
    'effectiveDurationMs',
    'endMs',
    'fromClipId',
    'startMs',
    'toClipId',
  ];

  it('the default 1-clip fixture compiles exactly as a bare compileTimeline call', () => {
    const payload = buildSetupPayload();
    const fromSource = compileTimeline(
      payload.clips,
      indexRoute(payload.route),
      payload.mapSettings,
      {},
    );
    expect(payload.timeline).toEqual(fromSource);
    expect(Object.keys(payload.timeline).sort()).toEqual(TIMELINE_KEYS);
    expect(payload.timeline.groupSpans).toStrictEqual([]);
    for (const s of payload.timeline.transitionSpans) {
      expect(Object.keys(s).sort()).toEqual(TRANSITION_KEYS);
      expect(s.cameraAuthority).toBe(true);
    }
  });

  it('an ungrouped 5-clip compile differs from the grouped one ONLY in groupSpans / cameraAuthority', () => {
    const { payload: grouped } = fixture([GROUP]);
    const { payload: ungrouped } = fixture();

    expect(ungrouped.timeline.groupSpans).toStrictEqual([]);
    for (const s of ungrouped.timeline.transitionSpans) expect(s.cameraAuthority).toBe(true);
    expect(Object.keys(ungrouped.timeline).sort()).toEqual(TIMELINE_KEYS);

    // Everything the marker layer / orchestrator reads is byte-for-byte the same.
    expect(grouped.timeline.clipSpans).toStrictEqual(ungrouped.timeline.clipSpans);
    expect(grouped.timeline.totalDurationMs).toBe(ungrouped.timeline.totalDurationMs);
    expect(grouped.timeline.startCamera).toStrictEqual(ungrouped.timeline.startCamera);
    expect(grouped.timeline.transitionFeel).toBe(ungrouped.timeline.transitionFeel);
    expect(stripAuthority(grouped.timeline.transitionSpans)).toStrictEqual(
      stripAuthority(ungrouped.timeline.transitionSpans),
    );
    // And the rest of the setup payload is identical.
    const { timeline: _g, ...restGrouped } = grouped;
    const { timeline: _u, ...restUngrouped } = ungrouped;
    expect(restGrouped).toStrictEqual(restUngrouped);
  });

  it('an ungrouped payload renders the source camera at every seam', () => {
    const { payload, indexedRoute } = fixture();
    const wire = roundTrip(payload) as SetupCmd;
    const viewport = sceneViewport(wire);
    for (const s of wire.timeline.transitionSpans) {
      for (const t of [s.startMs, s.cutMs, s.endMs - 1]) {
        expect(buildFramePayload(wire, indexedRoute, t).camera, `t=${t}`).toEqual(
          sourceCamera(wire.timeline, viewport, t),
        );
      }
    }
  });
});
