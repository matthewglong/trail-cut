# Clip Groups — continuous cross-clip camera glide — IMPLEMENTATION HANDOFF

Written 2026-08-24. Plan authored and user-approved in a planning session; this file is the
execution spec for a fresh session. The design was validated against the codebase by three
exploration passes + one design pass; file/line citations below were verified at write time.

## Execution discipline (binding — from `docs/CAMERA_MOVEMENT_LESSONS.md`)

This is the SECOND attempt at cross-clip camera motion. The first ("Camera Moves",
2026-08-18) was reverted; its post-mortem rules apply to this session:

1. **Watch it move before fanning out.** Phase A ends with a human-watchable glide in the
   running app (`npm run tauri dev`). Do NOT proceed to Phases B-D until the Phase A gate
   has been watched and accepted by Matthew. Tests are backup, not the deliverable.
2. **One camera model.** If any change requires runtime absorb/trim/retarget rules between
   competing camera authorities, the implementation has diverged from this spec — stop.
3. **Subagents do mechanical work against this spec.** Judgment calls that deviate from the
   model below go back to Matthew, not into code.
4. No human time estimates in reports; describe progress by scope/risk.

---

## Context

For "living portrait" projects (many short, geographically static clips), today's camera
alternates between stasis (per-clip hold/follow) and lurch (a Van Wijk arc at every cut).
The camera already arcs across every seam (`evaluateTransitionSpan`); the feature replaces
N−1 stasis→arc→stasis cycles with one continuous glide whose waypoints are generated from
the member clips.

## Decided model (user-approved, binding — do NOT redesign)

**CameraPath = one compiled sequence of camera stops.** A *clip group* is a contiguous run
of ≥2 timeline clips acting as a stop *generator*:

- **Sweep rule**: member k of n (1-based) contributes one anchor at fraction
  f_k = (k−1)/(n−1) through **clip k's own trimmed span** — clip 1 → its first frame,
  middle → midpoint, clip n → its last frame. Anchor 1/n coincide with the group's
  first/last frames; every intermediate anchor lives *inside* a clip, so **every cut lands
  mid-glide** — no velocity event at seams regardless of clip lengths.
- **Anchor center** = hiker's position at that same playback moment, **time-sampled**:
  `locationAt(wallClockBaseMs + mediaInMs + f_k·(mediaOut−mediaIn))` (trim/speed-aware;
  NOT distance-sampled — the anchor must be where the hiker *is* when the camera crosses
  it; this was an explicit user decision).
- **Anchor zoom/bearing/pitch** from that clip's fully resolved MapSettings (per-clip
  overrides shape the glide). Auto bearing samples `bearingAt` at the anchor wall-clock;
  fixed uses the fixed value; pitch from map_style ('3d' → 60 else 0) as today.
- **Interpolation**: smooth C¹ spline through anchors, monotone glide, NO per-stop easing.
- **Entry/exit**: existing seam-arc machinery; arc endpoints = the glide's camera evaluated
  at the transition-window edge.
- Member clips' `follow_playhead` is ignored while grouped; zoom/bearing/pitch/style still
  matter via anchors. Basemap swaps still pop at the cut (CANON §2.10 unchanged).
- **Marker layer untouched**: Transition decorations (travel playhead, seam eases) still
  fire at member cuts exactly as configured. Camera and marker are independent layers.
- Degenerate: no route data → anchor at `clip.gps` fallback. A group dropping below 2
  members dissolves. Single-clip movement (zoom drift / orbit) is a *future second
  generator* feeding the same CameraPath — model-ready, authoring UI deferred.

**UX (user-authored)**: multi-select in Timeline → revealed "Group" button; a small bar
spans the top of member cards, its ends draggable to include/exclude adjacent clips,
selectable + deletable; the follow pill shows a frozen "GROUP" state for member clips —
clicking it only highlights the group bar (never toggles `follow_playhead`).

