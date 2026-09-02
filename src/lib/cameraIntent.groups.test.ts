// Clip-group camera glide: compiler (`buildGroupSpans`), evaluator
// (`groupCameraAt`) and `cameraAt` dispatch. Pins the anchor sweep rule,
// entry/exit continuity and the marker-layer independence invariant from
// `docs/CLIP_GROUPS_HANDOFF.md` §2 / §7.
//
// Fixture conventions mirror `cameraIntent.test.ts`: `compilerClip` builds a
// full Clip record; clips are 10 s of media at speed 1 unless a test says
// otherwise; `created_at` is spaced so wall-clock is contiguous and sits
// inside the synthetic route's time range.

import { describe, it, expect } from 'vitest';
import {
  cameraAt,
  compileTimeline,
  groupCameraAt,
  groupSpanWithFirstMember,
  groupSpanWithLastMember,
  findTransitionSpanAt,
  findCameraTransitionSpanAt,
  activeClipIdAt,
  resolveIntent,
} from './cameraIntent';
import type {
  CameraIntent,
  CompiledTimeline,
  CompileTimelineProjectSettings,
  GroupSpan,
  ResolvedCamera,
  TransitionSpan,
  Viewport,
} from './cameraIntent';
import { indexRoute, bearingAt, parseTimestamp } from './routeLocation';
import type { IndexedRoute } from './routeLocation';
import { mkPoint } from './__fixtures__/routes';
import { seedWaypointsFromClips } from './waypoints';
import { buildPerFrameState } from './mapVisuals/perFrame';
import {
  DEFAULT_MAP_SETTINGS,
  type Clip,
  type ClipGroup,
  type MapSettings,
  type Route,
} from '../types';

// -- Fixtures ---------------------------------------------------------------

const TEN_S = 10_000;
const VIEWPORT: Viewport = { width: 1024, height: 1024, dpr: 1 };

/** Full Clip record so tests can override single fields without noise. */
function compilerClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c',
    path: '/tmp/c.mov',
    filename: 'c.mov',
    created_at: '2026-04-04T15:00:00Z',
    duration_ms: TEN_S,
    gps: { lat: 37.77, lng: -122.4 },
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
    ...overrides,
  };
}

/** Follow camera, fixed bearing 0 (the DEFAULT_MAP_SETTINGS shape). */
const FOLLOW_SETTINGS: MapSettings = {
  ...DEFAULT_MAP_SETTINGS,
  camera: {
    ...DEFAULT_MAP_SETTINGS.camera,
    follow_playhead: true,
    bearing_mode: 'fixed',
    bearing_degrees: 0,
    zoom: 14,
  },
};

const AUTO_BEARING_SETTINGS: MapSettings = {
  ...FOLLOW_SETTINGS,
  camera: { ...FOLLOW_SETTINGS.camera, bearing_mode: 'auto' },
};

const ROUTE_START_ISO = '2026-04-04T15:00:00Z';
const ROUTE_START_MS = parseTimestamp(ROUTE_START_ISO);

/** 1 Hz route, 0..180 s: a gentle arc — north with a growing eastward
 *  drift — so both location and `bearingAt` vary smoothly with time. */
function syntheticRoute(): { route: Route; indexed: IndexedRoute } {
  const trackpoints = [];
  for (let s = 0; s <= 180; s++) {
    const lat = 37.77 + s * 0.0002;
    const lng = -122.4 + 0.000004 * s * s;
    trackpoints.push(
      mkPoint(lat, lng, new Date(ROUTE_START_MS + s * 1000).toISOString()),
    );
  }
  const route: Route = { source_path: '/tmp/r.gpx', format: 'gpx', trackpoints };
  const indexed = indexRoute(route);
  if (!indexed) throw new Error('fixture route failed to index');
  return { route, indexed };
}

/** N contiguous 10 s clips a, b, c, ... starting at the route's origin. */
function contiguousClips(ids: string[], perClip: (i: number) => Partial<Clip> = () => ({})): Clip[] {
  return ids.map((id, i) =>
    compilerClip({
      id,
      created_at: new Date(ROUTE_START_MS + i * TEN_S).toISOString(),
      gps: { lat: 37.77 + i * 0.002, lng: -122.4 + i * 0.001 },
      ...perClip(i),
    }),
  );
}

