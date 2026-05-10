// Process-level protocol test for the chromium renderer worker. Spawns
// the bundled worker as a child process, walks setup → render → recycle →
// render → shutdown, asserts the wire format on each step. Mirrors the
// native renderer's __tests__/protocol.test.ts; same assertions, longer
// timeouts to absorb cold Chromium launch.
//
// Gated behind `npm run test:renderer` (separate vitest config)
// because the test:
//   - requires dist/renderer.cjs + dist/page-init.bundle.js (run
//     build:renderer first; fails up front if missing),
//   - requires TRAILCUT_CHROME_BIN pointing at a Chrome binary,
//   - requires internet access for OpenFreeMap tile fetches on first run,
//   - is structurally heavy: cold Chromium first frame is 5+ s.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';

import { buildSetupPayload } from './setupFixture';

const RENDERER_CJS = resolve(__dirname, '../dist/renderer.cjs');
const PAGE_BUNDLE = resolve(__dirname, '../dist/page-init.bundle.js');

// First-frame budget: cold Chromium launch + first tile prefetch. Very
// generous on CI; the spike measured ~5s warm. 60s gives margin for slow
// CI hosts.
const FIRST_FRAME_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const VIEWPORT_W = 540;
const VIEWPORT_H = 960;

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

  private async waitForBytes(n: number, signal?: AbortSignal): Promise<void> {
    while (this.buf.length < n && !this.closed) {
      await new Promise<void>((resolveWait, rejectWait) => {
        this.waiters.push(resolveWait);
        if (signal) {
          const onAbort = () => rejectWait(new Error('reader aborted'));
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }
  }

  async readLine(signal?: AbortSignal): Promise<string> {
    while (true) {
      const idx = this.buf.indexOf(0x0a); // '\n'
      if (idx >= 0) {
        const line = this.buf.subarray(0, idx).toString('utf8');
        this.buf = this.buf.subarray(idx + 1);
        return line;
      }
      if (this.closed) throw new Error('stream closed before newline');
      await this.waitForBytes(this.buf.length + 1, signal);
    }
  }

  async readFrame(signal?: AbortSignal): Promise<Buffer> {
    await this.waitForBytes(4, signal);
    if (this.buf.length < 4) throw new Error('stream closed before length prefix');
    const len = this.buf.readUInt32BE(0);
    await this.waitForBytes(4 + len, signal);
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

function listAllFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries) {
      const full = join(d, name);
      let s;
      try { s = statSync(full); } catch { continue; }
      if (s.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
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

describe('renderer worker protocol', () => {
  beforeAll(() => {
    if (!existsSync(RENDERER_CJS)) {
      throw new Error(
        `${RENDERER_CJS} not found. Run \`npm run build:renderer\` first.`,
      );
    }
    if (!existsSync(PAGE_BUNDLE)) {
      throw new Error(
        `${PAGE_BUNDLE} not found. Run \`npm run build:renderer\` first.`,
      );
    }
    if (!process.env.TRAILCUT_CHROME_BIN) {
      throw new Error(
        'TRAILCUT_CHROME_BIN env var not set. Set it to a Chrome binary path ' +
        'before running this test (task 118 resolves this from a bundled binary).',
      );
    }
  });

  let active: ChildProcessWithoutNullStreams | null = null;
  let activeCacheDir: string | null = null;
  afterEach(() => {
    if (active && !active.killed) {
      try { active.kill('SIGKILL'); } catch { /* ignore */ }
    }
    active = null;
    if (activeCacheDir) {
      try { rmSync(activeCacheDir, { recursive: true, force: true }); }
      catch { /* ignore */ }
      activeCacheDir = null;
    }
  });

  it(
    'walks setup → render → recycle → render → shutdown',
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), 'trailcut-tile-cache-test-'));
      activeCacheDir = cacheDir;
      const { child, reader, stderr } = spawnWorker({ TRAILCUT_TILE_CACHE_DIR: cacheDir });
      active = child;
      const stderrOnFail = () => `\nchild stderr:\n${stderr.join('') || '<empty>'}`;

      // ---- setup ----
      send(child, buildSetupPayload({ viewportW: VIEWPORT_W, viewportH: VIEWPORT_H, fps: 30 }));
      const ready1 = await withTimeout(
        reader.readLine(),
        FIRST_FRAME_TIMEOUT_MS,
        'first ready',
      ).catch((e) => { throw new Error(e.message + stderrOnFail()); });
      expect(ready1, stderrOnFail()).toBe('{"ready":true}');

      // ---- render frame 0 ----
      send(child, { cmd: 'render', frame_index: 0, project_time_ms: 0 });
      const frame1 = await withTimeout(
        reader.readFrame(),
        FIRST_FRAME_TIMEOUT_MS,
        'first frame',
      ).catch((e) => { throw new Error(e.message + stderrOnFail()); });
      const expectedBytes = VIEWPORT_W * VIEWPORT_H * 4;
      expect(frame1.length).toBe(expectedBytes);
      const allZero = frame1.every((b) => b === 0);
      expect(allZero, 'rendered frame is all-zero RGBA').toBe(false);

      // ---- recycle ----
      send(child, { cmd: 'recycle' });
      const ready2 = await withTimeout(
        reader.readLine(),
        FIRST_FRAME_TIMEOUT_MS,
        'recycle ready',
      ).catch((e) => { throw new Error(e.message + stderrOnFail()); });
      expect(ready2).toBe('{"ready":true}');

      // ---- render frame 1 (post-recycle) ----
      send(child, { cmd: 'render', frame_index: 1, project_time_ms: 1000 });
      const frame2 = await withTimeout(
        reader.readFrame(),
        FIRST_FRAME_TIMEOUT_MS,
        'post-recycle frame',
      ).catch((e) => { throw new Error(e.message + stderrOnFail()); });
      expect(frame2.length).toBe(expectedBytes);

      // ---- shutdown ----
      send(child, { cmd: 'shutdown' });
      const exitCode = await withTimeout(
        new Promise<number>((resolveExit) => {
          child.on('exit', (code) => resolveExit(code ?? -1));
        }),
        SHUTDOWN_TIMEOUT_MS,
        'shutdown',
      );
      expect(exitCode, `stderr:\n${stderr.join('')}`).toBe(0);
    },
    FIRST_FRAME_TIMEOUT_MS * 5,
  );

  it(
    'two consecutive renders at the same project_time_ms produce byte-identical RGBA',
    async () => {
      // The determinism contract — same (timeline, t) must produce same
      // bytes across boots. Catches non-determinism from setNow regressions,
      // missing rAFs, or random tile-load races.
      const cacheDir = mkdtempSync(join(tmpdir(), 'trailcut-tile-cache-test-'));
      activeCacheDir = cacheDir;
      const { child, reader, stderr } = spawnWorker({ TRAILCUT_TILE_CACHE_DIR: cacheDir });
      active = child;
      const stderrOnFail = () => `\nchild stderr:\n${stderr.join('') || '<empty>'}`;

      send(child, buildSetupPayload({ viewportW: VIEWPORT_W, viewportH: VIEWPORT_H, fps: 30 }));
      const ready = await withTimeout(reader.readLine(), FIRST_FRAME_TIMEOUT_MS, 'ready');
      expect(ready, stderrOnFail()).toBe('{"ready":true}');

      send(child, { cmd: 'render', frame_index: 0, project_time_ms: 500 });
      const frameA = await withTimeout(reader.readFrame(), FIRST_FRAME_TIMEOUT_MS, 'frame A');
      send(child, { cmd: 'render', frame_index: 1, project_time_ms: 500 });
      const frameB = await withTimeout(reader.readFrame(), FIRST_FRAME_TIMEOUT_MS, 'frame B');

      expect(frameA.length).toBe(frameB.length);
      const equal = frameA.equals(frameB);
      expect(equal, `byte mismatch between two renders at same t.${stderrOnFail()}`).toBe(true);

      send(child, { cmd: 'shutdown' });
      await withTimeout(
        new Promise<number>((resolveExit) => child.on('exit', (code) => resolveExit(code ?? -1))),
        SHUTDOWN_TIMEOUT_MS,
        'shutdown',
      );
    },
    FIRST_FRAME_TIMEOUT_MS * 5,
  );

  it(
    'second worker renders from cache with TRAILCUT_TILE_CACHE_OFFLINE=1',
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), 'trailcut-tile-cache-test-'));
      activeCacheDir = cacheDir;

      // ---- worker A: online, populates the cache ----
      const a = spawnWorker({ TRAILCUT_TILE_CACHE_DIR: cacheDir });
      active = a.child;
      const stderrA = () => `\nworker A stderr:\n${a.stderr.join('') || '<empty>'}`;

      send(a.child, buildSetupPayload({ viewportW: VIEWPORT_W, viewportH: VIEWPORT_H, fps: 30 }));
      const readyA = await withTimeout(
        a.reader.readLine(), FIRST_FRAME_TIMEOUT_MS, 'A ready',
      ).catch((e) => { throw new Error(e.message + stderrA()); });
      expect(readyA, stderrA()).toBe('{"ready":true}');

      send(a.child, { cmd: 'render', frame_index: 0, project_time_ms: 0 });
      const frameA = await withTimeout(
        a.reader.readFrame(), FIRST_FRAME_TIMEOUT_MS, 'A frame',
      ).catch((e) => { throw new Error(e.message + stderrA()); });
      expect(frameA.length).toBe(VIEWPORT_W * VIEWPORT_H * 4);

      send(a.child, { cmd: 'shutdown' });
      const exitA = await withTimeout(
        new Promise<number>((resolveExit) => a.child.on('exit', (code) => resolveExit(code ?? -1))),
        SHUTDOWN_TIMEOUT_MS,
        'A shutdown',
      );
      expect(exitA, stderrA()).toBe(0);
      active = null;

      // Cache shape on disk: {2-char}/{2-char}/{64-char-hex}, no .tmp.* leftovers.
      // Same as the native renderer's protocol test — the cache module is
      // unchanged, so the disk layout is unchanged.
      const files = listAllFiles(cacheDir);
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        expect(f).not.toMatch(/\.tmp\./);
        const rel = f.slice(cacheDir.length + 1);
        expect(rel).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
      }

      // ---- worker B: offline, reads from the populated cache ----
      const b = spawnWorker({
        TRAILCUT_TILE_CACHE_DIR: cacheDir,
        TRAILCUT_TILE_CACHE_OFFLINE: '1',
      });
      active = b.child;
      const stderrB = () => `\nworker B stderr:\n${b.stderr.join('') || '<empty>'}`;

      send(b.child, buildSetupPayload({ viewportW: VIEWPORT_W, viewportH: VIEWPORT_H, fps: 30 }));
      const readyB = await withTimeout(
        b.reader.readLine(), FIRST_FRAME_TIMEOUT_MS, 'B ready',
      ).catch((e) => { throw new Error(e.message + stderrB()); });
      expect(readyB, stderrB()).toBe('{"ready":true}');

      send(b.child, { cmd: 'render', frame_index: 0, project_time_ms: 0 });
      const frameB = await withTimeout(
        b.reader.readFrame(), FIRST_FRAME_TIMEOUT_MS, 'B frame',
      ).catch((e) => { throw new Error(e.message + stderrB()); });
      expect(frameB.length).toBe(VIEWPORT_W * VIEWPORT_H * 4);

      send(b.child, { cmd: 'shutdown' });
      const exitB = await withTimeout(
        new Promise<number>((resolveExit) => b.child.on('exit', (code) => resolveExit(code ?? -1))),
        SHUTDOWN_TIMEOUT_MS,
        'B shutdown',
      );
      expect(exitB, stderrB()).toBe(0);
      active = null;
    },
    FIRST_FRAME_TIMEOUT_MS * 5,
  );
});
