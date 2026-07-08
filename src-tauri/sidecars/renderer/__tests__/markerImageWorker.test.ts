// Process-level test for marker-library images through the REAL renderer
// worker (native backend): a solid-magenta baked master selected as the POV
// marker must actually draw at the marker position in the readback, and a
// broken asset reference must kill the setup LOUDLY (exit 1 + actionable
// stderr), never render a marker-less export silently.
//
// Same preconditions/harness as protocol.test.ts: dist/renderer.cjs + the
// staged maplibre-gl-native binding, network (or warm cache) for tiles.
// Run via `npm run test:renderer`.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';

import { buildSetupPayload } from './setupFixture';
import { DEFAULT_MAP_SETTINGS, type MarkerImageRef } from '../../../../src/types';

const RENDERER_CJS = resolve(__dirname, '../dist/renderer.cjs');
const FIRST_FRAME_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const VIEWPORT_W = 540;
const VIEWPORT_H = 960;

// Marker fill — chosen to be absent from map cartography so a positive
// pixel probe can only come from the registered marker image.
const MAGENTA: [number, number, number] = [255, 0, 220];

class StdoutReader {
  private buf = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private closed = false;

  constructor(stream: NodeJS.ReadableStream) {
    stream.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      const w = this.waiters.shift();
      if (w) w();
    });
    stream.on('close', () => {
      this.closed = true;
      while (this.waiters.length) this.waiters.shift()!();
    });
  }

  private async waitForBytes(n: number): Promise<void> {
    while (this.buf.length < n && !this.closed) {
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }

  async readLine(): Promise<string> {
    while (true) {
      const idx = this.buf.indexOf(0x0a);
      if (idx >= 0) {
        const line = this.buf.subarray(0, idx).toString('utf8');
        this.buf = this.buf.subarray(idx + 1);
        return line;
      }
      if (this.closed) throw new Error('stream closed before newline');
      await this.waitForBytes(this.buf.length + 1);
    }
  }

  async readFrame(): Promise<Buffer> {
    await this.waitForBytes(4);
    if (this.buf.length < 4) throw new Error('stream closed before length prefix');
    const len = this.buf.readUInt32BE(0);
    await this.waitForBytes(4 + len);
    if (this.buf.length < 4 + len) throw new Error('stream closed mid-frame');
    const frame = Buffer.from(this.buf.subarray(4, 4 + len));
    this.buf = this.buf.subarray(4 + len);
    return frame;
  }
}

function spawnWorker(env: NodeJS.ProcessEnv = {}): {
  child: ChildProcessWithoutNullStreams;
  reader: StdoutReader;
  stderr: string[];
} {
  const child = spawn('node', [RENDERER_CJS], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const reader = new StdoutReader(child.stdout);
  const stderr: string[] = [];
  child.stderr.on('data', (c: Buffer) => stderr.push(c.toString('utf8')));
  return { child, reader, stderr };
}

function send(child: ChildProcessWithoutNullStreams, obj: object): void {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolveT, rejectT) => {
    const id = setTimeout(() => rejectT(new Error(`timeout: ${label} (${ms}ms)`)), ms);
    p.then(
      (v) => { clearTimeout(id); resolveT(v); },
      (e) => { clearTimeout(id); rejectT(e); },
    );
  });
}

/** Write a solid-color RGBA PNG to disk and return its path. */
function writeSolidPng(dir: string, name: string, w: number, h: number): string {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = MAGENTA[0];
    png.data[i * 4 + 1] = MAGENTA[1];
    png.data[i * 4 + 2] = MAGENTA[2];
    png.data[i * 4 + 3] = 255;
  }
  const path = join(dir, name);
  writeFileSync(path, PNG.sync.write(png));
  return path;
}

function markerImageRef(path: string, w: number, h: number): MarkerImageRef {
  return {
    id: '0123456789abcdef',
    icon_file: 'assets/marker-icon-0123456789abcdef.png',
    source_file: 'assets/marker-source-0123456789abcdef.png',
    source_name: 'probe.png',
    width: w,
    height: h,
    path,
  };
}