**Hard constraints**: one camera model with disjoint compile-time authority ranges; zero
added frames (`totalDurationMs` unchanged by grouping); preview/export parity — everything
the glide needs lives inside `CompiledTimeline`, evaluated only via `cameraAt` inside
`buildPerFrameState`; mapVisuals single-source contract, reference-space zoom (CANON §2.6)
and magnification k (§2.8) untouched; additive persistence (no schema bump — v11 stays);
Phase A watchable before full UX.

---

## 1. Data model (persisted)

`ClipGroup { id: string (uuid), clip_ids: string[] }` — timeline-ordered, contiguous.
No per-group settings in v1; the glide's shape comes entirely from member clips' resolved
MapSettings.

- **Rust** `src-tauri/src/models.rs`: new `ClipGroup` struct (`Debug, Clone, Serialize,
  Deserialize, PartialEq`); on `Project`:
  `#[serde(default, skip_serializing_if = "Vec::is_empty")] pub clip_groups: Vec<ClipGroup>`
  (precedent: `map_magnification` :1348, `waypoints` :1392); `impl Default` gets
  `Vec::new()`. **No schema bump.**
- **TS** `src/types.ts`: `ClipGroup` interface + `clip_groups?: ClipGroup[]` on `Project`,
  doc-commented "additive, no schema bump; absent ⇔ empty".
- **Parity harness (mandatory, mechanical)**: add `clip_groups: true` to
  `PROJECT_WIRE_KEYS` (`src/lib/__tests__/projectPersistence.test.ts:43` — `satisfies
  Record<keyof Project, true>` makes tsc force it) and populate
  `src-tauri/tests/fixtures/project_parity.json` with one group of ≥2 existing fixture clip
  ids (the "every field populated" runtime loop fails until it's there; the Rust suite
  `src-tauri/tests/project_parity.rs` round-trips the same fixture).
- **Live state**: `const [clipGroups, setClipGroups] = useState<ClipGroup[]>([])` in
  `src/App.tsx` (next to `waypoints` :47) → threaded to `useProject`, `useAutoSave`
  (params/payload/deps), `ProjectView`. `src/lib/projectPersistence.ts`: add
  `clipGroups: ClipGroup[]` to `LiveProjectState` (:50); `hydrateProjectState` (:139) sets
  `clipGroups: normalizeClipGroups(project.clip_groups ?? [], project.clips)`;
  `buildSavePayload` (:173) overlays `clip_groups: live.clipGroups`, key deleted when empty
  (same absence-is-default treatment as `map_magnification` :193). Reset to `[]` on
  new/close project in `useProject.ts` (:142, :186 areas); set from hydrate in
  `openProjectDir` (:92 area).

### Referential integrity — new module `src/lib/clipGroups.ts` (à la `waypoints.ts`)

Pure, unit-tested:

- `normalizeClipGroups(groups, clips): ClipGroup[]` — THE single policy, idempotent,
  shared by persistence AND the compiler:
  1. Drop member ids not in `clips`; drop duplicate membership across groups (earlier
     group wins).
  2. Reorder each group's `clip_ids` by index in `clips` (clips array order IS timeline
     order).
  3. Split each group into contiguous runs of indices; first run keeps the id, later runs
     mint new ids.
  4. Dissolve runs with <2 members.
- `removeClipFromGroups(groups, clipId, clips)` — filter + normalize; called in
  `handleRemoveClip` (`src/hooks/useProject.ts:203`, next to `removeClipWaypoints`).
- `insertSplitClipIntoGroups(groups, originalId, newId)` — splitting a member keeps both
  halves grouped (insert newId right after originalId); called in `handleSplitClip`
  (`useProject.ts:~343`).
- Import re-sort: after both `mergeClips` sites (`src/hooks/useMediaImport.ts:148, 220`),
  normalize against the post-merge clip order (interleaved imports split runs per policy —
  no silent absorption).
