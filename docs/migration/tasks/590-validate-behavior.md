# Task 590 — Validate end-to-end behavior of the compiled-timeline preview

**Step**: Compiled Timeline (Step 10)
**Estimated effort**: 2h (manual + scripted verification)
**Status**: pending
**Depends on**: 570

## Goal

Run the explicit validation checklist from §"Implementation Plan → 10. Validate behavior" of `docs/migration/COMPILED_TIMELINE_PLAN.md` and capture results. This is the gating sign-off for the 500-series migration before export work (600-series) resumes.

Note: this is *preview* validation. Export-side validation lands as task 640 once the 600-series tasks ship.

## Files to touch

- `docs/migration/COMPILED_TIMELINE_VALIDATION_REPORT.md` — new — report capturing the test project used, the result of each checklist item, any deviations, and the final PASS / FAIL verdict.

## Deliverables

A report covering:

- **Test project**: a real `.trailcut` bundle with ≥3 clips and a GPX route. Document its name, clip count, total duration, and any noteworthy properties (e.g., a clip with a non-default `entryTransition`, a clip with `effects.speed != 1`).
- **Checklist** (each item PASS / FAIL with notes):
  - [ ] Manual clip selection restores cinematic camera entry motion. Selecting a clip lands the map on that clip's initial camera (= `cameraAt(timeline, clipSpan.canonicalSeekMs)` resolved). The motion to get there matches what export would render at the same `t`.
  - [ ] Auto-advance between clips plays the entry transition. Project-time crosses `transitionSpan.endMs` smoothly; the Van Wijk arc is visible during `[transitionSpan.startMs, transitionSpan.endMs]`.
  - [ ] Loop mode remains stable. Looping inside a single clip span does not trigger any transition. Camera follows the clip's intent throughout.
  - [ ] Export at any project-time `t` matches preview at the same `t`. *Deferred to task 640 once export tasks ship; note here.*
  - [ ] Inserting / reordering / deleting clips recompiles cleanly with no stale state. Verify by:
    - inserting a clip mid-timeline → compiled spans update; selection snaps to the affected clip's new `canonicalSeekMs`
    - deleting a clip → compiled spans update; if the deleted clip was active, selection moves to a sensible neighbor
    - reordering (if the UI supports it; currently chronological auto-order, so this is "change `created_at` and re-import" or programmatic)
- **Continuity invariants** sampled live: pick 5 random project-times across the test project, evaluate `cameraAt(timeline, t)` and confirm continuity at each adjacent span boundary.
- **Performance sanity**: the ease loop runs at the configured cadence (target STEP_MS = 50). No noticeable jank during transitions.

## Acceptance criteria

- [ ] Report file exists at `docs/migration/COMPILED_TIMELINE_VALIDATION_REPORT.md`.
- [ ] Every checklist item has a PASS / FAIL marker plus a short observation.
- [ ] Final verdict is PASS, OR every FAIL has a follow-up task filed.
- [ ] Continuity invariant spot-checks attached to the report (with the sampled `t` values and the measured deltas).

## Implementation notes

The validation is mostly manual — drive the app, observe, log. Augment with a small dev panel button if it speeds up the boundary-continuity spot checks (could compute `||resolveIntent(cameraAt(t-ε)) - resolveIntent(cameraAt(t+ε))||` for each boundary `t` and dump the values).

Per §"Continuity Invariants" of the plan, the gating tests for the new evaluator are:

- `cameraAt(transitionSpan.startMs)` equals the previous clip's terminal resolved camera (or `startCamera` for clip 1)
- `cameraAt(transitionSpan.endMs)` equals the current clip's initial resolved camera
- `cameraAt(clipSpan.startMs)` equals the clip's initial resolved camera
- `cameraAt(clipSpan.endMs)` equals the clip's terminal resolved camera
- `cameraAt(t)` is continuous across every span boundary (no jumps within numerical tolerance)
- `cameraAt(t)` is a pure function of `(track, t)` — same inputs always produce the same output

Tasks 520 and 530 already lock these in via unit tests; this task confirms they hold for a *real* project, not just synthetic clip lists.

If a checklist item fails, the right move is usually to file a focused follow-up task, fix in a small follow-up PR, then re-run this validation. Do not silently fix in this task.

Once this task is PASS, the 500-series is complete and the 600-series (export, planned in task 580) can begin.
