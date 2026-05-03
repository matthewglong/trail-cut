# Task 540 — Switch the playhead axis from wall-clock to project-time

**Step**: Compiled Timeline (Step 5)
**Estimated effort**: 2h
**Status**: pending
**Depends on**: 530

> **MUST LAND IN THE SAME PR AS TASK 530.** Per the plan: "The playhead axis switch (step 5) lands in the same PR as the new `cameraAt` (step 4) — splitting causes a half-translated regime." Treat 530 + 540 as a single shippable unit even though they live in separate task files for review clarity.

## Goal

Replace the wall-clock `playheadMs` in `App.tsx` and `ProjectView.tsx` with a project-time playhead. The video player still emits clip-local media time; `ProjectView` translates clip-local → project-time using the active clip's compiled span. Per §"Implementation Plan → 5. Switch playhead axis" of `docs/migration/COMPILED_TIMELINE_PLAN.md`.

## Files to touch

- `src/screens/ProjectView.tsx` — modify — replace the `playheadMs: number | null` derivation (currently wall-clock from `parseTimestamp(clip.created_at) + clipLocalMediaMs`) with a project-time derivation: `projectPlayheadMs = clipSpan.startMs + (clipLocalMediaMs - clipSpan.mediaInMs) / clip.effects.speed`. Replace the `buildMapTrack(...)` `useMemo` with `compileTimeline(...)` and pass the resulting `CompiledTimeline` as `timeline` to `MapView`.
- `src/components/MapView.tsx` — modify — accept `timeline: CompiledTimeline` instead of `track: MapTrack`. **Do not yet update the ease loop body** — that's task 550, but it must compile and run after this task. The simplest interim is to keep the old prop alongside and dual-wire: pass both `track` and `timeline`, route the ease loop through whichever is present. Cleaner: do this in the same diff as task 550. Pick one and document.
- `src/App.tsx` — modify — wherever `playheadMs` is propagated through props, ensure the value passed to `ProjectView` (or down to consumers expecting wall-clock) is the new project-time value. If `App.tsx` does not currently translate, only the ProjectView-internal derivation changes.
- `src/components/VideoPreview/*` — verify — the video player keeps emitting clip-local media time. No change to its emitted axis.

## Deliverables

- `ProjectView` derives `projectPlayheadMs` from the compiled timeline + the selected clip's clip-local time.
- `MapView` consumes `CompiledTimeline` and project-time in its ease loop (full ease-loop refactor in task 550; this task can ship a thin wrapper that calls the new `cameraAt(timeline, t)` if 550 ships separately).
- `App.tsx` no longer references wall-clock playhead at any boundary that crosses into MapView.
- The video player remains the source of truth for clip-local media time; `ProjectView` is the only place that translates clip-local → project-time.

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] `npm run tauri dev` runs and the live preview behaves equivalent to today's: smooth clip-to-clip handoff (entry transitions now play on auto-advance/selection — that's the whole point), marker tracks playhead, bearing rotates as configured.
- [ ] Selecting a clip seeks the video to its trim-in and the map to the clip span's `canonicalSeekMs`.
- [ ] Auto-advance from clip A to clip B causes project-time to cross the transition span's boundary, so the entry transition plays. (This is the regression-fix the redesign is targeting.)
- [ ] Looping inside a single clip stays inside that clip span — no transition fires.
- [ ] No remaining reference to `MapTrack` or `buildMapTrack` in `ProjectView.tsx` after this task.
- [ ] Continuity invariants (from task 530) still pass against synthetic timelines exercised by the running app.

## Implementation notes

Project-time derivation (per §"Time-Axis Translation" of the plan, inverted):

```ts
// inside ProjectView, given the active clip and its clip-local media time
const clipSpan = timeline.clipSpans.find(s => s.clipId === activeClipId);
if (!clipSpan) return null;
const projectPlayheadMs = clipSpan.startMs + (clipLocalMediaMs - clipSpan.mediaInMs) / clip.effects.speed;
```

Note that `effects.speed` cancels: clip-local seconds are compressed into project-time at the same rate the clip span was elongated. Sanity check: at `clipLocalMediaMs = mediaInMs`, `projectPlayheadMs = clipSpan.startMs`. At `clipLocalMediaMs = mediaOutMs`, `projectPlayheadMs = clipSpan.endMs`.

For preview *during* an entry transition: the video element doesn't advance during the transition span (the transition is camera-only; clip media plays from the clip span). So the playhead-during-transition is driven by an animated project-time variable, not the video element. Two implementation options:

1. **Drive transitions via a project-time animator**: when auto-advance crosses into a transition span, animate `projectPlayheadMs` from `transitionSpan.startMs` → `transitionSpan.endMs` over `effectiveDurationMs` real ms, then resume video playback at `clipSpan.startMs` (which equals `transitionSpan.endMs`). The video element pauses or seeks during the transition.
2. **Couple transition to video crossfade**: more complex, defer.

Option 1 is the minimum viable. Document the choice and any deferred work.

`canonicalSeekMs` consumption: when the user clicks a clip in the timeline strip, set `projectPlayheadMs = clipSpan.canonicalSeekMs`. The video seeks to `mediaInMs` (clip-local) for that clip, the map ease loop's next tick reads the new `projectPlayheadMs` and lands on the clip's intent.

Coordinate carefully with task 550 — the MapView ease loop change is the consumer of the new `timeline` prop. If 540 lands without 550, keep a thin shim in MapView that calls `cameraAt(timeline, projectPlayheadMs)` directly inside the existing ease loop.