- **Hidden clips policy**: persisted groups KEEP hidden members (hide is a soft toggle;
  unhiding restores the glide — `onToggleVisibility` does NOT touch groups). The compiler
  re-normalizes per compile against the filtered clip list (`filterCompilableClips` at
  `src/lib/cameraIntent.ts:843` already removes `visible:false` clips before span
  construction, so they occupy zero project time); runs <2 degrade to ordinary per-clip
  camera for that compile. One shared pure normalization ⇒ preview and export cannot
  disagree.

## 2. Compiled model — `src/lib/cameraIntent.ts`

```ts
export interface GroupAnchor {
  tMs: number;               // project-time; strictly increasing within a span
  camera: ResolvedCamera;    // snapshot at tMs; viewport-agnostic by construction
}
export interface GroupSpan {
  groupId: string;
  memberClipIds: string[];   // compile-effective members, timeline order
  startMs: number;           // == first member ClipSpan.startMs
  endMs: number;             // == last member ClipSpan.endMs
  anchors: GroupAnchor[];    // length == member count, ≥2
}
// CompiledTimeline gains:  groupSpans: GroupSpan[]
// TransitionSpan gains:    cameraAuthority: boolean
//   false ⇒ span still drives marker travel/seam decorations but is NOT a camera
//   authority (intra-group seams). Default true.
```

Anchors store `ResolvedCamera` directly: the sweep rule only ever produces point-like
cameras (center from `locationAt`, scalar zoom/bearing/pitch) — no `region` intent is
involved, so nothing is viewport-dependent; matches the `resolveCanonical`/
`CANONICAL_VIEWPORT` snapshot precedent (:475/:455). Zoom stays reference-space;
`resolveIntent`/`withDisplayScale` remain the only aspect/scale-aware layers.

**`buildGroupSpans`** (inside `compileTimeline` :885 — after clip spans :915-961, before
transition spans :963-1034):

