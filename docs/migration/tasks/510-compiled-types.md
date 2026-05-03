# Task 510 — Add compiled types (`ClipSpan`, `TransitionSpan`, `CompiledTimeline`)

**Step**: Compiled Timeline (Step 2)
**Estimated effort**: 30m
**Status**: pending
**Depends on**: —

## Goal

Add the runtime-only compiled types to `src/lib/cameraIntent.ts` per §"Data Model → Compiled Data" and §"Implementation Plan → 2. Add compiled types" of `docs/migration/COMPILED_TIMELINE_PLAN.md`. Types only — no logic.

`MapAnchor` and `MapTrack` stay alongside; this task does not delete them. They are removed in task 570 once the new path is fully wired.

## Files to touch

- `src/lib/cameraIntent.ts` — modify — add the three new interfaces below the existing `MapAnchor` / `MapTrack` declarations. Export them.

## Deliverables

- Exported `ClipSpan`, `TransitionSpan`, `CompiledTimeline` interfaces matching the plan's shape.
- Existing `MapAnchor` / `MapTrack` types untouched.
- File compiles and is consumed nowhere yet.

```ts
export interface ClipSpan {
  clipId: string;
  startMs: number;            // project-time
  endMs: number;              // project-time
  mediaInMs: number;          // clip-local (= clip.trim.in_ms)
  mediaOutMs: number;         // clip-local
  canonicalSeekMs: number;    // project-time, where preview selection lands
  intent: CameraIntent;
}

export interface TransitionSpan {
  fromClipId: string | null;  // null for project-start → clip 1
  toClipId: string;
  startMs: number;            // project-time
  endMs: number;              // project-time
  effectiveDurationMs: number; // post-clamp
}

export interface CompiledTimeline {
  clipSpans: ClipSpan[];
  transitionSpans: TransitionSpan[];
  totalDurationMs: number;
  startCamera: ResolvedCamera;
  transitionFeel: TransitionFeel;
}
```

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] `npm run test:run` passes (no behavior change).
- [ ] All three types are exported and importable from `src/lib/cameraIntent.ts`.
- [ ] `MapAnchor` / `MapTrack` are still exported and unmodified.

## Implementation notes

Pure type addition. No tests required — the types are exercised by tasks 520 (compiler) and 530 (evaluator).

`startCamera` is `ResolvedCamera`, not `ProjectStartCamera` — the compiler resolves `ProjectStartCamera` (or its computed default) into a concrete `ResolvedCamera` at compile time. The "before t=0 hold" branch in the new evaluator (task 530) reads this directly.

`canonicalSeekMs` is the project-time the preview should land on when the user selects this clip. Per §"Preview Semantics" of the plan: typically the clip span's `startMs` (i.e. *after* any incoming transition). Document this as the convention in a code comment.

Keep `clipSpan.lengthMs = (mediaOutMs - mediaInMs) / clip.effects.speed` as a derived property — either compute on read or expose a helper. The plan gives the formula in §"Data Model → Compiled Data".
