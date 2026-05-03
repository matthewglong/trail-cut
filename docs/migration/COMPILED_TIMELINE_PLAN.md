# Compiled Timeline Plan

Date: 2026-05-01

## Purpose

This document is the durable handoff artifact for the camera/export redesign.
It describes:

- where the codebase is today
- what model we are moving to
- the concrete preview/export semantics
- the implementation plan from the current Step 3 state

This is the forward-looking source of truth. It is intentionally more useful
for execution than the older migration history.

## Current State

The codebase has already completed Step 3 of the original camera migration.
That means:

- `cameraAt(track, t)` exists
- `MapView` is driven by a live ease loop
- the old imperative clip-selection writers are gone
- the current track is derived from wall-clock anchors keyed off
  `clip.created_at`

That architecture is deterministic, but it does not match the behavior we now
want in preview. In normal app usage, selection and auto-advance jump between
clips; they do not traverse wall-clock gaps between anchors. As a result, the
beautiful clip-to-clip easing largely disappeared.

## Target Model

We are moving to a compiled project-timeline model.

Core decisions:

- Preview and export share one compiled timeline.
- Camera scheduling uses project/output time, not recording wall-clock time.
- Each clip owns its target camera behavior.
- Each destination clip owns its entry transition behavior.
- Entry placement is represented internally as a float `entryBias` in
  `[-1, 1]`.
- Preview selection should show what export would show for that clip.

This means the primary abstraction is no longer "camera at recording-time gap
between clips." It is "camera at compiled project time."

## Time Axes

Three time axes exist in this architecture. Keeping them named and distinct is
load-bearing — most of the design questions in this doc reduce to "which axis
does this quantity live on?"

| Axis          | Meaning                                              | Where it lives                                  | Authored or derived |
|---------------|------------------------------------------------------|-------------------------------------------------|---------------------|
| Clip-local    | Position inside a clip, `[0, clip.duration_ms]`      | Per-clip media time; transition authoring       | Authored            |
| Wall-clock    | Real-world recording time                            | GPX index (`route.trackpoints[].timestamp`), `clip.created_at` | Authored by the world |
| Project-time  | Position in compiled output, `[0, totalDurationMs]`  | Compiled timeline, `cameraAt(t)`, export loop   | Derived             |

Rules:

- All persisted/user-facing transition settings are authored in **clip-local**
  terms (`durationMs`, `entryBias`). Nothing in `project.json` is stored in
  project-time.
- The GPX is **wall-clock**. `locationAt(playheadMs, indexedRoute)` continues
  to take wall-clock; the evaluator translates project-time → clip-local →
  wall-clock at the seam.
- The evaluator (`cameraAt`) and the export frame loop run on **project-time**.
  Project-time is fully derived: same authored inputs → same compiled output.
- "Output-time" and "project-time" are the same thing. Project-time wins as
  the canonical name.

## Transition Ownership

The destination clip owns the incoming camera move.

At boundary `A -> B`:

- `B` defines how the camera enters
- `A` does not separately define an outgoing transition for that same boundary

This avoids conflicting ownership and keeps insertion/reordering local.

The first clip's "previous" is the project start camera (see §Project Start
Camera below). It acts as a zero-length predecessor anchored at project-time
`0`.

## Entry Placement

Use a float internally:

- `entryBias = -1`: entire transition occurs before the cut
- `entryBias = 0`: transition is centered on the cut
- `entryBias = 1`: entire transition occurs after the cut

UI can expose presets like `Before`, `Split`, and `After`, but the model
should stay continuous.

### Boundary Formula

Given `cutTime` (project-time of the cut), `durationMs`, and `entryBias`:

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

The Van Wijk arc parameterizes over `[start, end]` with
`localT = (t - start) / (end - start)`. So `t = start` resolves to the
previous clip's terminal camera (or the project start camera for clip 1) and
`t = end` resolves to the current clip's initial camera. The transition is
continuous at both ends regardless of clamping.

