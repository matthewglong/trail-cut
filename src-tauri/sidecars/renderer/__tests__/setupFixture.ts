// Shared fixture builder. Used by both:
//   - protocol.test.ts (vitest, drives the worker directly).
//   - the Rust orchestrator integration test (which exec's the bundled
//     dist/setup_fixture.cjs and reads the JSON from stdout).
//
// Single source of truth for "the synthetic 1-clip 2s setup payload" so the
// two test sites can't drift. Build script bundles this to dist/setup_fixture.cjs;
// the Rust test invokes `node dist/setup_fixture.cjs`.

import { compileTimeline } from '../../../../src/lib/cameraIntent';
import { indexRoute } from '../../../../src/lib/routeLocation';
import {
  DEFAULT_MAP_SETTINGS,
  type Clip,
  type Route,
  type MapSettings,
} from '../../../../src/types';

export interface SetupFixtureOptions {
  viewportW?: number;
  viewportH?: number;
  fps?: number;
}

export function buildSetupPayload(opts: SetupFixtureOptions = {}) {
  const viewportW = opts.viewportW ?? 540;
  const viewportH = opts.viewportH ?? 960;
  const fps = opts.fps ?? 30;

  const clip: Clip = {
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
  };

  const route: Route = {
    source_path: '/dev/null/route.gpx',
    format: 'gpx',
    trackpoints: [
      { lat: 37.7749, lng: -122.4194, elevation: 50, timestamp: '2024-06-01T12:00:00.000-07:00' },
      { lat: 37.7755, lng: -122.4180, elevation: 55, timestamp: '2024-06-01T12:00:01.000-07:00' },
      { lat: 37.7760, lng: -122.4170, elevation: 60, timestamp: '2024-06-01T12:00:02.000-07:00' },
    ],
  };

  const mapSettings: MapSettings = {
    ...DEFAULT_MAP_SETTINGS,
    map_style: 'default',
    waypoints_mode: 'full',
    route_mode: 'full',
  };

  const timeline = compileTimeline([clip], indexRoute(route), mapSettings, {});

  return {
    cmd: 'setup' as const,
    viewport: { w: viewportW, h: viewportH },
    fps,
    timeline,
    route,
    clips: [clip],
    mapSettings,
  };
}

// CommonJS entry point: when run as a script, emit the default fixture as JSON
// to stdout. The bundled dist/setup_fixture.cjs is the artifact the Rust
// integration test invokes via `node`.
if (require.main === module) {
  process.stdout.write(JSON.stringify(buildSetupPayload()));
}
