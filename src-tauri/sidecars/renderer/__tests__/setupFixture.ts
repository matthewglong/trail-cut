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

import {
  canonicalMapViewport,
  type AspectRatio,
  type OutputResolution,
} from '../../../../src/lib/layout';
import { compileTimeline } from '../../../../src/lib/cameraIntent';
import { indexRoute } from '../../../../src/lib/routeLocation';
import {
  DEFAULT_MAP_SETTINGS,
  type Clip,
  type Route,
  type MapSettings,
} from '../../../../src/types';

export interface SetupFixtureOptions {
  /** Export aspect — drives `canonicalMapViewport`, which yields the
   *  cssViewport dims and pixelRatio under the lever model. Defaults to
   *  '9_16'. */
  aspect?: AspectRatio;
  /** Framebuffer width — the actual pixel buffer the worker reads back.
   *  Defaults to 540 (matches the protocol/golden-frame fixtures' 540×960
   *  map slot). */
  framebufferW?: number;
  /** Framebuffer height. Defaults to 960. */
  framebufferH?: number;
  fps?: number;
  /** Export output resolution. Defaults to '1080p'. Drives `pixelRatio` via
   *  `canonicalMapViewport`'s multiplier model. */
  outputResolution?: OutputResolution;
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
  const aspect: AspectRatio = opts.aspect ?? '9_16';
  const framebufferW = opts.framebufferW ?? 540;
  const framebufferH = opts.framebufferH ?? 960;
  const fps = opts.fps ?? 30;
  const outputResolution: OutputResolution = opts.outputResolution ?? '1080p';

  // Under the lever model, `canonicalMapViewport` derives cssViewport dims
  // and pixelRatio from (aspect, slot pixel dims, outputResolution). The
  // cssViewport's aspect matches the slot's aspect; pixelRatio is the
  // output-resolution multiplier (1.0 @ 1080p, 4/3 @ 1440p, 2.0 @ 2160p).
  // See `MAP_RENDERING_PLAN.md` §"The lever model" and
  // `src/lib/layout.ts:canonicalMapViewport`.
  const canonical = canonicalMapViewport(
    aspect,
    framebufferW,
    framebufferH,
    outputResolution,
  );
  const pixelRatio = canonical.pixelRatio;
  const cssViewportW = canonical.cssW;
  const cssViewportH = canonical.cssH;

  const clips: Clip[] = opts.clips ?? [DEFAULT_CLIP];
  const route: Route | null = opts.route === undefined ? DEFAULT_ROUTE : opts.route;

  const overrides = opts.mapSettings ?? {};
  const mapSettings: MapSettings = {
    ...DEFAULT_MAP_SETTINGS,
    camera: {
      ...DEFAULT_MAP_SETTINGS.camera,
      map_style: 'default',
      ...(overrides.camera ?? {}),
    },
    route: {
      ...DEFAULT_MAP_SETTINGS.route,
      mode: 'full',
      ...(overrides.route ?? {}),
      size: {
        ...DEFAULT_MAP_SETTINGS.route.size,
        ...(overrides.route?.size ?? {}),
      },
    },
    waypoints: {
      ...DEFAULT_MAP_SETTINGS.waypoints,
      mode: 'full',
      ...(overrides.waypoints ?? {}),
      size: {
        ...DEFAULT_MAP_SETTINGS.waypoints.size,
        ...(overrides.waypoints?.size ?? {}),
      },
    },
    pov: {
      ...DEFAULT_MAP_SETTINGS.pov,
      ...(overrides.pov ?? {}),
      size: {
        ...DEFAULT_MAP_SETTINGS.pov.size,
        ...(overrides.pov?.size ?? {}),
      },
    },
  };

  const indexedRoute = route ? indexRoute(route) : null;
  const timeline = compileTimeline(clips, indexedRoute, mapSettings, {});

  return {
    cmd: 'setup' as const,
    cssViewport: { w: cssViewportW, h: cssViewportH },
    framebuffer: { w: framebufferW, h: framebufferH },
    pixelRatio,
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