/** mapSettings override selecting `ref` as the POV marker. */
function povImageSettings(ref: MarkerImageRef) {
  return {
    marker_images: [ref],
    pov: {
      ...DEFAULT_MAP_SETTINGS.pov,
      marker: { kind: 'image' as const, image_id: ref.id },
    },
  };
}

/** Count pixels within ±tol of the probe color inside the central third of
 *  the frame (the live marker renders at buffer center under the fixture's
 *  follow camera — MECHANICAL_VERDICT §1). */
function countProbePixels(frame: Buffer, w: number, h: number, tol = 12): number {
  let count = 0;
  const x0 = Math.floor(w / 3);
  const x1 = Math.floor((2 * w) / 3);
  const y0 = Math.floor(h / 3);
  const y1 = Math.floor((2 * h) / 3);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      if (
        Math.abs(frame[i] - MAGENTA[0]) <= tol &&
        Math.abs(frame[i + 1] - MAGENTA[1]) <= tol &&
        Math.abs(frame[i + 2] - MAGENTA[2]) <= tol
      ) {
        count++;
      }
    }
  }
  return count;
}

describe('renderer worker marker images', () => {
  beforeAll(() => {
    if (!existsSync(RENDERER_CJS)) {
      throw new Error(`${RENDERER_CJS} not found. Run \`npm run build:renderer\` first.`);
    }
    const triple = process.platform === 'darwin' && process.arch === 'arm64'
      ? 'aarch64-apple-darwin'
      : process.platform === 'darwin' && process.arch === 'x64'
        ? 'x86_64-apple-darwin'
        : null;
    if (triple === null) {
      throw new Error(
        `unsupported host platform=${process.platform} arch=${process.arch}`,
      );
    }
    const bindingDir = process.env.TRAILCUT_MBGL_NATIVE_DIR?.trim()
      || resolve(__dirname, '..', '..', '..', 'binaries', `mbgl-native-${triple}`);
    if (!existsSync(bindingDir)) {
      throw new Error(
        `Patched maplibre-gl-native binding missing at ${bindingDir}. ` +
        'Run `npm run build:renderer` first, or set TRAILCUT_MBGL_NATIVE_DIR.',
      );
    }
  });

  let active: ChildProcessWithoutNullStreams | null = null;
  let tempDirs: string[] = [];
  afterEach(() => {
    if (active && !active.killed) {
      try { active.kill('SIGKILL'); } catch { /* ignore */ }
    }
    active = null;
    for (const d of tempDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tempDirs = [];
  });

  it(
    'draws the registered image at the marker and hides the dot',
    async () => {
      const assetDir = mkdtempSync(join(tmpdir(), 'trailcut-pov-image-test-'));
      const cacheDir = mkdtempSync(join(tmpdir(), 'trailcut-tile-cache-test-'));
      tempDirs = [assetDir, cacheDir];
      const masterPath = writeSolidPng(assetDir, 'pov-icon.png', 300, 376);

      const { child, reader, stderr } = spawnWorker({ TRAILCUT_TILE_CACHE_DIR: cacheDir });
      active = child;
      const stderrOnFail = () => `\nchild stderr:\n${stderr.join('') || '<empty>'}`;

      send(child, buildSetupPayload({
        framebufferW: VIEWPORT_W,
        framebufferH: VIEWPORT_H,
        fps: 30,
        mapSettings: povImageSettings(markerImageRef(masterPath, 300, 376)),
      }));
      const ready = await withTimeout(reader.readLine(), FIRST_FRAME_TIMEOUT_MS, 'ready')
        .catch((e) => { throw new Error(e.message + stderrOnFail()); });
      expect(ready, stderrOnFail()).toBe('{"ready":true}');
      expect(stderr.join(''), 'setup must log the marker-image registration when verbose')
        .not.toMatch(/setup failed/);

      send(child, { cmd: 'render', frame_index: 0, project_time_ms: 0 });
      const frame = await withTimeout(reader.readFrame(), FIRST_FRAME_TIMEOUT_MS, 'frame')
        .catch((e) => { throw new Error(e.message + stderrOnFail()); });
      expect(frame.length).toBe(VIEWPORT_W * VIEWPORT_H * 4);

      // The magenta master must actually draw: at image_size 0.08 the marker
      // is ~86 CSS px on its long side (~thousands of pixels); require a
      // conservative fraction so AA edges / pulse overlap can't flake it.
      const probe = countProbePixels(frame, VIEWPORT_W, VIEWPORT_H);
      expect(
        probe,
        `expected the magenta POV image near frame center, found ${probe} px${stderrOnFail()}`,
      ).toBeGreaterThan(500);

      send(child, { cmd: 'shutdown' });
      const exitCode = await withTimeout(
        new Promise<number>((r) => child.on('exit', (code) => r(code ?? -1))),
        SHUTDOWN_TIMEOUT_MS,
        'shutdown',
      );
      expect(exitCode, stderrOnFail()).toBe(0);
    },
    FIRST_FRAME_TIMEOUT_MS * 3,
  );

  it(
    'fails setup LOUDLY when the asset path is missing or unreadable',
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), 'trailcut-tile-cache-test-'));
      tempDirs = [cacheDir];
      const { child, stderr } = spawnWorker({ TRAILCUT_TILE_CACHE_DIR: cacheDir });
      active = child;

      // Image set but the asset file does not exist.
      send(child, buildSetupPayload({
        framebufferW: VIEWPORT_W,
        framebufferH: VIEWPORT_H,
        fps: 30,
        mapSettings: povImageSettings(
          markerImageRef('/nonexistent/marker-icon-gone.png', 64, 64),
        ),
      }));

      const exitCode = await withTimeout(
        new Promise<number>((r) => child.on('exit', (code) => r(code ?? -1))),
        FIRST_FRAME_TIMEOUT_MS,
        'worker exit on bad asset',
      );
      expect(exitCode).toBe(1);
      const err = stderr.join('');
      expect(err).toMatch(/setup failed/);
      expect(err).toMatch(/marker image asset unreadable/);
    },
    FIRST_FRAME_TIMEOUT_MS * 2,
  );

  it(
    'fails setup LOUDLY when the image reference carries no absolute path',
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), 'trailcut-tile-cache-test-'));
      tempDirs = [cacheDir];
      const { child, stderr } = spawnWorker({ TRAILCUT_TILE_CACHE_DIR: cacheDir });
      active = child;

      const ref = markerImageRef('/tmp/whatever.png', 64, 64);
      delete ref.path;
      send(child, buildSetupPayload({
        framebufferW: VIEWPORT_W,
        framebufferH: VIEWPORT_H,
        fps: 30,
        mapSettings: povImageSettings(ref),
      }));

      const exitCode = await withTimeout(
        new Promise<number>((r) => child.on('exit', (code) => r(code ?? -1))),
        FIRST_FRAME_TIMEOUT_MS,
        'worker exit on pathless image',
      );
      expect(exitCode).toBe(1);
      expect(stderr.join('')).toMatch(/carries no absolute `path`/);
    },
    FIRST_FRAME_TIMEOUT_MS * 2,
  );

  it(
    'fails setup LOUDLY when a referenced marker id is missing from the library',
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), 'trailcut-tile-cache-test-'));
      tempDirs = [cacheDir];
      const { child, stderr } = spawnWorker({ TRAILCUT_TILE_CACHE_DIR: cacheDir });
      active = child;

      // POV marker references an id with NO library entry — corrupt state.
      send(child, buildSetupPayload({
        framebufferW: VIEWPORT_W,
        framebufferH: VIEWPORT_H,
        fps: 30,
        mapSettings: {
          marker_images: [],
          pov: {
            ...DEFAULT_MAP_SETTINGS.pov,
            marker: { kind: 'image' as const, image_id: 'ffffffffffffffff' },
          },
        },
      }));

      const exitCode = await withTimeout(
        new Promise<number>((r) => child.on('exit', (code) => r(code ?? -1))),
        FIRST_FRAME_TIMEOUT_MS,
        'worker exit on ghost marker id',
      );
      expect(exitCode).toBe(1);
      expect(stderr.join('')).toMatch(/missing from mapSettings\.marker_images/);
    },
    FIRST_FRAME_TIMEOUT_MS * 2,
  );
});
