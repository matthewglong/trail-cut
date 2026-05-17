// Unit tests for the Node-side trailcut bridge. Two responsibilities:
//   1. unwrapTrailcutUrl recovers the original URL from `?u=` correctly,
//      and rejects malformed input.
//   2. bridgeFetchFactory ALWAYS hashes the cache on the *original* URL,
//      not on the trailcut:// URL. This is the load-bearing invariant
//      from docs/export/plans/chromium-renderer.md §7 R2.
//
// The hash-key parity assertion is non-circular: the test stubs the
// TileCache and asserts what URL the stub receives, so a regression in
// either the bridge or the unwrap can't mask itself.

import { describe, it, expect, vi } from 'vitest';

import {
  bridgeFetchFactory,
  unwrapTrailcutUrl,
} from '../trailcutFetch';
import type { TileCache } from '../../renderer/tileCache';

function rewriteForTest(originalUrl: string): string {
  // Mirrors the page-side rewriter in page/init.ts. Duplicated here (and
  // not imported, since init.ts requires DOM types) but the wire format is
  // load-bearing: any drift between the two sides must surface immediately.
  const b64 = Buffer.from(originalUrl, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `trailcut://r?u=${b64}`;
}

describe('unwrapTrailcutUrl', () => {
  it('round-trips a typical OpenFreeMap tile URL', () => {
    const original = 'https://tiles.openfreemap.org/styles/liberty';
    const rewritten = rewriteForTest(original);
    expect(unwrapTrailcutUrl(rewritten)).toBe(original);
  });

  it('round-trips an interpolated tile URL with z/x/y values', () => {
    const original = 'https://tiles.openfreemap.org/planet/20240101/14/8581/5586.pbf';
    expect(unwrapTrailcutUrl(rewriteForTest(original))).toBe(original);
  });

  it('round-trips a glyphs URL with non-ASCII fontstack name', () => {
    const original = 'https://demotiles.maplibre.org/font/Roboto Regular/0-255.pbf';
    expect(unwrapTrailcutUrl(rewriteForTest(original))).toBe(original);
  });

  it('throws on a non-trailcut URL', () => {
    expect(() => unwrapTrailcutUrl('https://example.com/foo')).toThrow(/not a trailcut url/);
  });

  it('throws on a trailcut URL with no ?u= parameter', () => {
    expect(() => unwrapTrailcutUrl('trailcut://r?other=1')).toThrow(/missing \?u=/);
  });
});

describe('bridgeFetchFactory hash-key parity', () => {
  it('passes the ORIGINAL URL (not the trailcut URL) to TileCache.get', async () => {
    const original = 'https://tiles.openfreemap.org/styles/liberty';
    const rewritten = rewriteForTest(original);

    const seen: string[] = [];
    const stubCache: TileCache = {
      get(url, _fetcher, cb) {
        seen.push(url);
        cb(null, Buffer.from('OK'));
      },
      stats: () => ({ hits: 0, misses: 0, bytesRead: 0, bytesWritten: 0 }),
    };

    const bridge = bridgeFetchFactory(stubCache, () => { /* unused on hit */ });
    const result = await bridge(rewritten);

    expect(seen).toEqual([original]);
    expect(result.ok).toBe(true);
    expect(result.dataB64).toBe(Buffer.from('OK').toString('base64'));
  });

  it('returns ok:false with the cache error message on cache failure', async () => {
    const stubCache: TileCache = {
      get(_url, _fetcher, cb) {
        cb(new Error('synthetic cache failure'));
      },
      stats: () => ({ hits: 0, misses: 0, bytesRead: 0, bytesWritten: 0 }),
    };

    const bridge = bridgeFetchFactory(stubCache, () => { /* unused */ });
    const result = await bridge(rewriteForTest('https://tiles.openfreemap.org/x'));

    expect(result.ok).toBe(false);
    expect(result.error).toBe('synthetic cache failure');
  });

  it('returns ok:false on malformed trailcut URL without invoking the cache', async () => {
    const stubCache: TileCache = {
      get: vi.fn(),
      stats: () => ({ hits: 0, misses: 0, bytesRead: 0, bytesWritten: 0 }),
    };

    const bridge = bridgeFetchFactory(stubCache, () => { /* unused */ });
    const result = await bridge('https://example.com/not-a-trailcut-url');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a trailcut url/);
    expect(stubCache.get).not.toHaveBeenCalled();
  });
});
