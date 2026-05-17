// Node-side bridge for the trailcut:// protocol. The page rewrites every
// http(s) URL maplibre is about to fetch (via transformRequest) into a
// trailcut:// URL whose `?u=` query parameter base64url-encodes the
// fully-interpolated original. Maplibre then fetches the trailcut:// URL
// via addProtocol; the page-side loader posts the URL to Node through the
// exposed `trailcutFetch` function. This module unwraps and serves.
//
// Divergence from docs/export/plans/chromium-renderer.md §2.4 — the plan
// described walking the parsed style JSON to rewrite every URL upfront.
// That runs into placeholder interpolation: tile templates have {z}/{x}/{y}
// and glyphs templates have {fontstack}/{range}, both interpolated by
// maplibre *after* a Node-side walk would happen. Doing the rewrite inside
// transformRequest (page-side, post-interpolation) sidesteps the problem
// while preserving the plan's intent: every fetch hits the existing
// tileCache.ts on a hash of the original URL. addProtocol still
// serves the bytes — it's the only API that lets us short-circuit the
// fetch and return arbitrary data.
//
// Load-bearing invariant — hash-key parity. The bridge MUST hash on the
// *original* URL recovered from `?u=`, not on the trailcut:// URL. A
// regression silently invalidates the cache for every fresh export. See
// __tests__/trailcutFetch.test.ts for the explicit assertion.

import type { Fetcher, TileCache } from './tileCache';

/** Recover the original URL from a trailcut:// URL produced by the page-
 *  side rewriter in page/init.ts. Throws on malformed input — callers
 *  treat that as a fatal protocol violation, not a soft fallback. */
export function unwrapTrailcutUrl(trailcutUrl: string): string {
  if (!trailcutUrl.startsWith('trailcut://')) {
    throw new Error(`not a trailcut url: ${trailcutUrl}`);
  }
  const parsed = new URL(trailcutUrl);
  const u = parsed.searchParams.get('u');
  if (!u) {
    throw new Error(`trailcut url missing ?u=: ${trailcutUrl}`);
  }
  return Buffer.from(u, 'base64url').toString('utf8');
}

export interface TrailcutFetchResult {
  ok: boolean;
  /** base64 of the response bytes; present iff ok. The page decodes back
   *  to a Uint8Array and returns `{ data: bytes.buffer }` to maplibre.
   *  Base64 round-trip costs ~30% size overhead but is dominated by I/O for
   *  cold fetches and microseconds for warm hits — acceptable, and the only
   *  correct option since puppeteer's exposeFunction serializes return
   *  values as JSON (Uint8Array would arrive as an object with numeric
   *  keys, which is wrong). */
  dataB64?: string;
  /** Error message; present iff !ok. */
  error?: string;
}

/**
 * Build the function we expose to the page via page.exposeFunction. The
 * page invokes it as `await window.trailcutFetch(trailcutUrl)`; the result
 * is JSON-serialized over CDP and resolved on the page side.
 *
 * Errors from cache / fetcher are reported as `{ ok: false, error }`
 * rather than thrown. Throwing inside an exposed function shows up on the
 * page side as a generic error string with an opaque rejection — packaging
 * the message ourselves makes the failure mode legible in page console
 * logs (which we forward to worker stderr) and in the addProtocol error
 * surface that maplibre reports as "tile failed to load".
 */
export function bridgeFetchFactory(
  cache: TileCache,
  networkFetcher: Fetcher,
): (trailcutUrl: string) => Promise<TrailcutFetchResult> {
  return (trailcutUrl: string) =>
    new Promise<TrailcutFetchResult>((resolve) => {
      let original: string;
      try {
        original = unwrapTrailcutUrl(trailcutUrl);
      } catch (e) {
        resolve({ ok: false, error: (e as Error).message });
        return;
      }
      cache.get(original, networkFetcher, (err, data) => {
        if (err || !data) {
          resolve({ ok: false, error: err?.message ?? 'no data' });
          return;
        }
        resolve({ ok: true, dataB64: data.toString('base64') });
      });
    });
}
