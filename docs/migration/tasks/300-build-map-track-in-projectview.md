# Task 300 — Build MapTrack in ProjectView and pass to MapView

**Step**: 3 (MapView refactor)
**Estimated effort**: 1h
**Status**: pending
**Depends on**: 120, 230

## Goal

Move the camera-state derivation into `ProjectView.tsx` via a `useMemo` that calls `buildMapTrack`, and update `MapView`'s prop interface to accept the resulting `MapTrack` plus a slim set of presentational props per §6.3 of the migration doc. This task only adds the new prop — Writers 1/4/5/6 still exist and still consume the old props in this commit. Tasks 310-340 then strip the old code in subsequent commits.

## Files to touch

- `src/screens/ProjectView.tsx` — modify — add a `useMemo` that calls `indexRoute(route)` once, then `buildMapTrack(clips, indexedRoute, mapSettings, transitionFeel)`. Pass the resulting `track` to `<MapView>`. The existing props (`clips`, `selectedClipId`, `route`, `playheadMs`, `mapSettings`, `mapBearing`, `onSelectClip`) stay in place for now.
- `src/components/MapView.tsx` — modify — add `track: MapTrack` to `MapViewProps` and accept it in the destructured props. No use of `track` yet — wiring only.

## Deliverables

- `ProjectView.tsx` builds `MapTrack` once per relevant change (`clips`, `route`, `mapSettings`, `transitionFeel`).
- `MapView` accepts the new prop without consuming it yet.
- App still compiles and runs identically to before this task.

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] `npm run tauri dev` shows the existing app behaving identically (no visual or interaction regressions).
- [ ] `MapViewProps` exports a `track: MapTrack` field.
- [ ] React DevTools shows the `track` memo updating only when one of its dependencies changes.

## Implementation notes

The migration doc (§6.3) gives the exact useMemo body:

```tsx
const indexedRoute = useMemo(() => indexRoute(route), [route]);
const track = useMemo(
  () => buildMapTrack(clips, indexedRoute, mapSettings, projectTransitionFeel),
  [clips, indexedRoute, mapSettings, projectTransitionFeel],
);
```

For `projectTransitionFeel`, this task does NOT yet add the persisted field to `Project` (that's task 350). Use a hardcoded default of `'natural'` for now and add a TODO comment pointing to task 350. When task 350 lands, the source becomes `project.transition_feel ?? 'natural'`.

`indexRoute` is the existing export from `routeLocation.ts:59-79`.

The full new prop interface from §6.3 is:

```ts
interface MapViewProps {
  track: MapTrack;
  playheadMs: number | null;
  mapSettings: MapSettings;
  selectedClipId: string | null;
  route: Route | null;
  onSelectClip?: (clipId: string) => void;
}
```

Do not delete the existing props yet — that happens in tasks 310/330. This task is purely additive so the next tasks can swap in usage piece-by-piece.
