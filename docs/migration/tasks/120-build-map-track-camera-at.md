# Task 120 — Implement `buildMapTrack`, `cameraAt`, and `liveIntent`

**Step**: 1 (Spike)
**Estimated effort**: 2h
**Status**: pending
**Depends on**: 010

## Goal

Implement the pure timeline builder and the central `cameraAt(track, t)` lookup function per §3.2 of the migration doc. These are the heart of the new architecture — `cameraAt` is "the single source of truth" returning the intent active at any wall-clock time t, and `buildMapTrack` derives the anchor list from clips + route + settings.

## Files to touch

- `src/lib/cameraIntent.ts` — modify — fill in `buildMapTrack`, `anchorIntentForClip`, `cameraAt`, `liveIntent`. Keep `interpolateAnchors` as a stub (task 130 fills it).
- `src/lib/cameraIntent.test.ts` — modify — add tests for empty track, single anchor, before-first, after-last, inside-clip, and gap detection (gap returns whatever the stub returns — just verify the routing).

## Deliverables

- `buildMapTrack(clips, route, projectMapSettings, transitionFeel): MapTrack` — pure, no DOM.
- Internal `anchorIntentForClip(clip, settings, route, anchorStartMs, anchorEndMs): CameraIntent` — picks `follow` for `follow_playhead && route`, otherwise falls back to `point` on the clip's waypoint.
- `cameraAt(track, t): CameraIntent` — handles empty track (returns `DEFAULT_INTENT`), before-first (holds first), after-last (holds last), inside-clip (calls `liveIntent`), in-gap (calls `interpolateAnchors`).
- `liveIntent(intent, t)` — for `follow`, returns `{...intent, playheadMs: t}`; otherwise returns intent as-is.

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] `npm run test:run` passes for new cases.
- [ ] Calling `cameraAt(track, t)` twice with the same args returns deeply-equal intents (purity).
- [ ] For a 3-clip track, `cameraAt(track, anchors[0].timeMs - 1)` returns an intent equivalent to `liveIntent(anchors[0].intent, anchors[0].timeMs)`.
- [ ] For a follow anchor, `cameraAt(track, t).playheadMs === t` when t is inside the anchor.

## Implementation notes

Code structure verbatim from §3.2. Key invariant called out in the doc: "**Key invariant**: `cameraAt(track, t)` is pure in `(track, t)`. There is no `performance.now()`, no MapLibre, no DOM. Calling it twice with the same arguments returns identical intents."

`buildMapTrack` reads each clip's `created_at`, `trim.in_ms`, `trim.out_ms`, `duration_ms`, and `map_overrides`. For each clip: skip if `visible === false`, `created_at` is missing, `parseTimestamp` returns NaN, or `outMs <= inMs`. Compute `startMs = baseMs + inMs`, `endMs = baseMs + outMs`. Resolve settings via `resolveMapSettings(projectMapSettings, clip.map_overrides)` (existing helper in `src/types.ts`). Call `anchorIntentForClip(...)` with the resolved settings.

`anchorIntentForClip` for follow mode: when `bearing_mode === 'auto'`, precompute `bearingKeyframes` via `computeBearingKeyframes(anchorStartMs, anchorEndMs, route, settings.bearing_stops)` and freeze on the intent. The migration doc explicitly addresses why this happens at build time, not in `resolveIntent`: "This keeps `resolveIntent` pure in `(intent, viewport)` with no transitive dependency on `IndexedRoute` math at render time."

Pitch is `60` for `'3d'` style, `0` otherwise. Padding default for follow intents is `0.06` (fraction of min viewport dim, per §3.2 code).

For the gap case in `cameraAt`, call `interpolateAnchors(a, next, t, track.transitionFeel)` — task 130 supplies the body. For now the test can use a stub that returns `a.intent` so the routing is verifiable independently.