1. Compile-effective groups = `normalizeClipGroups(settings.clip_groups ?? [], validClips)`.
2. For member k (1-based) of n, with that member's `ClipSpan`:
   - `f = (k − 1) / (n − 1)`
   - `tMs = span.startMs + f * (span.endMs − span.startMs)`
   - `wallMs = span.wallClockBaseMs + span.mediaInMs + f * (span.mediaOutMs − span.mediaInMs)`
     (identical translation to `liveIntentForClipSpan` :1092 — trim- and speed-consistent)
   - `resolved = resolveMapSettings(projectMapSettings, clip.map_overrides)` (already
     computed per clip at :934 — reuse)
   - `center = locationAt(wallMs, route, clip.gps) ?? {lng:0, lat:0}` (same fallback chain
     as `resolveIntent`'s follow branch :411)
   - `zoom = resolved.camera.zoom`
   - `bearing = resolved.camera.bearing_mode === 'auto'
        ? (bearingAt(wallMs, route) ?? prevAnchorBearing ?? 0)
        : resolved.camera.bearing_degrees`
   - `pitch = resolved.camera.map_style === '3d' ? 60 : 0`
3. By construction anchor 1 lands at `group.startMs` and anchor n at `group.endMs`.

`CompileTimelineProjectSettings` (:770) gains `clip_groups?: ClipGroup[]` (same convention
as `transition_feel`/`start_camera`).

### Spline evaluator

Generic math in new **`src/lib/spline.ts`** (standalone-testable); glue
`groupCameraAt(span: GroupSpan, t: number): ResolvedCamera` exported from cameraIntent.ts.

- **Center**: cubic Hermite on the *time* knots `tMs` through mercator points
  (`lngLatToMercator` :244; add the inverse `mercatorToLngLat` beside it), tangents via
  **centripetal Catmull-Rom** (Yuksel α=0.5 — cusp/loop-proof under uneven spacing);
  clamped one-sided (chord) tangents at anchors 1 and n so the glide starts/ends exactly
  on the group's boundary frames with finite velocity, no overshoot past the ends.
- **Zoom and pitch**: 1-D cubic Hermite on the same knots with **Fritsch–Carlson
  monotone-limited tangents** (a zoom that changes then holds cannot bounce).
- **Bearing**: unwrap the anchor sequence cumulatively short-way (each next value within
  ±180° of the previous — the `circularLerp` convention), spline as 1-D Hermite, re-wrap
  mod 360 on output.
- **No easing anywhere** — u linear in t per segment; monotone in t by construction.
- Numerical edge cases: centripetal increment `Δ_i = max(dist^0.5, ε)` (ε≈1e-9) so
  stationary-hiker duplicate anchors never NaN; a fully-degenerate segment early-outs to
  endpoint lerp; n=2 → straight constant-velocity glide; anchors validated finite at
  compile — on any non-finite anchor the group degrades to per-clip behavior rather than
  rendering NaN.
- Per-frame cost: tangent derivation is O(n) with tiny n; recompute per call (pure function
  of the wire-shape timeline; no hidden caches crossing IPC). Optional
  `WeakMap<GroupSpan, tangents>` memo later — not part of correctness.

### Dispatch — `cameraAt` (:1249), disjoint compile-time authority

1. empty / `t < 0` — unchanged.
2. `t >= totalDurationMs` — if the last clip span is grouped, hold
   `groupCameraAt(lastGroup, lastGroup.endMs)`; else unchanged.
3. Transition span with `cameraAuthority === true` (filtered variant of
   `findTransitionSpanAt` :1122, e.g. `findCameraTransitionSpanAt`) →
   `evaluateTransitionSpan` as today.
4. Group span containing t → `{ kind: 'point', ...groupCameraAt(span, t) }`.
5. Clip span → `liveIntentForClipSpan` (unchanged).

**Intra-group seams**: `compileTimeline` still emits every `TransitionSpan` exactly as
today (placement formula :1015-1027, authored/auto durations) but sets
`cameraAuthority: false` when BOTH `fromClipId` and `toClipId` belong to the same
compile-effective group. Verified TransitionSpan consumers that must keep working
untouched: the marker layer in `src/lib/mapVisuals/perFrame.ts` — `wallClockTrace`
post-cut hold (:115), `classifyTravelWindow` (:169), `travelTraceAt` (:247), seam-ease
instant scan (:349) — and `activeClipIdAt` (`cameraIntent.ts:1221`). The flag removes only
the camera claim, baked at compile — no runtime arbitration. Keep deriving intra-group
auto-durations exactly as today so marker travel-window widths are unchanged by grouping.

**Entry/exit continuity** (the two OUTER transition spans stay `cameraAuthority: true`):

- Into the group (`toClipId` == first member): in `evaluateTransitionSpan`, replace
  `toCamera = resolveCanonical(toSpan.intent, wallAtWindowEnd)` with
  `toCamera = groupCameraAt(groupSpan, span.endMs)` — the arc lands exactly where the
  glide is at the window's edge (mid-glide inside clip 1, since the post-cut half of the
  window extends into the group).
- Out of the group (`fromClipId` == last member):
  `fromCamera = groupCameraAt(groupSpan, span.startMs)`.
- Helpers: `groupSpanWithFirstMember(timeline, clipId)` /
  `groupSpanWithLastMember(timeline, clipId)`.
- Compile-time auto-duration for these seams: use the glide camera at the CUT
  (= anchor 1 / anchor n — deterministic without knowing the window width) as the endpoint
  snapshot for `vanWijkArc`/`arcDurationMs` — the exact "duration from clip-edge snapshot,
  evaluation from window-edge" pattern already in the code (:1000-1012 vs :1166-1179).
- Adjacent groups: the seam between them is an ordinary camera-authoritative transition —
  from-endpoint from the earlier glide, to-endpoint from the later glide; both rules
  compose.

`follow_playhead` is ignored for members automatically (group span outranks clip span in
dispatch). `activeClipIdAt` still flips at `cutMs` → basemap style pops at the cut,
unchanged (`scene.ts:234-247` and preview both resolve style per active clip).

## 3. Follow pill GROUP state — `src/components/MapToolbar/MapToolbar.tsx`

