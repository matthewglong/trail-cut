// One-off generator for the golden-frame fixture's setup.json.
//
// Per task 117: the fixture is a 5-second single-clip timeline at 30 fps
// over a slow-pan camera path from (lng=11.5820, lat=48.1351) to
// (lng=11.5780, lat=48.1340), zoom 16, bearing 0, pitch 0. The path is
// label-dense (Munich Marienplatz, OpenFreeMap liberty) and the per-frame
// lng/lat delta lands in the sub-pixel "wobble regime" at zoom 16.
//
// Determinism strategy: we don't rely on `compileTimeline`'s Van Wijk arcs
// or any time-based curve. We hand-author 150 stationary clip spans (one
// per frame at 30 fps × 5 s), each with a `point` CameraIntent at the
// linearly-interpolated camera. `findClipSpanAt` is half-open with the
// last span closed on the right, so frame N at project_time_ms = N*1000/30
// hits span N exactly, returning span N's intent unchanged.
// `transitionSpans` is empty: no Van Wijk between adjacent stationary
// spans, no time-based curve at all.
//
// Wire-shape strategy: everything EXCEPT the hand-authored timeline comes
// from the shared fixture builder (`dist/setup_fixture.cjs`, bundled from
// __tests__/setupFixture.ts) — the single source of truth the protocol and
// orchestrator tests already use. That builder tracks the live
// SetupCmd/MapSettings/Clip shapes, so this fixture can no longer rot
// silently when the wire shape evolves (it did once: the original
// hand-inlined mapSettings predated the camera/route/waypoints/pov
// restructure, and the golden tests failed at worker setup until this
// script was re-run).
//
// Preconditions: `npm run build:renderer` (produces dist/setup_fixture.cjs).
// Run: node src-tauri/tests/fixtures/golden-frames/generate_setup.mjs
// Output: setup.json in the same directory.
//
// Re-running this script produces byte-identical output (no Date.now,
// no random, JSON.stringify with stable key order from object literals).

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// The shared fixture builder — bundled CJS, tracks the live wire shapes.
const { buildSetupPayload } = require(
  join(__dirname, '..', '..', '..', 'sidecars', 'renderer', 'dist', 'setup_fixture.cjs'),
);

const VIEWPORT_W = 540;
const VIEWPORT_H = 960;
const FPS = 30;
const TOTAL_DURATION_MS = 5000;
const TOTAL_FRAMES = (TOTAL_DURATION_MS * FPS) / 1000; // 150

// Camera path endpoints — task 117 spec.
const START_LNG = 11.5820;
const START_LAT = 48.1351;
const END_LNG = 11.5780;
const END_LAT = 48.1340;
const ZOOM = 16.0;
const BEARING = 0;
const PITCH = 0;

// Wall-clock anchor for the synthetic clip. Picked deterministically;
// any fixed ISO timestamp works as long as it parses.
const CLIP_CREATED_AT = '2024-06-01T12:00:00.000-07:00';
const WALL_CLOCK_BASE_MS = Date.parse(CLIP_CREATED_AT); // deterministic

// Linear interpolation helper. Frame i at i/(TOTAL_FRAMES-1) along the path.
// Using TOTAL_FRAMES-1 so frame 0 is the start point exactly and frame
// (TOTAL_FRAMES-1) is the end point exactly.
function lerp(a, b, t) {
  return a + (b - a) * t;
}

function cameraAtFrame(i) {
  const u = i / (TOTAL_FRAMES - 1);
  return {
    center: {
      lng: lerp(START_LNG, END_LNG, u),
      lat: lerp(START_LAT, END_LAT, u),
    },
    zoom: ZOOM,
    bearing: BEARING,
    pitch: PITCH,
  };
}

