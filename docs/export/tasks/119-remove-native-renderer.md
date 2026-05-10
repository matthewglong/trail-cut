# Task 119 — Remove maplibre-native renderer; rename chromium → renderer

**Step**: Export pipeline (renderer migration step 5 of 5 — see [`../plans/chromium-renderer.md`](../plans/chromium-renderer.md))
**Estimated effort**: ~0.5 day (3–5h)
**Status**: pending
**Depends on**: 118 (chromium is the production default and has soaked through at least one release / week of dogfooding without rollback).

## Goal

Delete the legacy `src-tauri/sidecars/renderer/` directory and the `@maplibre/maplibre-gl-native` dependency. Rename `renderer-chromium/` → `renderer/`. Drop the `TRAILCUT_RENDERER` env-flag toggle. After this task, the chromium sidecar is the only renderer and the codebase has no reference to maplibre-native.

This is the cleanup PR. It should land **only after** the chromium renderer has soaked in production-default behavior for at least one release cycle and no rollback to the native renderer has been needed. If the legacy fallback was ever actually exercised in that window, do not run this task — instead, root-cause the failure first.

**Load-bearing invariant — `tileCache.ts` is preserved across the rename.** The cache module (`src-tauri/sidecars/renderer/tileCache.ts`) currently lives under the soon-to-be-deleted directory. It must be moved (not copied — moved) into the renamed `renderer/` directory, preserving git history via `git mv`. The new sidecar already imports it via relative path (`../renderer/tileCache.ts` post-115); after the rename, that import becomes `./tileCache.ts`. Update import paths accordingly.

**Load-bearing invariant — hash-key parity audit.** Plan §6 step 6 lives here: re-verify that the `addProtocol` bridge's path through `tileCache.get` hashes on the **original** OpenFreeMap URL, not the rewritten `trailcut://` URL. The unit test `trailcutFetch.test.ts` from 115 covers this; this task adds an end-to-end assertion: after one export run, `~/.trailcut/tile-cache/`'s entries are identical (same shard layout, same filenames) to entries produced by the legacy native renderer. Without this, a careless refactor between 115 and 119 could have silently broken cache reuse.

## Files to touch

### Deletions

- `src-tauri/sidecars/renderer/index.ts` — deleted.
- `src-tauri/sidecars/renderer/build.mjs` — deleted.
- `src-tauri/sidecars/renderer/tsconfig.json` — deleted (a fresh tsconfig moves under the new `renderer/` post-rename; `renderer-chromium/tsconfig.json` becomes the new `renderer/tsconfig.json`).
- `src-tauri/sidecars/renderer/__tests__/protocol.test.ts` — deleted. The chromium-side `__tests__/protocol.test.ts` becomes the only protocol test post-rename.
- `src-tauri/sidecars/renderer/__tests__/setupFixture.ts` — **moved**, not deleted. The sidecar-agnostic fixture builder relocates to `src-tauri/sidecars/renderer/__tests__/setupFixture.ts` post-rename (the chromium test was re-exporting it via relative path; the rename collapses two paths into one).

### Moves (via `git mv` to preserve history)

- `src-tauri/sidecars/renderer/tileCache.ts` → `src-tauri/sidecars/renderer-chromium/tileCache.ts` (one commit), then `src-tauri/sidecars/renderer-chromium/` → `src-tauri/sidecars/renderer/` (next commit, after the deletions above). Two-step to avoid a path collision during a single rename.
  - Order matters: delete the old `renderer/` contents first, *then* `git mv tileCache.ts` into `renderer-chromium/`, *then* `git mv renderer-chromium/ renderer/`. A single `git mv renderer-chromium/ renderer/` while old `renderer/` still exists fails.