Derived, never persisted. `ProjectView.tsx` computes
`groupIdForCurrentClip = clipGroups.find(g => g.clip_ids.includes(selectedClipId))?.id ?? null`
and passes it + `onHighlightGroup(groupId)` to MapToolbar. When `scope === 'clip'` and
`groupIdForCurrentClip != null`, `followPill` (:194-203) renders a third frozen state:
label `GROUP`, "locked" styling (accent/override color); onClick calls `onHighlightGroup`
ONLY — never `setCamera({follow_playhead})`. Tooltip: "Camera is controlled by the clip
group — click to show the group". `onHighlightGroup` sets ProjectView
`highlightedGroupId` (timeout or until next selection), threaded to Timeline so the group
bar lights up and scrolls into view. Project scope keeps today's 2-state pill;
zoom/bearing/pitch controls stay enabled in clip scope (they shape the member's anchor).

## 4. Timeline UI — `src/components/Timeline/`

- **Multi-select** (ephemeral ProjectView state; `selectedClipId` in App.tsx:38 keeps its
  exact semantics — playback, seeks, toolbar scope): `selectedClipIds: Set<string>` +
  `selectionAnchorId`. In the card click handler: plain click → existing `onSelectClip` +
  collapse multi-select to `{id}` + set anchor; shift-click → contiguous index range from
  anchor; cmd/ctrl-click → toggle membership. Multi-selected cards get a lighter variant
  of the `#ff6b35` selection border (Timeline keeps its legacy `colors`/raw-hex styling).
- **Group button**: revealed when `selectedClipIds.size ≥ 2`, indices contiguous
  (`max − min + 1 === count`), and no selected clip already grouped. Floating over the
  selection (positioned from first/last selected card `offsetLeft`/`offsetWidth`).
  onClick → `setClipGroups(prev => normalizeClipGroups([...prev, {id: uuid, clip_ids:
  orderedSelection}], clips))`, clear multi-select, set `highlightedGroupId`.
- **GroupBar** — new `src/components/Timeline/GroupBar.tsx`: absolutely-positioned sibling
  layer INSIDE `styles.strip` (give the strip `position:'relative'`) so it scrolls with
  the cards in the `overflowX:auto` container. Geometry from member cards'
  `offsetLeft`/`offsetWidth` (scroll-immune — NOT getBoundingClientRect), refs keyed by
  clip id off `data-clip-card`; recompute on clips/groups change + ResizeObserver on the
  strip. Visual: ~6px rounded bar spanning the member cards' top edge (cards gain a few px
  top padding in `styles.ts`); dim orange normally, full `#ff6b35` selected/highlighted.
  Interactions: click → `selectedGroupId` (Escape/click-away clears); Delete/Backspace +
  a × cap at the bar's right end when selected → remove group (clips untouched); 8-10px
  end handles with pointer capture (`setPointerCapture`, DecorationPanel `startDrag`
  precedent `DecorationPanel.tsx:266-340`) — dragging across an adjacent card's midpoint
  grows/shrinks membership one clip at a time, only into adjacent clips not in another
  group, never below 2; live-preview during drag, commit normalized on pointerup.
- `Timeline.tsx` props grow: `groups`, `selectedClipIds`, `onCardClick(id, {shift, meta})`,
  `selectedGroupId`, `highlightedGroupId`, `onSelectGroup`, `onDeleteGroup`,
  `onResizeGroup`. Threaded from `ProjectView.tsx:784-796`.

## 5. Export threading (all `compileTimeline` callers — verified exhaustive)

Production callers: `src/screens/ProjectView.tsx:305` and `src/lib/exportRequest.ts:246`.

1. `ProjectView.tsx:305`: pass `clip_groups: clipGroups` (props from App).
2. `exportRequest.ts`: `ExportRequestInputs` (:74) + `ExportRequestContext` (:313) gain
   `clipGroups?: ClipGroup[]`; `buildExportRequest` (:246) passes
   `clip_groups: inputs.clipGroups` into compile settings; `buildJobRequest` (:335)
   forwards; `src/components/ExportModal/ExportModal.tsx:518` context gains `clipGroups`
   (prop from ProjectView).
