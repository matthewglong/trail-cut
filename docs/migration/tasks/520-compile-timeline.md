# Task 520 — Implement `compileTimeline` (pure compiler)

**Step**: Compiled Timeline (Step 3)
**Estimated effort**: 4h
**Status**: pending
**Depends on**: 500, 510

## Goal

Implement the pure compiler that walks the ordered clip list, applies authored entry-transition settings, and produces a `CompiledTimeline`. Per §"Implementation Plan → 3. Implement the compiler" and §"Entry Placement → Boundary Formula" of `docs/migration/COMPILED_TIMELINE_PLAN.md`.

The compiler is the core determinism guarantee: same authored inputs → same compiled output, every time. Test against the continuity invariants on synthetic clip lists.

## Files to touch

- `src/lib/cameraIntent.ts` — modify — add `compileTimeline(clips, indexedRoute, projectMapSettings, project): CompiledTimeline` (or a parameter shape that conveys the project-level fields cleanly). Reuse `anchorIntentForClip` (existing) for per-clip intents. Reuse `vanWijkArc` / `arcDurationMs` for auto-derived durations. Add a `resolveProjectStartCamera(clips, project, mapSettings)` helper that produces the default centroid camera when `project.start_camera` is absent.
- `src/lib/cameraIntent.test.ts` — modify — add tests covering: empty clip list, single clip, three clips with no transitions authored, clips with explicit `durationMs`, clips with `entryBias` at `-1` / `0` / `1`, clamping when both sides overrun, first-clip clamping (always post-cut only).

## Deliverables

- `compileTimeline(...)` is pure: no DOM, no `performance.now`, no MapLibre.
- Clip spans:
  - `lengthMs = (mediaOutMs - mediaInMs) / clip.effects.speed`
  - `startMs` is the previous clip span's `endMs` (or `0` for clip 1).
  - `mediaInMs = clip.trim.in_ms`, `mediaOutMs = clip.trim.out_ms`.
  - `canonicalSeekMs = clipSpan.startMs` (preview lands after any incoming transition).
  - `intent` produced by existing `anchorIntentForClip(clip, settings, route, startMs, endMs)`.
- Transition spans (one per clip, including clip 1's project-start → clip 1):
  - `cutTime = previousClipSpan?.endMs ?? 0`. For clip 1, `cutTime = 0`.
  - Apply the boundary formula:
    ```
    requestedPreCut  = durationMs * (1 - entryBias) / 2
    requestedPostCut = durationMs * (1 + entryBias) / 2
    availablePreCut  = previousClipSpan ? previousClipSpan.lengthMs : 0
    availablePostCut = currentClipSpan.lengthMs
    effectivePreCut  = min(requestedPreCut,  availablePreCut)
    effectivePostCut = min(requestedPostCut, availablePostCut)
    start = cutTime - effectivePreCut
    end   = cutTime + effectivePostCut
    ```
  - `effectiveDurationMs = end - start` (post-clamp).
  - `fromClipId = previousClipSpan?.clipId ?? null`.
- `startCamera: ResolvedCamera` — resolved from `project.start_camera` if present, otherwise computed default (see §"Project Start Camera" of the plan).
- `totalDurationMs = clipSpans[clipSpans.length - 1].endMs` (or `0` if no clips).
- `transitionFeel` — pass-through from `project.transition_feel ?? 'natural'`.

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] `npm run test:run` passes for the new compiler test suite.
- [ ] **Continuity invariants** (per §"Continuity Invariants" of the plan) hold for any well-formed input — write tests asserting each:
  - [ ] `cameraAt(transitionSpan.startMs)` equals the previous clip's terminal resolved camera (or `startCamera` for clip 1). *Note: this invariant is fully testable here even though `cameraAt` lands in task 530 — the compiler must produce spans whose endpoints make the invariant satisfiable.*
  - [ ] `cameraAt(transitionSpan.endMs)` equals the current clip's initial resolved camera.
  - [ ] `cameraAt(clipSpan.startMs)` equals the clip's initial resolved camera.
  - [ ] `cameraAt(clipSpan.endMs)` equals the clip's terminal resolved camera.
  - [ ] No span has `start > end`.
  - [ ] `clipSpan[i].startMs == clipSpan[i-1].endMs` for all `i > 0` (no project-time gaps between clips).
  - [ ] `compileTimeline(...)` is pure: same inputs → deeply-equal output across two calls.
- [ ] **First-clip clamping**: for clip 1 with default `entryBias = 1`, the transition span has `startMs = 0` and `endMs = min(durationMs, clipSpan.lengthMs)`. With any other `entryBias`, the pre-cut side clamps to 0.
- [ ] **Both-sides overrun**: a 10s authored transition between two 1s clips produces `effectiveDurationMs = 2s` (sum of available media on both sides).
- [ ] **Authored `durationMs` wins literally**: when `durationMs` is set, `transitionFeel` is ignored for that transition. Only when `durationMs` is absent does the auto-derived `arcDurationMs(arc, feel)` apply.

## Implementation notes

The compiler is the place where authored data meets media reality. Two things to get right:

1. **Effective duration source**:
   ```ts
   const authored = mergeEntryTransition(project.default_entry_transition, clip.entry_transition);
   const arc = vanWijkArc(fromCamera, toCamera);
   const feel = authored.feel ?? project.transition_feel ?? 'natural';
   const durationMs = authored.durationMs ?? arcDurationMs(arc, feel);
   ```
   Per §"Duration: Authored vs. Auto-Derived" of the plan: `transitionFeel` only affects the auto-derived path. An authored `durationMs` is respected literally regardless of feel.

2. **`fromCamera` / `toCamera` for the arc**: these are the canonical *resolved* cameras at the transition endpoints — the previous clip's terminal camera (or `startCamera` for clip 1) and the current clip's initial camera. Per §"Camera State During a Transition": follow intents on either side collapse to point intents during the transition. Reuse the existing `interpolateAnchors` collapse logic — the math carries over unchanged.

3. **`resolveProjectStartCamera`** default per §"Project Start Camera":
   - `center`: centroid of all clip starting locations (use `clipWaypointLocation` for each clip; fall back to a sensible default if no clip resolves).
   - `zoom`: `12`.
   - `bearing`: `0`.
   - `pitch`: `60` for `'3d'` style, `0` otherwise.

4. **Non-visible / invalid clips**: per the existing `buildMapTrack` skip rules — `visible === false`, missing `created_at`, NaN parseTimestamp, `outMs <= inMs` — exclude from compiled timeline. The compiler must produce a coherent `CompiledTimeline` even for an empty clip list (`totalDurationMs = 0`, empty arrays).

5. **Naming**: `compileTimeline` is the recommended name. Alternative: rename existing `buildMapTrack` and have it return `CompiledTimeline` — but the plan's note "MapAnchor / MapTrack get fully replaced, not kept parallel" implies a fresh name is cleaner. Keep both functions in this task; delete `buildMapTrack` in task 570.

6. **Bearing / pitch interpolation** during transitions: per §"Camera State During a Transition" — circular lerp for bearing, linear lerp for pitch. This logic lives in the evaluator (task 530); the compiler only needs to ensure the *endpoints* are resolved correctly so the evaluator has well-defined inputs.

Do not touch `vanWijkArc`, `vanWijkSample`, `arcDurationMs`, `cameraForBounds`, `resolveIntent`, `locationAt`, `indexRoute`, or bearing keyframe code — these are reusable per the critical constraints in the plan.
