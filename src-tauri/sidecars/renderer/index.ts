// Renderer worker. Long-running Node sidecar that produces map frames for
// the export pipeline. Communicates with the Rust orchestrator over a
// line-delimited-JSON-on-stdin / length-prefixed-RGBA-on-stdout protocol.
//
// Phase 5 renderer strangle (completed): the worker is a protocol shell
// (this file) over the rendering backend behind backend.ts's interface —
// nativeBackend.ts, maplibre-gl-native in-process. The pre-cutover chrome
// backend (headless Chrome + maplibre-gl-js via puppeteer/CDP) was removed
// after the cutover; recover it from git history if an engine comparison
// is ever needed. TRAILCUT_RENDERER_BACKEND survives as a single-value
// switch ('native') so explicit-backend pins stay meaningful and stale
// values fail loud instead of silently rendering.
//
// Visual parity by import — the load-bearing invariant. Every visual
// decision (style spec, layer specs, source data, animation curves, camera
// math) lives in src/lib/mapVisuals/, src/lib/cameraIntent.ts,
// src/lib/routeLocation.ts. This worker imports the same modules the
// preview's MapView.tsx uses (via scene.ts); it never redefines them, and
// the backend consumes the engine-agnostic per-frame tuple translation.

import readline from 'node:readline';

import type { BackendName, Cmd, RenderCmd, RendererBackend, SetupCmd } from './backend';
import { selectBackendName, VERBOSE, verbose } from './backend';
import { buildFramePayload } from './scene';
import { indexRoute, type IndexedRoute } from '../../../src/lib/routeLocation';
import { createTileCache, defaultCacheDir, type TileCache } from './tileCache';
import { NativeBackend } from './nativeBackend';

// ---- Backend selection ------------------------------------------------------

function resolveBackendName(): BackendName {
  try {
    return selectBackendName(process.env.TRAILCUT_RENDERER_BACKEND);
  } catch (e) {
    // Loud failure — a stale 'chrome' or a typo silently falling back to a
    // default would make every explicit-backend gate meaningless.
    process.stderr.write(`[renderer] ${(e as Error).message}\n`);
    process.exit(1);
  }
}

const BACKEND_NAME: BackendName = resolveBackendName();

// ---- State ----------------------------------------------------------------

const tileCache: TileCache = createTileCache({
  dir: process.env.TRAILCUT_TILE_CACHE_DIR ?? defaultCacheDir(),
  offline: process.env.TRAILCUT_TILE_CACHE_OFFLINE === '1',
});

const backend: RendererBackend = new NativeBackend(tileCache);

let setupPayload: SetupCmd | null = null;
let indexedRoute: IndexedRoute | null = null;

// Liveness telemetry. The orchestrator and the worker talk over pipes;
// from the operator's seat, a stalled export looks identical to a busy
// one — both are silent. `currentActivity` describes what the worker
// thinks it is doing; the heartbeat interval (module bottom) prints it
// with elapsed-in-state so a hang is visible.
let currentActivity = 'starting';
let activityStartedAt = Date.now();
function setActivity(label: string): void {
  currentActivity = label;
  activityStartedAt = Date.now();
}

// ---- Command handlers -------------------------------------------------------

async function setup(payload: SetupCmd): Promise<void> {
  setupPayload = payload;
  await backend.setup(payload);
  indexedRoute = indexRoute(payload.route);
}

async function recycle(): Promise<void> {
  if (!setupPayload) {
    process.stderr.write('[renderer] recycle without prior setup, ignoring\n');
    return;
  }
  await backend.recycle();
  indexedRoute = indexRoute(setupPayload.route);
}

async function renderFrame(cmd: RenderCmd): Promise<void> {
  const tStart = Date.now();
  if (!setupPayload) {
    process.stderr.write('[renderer] render before setup, exiting\n');
    process.exit(1);
  }
  const payload = setupPayload;
  const t = cmd.project_time_ms;

  // Engine-agnostic per-frame translation (scene.ts) — identical tuples to
  // both backends; the backend only applies them and reads pixels back.
  const frame = buildFramePayload(payload, indexedRoute, t);
  verbose(
    `[renderer renderFrame f=${cmd.frame_index} +${Date.now() - tStart}ms] payload built t=${t}ms\n`,
  );

  const rendered = await backend.renderFrame(frame, cmd.frame_index);

  const writeStart = Date.now();
  writeFrame(rendered.rgba);
  const writeMs = Date.now() - writeStart;

  // Always-on per-frame summary. Future perf work has data without
  // re-instrumenting; deliberately concise (one line, named fields).
  const totalMs = Date.now() - tStart;
  process.stderr.write(
    `[renderer] frame ${cmd.frame_index} t=${t}ms total=${totalMs}ms ${rendered.detail} write=${writeMs}ms rgba=${rendered.rgba.length}B ` +
    `zoom=${frame.camera.zoom.toFixed(3)} center=${frame.camera.center.lng.toFixed(5)},${frame.camera.center.lat.toFixed(5)} ` +
    `bearing=${frame.camera.bearing.toFixed(1)} pitch=${frame.camera.pitch.toFixed(1)} ` +
    `css=${payload.cssViewport.w}x${payload.cssViewport.h} fb=${payload.framebuffer.w}x${payload.framebuffer.h} dpr=${payload.pixelRatio} ` +
    `backend=${BACKEND_NAME}\n`,
  );
}