### Clamping Policy

Clamping shrinks the overrunning side independently. The other side stays
literal at its requested offset from `cutTime`. This is the
`min(requestedX, availableX)` step in the formula above.

Consequences:

- If only one side overruns, the transition is shorter than authored on that
  side, but the cut still sits where the user intended.
- If both sides overrun (e.g. a 10s transition between two 1s clips), the
  transition runs end-to-end across both spans; effective duration is the
  sum of available media on both sides.
- Bias drifts away from the literal authored value when clamping kicks in,
  but the camera state at `start` and `end` is always continuous with
  neighboring spans. There are no jumps.

For the first clip specifically: `availablePreCut = 0`, so `effectivePreCut`
is always `0`. The natural authoring default for clip 1's `entryBias` is `1`
(purely post-cut); any other value is implicitly clamped to a post-cut-only
transition. The UI should reflect this — bias is meaningless for the first
clip.

## Project Start Camera

The project start camera is a fully-resolved camera state used as the "from"
endpoint for clip 1's entry transition.

Authored shape:

```ts
interface ProjectStartCamera {
  center: { lng: number; lat: number };
  zoom: number;
  bearing: number;
  pitch: number;
}
```

Defaults (used when the user hasn't overridden):

- `center`: centroid of all clip starting locations (or a sensible fallback
  if no clip has a resolvable location)
- `zoom`: `12`
- `bearing`: `0` (north up)
- `pitch`: `0` for `default` / `satellite` map styles, `60` for `3d`
  (matches the per-style pitch convention used elsewhere)

The user can override any of these at the project level. The compiler treats
`ProjectStartCamera` as the canonical resolved camera at the
`fromClipId: null` end of clip 1's transition span — Van Wijk computes the
arc from this camera into clip 1's initial resolved camera.

## Preview Semantics

Preview should stop inventing its own selection-only transition behavior.

Selection behavior:

- selecting a clip seeks to that clip's canonical project-time position
  (typically the start of its clip span, after any incoming transition)
- the camera shown after seek is whatever the compiled timeline says exists
  at that time
- playback from that point continues on the same compiled timeline

In short: preview selection should show export truth.

Within a clip:

- the existing live-follow behavior remains valid
- the only change is that it is evaluated inside the compiled project
  timeline rather than inside a wall-clock anchor schedule

Rapid reselection:

- a new selection interrupts the previous preview state by seeking to the new
  clip's canonical compiled position
- do not add a separate preview-only `flyTo` path

## Camera State During a Transition

During a transition span, the camera shown is a Van Wijk interpolation
between two canonical resolved cameras:

- the previous clip's resolved camera at its `endMs` (or the project start
  camera, for clip 1)
- the current clip's resolved camera at its `startMs`

Follow intents on either side collapse to point intents during the
transition window — the transition is between two snapshots, not a
moving-target chase. This matches the current `interpolateAnchors`
implementation; the math carries over unchanged.

Bearing and pitch are interpolated alongside center/zoom (circular lerp for
bearing, linear lerp for pitch). Within-clip live follow resumes at
`t = end`.

## Duration: Authored vs. Auto-Derived

Each transition's effective duration is determined by:

1. If the clip authored an explicit `durationMs`, use it as-is.
2. Otherwise, fall back to `arcDurationMs(arc, feel)` — the existing auto
   derivation from arc length and the project-level `transitionFeel`.

`transitionFeel` (the project-level multiplier: `natural` / `snappy` / `slow`)
applies **only to the auto-derived path**. An authored `durationMs` is
respected literally; the user said 600ms, we play 600ms regardless of feel.

This keeps `feel` as a dial for "how the project feels by default" without
overriding explicit per-clip authoring.

## Export Semantics

Export should use the same evaluator as preview.

For each frame:

