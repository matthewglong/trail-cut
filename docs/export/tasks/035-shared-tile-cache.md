# Task 035 — Shared on-disk tile cache

**Step**: Export pipeline (worker-side determinism + perf)
**Estimated effort**: 4–6h
**Status**: done
**Depends on**: [020 — Renderer worker](./020-renderer-worker.md). 035 modifies the worker's `request()` callback; the orchestrator (030) is unaffected.

## Goal

Replace the worker's network-only `fetchUrl` stub (`src-tauri/sidecars/renderer/index.ts:88–138`) with a hash-keyed on-disk cache so repeat exports skip network roundtrips for tiles, sprites, glyphs, and style JSON. The cache is shared across all workers in an export and across exports — first export pays the network cost, subsequent exports for the same scene render purely from disk.

This is what PLAN.md §"Renderer architecture" → "Determinism" specifies as the means by which "tile fetches go through the worker's `request()` callback, which we route through a shared on-disk tile cache so repeat exports are deterministic and fast." 020 deferred the implementation to a follow-up; 030 spun the follow-up out as 035 because the cache is worker-side, not orchestrator-side, and the design (key derivation, eviction, location, atomicity under concurrent access) is too small for its own task but too non-trivial to graft onto either neighbor.

**The load-bearing invariant — the cache is content-addressed and write-once.** Every URL maglibre-native fetches via `request()` is treated as immutable for cache purposes (style JSON, sprites, glyphs, vector tiles, raster tiles). The cache key is a hash of the URL; the cache value is the exact bytes returned by the network fetch (post-content-decoding). No HTTP semantics, no `If-Modified-Since`, no ETag — if the URL changes, the cached entry is orphaned and a new entry is created. This matches how OpenFreeMap and most tile services already work (URLs are versioned by tile pyramid revision; a new revision is a new URL). It also matches the determinism contract: same camera path → same URLs → same cached bytes → same pixels.

## Files to touch

