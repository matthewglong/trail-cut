// Unit tests for tileCache.ts. Pure module test — does NOT spawn the
// renderer worker. Each test gets its own tempdir so concurrent runs don't
// step on each other.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createTileCache,
  urlKey,
  cachePathFor,
  type Fetcher,
} from '../tileCache';

// ---- helpers --------------------------------------------------------------

function getOnce(
  cache: ReturnType<typeof createTileCache>,
  url: string,
  fetcher: Fetcher,
): Promise<Buffer> {
  return new Promise((resolveGet, rejectGet) => {
    cache.get(url, fetcher, (err, data) => {
      if (err || !data) rejectGet(err ?? new Error('no data'));
      else resolveGet(data);
    });
  });
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

// ---- tests ----------------------------------------------------------------

describe('tileCache', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trailcut-tile-cache-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('urlKey / cachePathFor', () => {
    it('returns the same key for the same URL across calls and instances', () => {
      const url = 'https://tiles.example/12/34/56.pbf?v=1';
      expect(urlKey(url)).toBe(urlKey(url));
      // Different URL — different key (very high probability).
      expect(urlKey(url)).not.toBe(urlKey(url + '&x=2'));
    });

    it('places files under {dir}/{2-char}/{2-char}/{64-char-hex}', () => {
      const url = 'https://tiles.example/style.json';
      const key = urlKey(url);
      const { filePath, shardDir } = cachePathFor(dir, key);
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(filePath).toBe(join(dir, key.slice(0, 2), key.slice(2, 4), key));
      expect(shardDir).toBe(join(dir, key.slice(0, 2), key.slice(2, 4)));
    });
  });

  describe('miss → fetch → store → hit', () => {
    it('invokes the fetcher on miss and not on subsequent hits', async () => {
      const cache = createTileCache({ dir });
      const url = 'https://tiles.example/a.pbf';
      const payload = Buffer.from('hello tile bytes');

      let calls = 0;
      const fetcher: Fetcher = (_u, cb) => {
        calls += 1;
        cb(null, payload);
      };

      const first = await getOnce(cache, url, fetcher);
      expect(first.equals(payload)).toBe(true);
      expect(calls).toBe(1);

      const second = await getOnce(cache, url, fetcher);
      expect(second.equals(payload)).toBe(true);
      expect(calls).toBe(1); // still 1 — served from disk

      const stats = cache.stats();
      expect(stats.misses).toBe(1);
      expect(stats.hits).toBe(1);
      expect(stats.bytesWritten).toBe(payload.length);
      expect(stats.bytesRead).toBe(payload.length);
    });

    it('hits across separate cache instances pointed at the same dir', async () => {
      const url = 'https://tiles.example/cross-instance.pbf';
      const payload = Buffer.from([1, 2, 3, 4, 5]);

      const writer = createTileCache({ dir });
      let writeCalls = 0;
      await getOnce(writer, url, (_u, cb) => { writeCalls += 1; cb(null, payload); });
      expect(writeCalls).toBe(1);

      // Fresh instance — should hit on disk without calling the fetcher.
      const reader = createTileCache({ dir });
      let readCalls = 0;
      const got = await getOnce(reader, url, (_u, cb) => {
        readCalls += 1; cb(new Error('should not be called'));
      });
      expect(readCalls).toBe(0);
      expect(got.equals(payload)).toBe(true);
      expect(reader.stats().hits).toBe(1);
    });
  });

  describe('error semantics', () => {
    it('does not cache fetcher errors — next call retries', async () => {
      const cache = createTileCache({ dir });
      const url = 'https://tiles.example/sometimes-fails.pbf';
      const payload = Buffer.from('eventual success');

      let calls = 0;
      const fetcher: Fetcher = (_u, cb) => {
        calls += 1;
        if (calls === 1) cb(new Error('boom'));
        else cb(null, payload);
      };

      await expect(getOnce(cache, url, fetcher)).rejects.toThrow('boom');

      const second = await getOnce(cache, url, fetcher);
      expect(second.equals(payload)).toBe(true);
      expect(calls).toBe(2);

      // Exactly one cache entry on disk now (the failing call must NOT have
      // written anything).
      const files = listAllFiles(dir).filter((f) => !f.includes('.tmp.'));
      expect(files.length).toBe(1);
    });

    it('refuses network on miss when offline=true', async () => {
      const cache = createTileCache({ dir, offline: true });
      const url = 'https://tiles.example/never-fetched.pbf';
      let calls = 0;
      const fetcher: Fetcher = (_u, cb) => {
        calls += 1; cb(null, Buffer.from('should not run'));
      };
      await expect(getOnce(cache, url, fetcher)).rejects.toThrow(/offline/);
      expect(calls).toBe(0);
    });

    it('serves a hit even when offline=true', async () => {
      const url = 'https://tiles.example/preloaded.pbf';
      const payload = Buffer.from('preloaded bytes');

      const populator = createTileCache({ dir });
      await getOnce(populator, url, (_u, cb) => cb(null, payload));

      const offline = createTileCache({ dir, offline: true });
      const got = await getOnce(offline, url, (_u, cb) => cb(new Error('should not be called')));
      expect(got.equals(payload)).toBe(true);
    });
  });

  describe('concurrent gets for the same URL', () => {
    it('both succeed; ends with one cache file (last-write-wins via atomic rename)', async () => {
      const cache = createTileCache({ dir });
      const url = 'https://tiles.example/race.pbf';
      // Deliberately different payloads so we can verify both callbacks
      // received what their fetcher produced (the cache doesn't dedupe
      // in-flight; both fetchers run; whichever rename lands second wins
      // on disk, but both callers get back their own bytes).
      const payloadA = Buffer.from('aaaaaaaaa');
      const payloadB = Buffer.from('bbbbbbbbbbbbbb');

      const [a, b] = await Promise.all([
        getOnce(cache, url, (_u, cb) => cb(null, payloadA)),
        getOnce(cache, url, (_u, cb) => cb(null, payloadB)),
      ]);
      expect(a.equals(payloadA)).toBe(true);
      expect(b.equals(payloadB)).toBe(true);

      const files = listAllFiles(dir);
      // No tempfiles left behind — every rename or unlink completed.
      const tempFiles = files.filter((f) => f.includes('.tmp.'));
      expect(tempFiles.length).toBe(0);
      // Exactly one final cache entry.
      const finalFiles = files.filter((f) => !f.includes('.tmp.'));
      expect(finalFiles.length).toBe(1);

      // A subsequent get reads whichever payload won the rename race; we
      // don't care which, only that it equals one of the two and is served
      // without invoking the fetcher.
      let calls = 0;
      const winner = await getOnce(cache, url, (_u, cb) => {
        calls += 1; cb(new Error('should not be called'));
      });
      expect(calls).toBe(0);
      const winnerOk = winner.equals(payloadA) || winner.equals(payloadB);
      expect(winnerOk).toBe(true);
    });
  });

  describe('on-disk shape', () => {
    it('writes the file at {dir}/{2-char}/{2-char}/{key} and leaves no tempfiles', async () => {
      const cache = createTileCache({ dir });
      const url = 'https://tiles.example/shape-check.pbf';
      const payload = Buffer.from('payload');

      await getOnce(cache, url, (_u, cb) => cb(null, payload));

      const key = urlKey(url);
      const { filePath } = cachePathFor(dir, key);
      const s = statSync(filePath);
      expect(s.size).toBe(payload.length);

      const tempFiles = listAllFiles(dir).filter((f) => f.includes('.tmp.'));
      expect(tempFiles.length).toBe(0);
    });
  });
});
