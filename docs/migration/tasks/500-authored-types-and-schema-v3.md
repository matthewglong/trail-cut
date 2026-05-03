# Task 500 — Add authored types (`ProjectStartCamera`, `ClipEntryTransition`) and bump schema v2 → v3

**Step**: Compiled Timeline (Step 1)
**Estimated effort**: 2h
**Status**: pending
**Depends on**: —

## Goal

Introduce the authored data model for the compiled-timeline redesign in both TypeScript and Rust, and bump the project schema from v2 to v3 with a forward migration that fills sensible defaults. Per §"Data Model → Authored Data" and §"Implementation Plan → 1. Add authored types" of `docs/migration/COMPILED_TIMELINE_PLAN.md`.

This task only ships the *persisted shape*. No compiler or evaluator code yet, no UI to edit the new fields. Existing projects must continue to load.

## Files to touch

- `src/types.ts` — modify — add `ProjectStartCamera` and `ClipEntryTransition` interfaces. Add `start_camera?: ProjectStartCamera` and `default_entry_transition?: ClipEntryTransition` to `Project`. Add `entry_transition?: ClipEntryTransition` to `Clip`. Keep the existing `transition_feel` and `schema_version` fields.
- `src-tauri/src/models.rs` — modify — add the equivalent Rust structs (`ProjectStartCamera`, `ClipEntryTransition`) with `#[serde(default)]` on the optional fields. Add the new optional fields to `Project` and `Clip`. Bump `pub const CURRENT_SCHEMA_VERSION: u32 = 3;`.
- `src-tauri/src/commands/project.rs` — modify — extend the existing migration ladder (the v1→v2 migration already in place is the template): add `migrate_v2_to_v3` (no-op fillers; the new fields are all optional and default to `None`). Update the `match version` block in `load_project` to route `2 => migrate_v2_to_v3(raw)?`.

## Deliverables

- `ProjectStartCamera { center: { lng, lat }, zoom, bearing, pitch }` exists in TS and Rust.
- `ClipEntryTransition { enabled?, durationMs?, entryBias?, feel? }` exists in TS and Rust. `entryBias` is a number expected to be in `[-1, 1]` (no runtime clamp here — clamping happens in the compiler).
- `Project.start_camera`, `Project.default_entry_transition`, and `Clip.entry_transition` are persisted with `#[serde(default)]` / optional in TS.
- `CURRENT_SCHEMA_VERSION = 3`. v2 projects load as v3 with all new fields = `None`. v3 projects round-trip cleanly.
- `transition_feel` semantics are unchanged on disk; this task is purely additive.

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] `cargo build --manifest-path src-tauri/Cargo.toml` passes.
- [ ] `npm run tauri dev`: opening a v2 `.trailcut` bundle succeeds; the in-memory `Project` has `schema_version: 3`, all new fields `None`/`undefined`.
- [ ] After save, on-disk `project.json` contains `"schema_version": 3`.
- [ ] Round-trip test (Rust unit or fixture-based): v2 JSON → load → save → reload reads `schema_version: 3` and preserves clip + transition_feel data.
- [ ] No code yet *consumes* the new fields — they exist only in the persisted shape and the in-memory types.

## Implementation notes

The v2 → v3 migration is the trivial case (purely additive optional fields). Suggested body:

```rust
fn migrate_v2_to_v3(mut raw: serde_json::Value) -> Result<Project, String> {
    if let Some(obj) = raw.as_object_mut() {
        obj.insert("schema_version".into(), serde_json::Value::from(3u32));
        // start_camera, default_entry_transition, entry_transition stay absent;
        // serde(default) fills them as None at deserialize time.
    }
    serde_json::from_value(raw).map_err(|e| e.to_string())
}
```

`entryBias` shape: store as `Option<f64>` in Rust / `number | undefined` in TS. The plan uses camelCase in the type sketches (`durationMs`, `entryBias`); match the existing serde convention in `models.rs` for the on-disk names — if the project uses snake_case for persisted fields, persist as `duration_ms` / `entry_bias` / `start_camera` / `default_entry_transition` / `entry_transition`. Document the chosen convention in a comment near the new types.

`feel` field: the per-clip override. Reuse the existing `TransitionFeel` enum already defined in `models.rs` and `types.ts`. `Option<TransitionFeel>` in Rust.

Defaults for `ProjectStartCamera` (centroid of clip starts, zoom 12, bearing 0, pitch 0/60 by style) are NOT computed in this task — they live in the compiler (task 520). Here we only persist the *override*; absent override means "compiler will use computed default."

Do NOT touch the existing v1 → v2 migration body; chain v2 → v3 after it (so a v1 project loaded fresh gets migrated v1 → v2 → v3 in sequence, or directly if you collapse the chain).
