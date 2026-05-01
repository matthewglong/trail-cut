# Task 530 — Implement new `cameraAt(timeline, t)` evaluator

**Step**: Compiled Timeline (Step 4)
**Estimated effort**: 3h
**Status**: pending
**Depends on**: 520

> **MUST LAND IN THE SAME PR AS TASK 540.** Per the plan: "The playhead axis switch (step 5) lands in the same PR as the new `cameraAt` (step 4) — splitting causes a half-translated regime." Treat 530 + 540 as a single shippable unit even though they live in separate task files for review clarity.

## Goal

Implement the new project-time evaluator `cameraAt(timeline: CompiledTimeline, t: number): CameraIntent` per §"Implementation Plan → 4. Implement new cameraAt(timeline, t)" of `docs/migration/COMPILED_TIMELINE_PLAN.md`. This is the single function preview and export both consume.

## Files to touch

- `src/lib/cameraIntent.ts` — modify — add the new `cameraAt(timeline, t)` overload (rename the existing wall-clock one to `cameraAtWallClock` or similar so both can coexist briefly until task 570 deletes the old one). Reuse the canonical-camera collapsing and Van Wijk sampling already used by `interpolateAnchors`.
- `src/lib/cameraIntent.test.ts` — modify — add tests for the four time regions (before-zero, inside clip span, inside transition span, after-total) plus all continuity invariants.

## Deliverables

- Pure `cameraAt(timeline, t)` returning a `CameraIntent` (not a `ResolvedCamera` — viewport stays out of this layer).
- Region routing:
  - `t < 0`: hold `timeline.startCamera` (returned as a point intent at `t = 0`).
  - `t >= totalDurationMs`: hold the last clip's terminal camera.
  - Inside a `ClipSpan`: return the clip's intent, with project-time → clip-local → wall-clock translation for follow intents (see §"Time-Axis Translation").
  - Inside a `TransitionSpan`: Van Wijk between the two canonical resolved cameras at the boundary, parameterized by `localT = (t - start) / (end - start)`.
- Span lookup is O(log n) (binary search across sorted spans).
- Bearing interpolated as circular lerp; pitch as linear lerp. Center / zoom from `vanWijkSample`.

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] `npm run test:run` passes for new evaluator tests.
- [ ] **Continuity invariants** (per §"Continuity Invariants" of the plan):
  - [ ] `cameraAt(timeline, transitionSpan.startMs)` equals the previous clip's terminal resolved camera (or `startCamera` for clip 1).
  - [ ] `cameraAt(timeline, transitionSpan.endMs)` equals the current clip's initial resolved camera.
  - [ ] `cameraAt(timeline, clipSpan.startMs)` equals the clip's initial resolved camera.
  - [ ] `cameraAt(timeline, clipSpan.endMs)` equals the clip's terminal resolved camera.
  - [ ] `cameraAt(timeline, t)` is continuous across every span boundary within numerical tolerance (assert `||resolveIntent(cameraAt(t-ε)) - resolveIntent(cameraAt(t+ε))|| < 1e-6` at every boundary in a synthetic 3-clip timeline).
  - [ ] `cameraAt(timeline, t)` is a pure function: same `(timeline, t)` always produces the same output.
- [ ] **Follow intent translation**: inside a clip span with a follow intent, `cameraAt(timeline, t).playheadMs` equals the wall-clock derived from `parseTimestamp(clip.created_at) + (t - clipSpan.startMs) * clip.effects.speed + clipSpan.mediaInMs`.
- [ ] Empty timeline: `cameraAt(timeline, t)` returns `timeline.startCamera` as a point intent for any `t`.

## Implementation notes

Time-axis translation for follow intents (per §"Time-Axis Translation"):

```ts
const clipLocalMs = (t - clipSpan.startMs) * clip.effects.speed + clipSpan.mediaInMs;
const wallClockMs = parseTimestamp(clip.created_at) + clipLocalMs;
// pass wallClockMs to liveIntent / locationAt downstream
```

The follow intent itself remains as authored — only the `playheadMs` field is replaced with `wallClockMs` so `resolveIntent` / `locationAt` resolve the correct GPX point. This is the only place project-time → wall-clock translation happens.

Transition-span body:

```ts
// localT in [0, 1]
const localT = (t - span.startMs) / (span.endMs - span.startMs);
const fromCam = canonicalResolvedCameraAt(span.fromClipId, 'end', timeline) ?? timeline.startCamera;
const toCam   = canonicalResolvedCameraAt(span.toClipId, 'start', timeline);
const arc     = vanWijkArc(fromCam, toCam);
const sample  = vanWijkSample(arc, localT);
return {
  kind: 'point',
  center: sample.center,
  zoom: sample.zoom,
  bearing: circularLerp(fromCam.bearing, toCam.bearing, localT),
  pitch: fromCam.pitch + (toCam.pitch - fromCam.pitch) * localT,
};
```

The "canonical resolved camera at clip start/end" computation collapses follow intents to their resolved point at that exact clip-local timestamp — same logic the existing `interpolateAnchors` uses. Reuse it. Per §"Camera State During a Transition" of the plan: "Follow intents on either side collapse to point intents during the transition window — the transition is between two snapshots, not a moving-target chase."

Span lookup: precompute a sorted array of `{ startMs, endMs, kind: 'clip' | 'transition', span }` for binary search. Or maintain two sorted arrays and binary-search in whichever covers `t`. Either is fine — document the choice.

Do NOT modify `vanWijkArc`, `vanWijkSample`, `arcDurationMs`, `cameraForBounds`, `resolveIntent`, `locationAt`, route indexing, or bearing keyframe code.

The old `cameraAt(track: MapTrack, t)` stays alongside until task 570. Use a distinct name (or function overload by parameter type) to disambiguate. Recommendation: keep `cameraAt` as the new project-time signature and rename the old one `cameraAtWallClock` so callers are explicit during the transition window.
