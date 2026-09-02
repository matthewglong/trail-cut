/**
 * Canonical project load-hydration and save-payload assembly.
 *
 * Ship review Phase 2a (data-loss fix): the auto-save path used to
 * hand-assemble the wire `Project` from an 11-field parameter list, which
 * silently dropped every persisted field the editor UI doesn't manage
 * (`working_color_space`, `start_camera`, `default_entry_transition`, and
 * any future addition). The fix is structural:
 *
 * - `hydrateProjectState` is the SINGLE translation from a deserialized
 *   `Project` (as returned by the Rust `load_project` command) to the
 *   App-level live editing state.
 * - `buildSavePayload` is the SINGLE inverse: it spreads the full
 *   deserialized base `Project` first, then overlays the live-edited fields.
 *   Fields the UI doesn't manage — including fields this TS build doesn't
 *   even know about — round-trip by construction.
 *
 * Both `useProject` (load) and `useAutoSave` (save) go through this module;
 * never hand-build a `Project` wire object anywhere else. The cross-language
 * parity contract lives in `src-tauri/tests/fixtures/project_parity.json`,
 * exercised by `src/lib/__tests__/projectPersistence.test.ts` (this path)
 * and `src-tauri/tests/project_parity.rs` (the Rust serde shape).
 */

import type {
  AspectRatio,
  Clip,
  ClipGroup,
  ExportGrid,
  MapMagnifications,
  MapSettings,
  Project,
  ProjectLayouts,
  Route,
  TransitionFeel,
  Waypoint,
} from '../types';
import { DEFAULT_MAP_SETTINGS } from '../types';
import {
  defaultMagnifications,
  defaultPipLayout,
  isDefaultMagnification,
} from './layout';
import { seedWaypointsFromClips } from './waypoints';
import { normalizeClipGroups } from './clipGroups';

/** The slice of App-level state that the editor UI owns and mutates. This is
 *  both the output of `hydrateProjectState` (load) and the overlay input of
 *  `buildSavePayload` (save). Anything on `Project` but NOT here is carried
 *  by the base spread in `buildSavePayload` and must never be re-stated by
 *  hand. */
export interface LiveProjectState {
  projectName: string;
  projectThumbnail: string | null;
  clips: Clip[];
  route: Route | null;
  mapSettings: MapSettings;
  transitionFeel: TransitionFeel | undefined;
  projectLayouts: ProjectLayouts;
  mapMagnifications: MapMagnifications;
  selectedExportAspect: AspectRatio;
  lastExportSelection: ExportGrid | null;
  waypoints: Waypoint[];
  /** Clip groups (camera glide — `docs/CLIP_GROUPS_HANDOFF.md` §1). Held
   *  RAW here (hidden members stay); `normalizeClipGroups` is applied on
   *  hydrate and again on save so the persisted form is always consistent
   *  with the persisted clip list. */
  clipGroups: ClipGroup[];
}

/** Defensive backfill mirroring the Rust `seeded_layouts()` (task 080 / 100).
 *  The Rust load path already populates `layouts` for every project; this
 *  TS-side guard handles the (theoretical) case where the IPC payload still
 *  arrives without it — hand-edited bundles, older Rust binaries, future
 *  regressions — so the editor always has a real value to render and
 *  persist. */
export function seededLayouts(): ProjectLayouts {
  return {
    '9_16': defaultPipLayout('9_16'),
    '4_5': defaultPipLayout('4_5'),
    '16_9': defaultPipLayout('16_9'),
  };
}

/** Block-aware merge of project map settings from disk with the canonical
 *  defaults. Mirrors `resolveMapSettings` (which is for clip overrides) but
 *  drops in for the v8 nested shape — `project.map_settings` may be `null`
 *  or a partially-populated nested record from a hand-edited bundle. Also
 *  carries the `full_width → width` legacy shim for pre-rename bundles. */
export function mergeMapSettings(
  defaults: MapSettings,
  incoming: MapSettings | undefined | null,
): MapSettings {
  if (!incoming) return defaults;
  const incomingRouteSize = incoming.route?.size as
    | Partial<MapSettings['route']['size']> & { full_width?: number }
    | undefined;
  const routeSize =
    incomingRouteSize && incomingRouteSize.width === undefined && incomingRouteSize.full_width !== undefined
      ? { ...incomingRouteSize, width: incomingRouteSize.full_width }
      : incomingRouteSize;
  return {
    camera: { ...defaults.camera, ...incoming.camera },
    route: {
      ...defaults.route,
      ...incoming.route,
      size: { ...defaults.route.size, ...routeSize },
    },
    waypoints: {
      ...defaults.waypoints,
      ...incoming.waypoints,
      size: { ...defaults.waypoints.size, ...incoming.waypoints?.size },
    },
    // Optional atomic blobs (`marker`, `halo`) ride the spread: present on
    // disk wins whole, absent stays absent (defaults carry none).
    pov: {
      ...defaults.pov,
      ...incoming.pov,
      size: { ...defaults.pov.size, ...incoming.pov?.size },
    },
    // Top-level atomic blob — present on disk wins whole, absent stays
    // absent (the defaults carry none; absent = transition off).
    transition: incoming.transition ?? defaults.transition,
    // The Rust model omits the field entirely while the library is empty
    // (`skip_serializing_if = "Vec::is_empty"`), so backfill the default.
    marker_images: incoming.marker_images ?? defaults.marker_images,
  };
}

