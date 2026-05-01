# Task 560 — Rework auto-advance, selection, and active-clip lookup against project-time

**Step**: Compiled Timeline (Step 7)
**Estimated effort**: 2h
**Status**: pending
**Depends on**: 540

## Goal

Update the three places in the app that translate user actions into playhead changes — auto-advance, manual selection, and the "active clip" lookup — to operate on project-time and the compiled timeline. Per §"Implementation Plan → 7. Rework auto-advance and selection" of `docs/migration/COMPILED_TIMELINE_PLAN.md`.

## Files to touch

- `src/screens/ProjectView.tsx` — modify — `handleClipEnded` (or wherever auto-advance lives), `handleSelectClip`, and the "currently active clip" derivation (used for highlighting in the timeline strip and for clip-info pane state).
- `src/components/Timeline/*` — verify / adjust — if the timeline strip computes the active clip independently, route it through the new `findActiveSpan(timeline, t)` helper instead.

## Deliverables

- **`handleClipEnded`**: when a clip's media ends, do NOT snap to the next clip's start. Instead, let project-time continue advancing past `clipSpan[i].endMs` into `transitionSpan[i+1]`, so the entry transition plays. After `transitionSpan[i+1].endMs`, the next clip's video begins playback at `mediaIn`. Implement as:
  - On video `ended` for clip `i`, start a project-time animator that advances `projectPlayheadMs` from `clipSpan[i].endMs` (= `transitionSpan[i+1].startMs` if entry bias has post-cut content; else from where the transition begins) to `transitionSpan[i+1].endMs` over `transitionSpan[i+1].effectiveDurationMs` real ms.
  - When the animator hits `transitionSpan[i+1].endMs`, switch the active clip to `i+1`, seek the video to `clip.trim.in_ms`, and resume normal playback.
- **`handleSelectClip`**: set `projectPlayheadMs = clipSpan.canonicalSeekMs` for the selected clip. Per §"Preview Semantics" of the plan: "selecting a clip seeks to that clip's canonical project-time position (typically the start of its clip span, after any incoming transition) ... preview selection should show export truth." Do not add a separate preview-only `flyTo` — the ease loop's normal chase produces the visible motion.
- **Active-clip lookup**: a helper `findActiveSpan(timeline, t): { kind: 'clip' | 'transition', span }` that binary-searches the sorted spans. For UI highlighting, transition spans report the *destination* clip as active.
- **Rapid reselection**: a new selection interrupts whatever the previous selection started. Implement by writing the new `projectPlayheadMs` and letting the ease loop's next tick chase it.

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] `npm run tauri dev`:
  - [ ] Clicking a clip in the timeline strip seeks to `canonicalSeekMs`. The map lands on the clip's initial camera. The video shows the trim-in frame.
  - [ ] Hitting "play" on clip A and letting it auto-advance to clip B plays the Van Wijk entry transition between them. The timeline strip highlights clip B as soon as project-time crosses `transitionSpan.endMs` (or earlier if the UI prefers showing the destination as active during transition — pick a rule and document).
  - [ ] Looping inside clip A keeps the camera on clip A's intent.
  - [ ] Rapidly clicking clip A → C → B during a transition correctly interrupts to B's `canonicalSeekMs`.
- [ ] No remaining manual `flyTo` / `easeTo` calls outside the MapView ease loop.
- [ ] Active-clip lookup is O(log n) (binary search), not O(n) per render.

## Implementation notes

The auto-advance project-time animator is the new piece. Pattern:

```ts
function startTransitionAdvance(span: TransitionSpan, onDone: () => void) {
  const start = performance.now();
  const tick = () => {
    const elapsed = performance.now() - start;
    const localT = Math.min(1, elapsed / span.effectiveDurationMs);
    setProjectPlayheadMs(span.startMs + localT * span.effectiveDurationMs);
    if (localT < 1) raf = requestAnimationFrame(tick);
    else onDone();
  };
  raf = requestAnimationFrame(tick);
}
```

For the `handleClipEnded` path: trigger this animator with the *next* clip's transition span, then on `onDone` call the existing "select next clip + seek video" path.

For interruptions (rapid reselect): cancel any in-flight animator before writing the new `projectPlayheadMs`. Use a ref to track the active animator's `raf` handle.

`findActiveSpan` is straightforward binary search over a single sorted array of all spans (as set up in task 530's lookup). Reuse the same array if possible.

UI highlighting rule (recommended, per the plan note in §"Implementation Plan → 7"): during a transition span, the destination clip is "active" for highlight purposes. The clip-info pane reads from the destination clip too. This avoids flashing back to the source clip's panel during the entry transition.

Edge case: clip 1's entry transition (from `startCamera`). If `entryBias = 1` (post-cut only), `transitionSpan.startMs = 0` and the camera ease begins at project start with no video playing yet. Document expected behavior — recommended: the video on clip 1 stays paused at `mediaInMs` until `t = transitionSpan.endMs`, then begins playback. Same pattern as inter-clip transitions.
