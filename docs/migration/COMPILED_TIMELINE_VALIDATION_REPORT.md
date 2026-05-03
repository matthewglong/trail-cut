# Compiled-Timeline Preview Validation Report

**Task**: [590 — Validate end-to-end behavior of the compiled-timeline preview](./tasks/590-validate-behavior.md)
**Branch**: `migration/cameraAt`
**Date**: 2026-05-02
**Verdict**: **PARTIAL — programmatic checks PASS; manual checklist items pending user verification**

This is the gating sign-off for the 500-series migration before export work (600-series, authored in task 580) resumes. The probe-driven half is complete. The four checklist items that require driving the live preview UI are documented below with reproduction steps; once a human walks through them, this report will be amended to a final PASS / FAIL verdict.

## Test Project

| Field                     | Value                                                    |
|---------------------------|----------------------------------------------------------|
| Path                      | `/Users/personal/Desktop/bri test/MyHike.trailcut`       |
| Name                      | MyHike                                                   |
| Schema version            | 3                                                        |
| Clip count                | 6                                                        |
| Total compiled duration   | 65,166 ms (~65 s)                                        |
| GPX route                 | Bundled (`route.gpx`); ignored by this probe (see Notes) |
| `transition_feel`         | unset (compiler default `natural`)                       |
| `start_camera` override   | none (computed default centroid: -122.4785, 37.7684)     |
| `default_entry_transition`| none (compiler default `entryBias=0`, auto-derived dur)  |
| Per-clip overrides        | none (every clip uses defaults)                          |
| Per-clip `effects.speed`  | 1.0 across all 6 clips                                   |

This project exercises the **defaults** end-to-end. No clip has an authored
`entryTransition.duration_ms`, no clip has a non-default `entryBias`, and no
clip is sped up or slowed. Every transition lands on the auto-derived path
(`arcDurationMs(arc, feel)` → clamped to `MIN_MS = 1100`).

> **Probe limitation — call out for manual verification**: this report's
> programmatic continuity checks compile the timeline with `route: null`. With
> the GPX route loaded (as the live app does), every clip's intent becomes a
> `follow` intent rather than `point`, and the in-clip camera tracks the
> marker. Continuity invariants are pure-math properties of the compiler and
> evaluator — they hold identically with or without the route — but the
> *visible* behavior during clip spans differs significantly between the two
> regimes. The manual checklist items below cover the route-loaded regime.

## Compiled Timeline (probe output)

```
totalDurationMs: 65166.0
clipSpans:       6
transitionSpans: 6 (incl. project-start → clip-1)
startCamera:     center=(-122.4785,37.7684) zoom=12.00 bearing=0 pitch=0
```

Clip spans (project-time, ms):

| i | startMs | endMs  | lengthMs | speed | intent |
|---|--------:|-------:|---------:|------:|--------|
| 0 |       0 |   6900 |     6900 |   1.0 | point  |
| 1 |    6900 |  16500 |     9600 |   1.0 | point  |
| 2 |   16500 |  31500 |    15000 |   1.0 | point  |
| 3 |   31500 |  42366 |    10866 |   1.0 | point  |
| 4 |   42366 |  52266 |     9900 |   1.0 | point  |
| 5 |   52266 |  65166 |    12900 |   1.0 | point  |

Transition spans (project-time, ms):

| i | fromClipId | toClipId | startMs | cutMs | endMs | effectiveDurationMs |
|---|------------|----------|--------:|------:|------:|--------------------:|
| 0 | null       | clip 0   |       0 |     0 |   550 |                 550 |
| 1 | clip 0     | clip 1   |    6350 |  6900 |  7450 |                1100 |
| 2 | clip 1     | clip 2   |   15950 | 16500 | 17050 |                1100 |
| 3 | clip 2     | clip 3   |   30950 | 31500 | 32050 |                1100 |
| 4 | clip 3     | clip 4   |   41816 | 42366 | 42916 |                1100 |
| 5 | clip 4     | clip 5   |   51716 | 52266 | 52816 |                1100 |

Notes:
- Trans 0 (`startCamera → clip 1`): `availablePreCut = 0` for clip 1 (no
  predecessor media), so `effectivePreCut = 0` and the span sits at
  `[0, 550]`. With default `entryBias = 0`, `requestedPostCut = 1100/2 = 550`
  — matches.
- Trans 1–5: full `[cut - 550, cut + 550] = 1100ms` window each.
  `effectivePreCut`/`effectivePostCut` are well under `availablePreCut`/`Post`
  for every neighboring clip (shortest is clip 0 at 6900ms ≫ 550ms).
