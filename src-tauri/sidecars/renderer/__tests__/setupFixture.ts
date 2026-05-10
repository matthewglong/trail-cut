// Shared fixture builder. Used by both:
//   - protocol.test.ts (vitest, drives the worker directly).
//   - the Rust orchestrator integration test (which exec's the bundled
//     dist/setup_fixture.cjs and reads the JSON from stdout).
//
// Single source of truth for "the synthetic 1-clip 2s setup payload" so the
// two test sites can't drift. Build script bundles this to dist/setup_fixture.cjs;
// the Rust test invokes `node dist/setup_fixture.cjs`.
//
// CLI override: when run as a script with JSON piped on stdin, the overrides
// in that JSON are merged into the default payload. This lets multi-clip
// integration tests (Channel A composite) drive a real `compileTimeline`
// against custom clip paths/durations rather than stubbing the timeline.

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
  /** Override the default 1-clip array. When supplied, `compileTimeline`
   *  runs against this list instead of the synthetic clip-a. */
  clips?: Clip[];
  /** Override the default route. `null` skips route indexing entirely. */
  route?: Route | null;
  /** Merged into the default mapSettings. */
  mapSettings?: Partial<MapSettings>;
}

const DEFAULT_CLIP: Clip = {
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

const DEFAULT_ROUTE: Route = {
  source_path: '/dev/null/route.gpx',
  format: 'gpx',
  trackpoints: [
    { lat: 37.7749, lng: -122.4194, elevation: 50, timestamp: '2024-06-01T12:00:00.000-07:00' },
    { lat: 37.7755, lng: -122.4180, elevation: 55, timestamp: '2024-06-01T12:00:01.000-07:00' },
    { lat: 37.7760, lng: -122.4170, elevation: 60, timestamp: '2024-06-01T12:00:02.000-07:00' },
  ],
};

export function buildSetupPayload(opts: SetupFixtureOptions = {}) {
  const viewportW = opts.viewportW ?? 540;
  const viewportH = opts.viewportH ?? 960;
  const fps = opts.fps ?? 30;

  const clips: Clip[] = opts.clips ?? [DEFAULT_CLIP];
  const route: Route | null = opts.route === undefined ? DEFAULT_ROUTE : opts.route;

  const mapSettings: MapSettings = {
    ...DEFAULT_MAP_SETTINGS,
    map_style: 'default',
    waypoints_mode: 'full',
    route_mode: 'full',
    ...(opts.mapSettings ?? {}),
  };

  const indexedRoute = route ? indexRoute(route) : null;
  const timeline = compileTimeline(clips, indexedRoute, mapSettings, {});

  return {
    cmd: 'setup' as const,
    viewport: { w: viewportW, h: viewportH },
    fps,
    timeline,
    route,
    clips,
    mapSettings,
  };
}

// CommonJS entry point: when run as a script, optionally read JSON overrides
// from stdin and emit the resulting fixture as JSON to stdout. The bundled
// dist/setup_fixture.cjs is the artifact the Rust integration test invokes
// via `node`.
//
// Stdin protocol: empty stdin → use defaults; JSON object on stdin → parse
// and pass to buildSetupPayload as overrides. The integration tests pipe
// `{"clips": [...], "route": null}` to construct multi-clip payloads with
// real timeline data.
async function readStdinJson(): Promise<SetupFixtureOptions> {
  // If stdin is a TTY, no piped input — use defaults.
  if (process.stdin.isTTY) return {};
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  raw = raw.trim();
  if (raw.length === 0) return {};
  return JSON.parse(raw) as SetupFixtureOptions;
}

if (require.main === module) {
  readStdinJson()
    .then((overrides) => {
      process.stdout.write(JSON.stringify(buildSetupPayload(overrides)));
    })
    .catch((err) => {
      process.stderr.write(`setup_fixture: ${err}\n`);
      process.exit(1);
    });
}