- New: `src-tauri/sidecars/renderer/tileCache.ts` — pure module exporting `createTileCache(opts)` returning `{ get(url, fetcher, cb), stats() }`. Pure Node, no maplibre-native imports. Hash via `crypto.createHash('sha256')`.
- Modified: `src-tauri/sidecars/renderer/index.ts` — replace the `request:` callback body (currently `fetchUrl(req.url, ...)`) with a `cache.get(req.url, fetchUrl, callback)` call. The cache instance is constructed once at boot; `fetchUrl` becomes the cache's miss-path fetcher.
- Modified: `src-tauri/sidecars/renderer/tsconfig.json` — add `tileCache.ts` to `include`.
- New: `src-tauri/sidecars/renderer/__tests__/tileCache.test.ts` — vitest unit tests (does NOT spawn the worker; pure module test). Asserts: hash determinism, miss → fetch → store → hit, atomic write semantics under concurrent get for the same URL, fetcher errors are not cached.
- Modified: `src-tauri/sidecars/renderer/__tests__/protocol.test.ts` — extend the existing protocol test with a "second render in a fresh worker, network disabled" assertion. After the first frame populates the cache, spawn a second worker with `TRAILCUT_TILE_CACHE_OFFLINE=1`, render the same `t`, assert the frame comes back without network access (or assert via cache stats / network-fetcher mock).
- Modified: `src-tauri/sidecars/renderer/index.ts` (env knobs) — read `TRAILCUT_TILE_CACHE_DIR` (override location) and `TRAILCUT_TILE_CACHE_OFFLINE` (refuse network on miss; fail the request with a clear error). Both are test/CI knobs; production uses the default location and online behavior.
- Modified: `docs/export/tasks/README.md` — add 035 row between 030 and 040, mark dependency `020`.
- Untouched in this task: any Rust file. The cache lives entirely in the Node worker. Pre-warming the cache with a camera-path walk (PLAN.md §"Performance considerations" #2) is a separate orchestrator-side task spun out later.

## Deliverables

A pure-TS module under `src-tauri/sidecars/renderer/tileCache.ts`:

```ts
export interface TileCacheOptions {
  dir: string;                                              // cache root
  offline?: boolean;                                        // refuse network on miss
}
export type Fetcher = (url: string, cb: (err: Error | null, data?: Buffer) => void) => void;
export interface TileCache {
  get(url: string, fetcher: Fetcher, cb: (err: Error | null, data?: Buffer) => void): void;
  stats(): { hits: number; misses: number; bytesRead: number; bytesWritten: number };
}
export function createTileCache(opts: TileCacheOptions): TileCache;
```

Behavior:

1. **Key derivation.** `key = sha256(url).hex()`. Cache file lives at `{dir}/{key[0..2]}/{key[2..4]}/{key}` — two levels of 256-way directory sharding to keep any single directory under ~10K entries even at 10M total tiles. `mkdir -p` the shard directories on demand.

2. **Get path.** On `cache.get(url, fetcher, cb)`:
   - Compute `key`. `stat()` the cache file. If it exists, `readFile()` it and call `cb(null, buf)`. Increment `hits`.
   - On miss: if `offline`, call `cb(new Error('cache miss + offline mode'))`; do not invoke `fetcher`.
   - Otherwise call `fetcher(url, (err, data) => { ... })`. On fetcher error, propagate via `cb(err)`; **do not write to the cache**. On fetcher success, write `data` to `{cacheFile}.tmp.{pid}.{rand}` then `rename()` to the final path (atomic on POSIX and Windows for same-volume renames). Then call `cb(null, data)`. Increment `misses` and `bytesWritten`.

3. **Concurrent gets for the same URL.** Two workers (or two `get` calls in the same worker) racing on the same URL must both succeed and at most one network fetch is wasted. The simple strategy: don't dedupe in-flight fetches at the cache level. Both fetchers run; both `rename()` to the same final path; the second `rename()` overwrites (atomic). The wasted fetch is a one-time cost on a cold cache; it's not worth a fetch-coalescing layer in v1.

4. **Atomicity.** Writes are tempfile + rename to avoid a torn read by a concurrent `readFile()`. Tempfile name includes `process.pid` and a random suffix to avoid collisions across workers.

5. **Eviction.** None in v1. The cache grows unboundedly. A representative scene caches ~50–500 MB of tiles; OpenFreeMap's full pyramid for a hike-sized region is small. We document the unbounded growth as a known limitation and add eviction (LRU by mtime, configurable disk quota) in a follow-up if real-world growth proves disruptive.

6. **Location.** Default `{HOME}/.trailcut/tile-cache/`. Mirrors the `recent.json` convention (`src-tauri/src/util/fs.rs::global_config_dir`). The cache is platform-shared across users on the same machine (each user has their own `$HOME`), and shared across all TrailCut projects.

7. **Cache stats.** `stats()` returns `{hits, misses, bytesRead, bytesWritten}` for the lifetime of the `TileCache` instance. Used by tests and (later) by the export progress UI to surface "rendered from cache" vs "fetched fresh."

The worker integrates the cache at boot:

```ts
import { createTileCache } from './tileCache';

const cache = createTileCache({
  dir: process.env.TRAILCUT_TILE_CACHE_DIR ?? defaultCacheDir(),
  offline: process.env.TRAILCUT_TILE_CACHE_OFFLINE === '1',
});

// In the maplibre-native Map's request callback:
request: (req, callback) => {
  cache.get(req.url, fetchUrl, (err, data) => {
    if (err || !data) { callback(err ?? new Error('no data')); return; }
    callback(undefined, { data });
  });
},
```

`defaultCacheDir()` is a tiny helper resolving `os.homedir() + '/.trailcut/tile-cache'`.

## Acceptance criteria

- [ ] `npm run build:renderer` continues to produce `src-tauri/sidecars/renderer/dist/renderer.cjs`. The bundle includes `tileCache.ts`'s compiled output (verifiable via `grep "createTileCache" dist/renderer.cjs`).
- [ ] `npm run test:renderer` passes:
  - **tileCache unit tests**: hash determinism (`createTileCache` returns the same key for the same URL across instances); miss → fetch → store → next-get-hits-without-fetcher (verified by passing a fetcher mock and asserting it's called once); fetcher errors are not cached (a failing fetcher followed by a succeeding one results in one cache entry, not zero); concurrent `get` for the same URL with two fetcher mocks returns the same data on both callbacks and ends with one cache file (last-write-wins via atomic rename).
  - **Protocol-level offline test**: spawn worker A with a fresh `TRAILCUT_TILE_CACHE_DIR` pointed at a tempdir, render frame 0 (populates cache via real network). Spawn worker B with the same tempdir + `TRAILCUT_TILE_CACHE_OFFLINE=1`, render frame 0, assert the frame returns successfully. (If maplibre-native fetches a URL not in the cache while offline, the `request()` callback calls back with an error and the render fails — the test passes if no such error occurs.)
- [ ] **Cache shape on disk**. After the protocol test runs, the tempdir contains files under `{tempdir}/{2-char}/{2-char}/{64-char-hex}` matching `sha256` of the fetched URLs. No `.tmp.*` files remain (all renames completed).
- [ ] `cargo test --test orchestrator` continues to pass (orchestrator is unchanged; the test now reads from the freshly-populated cache, which should make it slightly faster but is otherwise identical).
- [ ] `npm run test:run` and `npm run build` continue to pass.
- [ ] `grep -nE "fetchUrl\\(req\\.url" src-tauri/sidecars/renderer/index.ts` returns no matches — the direct fetch in `request:` is replaced by the cache's `get()`.

## Implementation notes

**Why content-addressed and not URL-addressed.** Using `sha256(url)` as the filename instead of a URL-encoded form lets us use the URL freely as a key without filesystem-illegal characters (`?`, `&`, `:`, `/`) needing escaping. It also gives constant-length filenames and natural sharding via prefix. The collision risk on sha256 is irrelevant for cache correctness (a collision would just serve the wrong tile, but the probability is far below cosmic-ray bit-flip territory).

**Why no in-flight fetch coalescing.** The pathological case is N=8 workers all booting simultaneously and racing on the same first frame's tiles. Each tile is fetched up to 8× on the first cold miss, then is cached forever. Tile responses are typically <100 KB; a worst-case 8× wasted fetch on 200 cold tiles is ~160 MB of extra network — annoying but not catastrophic, and only on the very first export of a fresh install. Adding fetch coalescing means a Map-of-pending-requests with cleanup, error-fanout semantics, etc. — significant complexity for a one-time cost. Skip it; revisit if real-world cold-start latency proves to be a problem.

**Tempfile naming.** `{cacheFile}.tmp.{process.pid}.{cryptoRandomBytes(8).toString('hex')}` — pid alone isn't enough on Windows where two threads in one process can race; the random suffix removes that. Tempfiles are written in the same shard directory as the final path so the rename is on the same volume (cross-volume rename isn't atomic on Windows).

**Cache key normalization (intentionally absent).** No URL normalization (lowercase, sort query params, etc.). maplibre-native produces stable URLs for stable inputs; if it generates two URLs for the same tile (it doesn't, in our experience), they'd cache as two entries. Documenting "we don't normalize" is more useful than implementing normalization that happens to be wasted work.

**Error semantics.** A fetcher error (network timeout, HTTP 500, gunzip failure) is reported to the caller via the callback **and** the cache entry is **not** written. Next call for the same URL re-fetches. This is correct: caching a failure would defeat retry semantics built into the rest of the stack. We only cache successful responses.

**Offline mode UX.** `TRAILCUT_TILE_CACHE_OFFLINE=1` is purely a test/CI knob in 035 — the production flow always allows network. A user-facing "render from cache only" mode is a future feature (would compose with this knob trivially), out of scope here.

**Why all `request()` URLs and not just tiles.** maplibre-native routes everything through `request()`: style JSON (manually pre-fetched in the worker today via `fetchStyleJson`), sprites (`https://.../sprite.png` and `.json`), glyphs (`https://.../{fontstack}/{range}.pbf`), source data (TileJSON), vector and raster tile PBFs/PNGs. Caching all of them is one rule: cache whatever URL `request()` is asked for. The naming "tile cache" is shorthand; the code caches any URL.

**Style JSON pre-fetch.** The worker currently calls `fetchStyleJson(url)` directly at boot (before the `Map` exists, so the cache isn't reachable from there yet). Two options: (a) instantiate the cache before `buildMap`, route the style fetch through it; (b) leave the boot-time style fetch on the direct path. Pick (a) — it's one extra call site, the style JSON is the largest single response of the boot phase (~400 KB), and caching it avoids re-fetching on every export. The cache instance is a module-level `let cache: TileCache` constructed at the top of `setup`'s handler; `fetchStyleJson` becomes `cache.get(styleUrl, fetchUrl, cb)`-shaped.

**Eviction is intentionally deferred.** The goal in 035 is to land the cache so 030-class exports stop hammering the network on every run. Eviction (LRU + disk quota) adds value only after some user has caused enough exports to fill their disk, which is many months away. Document the unbounded growth in the task's "Open questions" so the future eviction task has clear scope.

**Test isolation.** The protocol test uses `os.tmpdir() + '/trailcut-tile-cache-test-' + randomUUID()` for each test run. Cleanup in `afterAll` via `fs.rm({recursive: true})`. Doing the test in the user's real `~/.trailcut/tile-cache/` would conflate test runs with real exports; isolating per-test makes the offline assertion deterministic.

**No metric reporting in v1.** `stats()` exists for tests; the orchestrator does not yet read it. When the export-progress UI lands (alongside 060/090), it'll consume `stats()` to show a "cache hit rate" indicator. Out of scope for 035.

## Open questions deferred to follow-up tasks

- **Eviction policy (LRU + disk quota).** Most likely a 1-PR follow-up once real-world growth becomes a concern. Likely shape: track a sidecar `index.json` with `{url_hash: {bytes, atime}}`, evict oldest by `atime` when total bytes exceed a configurable cap. Out of scope for 035.
- **Pre-warming the cache before the frame loop.** PLAN.md §"Performance considerations" #2 — walk the camera path once, fetch all tiles into the cache, then start render. Orchestrator-side optimization; needs the cache (lands here in 035) but the walking logic is separate. Spin out a 037-or-similar follow-up after the first real export benchmark shows the warm-up phase is the dominant cost.
- **Cache surfacing in UI.** Show users "rendered N frames from cache, K from network" in the export progress dialog. Wait for 060/090's progress UI before designing.
- **Cross-machine cache (e.g. shared NAS).** Out of scope; the rename atomicity assumptions hold for local volumes only. If a user points the cache at a network share and renames are non-atomic, the worst case is an occasional torn read leading to a re-fetch. Document but don't engineer for.
- **Pruning orphaned cache entries** when style URLs change (e.g. OpenFreeMap version bump). Currently the orphaned bytes sit on disk forever. Same disposition as eviction: deal with it in a follow-up if it becomes a real disk-pressure problem.

## Doc tie-in

- PLAN.md §"Renderer architecture" → "Determinism" — this task implements the on-disk cache that section specifies. After 035, the determinism contract holds without "...subject to network availability" caveats; subsequent runs are fully offline-capable for any scene that's been exported once.
- 020 §"Tile cache deferral" — explicitly says the cache is task 030's concern or a follow-up; 030 §"Open questions" then spins it out as 035. This task closes the loop.
- LAYOUT.md is unaffected — the cache is an orthogonal infrastructure layer beneath the layout/channel system.
- After 035 lands, the worker has full local determinism. Tasks 040 (encoder probing) and 050 (layout descriptors) are independent of the cache and proceed in parallel.
