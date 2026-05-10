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
// Run: node src-tauri/tests/fixtures/golden-frames/generate_setup.mjs
// Output: setup.json in the same directory.
//
// Re-running this script produces byte-identical output (no Date.now,
// no random, JSON.stringify with stable key order from object literals).

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
// renders the route-full layer; the marker is data-driven from
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

// One synthetic clip whose id is referenced by every clipSpan (the
// orchestrator's `activeClipIdAt` does a clipSpans lookup; clips[] is also
// passed through for the waypoints layer). We pass a dummy single clip,
// not 150 — the timeline drives camera math; clips[] only feeds waypoint
// circles. A 1-clip waypoints set keeps the fixture small.
const clips = [
  {
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
  },
];

const mapSettings = {
  route_mode: 'full',
  waypoints_mode: 'full',
  follow_playhead: true,
  map_style: 'default',
  zoom: 16,
  bearing_mode: 'fixed',
  bearing_degrees: 0,
  bearing_stops: 3,
};

// Wire shape — matches what the chromium worker's setup handler reads.
// The Rust integration test loads this file, parses it as JSON, and feeds
// it into RenderExportRequest.project_state via #[serde(flatten)] (cmd,
// viewport, fps stripped first since they're re-injected by render_export).
const setup = {
  cmd: 'setup',
  viewport: { w: VIEWPORT_W, h: VIEWPORT_H },
  fps: FPS,
  timeline,
  route,
  clips,
  mapSettings,
};

const outPath = join(__dirname, 'setup.json');
writeFileSync(outPath, JSON.stringify(setup, null, 2) + '\n');
console.log(`wrote ${outPath} (${TOTAL_FRAMES} clip spans, ${TOTAL_DURATION_MS}ms total)`);