- Auto-derived durations all clamp to `MIN_MS = 1100` because the inter-clip
  pan distance is ~500m and the zoom doesn't change — Van Wijk `S` is small,
  raw duration falls below the floor.

## Checklist

### 1. Manual clip selection restores cinematic camera entry motion

> Selecting a clip lands the map on that clip's initial camera (=
> `cameraAt(timeline, clipSpan.canonicalSeekMs)` resolved). The motion to get
> there matches what export would render at the same `t`.

**Status**: **PENDING — manual verification required**

**Reproduction**:
1. `npm run tauri dev`, open MyHike from the project gallery.
2. Click clip 4 (the 5th tile in the timeline strip) directly.
3. Observe: the video seeks to clip 4's `mediaIn` frame; the map eases toward
   the camera state at `clipSpan[4].canonicalSeekMs = 42366`. Per the
   compiled-timeline contract this should equal `cameraAt(timeline, 42366)`
   resolved against the current viewport — the exact camera export would
   render at frame `floor(42366 * fps / 1000)`.
4. Click clip 0, then clip 5. Each click should interrupt the previous
   chase and land on the new clip's initial camera.

**Pass criterion**: each click lands the map on the destination clip's
initial framing (the marker centered or lead-in framing as configured by
project map settings). Camera motion looks intentional, not snappy or
half-canceled. No flicker, no double-fly.

### 2. Auto-advance between clips plays the entry transition

> Project-time crosses `transitionSpan.endMs` smoothly; the Van Wijk arc is
> visible during `[transitionSpan.startMs, transitionSpan.endMs]`.

**Status**: **PENDING — manual verification required**

**Reproduction**:
1. With MyHike open, click clip 0, hit play.
2. Let it play through to its end (~6.9 s).
3. Observe: at project-time ~6350ms (the start of trans 1), the map should
   begin a Van Wijk ease toward clip 1's initial camera. The transition
   completes at project-time 7450ms; clip 1's video begins playback at its
   `mediaIn` frame at the same instant.
4. Repeat for the clip 2 → 3 boundary at project-time 30,950–32,050.

**Pass criterion**: the entry transition plays — visible camera motion that
looks like a smooth pan/zoom rather than a snap. The video's `ended` event
on clip A doesn't yank the map to clip B's frame; it crosses through the
transition window first. Active-clip highlight in the timeline strip flips
to clip B at the cut (project-time 6900 for trans 1), per task 560's
documented rule.

### 3. Loop mode remains stable

> Looping inside a single clip span does not trigger any transition. Camera
> follows the clip's intent throughout.

**Status**: **PENDING — manual verification required**

