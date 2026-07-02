// End-to-end hash-key audit (task 119). The on-disk tile cache MUST be
// keyed on sha256 of the *original* resource URL — that key contract is
// what lets every worker (and the golden/orchestrator tests) share one
// warm cache across runs and backends. Historically the hazard was the
// chrome page's `trailcut://r?u=<base64url(originalUrl)>` rewrite leaking
// into the hash (task 119); the native backend has no rewrite (mbgl hands
// the Node request bridge original URLs), but the disk contract is still
// the thing every warm-cache consumer depends on, so the end-to-end pin
// stays: spawn the bundled worker, let it populate a temp cache dir, and
// match what landed on disk against expected `sha256(originalUrl)` keys
// for URLs the style references.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';

import { buildSetupPayload } from './setupFixture';

const RENDERER_CJS = resolve(__dirname, '../dist/renderer.cjs');

const VIEWPORT_W = 540;
const VIEWPORT_H = 960;
const FIRST_FRAME_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

// Known OpenFreeMap URLs the default style fetches. The style URL itself is
// always fetched first (the addProtocol path serves it), so it's the most
// reliable anchor for this assertion. Other URLs (sprite, glyph, tile-set
// metadata) are fetched on style.load but their exact form depends on the
// style JSON we don't want to inline here.
const KNOWN_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
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
      await new Promise<void>((res) => this.waiters.push(res));
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

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolveT, rejectT) => {
    const id = setTimeout(() => rejectT(new Error(`timeout: ${label} (${ms}ms)`)), ms);
    p.then((v) => { clearTimeout(id); resolveT(v); }, (e) => { clearTimeout(id); rejectT(e); });
  });
}

function send(child: ChildProcessWithoutNullStreams, obj: object): void {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

describe('tile-cache hash-key parity (end-to-end)', () => {
  beforeAll(() => {
    if (!existsSync(RENDERER_CJS)) {
      throw new Error('renderer dist missing. Run `npm run build:renderer` first.');
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
    'on-disk cache filenames are sha256(originalUrl), not sha256(trailcut://...)',
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), 'trailcut-key-parity-'));
      activeCacheDir = cacheDir;

      const child = spawn('node', [RENDERER_CJS], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, TRAILCUT_TILE_CACHE_DIR: cacheDir },
      });
      active = child;
      const reader = new StdoutReader(child.stdout);
      const stderr: string[] = [];
      child.stderr.on('data', (c: Buffer) => stderr.push(c.toString('utf8')));
      const stderrOnFail = () => `\nchild stderr:\n${stderr.join('') || '<empty>'}`;

      // Drive setup + 1 render so the worker fetches at minimum: the style
      // doc, glyph metadata, sprite metadata, plus the first viewport's tile
      // set. Any of those landing in the cache is enough to inspect.
      send(child, buildSetupPayload({ framebufferW: VIEWPORT_W, framebufferH: VIEWPORT_H, fps: 30 }));
      const ready = await withTimeout(reader.readLine(), FIRST_FRAME_TIMEOUT_MS, 'ready')
        .catch((e) => { throw new Error(e.message + stderrOnFail()); });
      expect(ready, stderrOnFail()).toBe('{"ready":true}');

      send(child, { cmd: 'render', frame_index: 0, project_time_ms: 0 });
      const frame = await withTimeout(reader.readFrame(), FIRST_FRAME_TIMEOUT_MS, 'frame')
        .catch((e) => { throw new Error(e.message + stderrOnFail()); });
      expect(frame.length).toBe(VIEWPORT_W * VIEWPORT_H * 4);

      send(child, { cmd: 'shutdown' });
      await withTimeout(
        new Promise<number>((res) => child.on('exit', (code) => res(code ?? -1))),
        SHUTDOWN_TIMEOUT_MS,
        'shutdown',
      );
      active = null;

      // ---- Assertions -----
      const files = listAllFiles(cacheDir);
      expect(files.length, 'cache should contain entries after one render' + stderrOnFail()).toBeGreaterThan(0);

      // (1) Layout: every file matches `{2-hex}/{2-hex}/{64-hex}` relative to
      // the cache root. `.tmp.*` write-files would imply a torn write.
      for (const f of files) {
        expect(f).not.toMatch(/\.tmp\./);
        const rel = f.slice(cacheDir.length + 1);
        expect(rel, `unexpected cache path: ${rel}`).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
      }

      // (2) The style URL hashes to a key that exists in the cache. This is
      // the load-bearing assertion: if the bridge hashed on the trailcut://
      // URL, this expected key would NOT be present.
      const expectedStyleKey = sha256Hex(KNOWN_STYLE_URL);
      const styleShardDir = join(cacheDir, expectedStyleKey.slice(0, 2), expectedStyleKey.slice(2, 4));
      const expectedStylePath = join(styleShardDir, expectedStyleKey);
      expect(
        existsSync(expectedStylePath),
        `expected cache entry for sha256("${KNOWN_STYLE_URL}") = ${expectedStyleKey} ` +
        `at ${expectedStylePath}, but it is missing. If hash-key parity has regressed (cache ` +
        `keyed on trailcut:// URL instead of original), the actual on-disk keys won't match. ` +
        `Cache contents:\n  ${files.map((f) => f.slice(cacheDir.length + 1)).join('\n  ')}` +
        stderrOnFail(),
      ).toBe(true);

      // (3) Defensive: no filename should contain a base64-padding character
      // or 'trailcut' substring. `sha256` outputs lowercase hex only.
      for (const f of files) {
        const base = f.slice(f.lastIndexOf('/') + 1);
        expect(base, `cache filename ${base} contains non-hex chars`).toMatch(/^[0-9a-f]{64}$/);
        expect(base.includes('trailcut'), `cache filename should not contain 'trailcut'`).toBe(false);
      }
    },
    FIRST_FRAME_TIMEOUT_MS * 5,
  );
});