// ---- Stdout writes --------------------------------------------------------

function writeReady(): void {
  process.stdout.write('{"ready":true}\n');
}

function writeFrame(buf: Uint8Array): void {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(buf.byteLength, 0);
  process.stdout.write(prefix);
  process.stdout.write(buf);
}

// ---- Stdin loop -----------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin });

const queue: string[] = [];
let busy = false;
let stdinClosed = false;

function processNext(): void {
  if (busy) return;
  const line = queue.shift();
  if (line === undefined) {
    if (stdinClosed) {
      void shutdownAndExit(0);
    }
    return;
  }
  busy = true;
  let cmd: Cmd;
  try {
    cmd = JSON.parse(line) as Cmd;
  } catch (e) {
    process.stderr.write(`[renderer] malformed JSON: ${(e as Error).message}\n`);
    process.exit(1);
  }
  switch (cmd.cmd) {
    case 'setup':
      setActivity('setup');
      setup(cmd).then(
        () => {
          setActivity('idle (post-setup)');
          writeReady();
          busy = false;
          processNext();
        },
        (e: Error) => {
          process.stderr.write(`[renderer] setup failed: ${e.message}\n${e.stack ?? ''}\n`);
          // Defer exit so any in-flight stderr (native binding load errors,
          // OOM diagnostics) has a chance to flush before we tear down.
          // Without this delay, the stderr ring only captures the surface
          // error, not the root cause.
          setTimeout(() => process.exit(1), 500);
        },
      );
      break;
    case 'render':
      setActivity(`render frame=${cmd.frame_index} t=${cmd.project_time_ms}ms`);
      renderFrame(cmd).then(
        () => {
          setActivity(`idle (post-frame ${cmd.frame_index})`);
          busy = false;
          processNext();
        },
        (e: Error) => {
          process.stderr.write(
            `[renderer] render error at frame ${cmd.frame_index} t=${cmd.project_time_ms}: ${e.message}\n${e.stack ?? ''}\n`,
          );
          setTimeout(() => process.exit(1), 500);
        },
      );
      break;
    case 'recycle':
      setActivity('recycle');
      recycle().then(
        () => {
          setActivity('idle (post-recycle)');
          writeReady();
          busy = false;
          processNext();
        },
        (e: Error) => {
          process.stderr.write(`[renderer] recycle failed: ${e.message}\n${e.stack ?? ''}\n`);
          setTimeout(() => process.exit(1), 500);
        },
      );
      break;
    case 'shutdown':
      setActivity('shutdown');
      void shutdownAndExit(0);
      break;
    default: {
      const c: { cmd?: string } = cmd as { cmd?: string };
      process.stderr.write(`[renderer] unknown cmd, ignoring: ${c.cmd}\n`);
      busy = false;
      processNext();
    }
  }
}

async function shutdownAndExit(code: number): Promise<void> {
  try { await backend.shutdown(); } catch { /* ignore */ }
  process.exit(code);
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  queue.push(line);
  processNext();
});

rl.on('close', () => {
  stdinClosed = true;
  if (!busy && queue.length === 0) {
    void shutdownAndExit(0);
  }
});

// Heartbeat — prints current activity + how long we've been in it. Gated
// behind TRAILCUT_RENDERER_VERBOSE=1: the per-frame summary line is
// already a healthy-export liveness signal; the heartbeat earns its keep
// during diagnosis of hangs. `unref` so the timer doesn't block shutdown.
if (VERBOSE) {
  setInterval(() => {
    const elapsed = Date.now() - activityStartedAt;
    process.stderr.write(
      `[renderer heartbeat] activity="${currentActivity}" elapsed=${elapsed}ms ` +
      `busy=${busy} queueDepth=${queue.length} backend=${BACKEND_NAME}\n`,
    );
  }, 15_000).unref();
}