function group(id: string, clip_ids: string[]): ClipGroup {
  return { id, clip_ids };
}

function span(tl: CompiledTimeline, clipId: string) {
  const s = tl.clipSpans.find((c) => c.clipId === clipId);
  if (!s) throw new Error(`no clip span ${clipId}`);
  return s;
}

function onlyGroup(tl: CompiledTimeline): GroupSpan {
  expect(tl.groupSpans).toHaveLength(1);
  return tl.groupSpans[0];
}

function pointOf(intent: CameraIntent): ResolvedCamera {
  return resolveIntent(intent, VIEWPORT);
}

function expectCameraClose(a: ResolvedCamera, b: ResolvedCamera, digits = 9) {
  expect(a.center.lng).toBeCloseTo(b.center.lng, digits);
  expect(a.center.lat).toBeCloseTo(b.center.lat, digits);
  expect(a.zoom).toBeCloseTo(b.zoom, digits);
  expect(a.bearing).toBeCloseTo(b.bearing, digits);
  expect(a.pitch).toBeCloseTo(b.pitch, digits);
}

function stripAuthority(spans: TransitionSpan[]) {
  return spans.map(({ cameraAuthority: _ignored, ...rest }) => rest);
}

// -- Anchor math ------------------------------------------------------------

describe('buildGroupSpans — anchor sweep rule', () => {
  const { indexed } = syntheticRoute();

  it('n=2: anchors at f = {0, 1} (group first/last frames)', () => {
    const clips = contiguousClips(['a', 'b']);
    const tl = compileTimeline(clips, indexed, FOLLOW_SETTINGS, {
      clip_groups: [group('g', ['a', 'b'])],
    });
    const g = onlyGroup(tl);
    expect(g.groupId).toBe('g');
    expect(g.memberClipIds).toEqual(['a', 'b']);
    expect(g.anchors.map((a) => a.tMs)).toEqual([
      span(tl, 'a').startMs,
      span(tl, 'b').endMs,
    ]);
    expect(g.startMs).toBe(span(tl, 'a').startMs);
    expect(g.endMs).toBe(span(tl, 'b').endMs);
  });

  it('n=3: anchors at f = {0, ½, 1} — the middle anchor is the middle clip’s midpoint', () => {
    const clips = contiguousClips(['a', 'b', 'c']);
    const tl = compileTimeline(clips, indexed, FOLLOW_SETTINGS, {
      clip_groups: [group('g', ['a', 'b', 'c'])],
    });
    const g = onlyGroup(tl);
    const b = span(tl, 'b');
    expect(g.anchors.map((a) => a.tMs)).toEqual([
      span(tl, 'a').startMs,
      (b.startMs + b.endMs) / 2,
      span(tl, 'c').endMs,
    ]);
  });

  it('n=5: member 3 anchors at the midpoint of its own span', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const clips = contiguousClips(ids, (i) => ({
      // Uneven lengths so "midpoint of ITS span" differs from "group midpoint".
      trim: { in_ms: 0, out_ms: (i + 1) * 2000 },
      duration_ms: TEN_S,
    }));
    const tl = compileTimeline(clips, indexed, FOLLOW_SETTINGS, {
      clip_groups: [group('g', ids)],
    });
    const g = onlyGroup(tl);
    expect(g.anchors).toHaveLength(5);
    const c = span(tl, 'c');
    expect(g.anchors[2].tMs).toBe((c.startMs + c.endMs) / 2);
    // f = k/(n−1): b at ¼, d at ¾ of their own spans.
    const b = span(tl, 'b');
    const d = span(tl, 'd');
    expect(g.anchors[1].tMs).toBe(b.startMs + 0.25 * (b.endMs - b.startMs));
    expect(g.anchors[3].tMs).toBe(d.startMs + 0.75 * (d.endMs - d.startMs));
    // Strictly increasing within the span.
    for (let i = 1; i < g.anchors.length; i++) {
      expect(g.anchors[i].tMs).toBeGreaterThan(g.anchors[i - 1].tMs);
    }
  });

  it('anchor wallMs matches the liveIntentForClipSpan translation under trim and 2× speed', () => {
    // Middle member: trimmed in 2 s, out 8 s, at 2× — its span is 3 s of
    // project time covering 6 s of wall-clock. The anchor at f=½ must sit
    // at wall-clock base + 2000 + 3000, which is exactly where the
    // UNGROUPED follow camera is at the same project-time.
    const clips = contiguousClips(['a', 'b', 'c'], (i) =>
      i === 1
        ? {
            trim: { in_ms: 2000, out_ms: 8000 },
            effects: { stabilize: { enabled: false, shakiness: 0 }, speed: 2 },
          }
        : {},
    );
    const ungrouped = compileTimeline(clips, indexed, FOLLOW_SETTINGS, {});
    const grouped = compileTimeline(clips, indexed, FOLLOW_SETTINGS, {
      clip_groups: [group('g', ['a', 'b', 'c'])],
    });
    const g = onlyGroup(grouped);
    const b = span(grouped, 'b');
    expect(b.endMs - b.startMs).toBe(3000);
    const anchor = g.anchors[1];
    expect(anchor.tMs).toBe(b.startMs + 1500);

    // Ungrouped follow camera at the same project-time — must be OUTSIDE
    // any transition window so the clip-span branch answers.
    expect(findTransitionSpanAt(ungrouped.transitionSpans, anchor.tMs)).toBeNull();
    const follow = pointOf(cameraAt(ungrouped, anchor.tMs));
    expect(anchor.camera.center.lng).toBeCloseTo(follow.center.lng, 12);
    expect(anchor.camera.center.lat).toBeCloseTo(follow.center.lat, 12);
    expect(anchor.camera.zoom).toBe(follow.zoom);
  });

  it('a per-clip zoom override moves only that member’s anchor', () => {
    const clips = contiguousClips(['a', 'b', 'c'], (i) =>
      i === 1 ? { map_overrides: { camera: { zoom: 17 } } } : {},
    );
    const tl = compileTimeline(clips, indexed, FOLLOW_SETTINGS, {
      clip_groups: [group('g', ['a', 'b', 'c'])],
    });
    const g = onlyGroup(tl);
    expect(g.anchors.map((a) => a.camera.zoom)).toEqual([14, 17, 14]);
  });

  it('bearing: fixed uses bearing_degrees; auto samples bearingAt at the anchor wall-clock', () => {
    const clips = contiguousClips(['a', 'b', 'c']);
    const fixed = compileTimeline(
      clips,
      indexed,
      { ...FOLLOW_SETTINGS, camera: { ...FOLLOW_SETTINGS.camera, bearing_degrees: 42 } },
      { clip_groups: [group('g', ['a', 'b', 'c'])] },
    );
    expect(onlyGroup(fixed).anchors.map((a) => a.camera.bearing)).toEqual([42, 42, 42]);

    const auto = compileTimeline(clips, indexed, AUTO_BEARING_SETTINGS, {
      clip_groups: [group('g', ['a', 'b', 'c'])],
    });
    const g = onlyGroup(auto);
    const b = span(auto, 'b');
    const wallMid = b.wallClockBaseMs + b.mediaInMs + 0.5 * (b.mediaOutMs - b.mediaInMs);
    const expected = bearingAt(wallMid, indexed);
    expect(expected).not.toBeNull();
    expect(g.anchors[1].camera.bearing).toBe(expected as number);
    // The route curves, so auto bearings are not all identical.
    const bearings = g.anchors.map((a) => a.camera.bearing);
    expect(new Set(bearings).size).toBeGreaterThan(1);
  });

  it('pitch: 60 for a member whose resolved map_style is 3d, 0 otherwise', () => {
    const clips = contiguousClips(['a', 'b', 'c'], (i) =>
      i === 1 ? { map_overrides: { camera: { map_style: '3d' } } } : {},
    );
    const tl = compileTimeline(clips, indexed, FOLLOW_SETTINGS, {
      clip_groups: [group('g', ['a', 'b', 'c'])],
    });
    expect(onlyGroup(tl).anchors.map((a) => a.camera.pitch)).toEqual([0, 60, 0]);
  });

  it('no route → clip.gps fallback → {0,0} when gps is null too', () => {
    const clips = contiguousClips(['a', 'b'], (i) => (i === 1 ? { gps: null } : {}));
    const tl = compileTimeline(clips, null, FOLLOW_SETTINGS, {
      clip_groups: [group('g', ['a', 'b'])],
    });
    const g = onlyGroup(tl);
    expect(g.anchors[0].camera.center).toEqual({ lng: clips[0].gps!.lng, lat: clips[0].gps!.lat });
    expect(g.anchors[1].camera.center).toEqual({ lng: 0, lat: 0 });
  });

  it('a group left with one member after filtering (hidden member) dissolves', () => {
    const clips = contiguousClips(['a', 'b'], (i) => (i === 1 ? { visible: false } : {}));
    const tl = compileTimeline(clips, indexed, FOLLOW_SETTINGS, {
      clip_groups: [group('g', ['a', 'b'])],
    });
    expect(tl.groupSpans).toEqual([]);
    expect(tl.clipSpans.map((s) => s.clipId)).toEqual(['a']);
  });

  it('a hidden middle member: the glide runs over the remaining members', () => {
    const clips = contiguousClips(['a', 'b', 'c'], (i) => (i === 1 ? { visible: false } : {}));
    const tl = compileTimeline(clips, indexed, FOLLOW_SETTINGS, {
      clip_groups: [group('g', ['a', 'b', 'c'])],
    });
    const g = onlyGroup(tl);
    expect(g.memberClipIds).toEqual(['a', 'c']);
    expect(g.anchors).toHaveLength(2);
    expect(g.anchors.map((a) => a.tMs)).toEqual([span(tl, 'a').startMs, span(tl, 'c').endMs]);
  });

  it('a group with a non-finite anchor is dropped (members degrade to per-clip camera)', () => {
    const clips = contiguousClips(['a', 'b'], (i) =>
      i === 1 ? { gps: { lat: Number.NaN, lng: 0 } } : {},
    );
    const tl = compileTimeline(clips, null, FOLLOW_SETTINGS, {
      clip_groups: [group('g', ['a', 'b'])],
    });
    expect(tl.groupSpans).toEqual([]);
    // With no group, the seam keeps its camera claim.
    expect(tl.transitionSpans.every((s) => s.cameraAuthority)).toBe(true);
  });

  it('absent and empty clip_groups compile identically', () => {
    const clips = contiguousClips(['a', 'b']);
    const absent = compileTimeline(clips, indexed, FOLLOW_SETTINGS, {});
    const empty = compileTimeline(clips, indexed, FOLLOW_SETTINGS, { clip_groups: [] });
    expect(absent).toEqual(empty);
    expect(absent.groupSpans).toEqual([]);
  });
});

