# Task 570 — Delete the old wall-clock anchor code

**Step**: Compiled Timeline (Step 8)
**Estimated effort**: 1h
**Status**: pending
**Depends on**: 550, 560

## Goal

Once the new compiled-timeline path is verified end-to-end, remove `MapAnchor`, `MapTrack`, the old `buildMapTrack`, and the old wall-clock `cameraAt` (or `cameraAtWallClock` if renamed in task 530). Per §"Implementation Plan → 8. Delete old wall-clock anchor code" of `docs/migration/COMPILED_TIMELINE_PLAN.md`. Update tests.

## Files to touch

- `src/lib/cameraIntent.ts` — modify — delete `MapAnchor`, `MapTrack`, `buildMapTrack`, `anchorIntentForClip` (if no longer reused; the new compiler may inline it or reuse it — keep whichever path the compiler depends on), and the old `cameraAt(track: MapTrack, t)` overload. Delete `liveIntent` if no longer used. Keep all Van Wijk primitives, `cameraForBounds`, `resolveIntent`, `interpolateAnchors` (if still used by the new evaluator's transition body).
- `src/lib/cameraIntent.test.ts` — modify — delete tests for the removed functions. Confirm the new compiler/evaluator tests from tasks 520 and 530 still cover the equivalent behaviors.
- `src/screens/ProjectView.tsx` — verify — no remaining import of removed symbols.
- `src/components/MapView.tsx` — verify — no remaining import of removed symbols.

## Deliverables

- All wall-clock-anchor types and functions removed from `cameraIntent.ts`.
- Build is green and `npm run test:run` passes.
- No dead imports anywhere in the repo (`grep -r MapAnchor src` returns nothing; same for `MapTrack`, `buildMapTrack`, `cameraAtWallClock`).
- Reusable primitives (`vanWijkArc`, `vanWijkSample`, `arcDurationMs`, `cameraForBounds`, `resolveIntent`, `locationAt`, `indexRoute`, bearing keyframe code) intact.

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] `cargo build --manifest-path src-tauri/Cargo.toml` passes.
- [ ] `npm run test:run` passes.
- [ ] `npm run tauri dev` — preview behavior unchanged from end of task 560.
- [ ] `grep -rn 'MapAnchor\|MapTrack\|buildMapTrack' src` returns zero matches.
- [ ] All remaining exports from `cameraIntent.ts` are referenced somewhere.

## Implementation notes

This task is the cleanup pass after the parallel-living period. Per the critical constraint in the plan: "MapAnchor/MapTrack get fully replaced, not kept parallel."

If `anchorIntentForClip` was reused inside `compileTimeline` (task 520), keep it — only delete the old types and the old top-level `cameraAt` / `buildMapTrack` functions.

If `interpolateAnchors` is still called inside the new evaluator (task 530's transition body uses its canonical-camera-collapsing math), keep it. If the new evaluator inlined that math, delete `interpolateAnchors` too.

`liveIntent` is the wall-clock branch helper (`{ ...intent, playheadMs: t }`). The new evaluator does the same translation but with project-time → wall-clock conversion baked in. If the new code does not import `liveIntent`, delete it.

Run a final full-text grep for the deleted symbols across the entire repo (including comments and docs that aren't `docs/migration/`) and remove stale references. Migration docs themselves can keep historical references — they describe completed work.
