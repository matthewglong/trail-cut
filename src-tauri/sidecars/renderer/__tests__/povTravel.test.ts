// Export-shaped coverage for the POV travel transition: the per-frame
// `layouts` bucket must reach `buildFramePayload` and — because the backend
// applies the layouts array sequentially — its marker-identity tuples must
// come AFTER the static resolution's, so the travel swap wins last-write
// inside the window and the static identity wins everywhere else. Pure unit
// tests over scene.ts's engine-agnostic translation (no native binding).
//
// Run via `npm run test:renderer`.

import { describe, it, expect } from 'vitest';

import { buildSetupPayload } from './setupFixture';
import { buildFramePayload } from '../scene';
import { indexRoute } from '../../../../src/lib/routeLocation';
import { EASE_PHASE_MS } from '../../../../src/lib/mapVisuals/animations';
import type { Clip, Route, TransitionSettings } from '../../../../src/types';

const T0 = Date.parse('2024-06-01T12:00:00.000-07:00');

function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

/** Route covering both clips and the inter-clip gap at 1 Hz, uniform
 *  movement — travel endpoints always resolve on GPX. */
const ROUTE: Route = {
  source_path: '/dev/null/travel-route.gpx',
  format: 'gpx',
  trackpoints: Array.from({ length: 76 }, (_, i) => ({
    lat: 37.7749 + i * 0.0001,
    lng: -122.4194,
    elevation: null,
    timestamp: iso(i * 1000),
  })),
};

function travelClips(): Clip[] {
  const base: Omit<Clip, 'id' | 'created_at' | 'gps' | 'trim'> = {
    path: '/dev/null/clip.mov',
    filename: 'clip.mov',
    duration_ms: 10_000,
    resolution: '1920x1080',
    frame_rate: 30,
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
  return [
    {
      ...base,
      id: 'clip-a',
      created_at: iso(0),
      gps: { lat: 37.7749, lng: -122.4194 },
      trim: { in_ms: 0, out_ms: 5_000 },
    },
    {
      ...base,
      id: 'clip-b',
      created_at: iso(60_000),
      gps: { lat: 37.7809, lng: -122.4194 },
      trim: { in_ms: 0, out_ms: 10_000 },
    },
  ];
}

/** Last-write-wins view of the layouts array — exactly the backend's
 *  sequential `setLayoutProperty` semantics. */
function effectiveLayout(
  layouts: Array<[string, string, unknown]>,
): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const [layer, prop, value] of layouts) m.set(`${layer}/${prop}`, value);
  return m;
}

/** Last-write-wins view of the paints array — the backend's sequential
 *  `setPaintProperty` semantics. */
function effectivePaint(
  paints: Array<[string, string, unknown]>,
): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const [layer, prop, value] of paints) m.set(`${layer}/${prop}`, value);
  return m;
}

