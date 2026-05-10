# Task 118 — Cut over default renderer to chromium; bundle headless-shell

**Step**: Export pipeline (renderer migration step 4 of 5 — see [`../plans/chromium-renderer.md`](../plans/chromium-renderer.md))
**Estimated effort**: ~1 day (5–7h)
**Status**: pending
**Depends on**: 115, 116, 117 (all parity gates green).

## Goal

Make the chromium renderer the production default. Three concrete things change:

1. `OrchestratorConfig::default()` resolves to the chromium bundle. `TRAILCUT_RENDERER=native` becomes the opt-out (kept for hotfix purposes — deleted in task 119).
2. `chrome-headless-shell` is bundled into the app via Tauri's `bundle.externalBin`. The build script downloads the per-target-triple binary at build time using `@puppeteer/browsers install`.
3. `docs/export/PLAN.md` reflects the new renderer architecture as the shipped one.

This is the bundle-size-growing PR. After 118, every macOS install adds ~120 MB for `chrome-headless-shell`. Plan §2.3 costs and accepts this trade-off; this task realizes it.

**Load-bearing invariant — runtime path resolution must work in both `tauri dev` and `tauri build`.** The worker resolves `chrome-headless-shell`'s path at boot via `puppeteer.launch({ executablePath })`. The path must be:
- In dev: a developer-local install (env override `TRAILCUT_CHROME_HEADLESS_SHELL`, or a default under `src-tauri/binaries/chrome-headless-shell-<target>/...`).
- In production: resolved relative to the sidecar binary's location (Tauri's resource resolution path, mirroring how 130 will resolve `node` and the worker bundle).

The orchestrator passes the resolved path to the worker via env var (`TRAILCUT_CHROME_HEADLESS_SHELL` set on `Command::env`) so the resolution logic lives in Rust, not in the Node worker.

**macOS only for v1.** Windows distribution is task 130's slot. This task ships per-arch macOS binaries: `aarch64-apple-darwin` and `x86_64-apple-darwin`.

## Files to touch

- Modified: `src-tauri/src/export/orchestrator.rs`:
  - `OrchestratorConfig::default()` — flip `renderer_cjs_path` to `sidecars/renderer-chromium/dist/renderer.cjs` by default. The 116-era logic stays (env var still respected) but the meaning inverts: unset → chromium, `TRAILCUT_RENDERER=native` → native.
  - Add Rust-side resolution for `chrome-headless-shell`: a function `resolve_chrome_headless_shell() -> PathBuf` that:
    1. Honors `TRAILCUT_CHROME_HEADLESS_SHELL` env var if set.
    2. Otherwise, in dev (`#[cfg(debug_assertions)]` or detect via `CARGO_MANIFEST_DIR`-relative existence): resolves to `src-tauri/binaries/chrome-headless-shell-<target-triple>/chrome-headless-shell`.
    3. Otherwise (production): resolves relative to the executing binary's location, matching Tauri's `externalBin` layout.
    The resolved path is stored on `OrchestratorConfig` (new field `chrome_headless_shell_path: PathBuf`) and passed to the worker via `Command::env("TRAILCUT_CHROME_HEADLESS_SHELL", &path)`. The worker reads this single env var; no path-resolution logic on the Node side.

- Modified: `src-tauri/sidecars/renderer-chromium/index.ts`:
  - Read `process.env.TRAILCUT_CHROME_HEADLESS_SHELL`. Use it as `executablePath` in `puppeteer.launch(...)`. Throw a clear error at boot if unset (with a message pointing at the orchestrator-config code path that should have set it).

- Modified: `src-tauri/sidecars/renderer-chromium/build.mjs`:
  - Add a build step that runs `npx @puppeteer/browsers install chrome-headless-shell@<pinned> --path <out>` for every supported target triple. For dev builds: download for the host platform only. For release builds: download for all bundled targets. The `--platform` flag accepts `mac` / `mac_arm` for cross-arch downloads on macOS.
  - Output layout: `src-tauri/binaries/chrome-headless-shell-<target-triple>/chrome-headless-shell-<target-triple>` (the inner-binary name must match Tauri's `externalBin` rules — `<original-name>-<target-triple>` suffix).
  - Pin the chrome-headless-shell version to whatever puppeteer-core's compatibility matrix points to as of the task's PR date. Document the pin in a comment with the date the pin was set.

- Modified: `src-tauri/tauri.conf.json`:
  - `bundle.externalBin` adds entries for `chrome-headless-shell` per target triple. Format follows existing entries (the Tauri v2 docs require `<name>-<target-triple>` naming).

- Modified: `docs/export/PLAN.md`:
  - Find the existing `## Renderer architecture` section (or equivalent) — flip its decision summary from "Node + maplibre-native" to "Node + headless-Chromium + maplibre-gl-js".
  - Add a `## Renderer architecture v2` (or rename the existing section) explaining the wobble fix and the Chromium bundling cost. One short paragraph; the deep rationale lives in `docs/export/plans/chromium-renderer.md`, which this section links.

- Modified: `docs/export/tasks/README.md` — add row for 118 ⬜.

- Modified: `.gitignore` — ensure `src-tauri/binaries/chrome-headless-shell-*/` is **ignored** (binaries are downloaded at build time, not committed). Verify the existing `.gitignore` already excludes `src-tauri/binaries/` or `src-tauri/target/`; if not, add a specific exclusion.

- New: `docs/export/tasks/118-renderer-cutover.md` — this file.

- Untouched (post-this-task; deleted in 119): the `src-tauri/sidecars/renderer/` directory, `@maplibre/maplibre-gl-native` in `package.json`. The native renderer stays present as a hotfix opt-out for one task cycle.

## CI cross-build considerations

- A macOS CI host running `npx @puppeteer/browsers install chrome-headless-shell --platform mac` produces an `x86_64-apple-darwin` binary; `--platform mac_arm` produces `aarch64-apple-darwin`. Both must be downloaded at release-build time so a universal-app bundle could in principle ship both — but per the plan's lean, **per-arch installers** (not universal), so each release CI job downloads only its own arch.
- If the install URL is rate-limited, cache the downloaded binaries in CI between runs (`actions/cache` keyed on `chrome-headless-shell-<version>-<platform>`).

## Acceptance

- `cargo test --features integration_export` passes against the **chromium** renderer by default (env unset). All three of `render_export_map_only.rs`, `render_export_video_only.rs`, `render_export_composite.rs` green. (Video-only doesn't touch the renderer; map-only and composite do.)
- `TRAILCUT_RENDERER=native cargo test --features integration_export` still passes — the legacy renderer remains a working hotfix path until 119.
- An app-level smoke test: build the app with `npm run tauri build --debug`, import a fixture project, click Export, confirm a clean wobble-free `.mov` is produced. (Documented as a manual step; not a CI assertion.)
- The bundled `.app` (or `.dmg`) contains `chrome-headless-shell-<host-triple>` in the resources directory. Verify with `tar -tf` or by cracking open the bundle.
- `docs/export/PLAN.md`'s renderer-architecture section reflects the new architecture and links the migration plan.
- The first export after a fresh install does NOT download anything — the headless-shell binary is shipped, not downloaded.

## Out of scope

- Removing the native renderer or its dependency. That happens in 119 after one release cycle of bake time on the chromium default.
- Windows binaries / Windows-bundle entries in `tauri.conf.json`. Task 130's slot.
- Cold-start prelaunch UX (plan §7 R5). Deferred; current cold-start is acceptable for v1.
- Telemetry on bundle size, perf, or worker stderr. Not infrastructure we have; not building it here.