// -- groupCameraAt ----------------------------------------------------------

describe('groupCameraAt', () => {
  const { indexed } = syntheticRoute();

  it('reproduces every anchor exactly at its knot and clamps outside the span', () => {
    const clips = contiguousClips(['a', 'b', 'c', 'd']);
    const tl = compileTimeline(clips, indexed, AUTO_BEARING_SETTINGS, {
      clip_groups: [group('g', ['a', 'b', 'c', 'd'])],
    });
    const g = onlyGroup(tl);
    for (const a of g.anchors) {
      expectCameraClose(groupCameraAt(g, a.tMs), a.camera, 9);
    }
    expect(groupCameraAt(g, g.startMs - 5000)).toEqual(groupCameraAt(g, g.startMs));
    expect(groupCameraAt(g, g.endMs + 5000)).toEqual(groupCameraAt(g, g.endMs));
  });

  it('n=2 is a straight constant-velocity glide in mercator space', () => {
    const clips = contiguousClips(['a', 'b']);
    const tl = compileTimeline(clips, null, FOLLOW_SETTINGS, {
      clip_groups: [group('g', ['a', 'b'])],
    });
    const g = onlyGroup(tl);
    const q = (f: number) => groupCameraAt(g, g.startMs + f * (g.endMs - g.startMs));
    const c0 = q(0), c25 = q(0.25), c50 = q(0.5), c75 = q(0.75);
    // Equal time steps → equal lng steps (mercator x is linear in lng).
    expect(c25.center.lng - c0.center.lng).toBeCloseTo(c50.center.lng - c25.center.lng, 10);
    expect(c50.center.lng - c25.center.lng).toBeCloseTo(c75.center.lng - c50.center.lng, 10);
  });

  it('bearing wraps the short way across 0° and stays in [0, 360)', () => {
    const clips = contiguousClips(['a', 'b'], (i) => ({
      map_overrides: { camera: { bearing_degrees: i === 0 ? 350 : 10 } },
    }));
    const tl = compileTimeline(clips, null, FOLLOW_SETTINGS, {
      clip_groups: [group('g', ['a', 'b'])],
    });
    const g = onlyGroup(tl);
    const mid = groupCameraAt(g, (g.startMs + g.endMs) / 2);
    expect(mid.bearing).toBeCloseTo(0, 9);
    const quarter = groupCameraAt(g, g.startMs + 0.25 * (g.endMs - g.startMs));
    expect(quarter.bearing).toBeCloseTo(355, 9);
    for (let f = 0; f <= 1; f += 0.05) {
      const b = groupCameraAt(g, g.startMs + f * (g.endMs - g.startMs)).bearing;
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(360);
    }
  });

  it('zoom that changes then holds never overshoots (monotone)', () => {
    const clips = contiguousClips(['a', 'b', 'c', 'd'], (i) => ({
      map_overrides: { camera: { zoom: i === 0 ? 12 : 16 } },
    }));
    const tl = compileTimeline(clips, null, FOLLOW_SETTINGS, {
      clip_groups: [group('g', ['a', 'b', 'c', 'd'])],
    });
    const g = onlyGroup(tl);
    let prev = -Infinity;
    for (let t = g.startMs; t <= g.endMs; t += 100) {
      const z = groupCameraAt(g, t).zoom;
      expect(z).toBeGreaterThanOrEqual(12 - 1e-9);
      expect(z).toBeLessThanOrEqual(16 + 1e-9);
      expect(z).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = z;
    }
  });

  it('coincident anchors (stationary hiker) stay finite', () => {
    const clips = contiguousClips(['a', 'b', 'c'], () => ({
      gps: { lat: 37.77, lng: -122.4 },
    }));
    const tl = compileTimeline(clips, null, FOLLOW_SETTINGS, {
      clip_groups: [group('g', ['a', 'b', 'c'])],
    });
    const g = onlyGroup(tl);
    for (let t = g.startMs; t <= g.endMs; t += 250) {
      const cam = groupCameraAt(g, t);
      expect(Number.isFinite(cam.center.lng)).toBe(true);
      expect(Number.isFinite(cam.center.lat)).toBe(true);
      expect(cam.center.lng).toBeCloseTo(-122.4, 9);
      expect(cam.center.lat).toBeCloseTo(37.77, 9);
    }
  });
});

