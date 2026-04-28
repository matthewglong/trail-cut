# Task 370 — Drop persisted `route` from project.json; re-parse from route.gpx on load

**Step**: 3 (MapView refactor) — persistence
**Estimated effort**: 1h
**Status**: pending
**Depends on**: 360

## Goal

Remove the `route` field from the persisted Rust `Project` shape. `save_project` no longer serializes route data. `load_project` re-parses `route.gpx` (using the existing `parse_gpx` helper) after JSON load and returns the in-memory project with the route populated. Per §3.9.2 of the migration doc: "**Proposal**: drop the `route` field from the persisted `Project` and re-parse from `route.gpx` on load. `project.json` becomes <10KB for a typical project."

## Files to touch

- `src-tauri/src/models.rs` — modify — drop `route: Option<Route>` from the persisted shape OR add `#[serde(skip)]` so it stays as an in-memory field but is never serialized/deserialized.
- `src-tauri/src/commands/project.rs` — modify — `load_project` calls `parse_gpx(<bundle>/route.gpx)` if the file exists, populates the in-memory `project.route`. `save_project` does not write the route field.
- `src/types.ts` — verify — frontend `Project` type stays as-is (route still in-memory). No change needed if `route` is already in the frontend type.

## Deliverables

- Rust `Project` has `route` as a `#[serde(skip)]` in-memory field (or removed entirely from the persisted struct and reconstructed at the boundary).
- `save_project` writes a `project.json` without a top-level `"route"` key.
- `load_project` re-parses `route.gpx` from the bundle directory and sets the in-memory route.
- Round-trip: save → re-open → route is present in the loaded project (verified via the frontend MapView still drawing the trail).

## Acceptance criteria

- [ ] `cargo build --manifest-path src-tauri/Cargo.toml` passes.
- [ ] `npm run build` passes.
- [ ] `npm run tauri dev`: open a project with a GPX route, save, close, reopen — route still visible on the map.
- [ ] After save, `project.json` is <50KB for a project with a typical multi-hour GPX (the doc says <10KB; allow margin for clips + settings).
- [ ] Loading a project bundle whose `route.gpx` is missing succeeds — route in memory is `None` (or null), no crash.
- [ ] Loading a v1 project (where `route` is in the JSON) ignores the JSON `route` field and uses `route.gpx` instead.

## Implementation notes

Approach 1 (preferred): use `#[serde(skip)]` on the `route` field in the Rust struct. The field stays in-memory, never serialized. `load_project` populates it after deserializing the JSON.

```rust
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Project {
    pub schema_version: u32,
    pub clips: Vec<Clip>,
    #[serde(skip)]
    pub route: Option<Route>,
    pub map_settings: Option<MapSettings>,
    pub transition_feel: Option<TransitionFeel>,
    pub exports: Vec<ExportConfig>,
    // ...
}
```

`load_project` body addition:

```rust
let route_path = bundle_dir.join("route.gpx");
if route_path.exists() {
    project.route = Some(parse_gpx_internal(&route_path)?);
}
```

Where `parse_gpx_internal` is the existing parser (the `parse_gpx` Tauri command wraps it; expose the internal helper directly to Rust).

The migration doc rationale (§3.9.2):
- A typical 1Hz GPX trace for a multi-hour hike runs 5–20k trackpoints, ~80 bytes each → 0.5-2 MB of JSON.
- Two copies (route in JSON + route.gpx) can drift.
- `route.gpx` is the canonical source.

This task pairs with task 360's v1→v2 migration: a v1 project may have `route` in the JSON; `migrate_v1_to_v2` should ignore it and let task 370's `load_project` populate from `route.gpx`. After save, the file is v2 with no `route`.

§8 has no open question for this task — straightforward refactor.
