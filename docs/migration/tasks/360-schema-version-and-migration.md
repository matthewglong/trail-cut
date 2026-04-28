# Task 360 — Add `schema_version` and v1→v2 migration logic

**Step**: 3 (MapView refactor) — persistence
**Estimated effort**: 2h
**Status**: pending
**Depends on**: 350

## Goal

Add a `schema_version: u32` field to the Rust `Project` struct and implement v1→v2 migration in `load_project` per §3.9.3 of the migration doc. The migration doc (§3.9.3): "**v1**: pre-migration shape (`route` present in JSON, no `transition_feel`). **v2**: post-migration shape (`route` re-parsed from `route.gpx`, `transition_feel` present, defaults to `'natural'`)."

## Files to touch

- `src-tauri/src/models.rs` — modify — add `schema_version: u32` to `Project` with `#[serde(default = "default_schema_version")]` returning 1 (so old files without the field are read as v1). Add a `pub const CURRENT_SCHEMA_VERSION: u32 = 2;` constant.
- `src-tauri/src/commands/project.rs` — modify — `load_project` reads the JSON twice (once as `serde_json::Value` to peek at `schema_version`, once into `Project` after migration), or uses a `serde(default)` deserializer + a post-deserialize fixup. Apply the v1→v2 migration: drop persisted `route` field (it's re-parsed from `route.gpx` in task 370), default `transition_feel` to `Natural`. Always write `schema_version: 2` on save.

## Deliverables

- `Project` struct has `schema_version: u32`.
- `load_project` detects `schema_version` (1 if absent, otherwise the value), runs migration, returns a v2 in-memory project.
- `save_project` always writes `schema_version: 2`.
- Round-trip test: load an old project (no schema_version, has `route`, no `transition_feel`), save it, reload — second load reads `schema_version: 2`, `route` field is gone from JSON.

## Acceptance criteria

- [ ] `cargo build --manifest-path src-tauri/Cargo.toml` passes.
- [ ] `npm run tauri dev`: opening any existing pre-migration `.trailcut` bundle succeeds.
- [ ] After save, the on-disk `project.json` contains `"schema_version": 2`.
- [ ] After save, the on-disk `project.json` does NOT contain a top-level `"route":` key (task 370 makes this fully true; this task can land first if the v1 read tolerates the field being present in JSON but ignored on save).
- [ ] Unit test in Rust (or a one-off fixture-based integration test) demonstrates the v1→v2 migration round-trip.

## Implementation notes

Suggested implementation pattern in `load_project`:

```rust
let raw: serde_json::Value = serde_json::from_str(&contents)?;
let version = raw.get("schema_version").and_then(|v| v.as_u64()).unwrap_or(1) as u32;

let project = match version {
    1 => migrate_v1_to_v2(raw)?,
    2 => serde_json::from_value(raw)?,
    _ => return Err(format!("Unknown schema version {}", version).into()),
};
```

`migrate_v1_to_v2` strips the `route` field (it'll be re-parsed in task 370) and ensures `transition_feel` is present (defaulting to `Natural`), then deserializes into `Project`.

`save_project` body sets `project.schema_version = CURRENT_SCHEMA_VERSION` before serializing, OR the `Project` struct's `Default` impl returns `2`, OR we rely on serialization to always write 2 (e.g., a custom `Serialize` impl). Pick the simplest — set it explicitly in `save_project`.

Coordinate with task 370 — they touch the same file (`load_project`). Land 360 first (adds the version field + migration scaffold), then 370 fills in the actual `route.gpx` re-parsing inside `migrate_v1_to_v2` (or directly in `load_project`).

The migration doc emphasizes this is **cheap insurance**: "Cheap insurance for the day a model field's *shape* needs to change (not just be added). Serde already handles additive changes via `#[serde(default)]`; the version field exists for the harder cases."