describe('travel — export frame payload', () => {
  function payloadWithTravel() {
    const payload = buildSetupPayload({
      clips: travelClips(),
      route: ROUTE,
      mapSettings: {
        transition: {
          travel: {
            enabled: true,
            sync: false,
            playhead: {
              ...buildSetupPayload().mapSettings.pov,
              color: '#ff715b',
              marker: { kind: 'shape', shape: 'ring' },
            },
          },
        },
      },
    });
    const indexedRoute = indexRoute(payload.route)!;
    const span = payload.timeline.transitionSpans.find(
      (s: { fromClipId: string | null }) => s.fromClipId != null,
    )!;
    return { payload, indexedRoute, span };
  }

  it('an in-window frame carries the custom playhead style (last-write over statics)', () => {
    const { payload, indexedRoute, span } = payloadWithTravel();
    const tMid = Math.round((span.startMs + span.endMs) / 2);
    const frame = buildFramePayload(payload, indexedRoute, tMid);
    const layout = effectiveLayout(frame.layouts);
    expect(layout.get('live-marker-shape-primary/visibility')).toBe('visible');
    expect(layout.get('live-marker-shape-primary/icon-image')).toBe(
      'pov-ring-primary',
    );
    expect(layout.get('live-marker-dot/visibility')).toBe('none');
    // The full style rides the paints channel too: the custom color wins
    // last-write over the active clip's static POV tint.
    const paint = effectivePaint(frame.paints);
    expect(paint.get('live-marker-shape-primary/icon-color')).toBe('#ff715b');
    expect(paint.get('live-marker-pulse/circle-color')).toBe('#ff715b');
  });

  it('frames outside the window carry the clip playhead (statics win — dot, clip color)', () => {
    const { payload, indexedRoute, span } = payloadWithTravel();
    const clipColor = payload.mapSettings.pov.color;
    for (const t of [0, span.endMs + 200]) {
      const frame = buildFramePayload(payload, indexedRoute, t);
      const layout = effectiveLayout(frame.layouts);
      expect(layout.get('live-marker-dot/visibility')).toBe('visible');
      expect(layout.get('live-marker-shape-primary/visibility')).toBe('none');
      const paint = effectivePaint(frame.paints);
      expect(paint.get('live-marker-pulse/circle-color')).toBe(clipColor);
    }
  });

  it('travel disabled leaves every frame on the clip playhead', () => {
    const base = buildSetupPayload({ clips: travelClips(), route: ROUTE });
    const indexedRoute = indexRoute(base.route)!;
    const span = base.timeline.transitionSpans.find(
      (s: { fromClipId: string | null }) => s.fromClipId != null,
    )!;
    const tMid = Math.round((span.startMs + span.endMs) / 2);
    const layout = effectiveLayout(
      buildFramePayload(base, indexedRoute, tMid).layouts,
    );
    expect(layout.get('live-marker-dot/visibility')).toBe('visible');
    expect(layout.get('live-marker-shape-primary/visibility')).toBe('none');
  });

  it('show_playhead: false ships an empty live-marker source for in-window frames only', () => {
    const payload = buildSetupPayload({
      clips: travelClips(),
      route: ROUTE,
      mapSettings: {
        transition: { travel: { enabled: true, show_playhead: false } },
      },
    });
    const indexedRoute = indexRoute(payload.route)!;
    const span = payload.timeline.transitionSpans.find(
      (s: { fromClipId: string | null }) => s.fromClipId != null,
    )!;
    const featureCount = (t: number): number => {
      const frame = buildFramePayload(payload, indexedRoute, t);
      const entry = frame.sources.find(([id]) => id === 'live-marker')!;
      return (entry[1] as { features: unknown[] }).features.length;
    };
    const tMid = Math.round((span.startMs + span.endMs) / 2);
    expect(featureCount(tMid)).toBe(0);
    expect(featureCount(0)).toBe(1);
    expect(featureCount(span.endMs + 200)).toBe(1);
  });

  it('draw_route forces the trail visible during the window when route mode is none', () => {
    const payload = buildSetupPayload({
      clips: travelClips(),
      route: ROUTE,
      mapSettings: {
        route: { ...buildSetupPayload().mapSettings.route, mode: 'none' },
        transition: { travel: { enabled: true } },
      },
    });
    const indexedRoute = indexRoute(payload.route)!;
    const span = payload.timeline.transitionSpans.find(
      (s: { fromClipId: string | null }) => s.fromClipId != null,
    )!;
    const tMid = Math.round((span.startMs + span.endMs) / 2);
    const inWindow = buildFramePayload(payload, indexedRoute, tMid);
    expect(effectiveLayout(inWindow.layouts).get('route-trail-line/visibility')).toBe(
      'visible',
    );
    const trail = inWindow.sources.find(([id]) => id === 'route-trail')![1] as {
      geometry: { coordinates: unknown[] };
    };
    expect(trail.geometry.coordinates.length).toBeGreaterThan(1);
    const outside = buildFramePayload(payload, indexedRoute, 0);
    expect(effectiveLayout(outside.layouts).get('route-trail-line/visibility')).toBe(
      'none',
    );
  });
});