// Build 150 stationary clip spans, one per frame. Each span owns
// [i*1000/30, (i+1)*1000/30) ms. The last span is closed on the right so
// project_time_ms = TOTAL_DURATION_MS hits the final span (defensive).
const clipSpans = [];
const FRAME_MS = 1000 / FPS;
for (let i = 0; i < TOTAL_FRAMES; i++) {
  const startMs = i * FRAME_MS;
  const endMs = (i + 1) * FRAME_MS;
  const cam = cameraAtFrame(i);
  clipSpans.push({
    clipId: `frame-${String(i).padStart(4, '0')}`,
    startMs,
    endMs,
    mediaInMs: 0,
    mediaOutMs: endMs - startMs,
    canonicalSeekMs: startMs,
    speed: 1,
    wallClockBaseMs: WALL_CLOCK_BASE_MS + startMs,
    intent: {
      kind: 'point',
      center: cam.center,
      zoom: cam.zoom,
      bearing: cam.bearing,
      pitch: cam.pitch,
    },
  });
}

// startCamera matches frame 0's camera so the t<0 hold is sensible.
const startCamera = {
  center: { lng: START_LNG, lat: START_LAT },
  zoom: ZOOM,
  bearing: BEARING,
  pitch: PITCH,
};

const timeline = {
  clipSpans,
  // Empty: no Van Wijk between stationary point spans. With
  // transitionSpans=[], findTransitionSpanAt returns null and cameraAt
  // falls through to findClipSpanAt → liveIntentForClipSpan → returns
  // span.intent unchanged for point intents. Fully deterministic.
  transitionSpans: [],
  totalDurationMs: TOTAL_DURATION_MS,
  startCamera,
  transitionFeel: 'natural',
};

// Synthetic 3-trackpoint route matching the camera path. The fixture
// renders the route decoration layers; the live marker is data-driven from
// wallClockTrace, which finds the route point matching wallMs.
const route = {
  source_path: '/dev/null/route.gpx',
  format: 'gpx',
  trackpoints: [
    {
      lat: START_LAT,
      lng: START_LNG,
      elevation: 520,
      timestamp: new Date(WALL_CLOCK_BASE_MS).toISOString(),
    },
    {
      lat: lerp(START_LAT, END_LAT, 0.5),
      lng: lerp(START_LNG, END_LNG, 0.5),
      elevation: 520,
      timestamp: new Date(WALL_CLOCK_BASE_MS + TOTAL_DURATION_MS / 2).toISOString(),
    },
    {
      lat: END_LAT,
      lng: END_LNG,
      elevation: 520,
      timestamp: new Date(WALL_CLOCK_BASE_MS + TOTAL_DURATION_MS).toISOString(),
    },
  ],
};

// One synthetic clip whose id matches clipSpans[0] (the orchestrator's
// `activeClipIdAt` does a clipSpans lookup; clips[] also feeds per-clip
// map overrides). Field shape rides the builder's DEFAULT_CLIP so new Clip
// fields (color metadata etc.) are picked up automatically — we override
// only what the fixture pins.
const clip = {
  id: 'frame-0000',
  path: '/dev/null/clip-a.mov',
  filename: 'clip-a.mov',
  created_at: CLIP_CREATED_AT,
  duration_ms: TOTAL_DURATION_MS,
  gps: { lat: START_LAT, lng: START_LNG },
  resolution: '1920x1080',
  frame_rate: 30,
  trim: { in_ms: 0, out_ms: TOTAL_DURATION_MS },
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

// Build the payload through the shared builder (current wire shape: modern
// MapSettings with camera/route/waypoints/pov blocks, top-level waypoints,
// readback, canonical cssViewport/pixelRatio for 9_16 @ 540×960 @ 1080p),
// then swap in the hand-authored deterministic timeline.
const setup = buildSetupPayload({
  aspect: '9_16',
  framebufferW: VIEWPORT_W,
  framebufferH: VIEWPORT_H,
  fps: FPS,
  outputResolution: '1080p',
  clips: [clip],
  route,
});
setup.timeline = timeline;

const outPath = join(__dirname, 'setup.json');
writeFileSync(outPath, JSON.stringify(setup, null, 2) + '\n');
console.log(`wrote ${outPath} (${TOTAL_FRAMES} clip spans, ${TOTAL_DURATION_MS}ms total)`);