3. **Sidecar & Rust: zero changes** — `CompiledTimeline.groupSpans` and
   `TransitionSpan.cameraAuthority` ride `#[serde(flatten)] pub project_state: Value`
   (`src-tauri/src/export/mod.rs:124`) to the sidecar, which evaluates them through the
   same shared `cameraAt` inside `buildPerFrameState` (`sidecars/renderer/scene.ts:249`).
   Rust still reads only `totalDurationMs` (unchanged — zero added frames).
   **The sidecar bundle (`renderer/dist`) MUST be rebuilt in the same change** or
   preview/export diverge silently.
4. Test callers (`cameraIntent.test.ts`, `cameraIntent.validation.test.ts`, sidecar
   `setupFixture.ts`) compile unchanged (optional field); extend per §7.

## 6. Phases — watch-it-first, ordered by risk

- **Phase A — the glide, watchable** (highest risk: does the motion feel right?).
  Scope: `clipGroups.ts` (normalize only), `spline.ts`, cameraIntent changes
  (GroupSpan/anchors/`groupCameraAt`/dispatch/`cameraAuthority`/entry-exit endpoints),
  TS `ClipGroup` type, and a CRUDE gesture: shift-click multi-select + a bare "Group"
  button in `Timeline.tsx` writing ProjectView-local `clipGroups` state into the compile
  call at :305. No persistence, no bar, no pill, no export threading. Anchor + spline unit
  tests land here (cheap, de-risk the milestone).
  **GATE: run the app, group 3-5 short clips, press play, watch the camera glide through
  the cuts in live preview — including entry/exit arcs landing mid-glide. Matthew watches
  and accepts before B-D.**
- **Phase B — persistence + integrity** (data-loss surface): Rust model + parity fixture +
  `PROJECT_WIRE_KEYS`, App/useAutoSave/projectPersistence/useProject wiring, normalization
  at all mutation sites (remove/split/import/load/hide), `clipGroups.ts` complete + tested.
- **Phase C — export parity** (wire + sidecar): request threading; sidecar grouped-fixture
  test asserting frontend/sidecar `cameraAt` agreement at sampled t's; manual export of the
  Phase A project, side-by-side with preview.
- **Phase D — full UX** (lowest architectural risk): GroupBar (span/drag/select/delete),
  cmd-click toggle, button polish, GROUP pill + highlight wiring, keyboard delete.

## 7. Verification

- **Anchor math** (`cameraIntent.test.ts` / new `clipGroups.test.ts`): sweep fractions
  (n=2 → {0,1}; n=3 → {0,½,1}; n=5 member 3 → midpoint); anchor tMs/wallMs identity with
  `liveIntentForClipSpan` under trim (in_ms>0) and 2× speed; per-clip zoom override moves
  only its anchor; bearing auto vs fixed; pitch 60 for '3d' member; no-route → clip.gps →
  {0,0} fallback; group-of-1-after-filtering dissolves; hidden-middle-member glide over
  remaining members.
- **Normalization** (`clipGroups.test.ts`): idempotence, run-splitting on re-sort,
  dissolution <2, removed member, split-clip insertion, duplicate-membership resolution.
- **Spline** (`spline.test.ts`): C⁰ + C¹ at every knot (finite-difference within
  tolerance); monotone zoom never overshoots neighbor range on change-then-hold;
  duplicate-point segments finite (no NaN); bearing 359°→1° short way; n=2 straight glide.
- **Continuity** (highest value): at every intra-group `cutMs`, `cameraAt(t−ε)` ≈
  `cameraAt(t+ε)` in value AND finite-difference velocity (the "no lurch at member cuts"
  pin); transition sample at entry window end deep-equals `groupCameraAt(group,
  span.endMs)` (symmetric at exit); dense t-sweep → exactly one authority per t;
  intra-group transition spans never produce camera output; `totalDurationMs` unchanged by
  grouping; `buildPerFrameState` marker outputs (travel/seam) for a grouped timeline
  deep-equal the ungrouped timeline's at identical t (marker-independence pin).
