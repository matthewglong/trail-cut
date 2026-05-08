// Hash-keyed on-disk cache for the renderer worker's request() callback.
// See docs/export/tasks/035-shared-tile-cache.md for the full design.
//
// Load-bearing invariant — the cache is content-addressed and write-once.
// Every URL maplibre-native fetches via request() (style JSON, sprites,
// glyphs, vector/raster tiles) is treated as immutable for cache purposes.
// key = sha256(url); value = the exact bytes returned by the network fetch.
// No HTTP semantics, no ETags — if a URL changes, a new entry is created and
// the old one is orphaned. Same camera path → same URLs → same cached bytes
// → same pixels. Determinism flows from this.
//
// Concurrency: writes are tempfile + rename (atomic on POSIX and same-volume
// Windows). Two workers racing on the same URL both fetch and both rename;
// the second rename overwrites cleanly. We don't dedupe in-flight fetches —
// that's a one-time cold-start cost, not worth a coalescing layer in v1.
//
// Errors: a fetcher error propagates to the caller; the cache entry is NOT
// written. Caching failures would defeat retry semantics; we only cache
// successful responses.
//
// Eviction: none in v1. The cache grows unboundedly. Documented as a known
// limitation; LRU + disk quota is a follow-up if real-world growth becomes
// disruptive.

import { createHash, randomBytes } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';

export interface TileCacheOptions {
  /** Cache root directory. Created on demand. */
  dir: string;
  /** If true, refuse to invoke the fetcher on a miss; fail with a clear error. */
  offline?: boolean;
}

export type Fetcher = (
  url: string,
  cb: (err: Error | null, data?: Buffer) => void,
) => void;

export interface TileCacheStats {
  hits: number;
  misses: number;
  bytesRead: number;
  bytesWritten: number;
}

export interface TileCache {
  get(
    url: string,
    fetcher: Fetcher,
    cb: (err: Error | null, data?: Buffer) => void,
  ): void;
  stats(): TileCacheStats;
}

/** Default location: $HOME/.trailcut/tile-cache (mirrors global_config_dir). */
export function defaultCacheDir(): string {
  return join(os.homedir(), '.trailcut', 'tile-cache');
}

/** sha256(url) hex digest — used as both the file name and shard index. */
export function urlKey(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

/**
 * Resolve the on-disk path for a key under `dir`. Two levels of 256-way
 * directory sharding (`{dir}/{key[0..2]}/{key[2..4]}/{key}`) keep any single
 * directory under ~10K entries even at 10M total tiles.
 */
export function cachePathFor(dir: string, key: string): {
  shardDir: string;
  filePath: string;
} {
  const shardDir = join(dir, key.slice(0, 2), key.slice(2, 4));
  return { shardDir, filePath: join(shardDir, key) };
}

export function createTileCache(opts: TileCacheOptions): TileCache {
  const { dir, offline = false } = opts;
  let hits = 0;
  let misses = 0;
  let bytesRead = 0;
  let bytesWritten = 0;

  function get(
    url: string,
    fetcher: Fetcher,
    cb: (err: Error | null, data?: Buffer) => void,
  ): void {
    const key = urlKey(url);
    const { shardDir, filePath } = cachePathFor(dir, key);

    // Try the on-disk hit path first. stat()→readFile() is two syscalls but
    // separating them lets us count hits cleanly and lets the miss path skip
    // the readFile entirely. ENOENT (and any other stat failure) falls
    // through to the miss path; readFile failures (mid-rename torn read,
    // permissions, etc.) propagate as a hard error.
    stat(filePath).then(
      () => {
        readFile(filePath).then(
          (buf) => {
            hits += 1;
            bytesRead += buf.length;
            cb(null, buf);
          },
          (err) => cb(err as Error),
        );
      },
      () => {
        // miss
        if (offline) {
          cb(new Error(`tile cache miss + offline mode: ${url}`));
          return;
        }
        fetcher(url, (fetchErr, data) => {
          if (fetchErr || !data) {
            // Do NOT write the cache on a fetcher error. Caching failures
            // would defeat the retry semantics built into the rest of the
            // stack; let the next call re-fetch.
            cb(fetchErr ?? new Error('fetcher returned no data'));
            return;
          }
          // Tempfile + rename for atomicity. Tempfile lives in the same
          // shard dir as the final path so the rename is on the same volume
          // (cross-volume rename isn't atomic on Windows). pid alone isn't
          // enough on Windows where two threads can race in one process; the
          // random suffix removes that.
          mkdir(shardDir, { recursive: true }).then(
            () => {
              const tempPath =
                `${filePath}.tmp.${process.pid}.` +
                randomBytes(8).toString('hex');
              writeFile(tempPath, data).then(
                () => {
                  rename(tempPath, filePath).then(
                    () => {
                      misses += 1;
                      bytesWritten += data.length;
                      cb(null, data);
                    },
                    (renameErr) => {
                      // Rename failed — try to clean up the temp file but
                      // don't mask the rename error if cleanup also fails.
                      unlink(tempPath).catch(() => { /* ignore */ });
                      cb(renameErr as Error);
                    },
                  );
                },
                (writeErr) => cb(writeErr as Error),
              );
            },
            (mkdirErr) => cb(mkdirErr as Error),
          );
        });
      },
    );
  }

  function statsOf(): TileCacheStats {
    return { hits, misses, bytesRead, bytesWritten };
  }

  return { get, stats: statsOf };
}