- `src-tauri/sidecars/renderer/__tests__/setupFixture.ts` (the legacy one) → `src-tauri/sidecars/renderer/__tests__/setupFixture.ts` (preserved through the rename — the legacy file is what the chromium sidecar's test was re-exporting, so we keep it and delete the chromium-side re-export shim).

### Modifications

- `src-tauri/sidecars/renderer/build.mjs` (post-rename) — drop the `external: ['@maplibre/maplibre-gl-native']` line if any survived the migration (shouldn't, since 115 didn't have it; verify). All other esbuild config stays.

- `src-tauri/sidecars/renderer/index.ts` (post-rename, ex-`renderer-chromium/index.ts`) — update the `tileCache` import: `import { createTileCache, defaultCacheDir } from './tileCache'` (was `from '../renderer/tileCache'`).

- `src-tauri/src/export/orchestrator.rs`:
  - Drop the `TRAILCUT_RENDERER` env-var read entirely. `OrchestratorConfig::default()` resolves directly to the (now only) `sidecars/renderer/dist/renderer.cjs`.
  - Drop the `default_renderer_is_native_when_env_unset` and `default_renderer_is_chromium_when_env_chromium` tests added in 116 — the toggle no longer exists.
  - Keep the `chrome_headless_shell_path` resolution from 118.

- `package.json`:
  - Remove `"@maplibre/maplibre-gl-native": "^6.4.1"` from `devDependencies`.
  - Rename script `build:renderer-chromium` → `build:renderer`. Remove the legacy `build:renderer` (which now points at deleted source). Same for `test:renderer-chromium` → `test:renderer`.
  - Run `npm install` to regenerate `package-lock.json`. Commit the lockfile change.

- `src-tauri/tauri.conf.json` — no change (118's `bundle.externalBin` entries for `chrome-headless-shell-*` are correct; the `renderer.cjs` path doesn't appear here directly).

- `docs/export/PLAN.md` — find any remaining "maplibre-native" mentions in the renderer-architecture section and remove or update them. The v2 section from 118 stays; it just no longer needs to contrast against an actively-shipped legacy.

- `docs/export/tasks/035-shared-tile-cache.md` — append a postscript section: "Post-chromium-renderer-migration call path." One short paragraph describing how the cache is now reached: `addProtocol` in the page → `exposeFunction` bridge to Node → `unwrapTrailcutUrl` extracts the original OpenFreeMap URL from the `?u=` parameter → `tileCache.get(originalUrl, ...)`. Note that the cache's hash-key is the original URL, unchanged from before the migration. Cite tasks 115 (where this was implemented) and 119 (where the audit was sealed). No structural change to the doc.

- `docs/export/tasks/README.md` — add row for 119 ⬜.

- `docs/export/plans/chromium-renderer.md` — append a "Status: complete" header at the top, dated. The plan stays in `plans/` as a historical record of the migration.

### New tests

- `src-tauri/sidecars/renderer/__tests__/tileCacheKeyParity.test.ts` (post-rename) — end-to-end assertion. Spawns the bundled worker with a temp `TRAILCUT_TILE_CACHE_DIR`, sends a `setup` + a couple of `render` commands, lets it write a few cache entries, then reads the temp cache dir. Asserts:
  1. All cache entries are placed at `{key[0..2]}/{key[2..4]}/{key}` where `key = sha256(url)` for the **original** OpenFreeMap URLs (compute the expected keys from a small list of known URLs the style spec references).
  2. No entry filename contains `trailcut://` or any base64 substring.

  This test covers plan §7 R2 with a non-circular assertion (it doesn't just call `unwrapTrailcutUrl` and check the result; it inspects the actual on-disk artifact a real export run produces).

## Acceptance

- `grep -r "maplibre-gl-native" .` (excluding `node_modules`, `target`, `dist`) returns nothing.
- `grep -r "TRAILCUT_RENDERER" .` returns nothing (env flag is gone).
- `grep -r "renderer-chromium" .` returns nothing (rename complete).
- `npm install` after dependency removal shrinks `node_modules` (the native binding's `.node` file is gone). Note approximate size reduction in the PR description (expected ~30 MB).
- `cargo test --features integration_export` passes — all three render_export_*.rs tests still green against the renamed sidecar.
- `npm run test:renderer` passes — the protocol/painterPatch/styleRewriter/trailcutFetch/tileCacheKeyParity tests all green at the renamed paths.
- `git log --follow src-tauri/sidecars/renderer/tileCache.ts` shows continuous history through the rename (sanity check that `git mv` was used, not delete-and-create).
- An app-level smoke export produces a clean `.mov`. (Manual; no CI assertion.)

## Out of scope

- Removing `@puppeteer/browsers` from `devDependencies`. It's used by the build script for the `chrome-headless-shell` install step (118), so it stays.
- Removing `puppeteer-core` from `dependencies`. It's the runtime binding for the chromium sidecar; stays.
- Any changes to `maplibre-gl` (preview and renderer share this version; bumping is a separate, single-PR change).
- Cold-start prelaunch UX (plan §7 R5). Still deferred.