- **Parity fixtures**: `project_parity.json` + `PROJECT_WIRE_KEYS` + Rust round-trip;
  `projectPersistence.test.ts` round-trip with populated groups; save-path
  "empty groups omit the key" assertion.
- **Sidecar/golden implications**: existing sidecar tests (`povTravel.test.ts`,
  `basemapSwap.test.ts`, `setupFixture.ts`) run ungrouped timelines and must pass
  UNCHANGED; assert explicitly (compile-output snapshot diff) that a no-group compile is
  identical except additive `groupSpans: []` / `cameraAuthority: true`. Add one grouped
  fixture asserting frontend/sidecar `cameraAt` agreement. Pixel goldens untouched — no
  paint changes.
- **Manual watch checklist** (gate A; repeat at C on an export):
  1. Group 4 short static clips → continuous glide; every cut lands mid-motion.
  2. Per-clip zoom override on member 3 → glide swells smoothly, no bounce.
  3. Entry arc lands mid-glide without a kink pop; exit symmetric.
  4. Two clips shot from the same spot mid-group → no jitter/NaN freeze.
  5. Travel-playhead decoration on a member seam still animates; basemap override on a
     member still pops at its cut.
  6. Scrub/seek into the middle of a group → camera lands exactly on the glide.
  7. Export the same project; frame-step seam regions against preview.

## 8. Risks & mitigations

1. **Entry/exit velocity handoff** — the Van Wijk arc eases to zero velocity into a moving
   glide; C⁰ by construction, C¹ not. Same class as today's arcs landing into moving
   follow cameras. Judge at the Phase A watch; bounded fixes if flagged: blend the glide's
   clamped end-tangent toward the arc's arrival direction, or authored
   `entry_transition.duration_ms = 0` on group edges. Decide from observation, not up front.
2. **Spline aesthetics on erratic anchors** (doubling back, GPS noise) — centripetal
   parameterization + monotone zoom are the mitigations; degeneracy tests pin NaN-freedom;
   residual aesthetic risk judged at the watch milestone.
3. **Sidecar bundle staleness** — rebuild `renderer/dist` in the same change; Phase C
   parity test compiles both sides from source.
4. **Normalization divergence** between persistence-time and compile-time grouping (the
   reverted attempt's bug class) — structurally prevented: ONE `normalizeClipGroups` used
   by both + idempotence tests.
5. **Auto-bearing anchors** sample `bearingAt` directly (not per-clip stop-quantized
   `bearingKeyframes`) — slight difference from ungrouped follow bearing is by design
   (grouping replaces camera authority); doc note in compile comments; `?? prev ?? 0`
   fallback near route edges.
6. **Overlay geometry fragility** — offsetLeft-based measurement inside the scroller +
   ResizeObserver; bar hides gracefully on missing card refs during thumbnail churn.
7. **Selection-model creep** — multi-select stays ephemeral ProjectView state;
   `selectedClipId` semantics untouched; only new coupling is the derived GROUP pill state.

## Critical files

- `src/lib/cameraIntent.ts` — GroupSpan/anchors/spline glue, compile + dispatch +
  entry/exit endpoints (the heart)
- `src/lib/clipGroups.ts` (new) — shared normalization/integrity, used by persistence AND
  compiler
- `src/lib/spline.ts` (new) — spline math, standalone-tested
- `src/screens/ProjectView.tsx` — compile call site, selection/group state, threading to
  Timeline/MapToolbar/ExportModal
- `src/components/Timeline/Timeline.tsx` + `GroupBar.tsx` (new) — multi-select, Group
  button, bar
- `src-tauri/src/models.rs` — persisted `ClipGroup` + `Project.clip_groups`, in lockstep
  with `src-tauri/tests/fixtures/project_parity.json` and
  `src/lib/__tests__/projectPersistence.test.ts`
