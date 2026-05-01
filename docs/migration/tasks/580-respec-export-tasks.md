# Task 580 — Author 600-series export tasks against the compiled timeline

**Step**: Compiled Timeline (Step 9)
**Estimated effort**: 2h (planning, no code)
**Status**: pending
**Depends on**: 570

## Goal

Author the export-side task set against the compiled-timeline architecture. Per §"Implementation Plan → 9. Re-spec Step 4 export tasks (400–440)" of `docs/migration/COMPILED_TIMELINE_PLAN.md`: "Preview and export share `cameraAt(timeline, t)`; export iterates `t = frame_index / fps`."

This task does not write export code. It produces the next batch of task files (600-series) describing the export-renderer scope, with the IPC and per-frame loop matched to the compiled-timeline evaluator.

## Files to touch

- `docs/migration/tasks/600-*.md` (new) — author the export task series, numbered 600 through 640.
- `docs/migration/SCORECARD.md` — modify — add the 600-series tasks to the scorecard with their dependencies.

## Deliverables

Five new task files under `docs/migration/tasks/600-*.md` covering:

- **600** — register `render_map_frames` Tauri command shell. IPC payload ships pre-resolved `ResolvedCamera` per frame derived from `cameraAt(timeline, t)`.
- **610** — hidden `/export-renderer` Tauri window route.
- **620** — IPC wiring: parent → renderer sends `(frames: FrameSpec[], fps, output_dir)` where each `FrameSpec` carries the `ResolvedCamera` from preview's evaluator.
- **630** — per-frame render loop with tile-load determinism check; the renderer calls `map.jumpTo(camera)` (no camera math in Rust, no second motion layer per §"Export Semantics" of the plan).
- **640** — pass criterion: render a 30-frame sequence and verify against `cameraAt(timeline, t)` truth.

Each new task should follow the established format (title / step / status / depends-on / goal / files / deliverables / acceptance / notes).

## Acceptance criteria

- [ ] Five new task files exist under `docs/migration/tasks/600-*.md`.
- [ ] Each new task's acceptance criteria explicitly references `cameraAt(timeline, t)` as the source of truth and the export determinism guarantee from §"Export Semantics" of the plan: "export at any project-time `t` matches preview at the same `t`."
- [ ] SCORECARD reflects the new tasks, with 600 depending on 570 (compiled-timeline complete) and the rest chaining 600 → 610 → 620 → 630 → 640.

## Implementation notes

Per §"Export Semantics" of the plan, the per-frame export loop is:

1. determine project time `t = frame_index / fps`
2. evaluate `cameraAt(timeline, t)`
3. resolve to a concrete camera with `resolveIntent(intent, viewport)`
4. `jumpTo` that exact camera
5. wait for tiles
6. capture frame

This means the IPC payload carries pre-resolved `ResolvedCamera` per frame — the renderer is "dumb" and never invokes `cameraAt` itself. Keeps the Rust side from needing a port of the camera math; export and preview stay locked to the same evaluator.

Task 640's pass criterion should include: at sampled frames, the rendered PNG's resolved camera matches `resolveIntent(cameraAt(timeline, t), viewport)` exactly (modulo tile freshness). This is the preview-parity gate the redesign promises.

Open questions to flag in the new task notes (do not resolve here):
- During a transition span, `cameraAt` returns a point intent (collapsed from Van Wijk). The renderer treats this as a normal frame. No special-case handling needed.
- For clip 1's `t = 0` to `transitionSpan.endMs` window (where the video isn't playing yet), the export composer needs a content-layer source — likely a held first frame of clip 1, or `startCamera`-only background. Flag this as design work belonging to the layout/compositing phase (out of scope for the camera migration).

This task is purely planning. No source code changes; only docs.