/** Translate a freshly-deserialized `Project` into the live editing state.
 *
 *  Normalizations (kept verbatim from the pre-extraction `openProjectDir`):
 *  - `route ?? null` — Rust's `Option<Route>` with `skip_serializing_if`
 *    arrives over IPC as a missing key (`undefined`), not `null`; the
 *    frontend Route state is typed `Route | null` and downstream strict
 *    `!== null` checks must not silently pass on `undefined`.
 *  - `layouts ?? seededLayouts()` / `selected_export_aspect ?? '9_16'` —
 *    edge-case backfills for payloads from older Rust binaries or
 *    hand-edited bundles (the Rust load path normally guarantees both).
 *  - `map_magnification ?? defaultMagnifications()` — absent is the NORMAL
 *    case, not an edge case: the field is omitted on disk whenever every
 *    aspect sits at the identity factor.
 *  - empty `waypoints` are seeded from clips (legacy pre-v7 bundles arrive
 *    with `[]` from Rust's serde default); the first auto-save persists the
 *    seeded list.
 *  - `clip_groups ?? []` normalized against `clips` — absent is the normal
 *    case (the key is omitted while empty); a hand-edited or stale bundle
 *    whose group references a missing clip id is repaired by THE single
 *    integrity policy (`normalizeClipGroups`), never trusted verbatim. */
export function hydrateProjectState(project: Project, fallbackName: string): LiveProjectState {
  return {
    projectName: project.name || fallbackName,
    projectThumbnail: project.thumbnail ?? null,
    clips: project.clips,
    route: project.route ?? null,
    mapSettings: mergeMapSettings(DEFAULT_MAP_SETTINGS, project.map_settings),
    transitionFeel: project.transition_feel,
    projectLayouts: project.layouts ?? seededLayouts(),
    // Per-key spread, not `??`: a hand-edited bundle carrying only one
    // aspect's factor still yields a complete record.
    mapMagnifications: { ...defaultMagnifications(), ...project.map_magnification },
    selectedExportAspect: project.selected_export_aspect ?? '9_16',
    lastExportSelection: project.last_export_selection ?? null,
    waypoints:
      project.waypoints && project.waypoints.length > 0
        ? project.waypoints
        : seedWaypointsFromClips(project.clips),
    clipGroups: normalizeClipGroups(project.clip_groups ?? [], project.clips),
  };
}

/** Assemble the wire `Project` for `save_project`.
 *
 *  `base` is the full deserialized `Project` exactly as `load_project`
 *  returned it (held in App state from open until close). Spreading it FIRST
 *  means every field the UI doesn't manage — `version`, `start_camera`,
 *  `default_entry_transition`, `working_color_space`, the runtime-only
 *  `schema_version`, and any field added in a future schema this build
 *  pre-dates — survives the save untouched. The live overlay then wins for
 *  everything the editor actually edits.
 *
 *  Do NOT replace the spread with an explicit field list: that is exactly
 *  the hand-maintained third copy of the Project shape that caused the
 *  silent data loss this module exists to fix (ship review §1.4a). */
export function buildSavePayload(base: Project, live: LiveProjectState): Project {
  const payload: Project = {
    ...base,
    name: live.projectName,
    thumbnail: live.projectThumbnail,
    clips: live.clips,
    route: live.route,
    layouts: live.projectLayouts,
    map_magnification: live.mapMagnifications,
    selected_export_aspect: live.selectedExportAspect,
    map_settings: live.mapSettings,
    transition_feel: live.transitionFeel,
    last_export_selection: live.lastExportSelection,
    waypoints: live.waypoints,
    // Normalize against the clips being persisted, so what lands on disk is
    // consistent by construction (a group can never reference a clip that
    // isn't in the same file).
    clip_groups: normalizeClipGroups(live.clipGroups, live.clips),
  };
  // Identity magnification is written as ABSENCE, not as a record of 1s, so
  // a project that never touches the knob saves the same bytes it always
  // did. The delete (rather than simply not overlaying) also matters when
  // the user dials a factor back to 1: the base spread would otherwise
  // resurrect the stale value from disk.
  if (isDefaultMagnification(live.mapMagnifications)) {
    delete payload.map_magnification;
  }
  // Same absence-is-default treatment: no groups ⇒ no key (the Rust side
  // `skip_serializing_if = "Vec::is_empty"` agrees), and the delete stops
  // the base spread resurrecting a group the user dissolved.
  if (payload.clip_groups !== undefined && payload.clip_groups.length === 0) {
    delete payload.clip_groups;
  }
  return payload;
}
