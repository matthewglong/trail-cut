// Marker-image library state helpers — the pure logic behind the shared
// `MapSettings.marker_images` library (schema v11).
//
// Two jobs:
//
//  1. `removeMarkerImage` — the delete flow's state transform. Deleting a
//     library entry must revert EVERY use of it (project-level selections
//     on both decorations, per-clip POV and waypoints overrides,
//     per-waypoint overrides) to the default marker in one atomic pass,
//     then drop the entry. The
//     caller (ProjectView) applies the returned state and only THEN invokes
//     the `delete_marker_image` command to remove the asset files — so a
//     failed file deletion can never leave a dangling reference.
//
//  2. `referencedMarkerImageIds` — the "which images does this project
//     actually use" walk shared by `buildExportRequest` (which must ship a
//     path for every referenced entry) and consumers that want
//     max-density/registration decisions.
//
// Pure and platform-free on purpose: unit-testable, and importable by the
// export sidecar bundle if it ever needs the same walk.

import type { Clip, MapSettings, Waypoint } from '../types';

/** Everything the library delete flow needs to update, as one value. */
export interface MarkerLibraryState {
  mapSettings: MapSettings;
  clips: Clip[];
  waypoints: Waypoint[];
}

/** Remove library entry `id` and revert every use of it to the default
 *  marker. Untouched objects keep their identity (clips/waypoints that
 *  never referenced the image are returned as-is) so React consumers only
 *  re-render what actually changed. */
export function removeMarkerImage(
  state: MarkerLibraryState,
  id: string,
): MarkerLibraryState {
  const { mapSettings, clips, waypoints } = state;

  const povMarkerHit =
    mapSettings.pov.marker?.kind === 'image' &&
    mapSettings.pov.marker.image_id === id;
  // Traveling-playhead marker (Transition decoration): strip only the
  // custom style block's `marker` field (reverting the traveling playhead
  // to the default dot — normal PovSettings semantics inside the block);
  // the transition block itself, its toggles/eases, and the rest of the
  // custom style all survive.
  const transitionHit = (t: MapSettings['transition']): boolean =>
    t?.travel?.playhead?.marker?.kind === 'image' &&
    t.travel.playhead.marker.image_id === id;
  const strippedTransition = (
    t: NonNullable<MapSettings['transition']>,
  ): NonNullable<MapSettings['transition']> => ({
    ...t,
    travel: t.travel
      ? {
          ...t.travel,
          playhead: t.travel.playhead
            ? { ...t.travel.playhead, marker: undefined }
            : t.travel.playhead,
        }
      : t.travel,
  });
  const nextSettings: MapSettings = {
    ...mapSettings,
    marker_images: mapSettings.marker_images.filter((m) => m.id !== id),
    pov: povMarkerHit
      ? { ...mapSettings.pov, marker: undefined }
      : mapSettings.pov,
    transition:
      transitionHit(mapSettings.transition) && mapSettings.transition
        ? strippedTransition(mapSettings.transition)
        : mapSettings.transition,
    waypoints:
      mapSettings.waypoints.marker_image_id === id
        ? { ...mapSettings.waypoints, marker_image_id: undefined }
        : mapSettings.waypoints,
  };

  const nextClips = clips.map((clip) => {
    const pov = clip.map_overrides?.pov;
    const wpOv = clip.map_overrides?.waypoints;
    const transitionOv = clip.map_overrides?.transition;
    const povHit = pov?.marker?.kind === 'image' && pov.marker.image_id === id;
    const clipTransitionHit = transitionHit(transitionOv);
    const wpHit = wpOv?.marker?.marker_image_id === id;
    if (!povHit && !clipTransitionHit && !wpHit) return clip;
    // Strip the referencing marker override(s); prune now-empty override
    // objects so a clip that only overrode the marker reads as "no
    // overrides" again (the override pill keys off object presence).
    const overrides = { ...clip.map_overrides };
    if (povHit && pov) {
      const { marker: _removed, ...restPov } = pov;
      if (Object.keys(restPov).length > 0) {
        overrides.pov = restPov;
      } else {
        delete overrides.pov;
      }
    }
    // A transition override is an atomic blob: strip only the custom
    // style's marker, keep everything else — a transition-only override
    // stays an override (with the traveling playhead reverted to the dot)
    // rather than collapsing to "no override".
    if (clipTransitionHit && transitionOv) {
      overrides.transition = strippedTransition(transitionOv);
    }
    if (wpHit && wpOv) {
      const { marker: _removed, ...restWp } = wpOv;
      if (Object.keys(restWp).length > 0) {
        overrides.waypoints = restWp;
      } else {
        delete overrides.waypoints;
      }
    }
    return {
      ...clip,
      map_overrides: Object.keys(overrides).length > 0 ? overrides : null,
    };
  });

  const nextWaypoints = waypoints.map((wp) =>
    wp.marker_image_id === id ? { ...wp, marker_image_id: undefined } : wp,
  );

  return {
    mapSettings: nextSettings,
    clips: nextClips,
    waypoints: nextWaypoints,
  };
}

/** Collect the ids of every library image the project references: the
 *  project-level POV marker, every per-clip POV or waypoints marker
 *  override, the project-level waypoint marker, and every per-waypoint
 *  override. The result is NOT intersected with the library — a referenced
 *  id missing from `marker_images` is a corruption the caller should
 *  surface loudly, not silently drop. */
export function referencedMarkerImageIds(
  mapSettings: MapSettings,
  clips: readonly Clip[],
  waypoints: readonly Waypoint[],
): Set<string> {
  const out = new Set<string>();
  if (mapSettings.pov.marker?.kind === 'image') {
    out.add(mapSettings.pov.marker.image_id);
  }
  // Traveling-playhead markers count as referenced even while the travel
  // block is disabled or synced — the config survives both off-toggles,
  // registration is harmless, and `removeMarkerImage` guarantees no
  // dangling ids either way.
  if (mapSettings.transition?.travel?.playhead?.marker?.kind === 'image') {
    out.add(mapSettings.transition.travel.playhead.marker.image_id);
  }
  for (const clip of clips) {
    const marker = clip.map_overrides?.pov?.marker;
    if (marker?.kind === 'image') out.add(marker.image_id);
    const travelMarker =
      clip.map_overrides?.transition?.travel?.playhead?.marker;
    if (travelMarker?.kind === 'image') out.add(travelMarker.image_id);
    const wpMarker = clip.map_overrides?.waypoints?.marker;
    if (wpMarker?.marker_image_id !== undefined) {
      out.add(wpMarker.marker_image_id);
    }
  }
  if (mapSettings.waypoints.marker_image_id !== undefined) {
    out.add(mapSettings.waypoints.marker_image_id);
  }
  for (const wp of waypoints) {
    if (wp.marker_image_id !== undefined) out.add(wp.marker_image_id);
  }
  return out;
}