// The POV dot is a MapLibre circle layer with TWO independent opacity
// channels: `circle-opacity` (fill) and `circle-stroke-opacity` (ring,
// default 1). The seam-ease `fade` envelope multiplies the single
// `paints.dotOpacity` scalar (perFrame.ts), so unless the frame payload
// drives BOTH channels from it the ring stays at full strength while the
// fill dissolves — a visible hard ring at every faded seam. Regression
// lock for the export side of that fix; MapView.tsx mirrors these tuples.
describe('seam ease (fade) — dot fill and stroke ride one opacity', () => {
  const FADE_MS = EASE_PHASE_MS.medium;

  function fadeFixture(eases: TransitionSettings) {
    const payload = buildSetupPayload({
      clips: travelClips(),
      route: ROUTE,
      mapSettings: { transition: eases },
    });
    const indexedRoute = indexRoute(payload.route)!;
    const span = payload.timeline.transitionSpans.find(
      (s: { fromClipId: string | null }) => s.fromClipId != null,
    )!;
    return { payload, indexedRoute, cutMs: span.cutMs };
  }

  /** Last-write-wins values of the dot's two opacity channels, plus the
   *  raw tuple counts — a channel the payload never emits reads
   *  `undefined` here rather than silently passing a numeric compare. */
  function dotOpacities(frame: { paints: Array<[string, string, unknown]> }) {
    const paint = effectivePaint(frame.paints);
    const emitted = (prop: string) =>
      frame.paints.filter(([l, p]) => l === 'live-marker-dot' && p === prop)
        .length;
    return {
      fill: paint.get('live-marker-dot/circle-opacity'),
      stroke: paint.get('live-marker-dot/circle-stroke-opacity'),
      fillTuples: emitted('circle-opacity'),
      strokeTuples: emitted('circle-stroke-opacity'),
    };
  }

  it('ease_out: both dot opacity channels are emitted and equal inside the window', () => {
    const f = fadeFixture({ ease_out: { style: 'fade', speed: 'medium' } });
    // 50ms before the cut = deep into the OUT ramp (v = 50/400).
    const inside = dotOpacities(
      buildFramePayload(f.payload, f.indexedRoute, f.cutMs - 50),
    );
    expect(inside.fillTuples).toBeGreaterThanOrEqual(1);
    expect(inside.strokeTuples).toBeGreaterThanOrEqual(1);
    expect(typeof inside.stroke).toBe('number');
    expect(inside.stroke).toBe(inside.fill);
    expect(inside.fill as number).toBeLessThan(1);
  });

  it('ease_in: both channels track the post-cut ramp together', () => {
    const f = fadeFixture({ ease_in: { style: 'fade', speed: 'medium' } });
    const inside = dotOpacities(
      buildFramePayload(f.payload, f.indexedRoute, f.cutMs + 50),
    );
    expect(typeof inside.stroke).toBe('number');
    expect(inside.stroke).toBe(inside.fill);
    expect(inside.fill as number).toBeLessThan(1);
  });

  it('well outside the fade window both channels are restored to 1', () => {
    const f = fadeFixture({
      ease_in: { style: 'fade', speed: 'medium' },
      ease_out: { style: 'fade', speed: 'medium' },
    });
    for (const t of [f.cutMs - FADE_MS - 200, f.cutMs + FADE_MS + 200]) {
      const outside = dotOpacities(
        buildFramePayload(f.payload, f.indexedRoute, t),
      );
      expect(outside.fill).toBe(1);
      expect(outside.stroke).toBe(1);
    }
  });

  it('the stroke channel is emitted on every frame, not only during eases', () => {
    // No eases configured at all: the tuple must still ship (a payload that
    // only emits it mid-fade would leave a stale ring opacity behind).
    const payload = buildSetupPayload({ clips: travelClips(), route: ROUTE });
    const indexedRoute = indexRoute(payload.route)!;
    const d = dotOpacities(buildFramePayload(payload, indexedRoute, 1_000));
    expect(d.strokeTuples).toBeGreaterThanOrEqual(1);
    expect(d.stroke).toBe(1);
    expect(d.stroke).toBe(d.fill);
  });
});