// -- Continuity + dispatch --------------------------------------------------

describe('cameraAt with clip groups — continuity and disjoint authority', () => {
  const { indexed } = syntheticRoute();
  const IDS = ['a', 'b', 'c', 'd', 'e'];

  /** a | [b c d] | e — one group in the middle, ungrouped clips either side. */
  function middleGroupFixture(settings: MapSettings = AUTO_BEARING_SETTINGS) {
    const clips = contiguousClips(IDS);
    const groups = [group('g', ['b', 'c', 'd'])];
    const grouped = compileTimeline(clips, indexed, settings, { clip_groups: groups });
    const ungrouped = compileTimeline(clips, indexed, settings, {});
    return { clips, grouped, ungrouped, groupSpan: onlyGroup(grouped) };
  }

  it('intra-group seams keep their placement but lose camera authority; outer seams keep it', () => {
    const { grouped, ungrouped } = middleGroupFixture();
    expect(stripAuthority(grouped.transitionSpans)).toEqual(stripAuthority(ungrouped.transitionSpans));
    const byTo = new Map(grouped.transitionSpans.map((s) => [s.toClipId, s]));
    expect(byTo.get('a')!.cameraAuthority).toBe(true); // start → a
    expect(byTo.get('b')!.cameraAuthority).toBe(true); // a → b (entry)
    expect(byTo.get('c')!.cameraAuthority).toBe(false); // b → c
    expect(byTo.get('d')!.cameraAuthority).toBe(false); // c → d
    expect(byTo.get('e')!.cameraAuthority).toBe(true); // d → e (exit)
    expect(ungrouped.transitionSpans.every((s) => s.cameraAuthority)).toBe(true);
  });

  it('no lurch at member cuts: value AND finite-difference velocity continuous at every intra-group cutMs', () => {
    const { grouped } = middleGroupFixture();
    const intra = grouped.transitionSpans.filter((s) => !s.cameraAuthority);
    expect(intra).toHaveLength(2);
    const EPS = 1;
    for (const seam of intra) {
      const cut = seam.cutMs;
      // Sanity: the cut is inside the seam's window, i.e. the arc WOULD
      // have played here if the seam still had camera authority.
      expect(seam.startMs).toBeLessThan(cut);
      expect(seam.endMs).toBeGreaterThan(cut);

      const before = pointOf(cameraAt(grouped, cut - EPS));
      const at = pointOf(cameraAt(grouped, cut));
      const after = pointOf(cameraAt(grouped, cut + EPS));

      // C⁰ + C¹ in one pin: the two one-sided finite-difference velocities
      // must agree. A value jump J exactly at the cut would inflate one
      // side by J/EPS and the sides would disagree, so this catches
      // discontinuities as well as kinks. (A plain value comparison with a
      // fixed tolerance is the wrong pin — an auto-bearing glide
      // legitimately turns ~1e-3°/ms, so "before ≈ after" must be judged
      // against the glide's own velocity, which is what the check below
      // does.) Loose absolute sanity bounds guard against a gross jump.
      expect(Math.abs(after.center.lng - before.center.lng)).toBeLessThan(1e-4);
      expect(Math.abs(after.center.lat - before.center.lat)).toBeLessThan(1e-4);
      expect(Math.abs(after.zoom - before.zoom)).toBeLessThan(1e-2);
      expect(Math.abs(after.bearing - before.bearing)).toBeLessThan(1e-1);
      expect(Math.abs(after.pitch - before.pitch)).toBeLessThan(1e-2);

      const vel = (p: ResolvedCamera, q: ResolvedCamera) => ({
        lng: (q.center.lng - p.center.lng) / EPS,
        lat: (q.center.lat - p.center.lat) / EPS,
        zoom: (q.zoom - p.zoom) / EPS,
        bearing: (q.bearing - p.bearing) / EPS,
        pitch: (q.pitch - p.pitch) / EPS,
      });
      const vIn = vel(before, at);
      const vOut = vel(at, after);
      expect(vOut.lng).toBeCloseTo(vIn.lng, 9);
      expect(vOut.lat).toBeCloseTo(vIn.lat, 9);
      expect(vOut.zoom).toBeCloseTo(vIn.zoom, 9);
      expect(vOut.bearing).toBeCloseTo(vIn.bearing, 6);
      expect(vOut.pitch).toBeCloseTo(vIn.pitch, 9);
    }
  });

  it('the camera actually moves through the group (the glide is not a hold)', () => {
    const { grouped, groupSpan } = middleGroupFixture();
    const a = pointOf(cameraAt(grouped, groupSpan.startMs + 2000));
    const b = pointOf(cameraAt(grouped, groupSpan.endMs - 2000));
    expect(Math.abs(a.center.lat - b.center.lat)).toBeGreaterThan(1e-4);
  });

  it('entry: the arc lands on the glide at the window end; exit: it departs from the glide at the window start', () => {
    const { grouped, groupSpan } = middleGroupFixture();
    const entry = grouped.transitionSpans.find((s) => s.toClipId === 'b')!;
    const exit = grouped.transitionSpans.find((s) => s.fromClipId === 'd')!;
    expect(groupSpanWithFirstMember(grouped, 'b')).toBe(groupSpan);
    expect(groupSpanWithLastMember(grouped, 'd')).toBe(groupSpan);

    // Window end is inside the group (post-cut half extends into clip b).
    expect(entry.endMs).toBeGreaterThan(groupSpan.startMs);
    const landed = pointOf(cameraAt(grouped, entry.endMs));
    expectCameraClose(landed, groupCameraAt(groupSpan, entry.endMs), 9);
    // And the very next sample is the glide itself (no authority gap).
    expectCameraClose(
      pointOf(cameraAt(grouped, entry.endMs + 1)),
      groupCameraAt(groupSpan, entry.endMs + 1),
      12,
    );

    expect(exit.startMs).toBeLessThan(groupSpan.endMs);
    const departed = pointOf(cameraAt(grouped, exit.startMs));
    expectCameraClose(departed, groupCameraAt(groupSpan, exit.startMs), 9);
    expectCameraClose(
      pointOf(cameraAt(grouped, exit.startMs - 1)),
      groupCameraAt(groupSpan, exit.startMs - 1),
      12,
    );
  });

  it('entry/exit auto-durations are derived from the glide camera at the cut (anchor 1 / anchor n)', () => {
    // Move member b's zoom far from a's: the entry seam a→b should get a
    // LONGER auto duration than ungrouped only if the endpoint snapshot
    // changed. Here the snapshot at the cut (anchor 1 = b's first frame,
    // follow camera) equals ungrouped b's first-frame snapshot, so the
    // durations must be IDENTICAL — pinning that grouping does not perturb
    // the outer seams' widths for a follow camera.
    const { grouped, ungrouped } = middleGroupFixture();
    for (const to of ['b', 'e']) {
      const g = grouped.transitionSpans.find((s) => s.toClipId === to)!;
      const u = ungrouped.transitionSpans.find((s) => s.toClipId === to)!;
      expect(g.effectiveDurationMs).toBeCloseTo(u.effectiveDurationMs, 6);
    }
  });

  it('dense t-sweep: exactly one authority answers per t, and intra-group arcs never reach the output', () => {
    const { grouped, groupSpan } = middleGroupFixture();
    const intra = grouped.transitionSpans.filter((s) => !s.cameraAuthority);
    let intraSamples = 0;
    for (let t = 0; t <= grouped.totalDurationMs; t += 37) {
      const camTs = findCameraTransitionSpanAt(grouped.transitionSpans, t);
      const inGroup = t >= groupSpan.startMs && t < groupSpan.endMs;
      const insideIntra = intra.some((s) => t >= s.startMs && t <= s.endMs);
      const out = cameraAt(grouped, t);
      expect(out.kind).not.toBe('region');

      if (camTs) {
        // Authority 3 (camera transition): it must be an authoritative span.
        expect(camTs.cameraAuthority).toBe(true);
      } else if (inGroup) {
        // Authority 4 (group glide): output IS the glide sample.
        const cam = groupCameraAt(groupSpan, t);
        expect(out).toEqual({ kind: 'point', ...cam });
        if (insideIntra) intraSamples += 1;
      } else {
        // Authority 5 (clip span): an ungrouped clip's live intent.
        expect(['a', 'e']).toContain(activeClipIdAt(grouped, t));
      }
    }
    // The sweep actually crossed the intra-group windows.
    expect(intraSamples).toBeGreaterThan(0);
  });

  it('findTransitionSpanAt (marker lookup) still returns intra-group seams; the camera variant does not', () => {
    const { grouped } = middleGroupFixture();
    const seam = grouped.transitionSpans.find((s) => s.toClipId === 'c')!;
    expect(findTransitionSpanAt(grouped.transitionSpans, seam.cutMs)).toBe(seam);
    expect(findCameraTransitionSpanAt(grouped.transitionSpans, seam.cutMs)).toBeNull();
  });

  it('totalDurationMs and clipSpans are unchanged by grouping', () => {
    const { grouped, ungrouped } = middleGroupFixture();
    expect(grouped.totalDurationMs).toBe(ungrouped.totalDurationMs);
    expect(grouped.clipSpans).toEqual(ungrouped.clipSpans);
    expect(grouped.startCamera).toEqual(ungrouped.startCamera);
  });

  it('activeClipIdAt is unchanged by grouping at sampled t’s', () => {
    const { grouped, ungrouped } = middleGroupFixture();
    for (let t = -10; t <= grouped.totalDurationMs + 10; t += 113) {
      expect(activeClipIdAt(grouped, t)).toBe(activeClipIdAt(ungrouped, t));
    }
  });

  it('marker independence: buildPerFrameState for grouped vs ungrouped is identical except the camera', () => {
    const { clips, grouped, ungrouped } = middleGroupFixture();
    const waypoints = seedWaypointsFromClips(clips);
    const settings = AUTO_BEARING_SETTINGS;
    for (let t = 0; t <= grouped.totalDurationMs; t += 977) {
      const g = buildPerFrameState(grouped, t, indexed, clips, waypoints, settings, settings, VIEWPORT);
      const u = buildPerFrameState(ungrouped, t, indexed, clips, waypoints, settings, settings, VIEWPORT);
      const { camera: _gc, ...gRest } = g;
      const { camera: _uc, ...uRest } = u;
      expect(gRest).toEqual(uRest);
    }
  });

  it('t ≥ totalDurationMs holds the glide’s terminal frame when the last clip is grouped', () => {
    const clips = contiguousClips(['a', 'b', 'c']);
    const tl = compileTimeline(clips, indexed, AUTO_BEARING_SETTINGS, {
      clip_groups: [group('g', ['b', 'c'])],
    });
    const g = onlyGroup(tl);
    expect(g.endMs).toBe(tl.totalDurationMs);
    const terminal = { kind: 'point', ...groupCameraAt(g, g.endMs) };
    expect(cameraAt(tl, tl.totalDurationMs)).toEqual(terminal);
    expect(cameraAt(tl, tl.totalDurationMs + 5000)).toEqual(terminal);
    // Approaching from inside: the last in-range sample is the glide itself,
    // so the hold at endMs is reached continuously.
    expect(cameraAt(tl, tl.totalDurationMs - 1)).toEqual({
      kind: 'point',
      ...groupCameraAt(g, tl.totalDurationMs - 1),
    });
  });

  it('t ≥ totalDurationMs is unchanged when the last clip is NOT grouped', () => {
    const clips = contiguousClips(['a', 'b', 'c']);
    const grouped = compileTimeline(clips, indexed, AUTO_BEARING_SETTINGS, {
      clip_groups: [group('g', ['a', 'b'])],
    });
    const ungrouped = compileTimeline(clips, indexed, AUTO_BEARING_SETTINGS, {});
    expect(cameraAt(grouped, grouped.totalDurationMs)).toEqual(
      cameraAt(ungrouped, ungrouped.totalDurationMs),
    );
  });

  it('adjacent groups compose on their shared seam: from the earlier glide, to the later glide', () => {
    const clips = contiguousClips(['a', 'b', 'c', 'd']);
    const tl = compileTimeline(clips, indexed, AUTO_BEARING_SETTINGS, {
      clip_groups: [group('g1', ['a', 'b']), group('g2', ['c', 'd'])],
    });
    expect(tl.groupSpans.map((g) => g.groupId)).toEqual(['g1', 'g2']);
    const [g1, g2] = tl.groupSpans;
    const seam = tl.transitionSpans.find((s) => s.fromClipId === 'b' && s.toClipId === 'c')!;
    expect(seam.cameraAuthority).toBe(true);
    expectCameraClose(pointOf(cameraAt(tl, seam.startMs)), groupCameraAt(g1, seam.startMs), 9);
    expectCameraClose(pointOf(cameraAt(tl, seam.endMs)), groupCameraAt(g2, seam.endMs), 9);
    // The intra seams of both groups are non-authoritative.
    expect(tl.transitionSpans.find((s) => s.toClipId === 'b')!.cameraAuthority).toBe(false);
    expect(tl.transitionSpans.find((s) => s.toClipId === 'd')!.cameraAuthority).toBe(false);
  });

  it('a whole-timeline group: only the project-start seam keeps camera authority', () => {
    const clips = contiguousClips(['a', 'b', 'c']);
    const tl = compileTimeline(clips, indexed, FOLLOW_SETTINGS, {
      clip_groups: [group('g', ['a', 'b', 'c'])],
    });
    expect(tl.transitionSpans.map((s) => s.cameraAuthority)).toEqual([true, false, false]);
    const g = onlyGroup(tl);
    const start = tl.transitionSpans[0];
    expectCameraClose(pointOf(cameraAt(tl, start.endMs)), groupCameraAt(g, start.endMs), 9);
    // Scrubbing anywhere inside lands exactly on the glide.
    for (const t of [start.endMs + 1, 9_999, 10_000, 10_001, 15_000, 20_000, 29_999]) {
      expect(cameraAt(tl, t)).toEqual({ kind: 'point', ...groupCameraAt(g, t) });
    }
  });

  it('purity: two compiles of the same grouped input are deeply equal', () => {
    const { clips } = middleGroupFixture();
    const settings: CompileTimelineProjectSettings = { clip_groups: [group('g', ['b', 'c', 'd'])] };
    const x = compileTimeline(clips, indexed, AUTO_BEARING_SETTINGS, settings);
    const y = compileTimeline(clips, indexed, AUTO_BEARING_SETTINGS, settings);
    expect(x).toEqual(y);
  });
});