1. determine project time `t = frame_index / fps`
2. evaluate `cameraAt(track, t)`
3. resolve to a concrete camera with `resolveIntent(intent, viewport)`
4. `jumpTo` that exact camera
5. wait for tiles
6. capture frame

`jumpTo` remains correct for export because interpolation is contained in
`cameraAt(track, t)`. Export must not ask MapLibre to add a second layer of
motion.

## Continuity Invariants

These are the gating tests for the new evaluator. The compiler/evaluator
combination must satisfy all of them for any well-formed input:

- `cameraAt(transitionSpan.startMs)` equals the previous clip's terminal
  resolved camera (or `ProjectStartCamera` for clip 1)
- `cameraAt(transitionSpan.endMs)` equals the current clip's initial resolved
  camera
- `cameraAt(clipSpan.startMs)` equals the clip's initial resolved camera
- `cameraAt(clipSpan.endMs)` equals the clip's terminal resolved camera
- `cameraAt(t)` is continuous across every span boundary (no jumps within
  numerical tolerance)
- `cameraAt(t)` is a pure function of `(track, t)` — same inputs always
  produce the same output

## Data Model

There are two layers of types to define.

### Authored Data

Persisted, editor-facing, clip-local where applicable.

```ts
interface ProjectStartCamera {
  center: { lng: number; lat: number };
  zoom: number;
  bearing: number;
  pitch: number;
}

interface ClipEntryTransition {
  enabled?: boolean;
  durationMs?: number;       // clip-local; if unset, auto-derive via arcDurationMs
  entryBias?: number;        // clamp to [-1, 1]
  feel?: TransitionFeel;     // optional per-clip override of project-level feel
}
```

Persisted on `Project`:

- `startCamera?: ProjectStartCamera` — optional override of the computed default
- `defaultEntryTransition?: ClipEntryTransition` — project-level defaults
- existing `transition_feel?: TransitionFeel`

Persisted on `Clip`:

- `entryTransition?: ClipEntryTransition` — per-clip overrides

### Compiled Data

Runtime-only, derived from clip order + authored settings + media durations.
Never persisted.

```ts
interface ClipSpan {
  clipId: string;
  startMs: number;            // project-time
  endMs: number;              // project-time
  mediaInMs: number;          // clip-local (= clip.trim.in_ms)
  mediaOutMs: number;         // clip-local
  canonicalSeekMs: number;    // project-time, where preview selection lands
  intent: CameraIntent;
}

interface TransitionSpan {
  fromClipId: string | null;  // null for project-start → clip 1
  toClipId: string;
  startMs: number;            // project-time
  endMs: number;              // project-time
  effectiveDurationMs: number; // post-clamp
}

interface CompiledTimeline {
  clipSpans: ClipSpan[];
  transitionSpans: TransitionSpan[];
  totalDurationMs: number;
  startCamera: ResolvedCamera;
  transitionFeel: TransitionFeel;
}
```

Clip span length must account for `effects.speed`:

```
clipSpan.lengthMs = (mediaOutMs - mediaInMs) / clip.effects.speed
```

The compiler is pure: same inputs → same outputs. Recomputed on any change to
clips, transitions, settings, or route.

## Time-Axis Translation

Inside the evaluator, project-time → wall-clock translation for follow
intents:

```
clipLocalMs = (t - clipSpan.startMs) * clip.effects.speed + clipSpan.mediaInMs
wallClockMs = parseTimestamp(clip.created_at) + clipLocalMs
```

`locationAt(wallClockMs, indexedRoute)` then resolves the GPX position. The
GPX axis never changes; it's the route's authored truth.

## Reusable Pieces

The redesign should preserve these primitives where possible:

- `cameraForBounds`
- Van Wijk arc primitives (`vanWijkArc`, `vanWijkSample`, `arcDurationMs`)
- `resolveIntent`
- `locationAt`
- route indexing
- bearing keyframe computation

The goal is to replace the scheduling model, not throw away the camera math.

## Implementation Plan

