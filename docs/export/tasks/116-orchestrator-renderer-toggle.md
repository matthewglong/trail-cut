# Task 116 — Orchestrator renderer toggle (`TRAILCUT_RENDERER` env flag)

**Step**: Export pipeline (renderer migration step 2 of 5 — see [`../plans/chromium-renderer.md`](../plans/chromium-renderer.md))
**Estimated effort**: ~0.5 day (3–4h)
**Status**: pending
**Depends on**: 115 (chromium sidecar exists at `src-tauri/sidecars/renderer-chromium/dist/renderer.cjs`).

## Goal

Make `OrchestratorConfig` choose between the two renderer bundles via the `TRAILCUT_RENDERER` environment variable. `native` (default) routes to the existing `src-tauri/sidecars/renderer/dist/renderer.cjs`; `chromium` routes to `src-tauri/sidecars/renderer-chromium/dist/renderer.cjs`. No other code changes — same `OrchestratorConfig` struct surface, same protocol, same `render_map_frames` entry point.

This is a one-call-site change. It exists so dev-mode validation in step 3 (golden frames, task 117) can run against the new sidecar without touching the orchestrator's defaults, and so the cutover in step 4 (task 118) is a one-line flip rather than a multi-file change.

**Load-bearing invariant — the env flag is a dev/test convenience, not a user-facing knob.** It does not appear in any UI, in any `tauri.conf.json` setting, or in `~/.trailcut/`. Production builds always resolve to one renderer; the flag is read at orchestrator construction and forgotten. After 119 deletes the native renderer, this code path goes away entirely.

## Files to touch

- Modified: `src-tauri/src/export/orchestrator.rs`:
  - In `OrchestratorConfig::default()`, read `std::env::var("TRAILCUT_RENDERER")`. Match on `"chromium"` (case-insensitive trim) → resolve `renderer_cjs_path` to `sidecars/renderer-chromium/dist/renderer.cjs`. Anything else (including unset, empty, or `"native"`) → existing `sidecars/renderer/dist/renderer.cjs`. Default behavior stays exactly identical to today.
  - Add a comment block at the env-read site explaining: this is a temporary toggle for the chromium-renderer migration (task 116), removed in task 119.

- New: `src-tauri/src/export/tests/orchestrator_renderer_toggle.rs` (or inline as a `#[cfg(test)]` module in `orchestrator.rs` — pick whichever matches the existing convention; check `orchestrator.rs` for existing test placement and follow it). Two tests:
  - `default_renderer_is_native_when_env_unset` — clears the env var, calls `OrchestratorConfig::default()`, asserts `renderer_cjs_path` ends in `renderer/dist/renderer.cjs`.
  - `default_renderer_is_chromium_when_env_chromium` — sets `TRAILCUT_RENDERER=chromium`, calls `OrchestratorConfig::default()`, asserts the path ends in `renderer-chromium/dist/renderer.cjs`. Restore the env var to its prior value at test exit (or use `std::env::set_var` + `std::env::remove_var` carefully — these tests must not leak state to other tests; if existing tests in this file use a serial mutex pattern, follow it).

- Modified: `docs/export/tasks/README.md` — add row for 116 ⬜.

- Untouched: every other Rust file, all worker source, `tauri.conf.json`, `package.json`. The env flag is read in exactly one place.

## Acceptance

- `cargo test` passes including the two new toggle tests.
- `cargo test --features integration_export` (default — env unset) passes against the **native** renderer, identical to today.
- `TRAILCUT_RENDERER=chromium cargo test --test render_export_map_only --features integration_export -- --nocapture` passes against the **chromium** renderer. The map-only render integration test is the smallest end-to-end check; if it passes, the orchestrator/protocol/sidecar wiring is correct end-to-end. (Composite and video-only tests are exercised in 117 and 118.)
- `cargo test --test render_export_video_only --features integration_export` and `cargo test --test render_export_composite --features integration_export` still pass with `TRAILCUT_RENDERER` unset (sanity that nothing regressed under default).
- `grep "TRAILCUT_RENDERER" src-tauri/src/` shows the env var is read in exactly one location.

## Out of scope

- Wiring the env var through `tauri.conf.json` or any production config surface. The chromium renderer is not yet the default and is not yet user-facing. Production behavior is unchanged.
- Documenting the env var in `README.md` or anywhere else. It's transient; deleted in 119.
- Cross-platform binary resolution. Path resolution still uses the dev-mode `CARGO_MANIFEST_DIR` join — production sidecar resolution via `bundle.externalBin` is task 118's concern.
