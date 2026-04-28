# Task 010 — Scaffold src/lib/cameraIntent.ts with type definitions

**Step**: Setup
**Estimated effort**: 1h
**Status**: pending
**Depends on**: none

## Goal

Create the new `src/lib/cameraIntent.ts` file containing only the type definitions and constants from §3.1 of the migration doc — no logic. This unblocks all 1xx (spike) tasks to import canonical types in parallel without coupling. The migration doc states (§3.1): "Add a new file `src/lib/cameraIntent.ts` (location is a recommendation; keep it next to `routeLocation.ts` since the two compose)."

## Files to touch

- `src/lib/cameraIntent.ts` — new — type-only module exporting `LngLat`, `Bounds`, `Viewport`, `ResolvedCamera`, `Padding`, `CameraIntent` (discriminated union), `MapAnchor`, `MapTrack`, `TransitionFeel`, plus a `DEFAULT_INTENT` constant.

## Deliverables

- File compiles under `tsc`.
- All types are exported and named exactly as in §3.1 / §3.2.
- `CameraIntent` is the three-arm discriminated union (`'point' | 'region' | 'follow'`).
- A `DEFAULT_INTENT: CameraIntent` constant exists (used by `cameraAt` in task 120).
- Function signatures may be declared with `declare` or stub `throw new Error('not implemented')` bodies for: `buildMapTrack`, `cameraAt`, `resolveIntent`, `interpolateAnchors`, `vanWijkArc`, `vanWijkSample`, `arcDurationMs`. Stub bodies preferred — keeps imports working in adjacent test files immediately.

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] `import type { CameraIntent, MapTrack, Viewport, ResolvedCamera, Bounds, MapAnchor, TransitionFeel } from './cameraIntent'` resolves cleanly from any file in `src/lib/`.
- [ ] `TransitionFeel` is exactly the string-literal union `'natural' | 'snappy' | 'slow'`.

## Implementation notes

Copy the type bodies verbatim from §3.1 of the migration doc (lines ~360-440), including the JSDoc comments — they encode the design rationale (e.g., why `Padding` is fractional rather than pixel-based: "the same N-pixel inset has wildly different visual proportions in a 360-wide vertical strip vs. a 1920-wide landscape strip").

Imports needed:
- `import type { IndexedRoute, BearingKeyframe } from './routeLocation';`
- `import type { BearingMode } from '../types';`

Stub functions should match the exact signatures shown in §3.2-3.4 so consumers can already type-check usage. Bodies of pure-helper functions (`vanWijkArc`, etc.) get filled in by Step 1 tasks.