Concrete board from the current codebase to the target model. Each step is
sized to be its own task / commit.

### 1. Add authored types

In `src/types.ts` and `src-tauri/src/models.rs`:

- `ProjectStartCamera`
- `ClipEntryTransition`
- `Project.startCamera`, `Project.defaultEntryTransition`
- `Clip.entryTransition`

Bump schema version (v2 → v3) with a forward migration that fills sensible
defaults for existing projects.

### 2. Add compiled types

In `src/lib/cameraIntent.ts`:

- `ClipSpan`
- `TransitionSpan`
- `CompiledTimeline`

Keep `MapAnchor`/`MapTrack` alongside temporarily. Do not delete in this step.

### 3. Implement the compiler

A new pure function (`compileTimeline` or rename `buildMapTrack`) that walks
the ordered clip list and produces a `CompiledTimeline`:

- compute clip spans from media durations + `effects.speed`
- compute transition spans using the boundary formula and clamping policy
- record canonical seek positions
- compute project start camera (default or override)
- attach per-clip intents (existing logic from `anchorIntentForClip`)

Test against the continuity invariants on synthetic clip lists.

### 4. Implement new `cameraAt(timeline, t)`

Evaluate the compiled timeline:

- before `t = 0`: hold project start camera
- inside a clip span: clip intent, with project-time → clip-local → wall-clock
  translation for follow intents
- inside a transition span: Van Wijk between canonical resolved cameras at
  the boundary, parameterized by `localT`
- after `totalDurationMs`: hold last clip's terminal camera

### 5. Switch playhead axis

In `App.tsx` and `ProjectView.tsx`, replace wall-clock `playheadMs` with
project-time. The video player still emits clip-local media time;
`ProjectView` translates to project-time using the selected clip's compiled
span.

Same PR as step 4 — splitting causes a half-translated regime.

### 6. Update MapView ease loop

`MapView.tsx`'s ease loop consumes the new `cameraAt(timeline, t)`. The
lookahead pattern (`t + LOOKAHEAD_MS`) stays — it's the right driver for
MapLibre.

### 7. Rework auto-advance and selection

- `handleClipEnded`: let project-time cross the boundary so the entry
  transition into the next clip plays, instead of snapping to the next
  clip's start.
- `handleSelectClip`: seek to the selected clip's `canonicalSeekMs`.
- "Currently active clip" UI lookup: find the clip span containing the
  current project-time `t` (binary search; transition spans report the
  destination clip as active for highlighting purposes).

### 8. Delete old wall-clock anchor code

Once the new path is verified end-to-end, remove `MapAnchor`, `MapTrack`,
the old `buildMapTrack`, and the old `cameraAt`. Update tests.

### 9. Re-spec Step 4 export tasks (400–440)

The original task wording assumed the wall-clock anchor model. Re-plan
against the compiled timeline before resuming export work. Preview and export
share `cameraAt(timeline, t)`; export iterates `t = frame_index / fps`.

### 10. Validate behavior

Verify:

- manual clip selection restores cinematic camera entry motion
- auto-advance between clips plays the entry transition
- loop mode remains stable
- export at any project-time `t` matches preview at the same `t`
- inserting / reordering / deleting clips recompiles cleanly with no stale
  state

## Migration-from-current-state Notes

- The route is not persisted in `project.json` — it's re-parsed from
  `route.gpx` on load. This decision survives unchanged.
- The schema-versioning infrastructure already in `commands/project.rs` (v1 →
  v2 migration) is the template for the v2 → v3 bump in step 1.
- The existing `transition_feel` field carries over with refined semantics:
  feel only applies to auto-derived durations.
- The Van Wijk machinery (`vanWijkArc`, `vanWijkSample`, `arcDurationMs`,
  canonical-camera collapsing) is the most valuable piece of the existing
  work and should not be touched.
- `MapAnchor` / `MapTrack` are conceptually superseded. Do not try to keep
  them parallel — the new path replaces them.
