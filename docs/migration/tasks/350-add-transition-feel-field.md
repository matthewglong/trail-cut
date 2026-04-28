# Task 350 — Add `transition_feel` field to Project (frontend + Rust)

**Step**: 3 (MapView refactor) — persistence
**Estimated effort**: 1h
**Status**: pending
**Depends on**: 010

## Goal

Add the `transition_feel: TransitionFeel` field to the frontend `Project` type and the Rust `Project` struct, additive with default `'natural'`, per §3.6 and §3.9 of the migration doc. This is the only camera-migration-introduced persisted field. The migration doc (§3.6): "Persist this under `Project.transition_feel: TransitionFeel` in `models.rs` (additive field, defaulting to `'natural'`)."

## Files to touch

- `src/types.ts` — modify — add `transition_feel?: TransitionFeel` to `Project`. Import or re-export `TransitionFeel` from `cameraIntent.ts` (or duplicate the union locally — pick one and document).
- `src-tauri/src/models.rs` — modify — add `transition_feel: Option<String>` (or a Rust enum) to `Project` with `#[serde(default)]`. Path-of-least-resistance: use `Option<String>` and trust the frontend to send only valid values; alternative is a `TransitionFeel` enum with serde rename_all.
- `src/screens/ProjectView.tsx` — modify — replace the hardcoded `'natural'` from task 300's TODO with `project.transition_feel ?? 'natural'`.

## Deliverables

- New persisted field that round-trips through save/load.
- Existing project files (without the field) still load — value defaults to `'natural'`.
- Frontend can read and pass the value into `buildMapTrack`.
- This task does NOT add a UI to set the field (the migration doc explicitly defers transition authoring UI; setter is hardcoded for now or set via test edits to `project.json`).

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] `cargo build --manifest-path src-tauri/Cargo.toml` passes.
- [ ] Loading a pre-existing `project.json` without `transition_feel` succeeds and the in-memory project has `transition_feel === undefined` (or `'natural'` after defaulting).
- [ ] Saving a project writes `transition_feel` to disk if set, omits it if undefined (or always writes the default — pick one, document).
- [ ] `buildMapTrack` is called with the resolved transition feel from the project.

## Implementation notes

Frontend `TransitionFeel` is the literal union `'natural' | 'snappy' | 'slow'`. Rust has two reasonable shapes:

1. **`Option<String>`** with `#[serde(default)]` — simplest, but type-unsafe at the Rust boundary.
2. **`Option<TransitionFeel>` enum** with `#[serde(rename_all = "lowercase")]` — type-safe, slightly more code:
   ```rust
   #[derive(Serialize, Deserialize, Debug, Clone, Copy)]
   #[serde(rename_all = "lowercase")]
   pub enum TransitionFeel { Natural, Snappy, Slow }
   ```

Recommended: option 2 for type safety. The added code is ~6 lines and matches the project's existing pattern (e.g., `BearingMode` if present).

Default behavior: when reading an old project, serde fills in `None`. The frontend resolves `None` to `'natural'` at the call site (`project.transition_feel ?? 'natural'`).

This task is independent of task 360 (schema_version) and 370 (drop persisted route) — order them by reviewer preference. They can land as separate commits.

The migration doc emphasizes (§3.6) there is **no transition authoring UI**: "There is **no first-class Transition object, no transition authoring UI, no per-pair transition data**." This task ships the persistence only.
