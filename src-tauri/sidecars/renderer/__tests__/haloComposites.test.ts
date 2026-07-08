// Payload-level coverage for the halo group-opacity composite (patch 3,
// native/group-composite.patch): `resolveStaticPaints`'s `haloComposites`
// bucket has to reach both `buildStaticScene` (the setup-time seed) and
// `buildFramePayload` (the per-frame re-resolve, which is what makes a
// per-clip halo-opacity override land at a cut). Pure unit tests — no
// process spawn, no native binding — this only exercises scene.ts's
// engine-agnostic translation, same layer `nativeBackend.test.ts`-style
// process tests sit above.
//
// Run via `npm run test:renderer` (vitest.renderer.config.ts scopes
// __tests__/**/*.test.ts under this dir; the default `npm test` config does
// not include src-tauri/**).

import { describe, it, expect } from 'vitest';

import { buildSetupPayload } from './setupFixture';
import { buildStaticScene, buildFramePayload } from '../scene';
import { indexRoute } from '../../../../src/lib/routeLocation';
import {
  DEFAULT_MAP_SETTINGS,
  DEFAULT_ROUTE_HALO,
  type Clip,
} from '../../../../src/types';

const EXPECTED_GROUP_LAYERS = [
  ['route-full-halo', 'route-full-halo-core'],
  ['route-trail-halo', 'route-trail-halo-core'],
  ['waypoints-halo', 'waypoints-halo-core'],
  ['live-marker-halo', 'live-marker-halo-core'],
];

function expectFourGroupsInFixedOrder(groups: Array<{ layers: string[]; opacity: number }>): void {
  expect(groups).toHaveLength(4);
  groups.forEach((group, i) => {
    expect(group.layers).toEqual(EXPECTED_GROUP_LAYERS[i]);
    expect(Number.isFinite(group.opacity)).toBe(true);
  });
}

describe('halo group-composite payload wiring', () => {
  it('buildStaticScene carries the four groups in fixed order with finite opacities', () => {
    const payload = buildSetupPayload({
      mapSettings: { route: { ...DEFAULT_MAP_SETTINGS.route, halo: DEFAULT_ROUTE_HALO } },
    });
    const scene = buildStaticScene(payload);
    expectFourGroupsInFixedOrder(scene.haloComposites);
  });

  it('buildFramePayload carries the four groups in fixed order with finite opacities', () => {
    const payload = buildSetupPayload({
      mapSettings: { route: { ...DEFAULT_MAP_SETTINGS.route, halo: DEFAULT_ROUTE_HALO } },
    });
    const indexedRoute = payload.route ? indexRoute(payload.route) : null;
    const frame = buildFramePayload(payload, indexedRoute, 500);
    expectFourGroupsInFixedOrder(frame.haloComposites);
  });

  it('a per-clip route-halo opacity override changes the route-group composite opacity at that clip, not the project default', () => {
    const projectHalo = { ...DEFAULT_ROUTE_HALO, opacity: 0.6 };
    const overrideHalo = { ...DEFAULT_ROUTE_HALO, opacity: 0.3 };

    const clipA: Clip = {
      id: 'clip-a',
      path: '/dev/null/clip-a.mov',
      filename: 'clip-a.mov',
      created_at: '2024-06-01T12:00:00.000-07:00',
      duration_ms: 2000,
      gps: { lat: 37.7749, lng: -122.4194 },
      resolution: '1920x1080',
      frame_rate: 30,
      trim: { in_ms: 0, out_ms: 2000 },
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
    const clipB: Clip = {
      ...clipA,
      id: 'clip-b',
      path: '/dev/null/clip-b.mov',
      filename: 'clip-b.mov',
      created_at: '2024-06-01T12:00:02.000-07:00',
      map_overrides: { route: { halo: overrideHalo } },
    };

    const payload = buildSetupPayload({
      clips: [clipA, clipB],
      mapSettings: { route: { ...DEFAULT_MAP_SETTINGS.route, halo: projectHalo } },
    });
    const indexedRoute = payload.route ? indexRoute(payload.route) : null;

    // t=500 sits inside clip-a (project defaults); t=2500 sits inside
    // clip-b (route halo opacity overridden to 0.3). Both clips are 2s,
    // laid out back-to-back by compileTimeline in array order.
    const frameDefault = buildFramePayload(payload, indexedRoute, 500);
    const frameOverride = buildFramePayload(payload, indexedRoute, 2500);

    const routeFullDefault = frameDefault.haloComposites[0];
    const routeFullOverride = frameOverride.haloComposites[0];
    expect(routeFullDefault.layers).toEqual(['route-full-halo', 'route-full-halo-core']);
    expect(routeFullOverride.layers).toEqual(['route-full-halo', 'route-full-halo-core']);
    expect(routeFullOverride.opacity).not.toBeCloseTo(routeFullDefault.opacity, 6);

    // route-trail pair rides the same routePolicy as route-full — pins that
    // both members of the route halo move together at the cut.
    expect(frameOverride.haloComposites[1].opacity).toBeCloseTo(routeFullOverride.opacity, 10);
  });
});