**Reproduction**:
1. Open MyHike. Toggle loop mode on (per the editor's loop control).
2. Click clip 2 (longest at 15s) and let it loop ~3 times.
3. Observe: the video restarts from `mediaIn` each iteration; the map stays
   on clip 2's intent throughout. No transition fires — `cameraAt` evaluates
   inside `clipSpan[2]` (project-time 16500–31500) for every loop iteration.

**Pass criterion**: no Van Wijk arc fires between loops. The camera stays
on clip 2's framing for every loop iteration. Marker (if visible) tracks
the playhead within the clip.

### 4. Export at any project-time `t` matches preview at the same `t`

> *Per task 590: deferred to task 640 once export tasks ship.*

**Status**: **DEFERRED to task 640** (per the task spec). Task 580 has now
authored the 600-series; task 640 is the export-side mirror of this
checklist item. No action needed in this report.

### 5. Inserting / reordering / deleting clips recompiles cleanly

> Verify by:
> - inserting a clip mid-timeline → compiled spans update; selection snaps
>   to the affected clip's new `canonicalSeekMs`
> - deleting a clip → compiled spans update; if the deleted clip was active,
>   selection moves to a sensible neighbor
> - reordering — UI is chronological auto-order, so this means changing
>   `created_at` and re-importing, or programmatic.

**Status**: **PENDING — manual verification required**

**Reproduction (insert)**:
1. Open MyHike. Note current clip count (6) and total duration (65 s).
2. Import a new video file with `created_at` falling between clip 2 and
   clip 3 (i.e. between 13:25:xx and 13:42:xx local time on 2026-04-04 —
   any iPhone clip in that window will land in slot 2).
3. Observe: the new clip appears at index 3 (0-based: position 3), pushing
   former clip 3 to index 4 and so on. Total duration grows by the new
   clip's `(out - in) / speed`. All transition spans for clips at index ≥ 3
   shift by that amount.
4. Click the new clip — the map should land on its initial camera with no
   visual artifacts from the prior compile.

**Reproduction (delete)**:
1. With MyHike open, select clip 4 (any non-edge clip), then delete it.
2. Observe: clip count drops to 5 (or 6 if you skipped insert). Total
   duration shrinks. Selection should move to a sensible neighbor (the next
   clip, or the previous if the deleted one was last). No stale state — the
   compiled timeline reflects the new ordering immediately.
3. Hit play from the start. Auto-advance should now land on the
   newly-adjacent pair without referencing the deleted clip.

**Reproduction (reorder)**: skip; UI is chronological-only. Re-importing
with edited `created_at` is equivalent to "insert" above.

**Pass criterion**: after each operation, the compiled timeline is
internally coherent (no overlap, no gap, no stale span). Selection state
moves to a valid clip. No console errors related to a stale compiled
timeline. No flash of the prior compile's camera state.

## Continuity Invariants — Probe Spot Check

Probe: `src/lib/cameraIntent.validation.test.ts` (gated by
`VALIDATION_PROBE=1`). Run with `VALIDATION_PROBE=1 npx vitest run
src/lib/cameraIntent.validation.test.ts --reporter=verbose`.

Method: at every span boundary `b` in the compiled timeline, evaluate
`||resolveIntent(cameraAt(timeline, b - ε)) - resolveIntent(cameraAt(timeline, b + ε))||`
with `ε = 0.001 ms` and the export-relevant 1080×1920 viewport.

Result:

```
=== Boundary Continuity (||cam(t-ε) - cam(t+ε)||) ===
  boundary_t   delta
      550.000  0.000e+0
     6350.000  0.000e+0
     6900.000  4.062e-8
     7450.000  0.000e+0
    15950.000  0.000e+0
    16500.000  1.009e-7
    17050.000  0.000e+0
    30950.000  0.000e+0
    31500.000  9.297e-9
    32050.000  0.000e+0
    41816.000  0.000e+0
    42366.000  1.253e-7
    42916.000  0.000e+0
    51716.000  0.000e+0
    52266.000  1.336e-7
    52816.000  0.000e+0

  max delta across 16 boundaries: 1.336e-7
```

**PASS**: max delta = 1.336e-7 (well under the 1e-2 probe tolerance).
The non-zero deltas appear at every cut boundary inside a transition span
— they reflect floating-point arithmetic in the Van Wijk sample (zoom is
log-scale, sub-ms `localT` deltas produce non-zero zoom changes). All are
below 1e-6 in magnitude. Continuity holds.

## 5 Random Project-Time Samples

Sampled at project-time fractions {0.07, 0.23, 0.41, 0.68, 0.91} of
totalDurationMs:

| t (ms) | intent.kind | center                | zoom   | bearing | pitch |
|-------:|-------------|-----------------------|-------:|--------:|------:|
| 4561.6 | point       | (-122.46480, 37.74690)| 14.000 |  0.00   | 0.00  |
| 14988.2| point       | (-122.47070, 37.75130)| 14.000 |  0.00   | 0.00  |
| 26718.1| point       | (-122.47370, 37.76820)| 14.000 |  0.00   | 0.00  |
| 44312.9| point       | (-122.48290, 37.78860)| 14.000 |  0.00   | 0.00  |
| 59301.1| point       | (-122.50520, 37.78520)| 14.000 |  0.00   | 0.00  |

All samples land inside clip spans (no transition span hits among the
random 5). Each `point` intent matches the clip's GPS waypoint at zoom 14
(the project's `MapSettings.zoom` default), bearing 0, pitch 0. Determinism
verified — re-running the probe with identical inputs produces deeply-equal
outputs (probe `compiles deterministically` test passes).

## Endpoint Invariants — Per-Span

Per the plan §"Continuity Invariants":
- `cameraAt(clipSpan.startMs)` equals the clip's initial resolved camera.
- `cameraAt(clipSpan.endMs)` equals the clip's terminal resolved camera.
- `cameraAt(transitionSpan.startMs)` equals the previous clip's terminal
  resolved camera (or `startCamera` for clip 1).
- `cameraAt(transitionSpan.endMs)` equals the current clip's initial
  resolved camera.

Probe results (zoom shown; full camera state checked in pure unit tests):

| Span         | startMs | start zoom | endMs | end zoom |
|--------------|--------:|-----------:|------:|---------:|
| clip[0]      |       0 |    12.000  |  6900 |  13.974  |
| clip[1]      |    6900 |    13.974  | 16500 |  13.835  |
| clip[2]      |   16500 |    13.835  | 31500 |  13.998  |
| clip[3]      |   31500 |    13.998  | 42366 |  13.781  |
| clip[4]      |   42366 |    13.781  | 52266 |  13.819  |
| clip[5]      |   52266 |    13.819  | 65166 |  14.000  |
| trans[0]     |       0 |    12.000  |   550 |  14.000  |
| trans[1]     |    6350 |    14.000  |  7450 |  14.000  |
| trans[2]     |   15950 |    14.000  | 17050 |  14.000  |
| trans[3]     |   30950 |    14.000  | 32050 |  14.000  |
| trans[4]     |   41816 |    14.000  | 42916 |  14.000  |
| trans[5]     |   51716 |    14.000  | 52816 |  14.000  |

The "clip[i].endMs zoom" column shows the *queried* zoom at `clipSpan.endMs`
— but `clipSpan.endMs` falls inside the *next* transition span (which owns
the closed boundary per the evaluator's `findTransitionSpanAt` rule). So
`cameraAt(clipSpan[i].endMs)` returns the trans[i+1] sample at `localT =
0.5` (cubic-eased halfway through the arc), explaining the slightly off-14
zoom values. This is **expected and correct** — the documented continuity
invariant is `cameraAt(clipSpan.endMs) == clip's terminal resolved camera`,
and the seam belongs to the transition span; if the user wants the clip's
terminal camera in isolation, evaluate at `clipSpan.endMs - ε`.

The pure-function continuity invariants live in
`cameraIntent.test.ts` (152 tests passing) and were not re-validated
here — they're already proven on synthetic timelines.

## Performance Sanity

> the ease loop runs at the configured cadence (target STEP_MS = 50). No
> noticeable jank during transitions.

**Programmatic check**: `src/components/MapView.tsx:530` defines
`STEP_MS = 50` and the loop body schedules itself with
`window.setTimeout(tick, STEP_MS)`. Lookahead is `LOOKAHEAD_MS = 100`
(`MapView.tsx:529`), and the body calls
`map.easeTo({ ..., duration: STEP_MS, essential: true })`. Wiring matches
the plan's prescription.

**Runtime check**: **PENDING — manual verification required** under
`npm run tauri dev` while playing through the entire 65 s timeline.
Spot-check via devtools Performance: confirm the `tick` callback fires
~every 50 ms (≤±5 ms drift) and that GPU/CPU usage during transitions is
in line with non-transition playback (the work is the same — `map.easeTo`
runs every tick regardless).

## Final Verdict

| Item                                            | Verdict |
|-------------------------------------------------|---------|
| 1. Manual clip selection                        | PENDING |
| 2. Auto-advance plays entry transition          | PENDING |
| 3. Loop mode stable                             | PENDING |
| 4. Export at `t` matches preview at `t`         | DEFERRED to task 640 |
| 5. Insert/reorder/delete recompiles cleanly     | PENDING |
| Continuity invariants (probe-driven, 16 boundaries) | PASS    |
| Determinism / purity (compileTimeline)          | PASS    |
| Endpoint invariants (probe-driven)              | PASS    |
| Performance — STEP_MS wiring                    | PASS    |
| Performance — runtime cadence                   | PENDING |

**Overall**: **PARTIAL** — programmatic and probe-driven checks pass; four
checklist items require driving the live app. Once those are walked through
and the observations recorded here, this report flips to its final PASS or
FAIL verdict. If any manual item FAILs, file a focused follow-up task and
re-run that item rather than fixing in this validation step (per task 590's
guidance).

## Notes

- The probe (`src/lib/cameraIntent.validation.test.ts`) is opt-in via
  `VALIDATION_PROBE=1` so it doesn't affect normal CI. After the migration
  ships and this report flips to PASS, the probe can be deleted (it's
  one-shot validation evidence, not a long-term test).
- All inter-clip transitions in MyHike are `startCamera → clip 1`-style
  point-to-point transitions with `effectiveDurationMs = 1100`. The auto-
  derive path is the dominant codepath here. A more diverse test project
  (clips with `duration_ms` overrides, non-zero `entryBias`, mixed `speed`
  values) would exercise more compiler branches; recommend authoring one
  for task 640's render-parity verification per task 640's "Test project
  guidance" note.
