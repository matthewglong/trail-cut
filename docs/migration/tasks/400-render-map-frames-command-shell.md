# Task 400 — Add render_map_frames Tauri command shell

**Step**: 4 (Export harness)
**Estimated effort**: 1h
**Status**: pending
**Depends on**: 360

## Goal

Create `src-tauri/src/commands/export.rs` and register a `render_map_frames(track, layout_per_frame, fps, output_dir)` Tauri command shell — IPC types and registration only, no rendering body yet. Per §6.4 step 1 of the migration doc: "Add a Tauri command `render_map_frames(track, layout_per_frame, fps, output_dir)` in a new `src-tauri/src/commands/export.rs`. The command signature mirrors `ARCHITECTURE.md:143`."

## Files to touch

- `src-tauri/src/commands/export.rs` — new — module with the command definition, the IPC payload structs (`RenderMapFramesArgs`, `LayoutFrame`-like serde shape), and a stub body that returns `Ok(())` with a `todo!()` comment.
- `src-tauri/src/lib.rs` — modify — register the new command in the Tauri builder's `invoke_handler`.
- `src-tauri/src/commands/mod.rs` (if it exists) or wherever modules are wired — modify — `pub mod export;`.
- `src/types.ts` (optional) — modify — add TS types mirroring the Rust IPC shape so the frontend can call `invoke('render_map_frames', ...)` with type safety.

## Deliverables

- The command `render_map_frames` is registered and callable from JS via `invoke`.
- Calling it returns `Ok(())` (or an empty success response) — body is a stub.
- IPC types match `ARCHITECTURE.md:143` shape: takes a track JSON (the serialized `MapTrack` — but since `MapTrack` is derived in-frontend, the simplest IPC is to send the full intent stream pre-resolved per frame, OR to ship the input `Project` and have the renderer build the track itself; pick one and document — recommended: ship pre-resolved `ResolvedCamera` per frame so the renderer is dumb).
- Output dir argument is a `PathBuf`.

## Acceptance criteria

- [ ] `cargo build --manifest-path src-tauri/Cargo.toml` passes.
- [ ] `npm run build` passes.
- [ ] `await invoke('render_map_frames', { ... })` from the frontend reaches the stub and returns successfully (verifiable via a manual call from devtools).
- [ ] `src-tauri/src/commands/export.rs` exists and is registered.

## Implementation notes

ARCHITECTURE.md:143 sketches the export flow. Inspect that file before designing the IPC shape.

Recommended IPC design (simplest, given that the export renderer is a hidden Tauri window — task 410):

```rust
#[derive(Deserialize)]
pub struct RenderMapFramesArgs {
    pub frames: Vec<FrameSpec>,
    pub fps: u32,
    pub output_dir: PathBuf,
}

#[derive(Deserialize)]
pub struct FrameSpec {
    pub frame_idx: u32,
    pub camera: ResolvedCamera,    // pre-resolved by the frontend
    pub map_rect: LayoutRect,       // viewport for this frame
}

#[derive(Deserialize)]
pub struct ResolvedCamera {
    pub center: LngLat,
    pub zoom: f64,
    pub bearing: f64,
    pub pitch: f64,
}

#[derive(Deserialize)]
pub struct LayoutRect {
    pub x: u32, pub y: u32, pub width: u32, pub height: u32,
}

#[tauri::command]
pub async fn render_map_frames(args: RenderMapFramesArgs) -> Result<(), String> {
    // task 420/430 fill this in
    todo!("renderer body lands in task 430")
}
```

Pre-resolving `ResolvedCamera` in the frontend keeps the Rust side dumb: it just orchestrates the hidden window and PNG file writes; all camera math stays in TS where it's tested.

Alternative (more invasive) — ship the raw `Project` to Rust, port `cameraIntent.ts` math to Rust. Strongly NOT recommended: doubles maintenance, diverges export from preview, defeats the migration's purity goal. Document the rejected alternative in a comment.

This task is just the registration. The IPC contract solidifies in task 420; the frame-by-frame body lands in task 430.
