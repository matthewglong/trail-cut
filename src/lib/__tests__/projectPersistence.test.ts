// Project persistence parity tests (ship review Phase 2a, defect 3).
//
// The shared fixture at `src-tauri/tests/fixtures/project_parity.json` is
// loaded here AND by `src-tauri/tests/project_parity.rs`; the Rust side pins
// the serde wire shape (deserialize → re-serialize, exact equality), this
// side pins the CANONICAL SAVE PATH: the fixture is run through the very
// functions auto-save uses (`hydrateProjectState` → `buildSavePayload`) and
// the payload must deep-equal the fixture. If the save path ever drops a
// persisted field again — the regression class that silently erased
// `working_color_space` / `start_camera` / `default_entry_transition`
// (ship review §1.4a) — it fails here by name.
//
// Adding a field to the `Project` type? `PROJECT_WIRE_KEYS` below fails the
// typecheck until you list it, and the runtime check fails until the fixture
// populates it.

import { describe, it, expect } from 'vitest';
import type { MapSettings, Project } from '../../types';
import { DEFAULT_MAP_SETTINGS } from '../../types';
import {
  buildSavePayload,
  hydrateProjectState,
  mergeMapSettings,
  seededLayouts,
} from '../projectPersistence';
import { defaultMagnifications } from '../layout';
import rawFixture from '../../../src-tauri/tests/fixtures/project_parity.json';

interface Fixture {
  doc: string;
  project: Project;
}

const fixture = rawFixture as unknown as Fixture;

/** Exhaustive key map of the persisted `Project` wire shape. The `satisfies`
 *  clause makes this a compile-time contract: adding a field to the
 *  `Project` interface without listing it here fails `tsc` (the build), and
 *  the runtime loop below fails until `project_parity.json` populates it —
 *  so every new persisted field is forced into the parity fixture on both
 *  sides. (The Rust-only `schema_version` is not on the TS type; it rides
 *  the base spread untyped and is covered by the Rust suite.) */
const PROJECT_WIRE_KEYS = {
  version: true,
  name: true,
  thumbnail: true,
  clips: true,
  route: true,
  layouts: true,
  map_magnification: true,
  selected_export_aspect: true,
  map_settings: true,
  transition_feel: true,
  start_camera: true,
  default_entry_transition: true,
  last_export_selection: true,
  waypoints: true,
  working_color_space: true,
} as const satisfies Record<keyof Project, true>;

describe('project_parity.json — fixture integrity', () => {
  it('exists, parses, and is non-trivial (loud precondition)', () => {
    // A missing/renamed fixture must fail the suite, never skip it.
    expect(fixture.project).toBeTruthy();
    expect(fixture.project.clips.length).toBeGreaterThan(0);
    expect(fixture.project.waypoints.length).toBeGreaterThan(0);
  });

  it('populates every field of the Project wire shape', () => {
    for (const key of Object.keys(PROJECT_WIRE_KEYS)) {
      expect(
        fixture.project,
        `fixture is missing Project field "${key}" — keep project_parity.json fully populated`,
      ).toHaveProperty(key);
    }
  });
});

describe('canonical auto-save payload (hydrateProjectState → buildSavePayload)', () => {
  it('round-trips the full fixture with zero field loss', () => {
    const base = fixture.project;
    const live = hydrateProjectState(base, 'FallbackName');
    const payload = buildSavePayload(base, live);
    // Deep equality over the WHOLE project: any persisted field the save
    // path drops or mutates fails here. (The fixture's map_settings is fully
    // populated, so the load-path defaults-merge is the identity.)
    expect(payload).toEqual(base);
  });

  it('preserves the fields the editor UI does not manage (the §1.4a regression)', () => {
    const base = fixture.project;
    const payload = buildSavePayload(base, hydrateProjectState(base, 'x'));
    expect(payload.working_color_space).toEqual(base.working_color_space);
    expect(payload.start_camera).toEqual(base.start_camera);
    expect(payload.default_entry_transition).toEqual(base.default_entry_transition);
    expect(payload.version).toBe(base.version);
  });

  it('round-trips fields this build does not even know about (future schemas)', () => {
    // The base spread carries unknown keys by construction — a v10 field
    // opened by this (v9-era) build must survive its auto-save untouched.
    const base = {
      ...fixture.project,
      __hypothetical_v10_field: { keep: true, nested: [1, 2, 3] },
    } as Project;
    const payload = buildSavePayload(base, hydrateProjectState(base, 'x'));
    expect((payload as unknown as Record<string, unknown>).__hypothetical_v10_field).toEqual({
      keep: true,
      nested: [1, 2, 3],
    });
  });

  it('persists an emptied project (removing the last clip is an edit)', () => {
    // Ship review §1.4b: the old `clips.length === 0` guard meant removing
    // the last clip never hit disk. The payload builder must express the
    // empty state while still carrying the unmanaged fields.
    const base = fixture.project;
    const live = { ...hydrateProjectState(base, 'x'), clips: [], waypoints: [] };
    const payload = buildSavePayload(base, live);
    expect(payload.clips).toEqual([]);
    expect(payload.waypoints).toEqual([]);
    expect(payload.start_camera).toEqual(base.start_camera);
    expect(payload.working_color_space).toEqual(base.working_color_space);
  });
});

describe('hydrateProjectState — load-path normalization', () => {
  it('backfills layouts and aspect when the payload lacks them', () => {
    const sparse = {
      ...fixture.project,
      layouts: undefined,
      selected_export_aspect: undefined,
    } as unknown as Project;
    const live = hydrateProjectState(sparse, 'x');
    expect(live.projectLayouts).toEqual(seededLayouts());
    expect(live.selectedExportAspect).toBe('9_16');
  });

  it('normalizes a missing route to null (IPC undefined guard)', () => {
    const routeless = { ...fixture.project, route: undefined } as unknown as Project;
    expect(hydrateProjectState(routeless, 'x').route).toBeNull();
  });

  it('seeds waypoints from clips for legacy (pre-v7) bundles', () => {
    const legacy = { ...fixture.project, waypoints: [] } as Project;
    const live = hydrateProjectState(legacy, 'x');
    // clip-1 has GPS + created_at → seeds a waypoint; the exact seeding
    // rules live in lib/waypoints.ts — here we only pin that seeding runs.
    expect(live.waypoints.length).toBeGreaterThan(0);
  });

  it('falls back to the directory-derived name when the bundle name is empty', () => {
    const unnamed = { ...fixture.project, name: '' } as Project;
    expect(hydrateProjectState(unnamed, 'MyHike').projectName).toBe('MyHike');
  });
});

describe('mergeMapSettings — legacy shims (moved from useProject, pinned here)', () => {
  it('is the identity for a fully-populated map_settings', () => {
    expect(mergeMapSettings(DEFAULT_MAP_SETTINGS, fixture.project.map_settings)).toEqual(
      fixture.project.map_settings,
    );
  });

  it('returns defaults for a null/absent map_settings', () => {
    expect(mergeMapSettings(DEFAULT_MAP_SETTINGS, null)).toEqual(DEFAULT_MAP_SETTINGS);
    expect(mergeMapSettings(DEFAULT_MAP_SETTINGS, undefined)).toEqual(DEFAULT_MAP_SETTINGS);
  });

  it('maps the legacy route.size.full_width onto width', () => {
    const legacy = {
      ...fixture.project.map_settings,
      route: {
        ...fixture.project.map_settings!.route,
        size: { full_width: 0.042 } as unknown as MapSettings['route']['size'],
      },
    } as MapSettings;
    const merged = mergeMapSettings(DEFAULT_MAP_SETTINGS, legacy);
    expect(merged.route.size.width).toBe(0.042);
  });

  it('round-trips transition (present rides through whole; absent stays absent)', () => {
    const transition = {
      travel: {
        enabled: true,
        sync: false,
        playhead: {
          ...DEFAULT_MAP_SETTINGS.pov,
          marker: { kind: 'shape', shape: 'ring' },
        },
        draw_route: false,
      },
      ease_in: { style: 'pop', speed: 'fast' },
    };
    const withTransition = {
      ...fixture.project.map_settings!,
      transition,
    } as MapSettings;
    const merged = mergeMapSettings(DEFAULT_MAP_SETTINGS, withTransition);
    expect(merged.transition).toEqual(transition);
    // A bundle without the field must not grow one.
    expect(
      mergeMapSettings(DEFAULT_MAP_SETTINGS, fixture.project.map_settings)
        .transition,
    ).toBeUndefined();
  });
});

describe('map_magnification — hydrate / save asymmetry', () => {
  // The field is optional on disk and ABSENT means "all three aspects at
  // 1.0". Hydration fills the record so the UI always has three numbers;
  // the save path drops it again while it holds the identity, so a project
  // that never touches the knob writes exactly the bytes it used to.

  it('default-fills the whole record when the bundle omits the field', () => {
    const without = { ...fixture.project };
    delete without.map_magnification;
    expect(hydrateProjectState(without, 'x').mapMagnifications).toEqual(
      defaultMagnifications(),
    );
  });

  it('default-fills only the missing aspects of a partial record', () => {
    // Hand-edited bundles. A one-aspect record must not leave `undefined`
    // in the other two slots — every consumer multiplies by these.
    const partial = {
      ...fixture.project,
      map_magnification: { '9_16': 1.5 },
    } as unknown as Project;
    expect(hydrateProjectState(partial, 'x').mapMagnifications).toEqual({
      '9_16': 1.5,
      '4_5': 1.0,
      '16_9': 1.0,
    });
  });

  it('omits the field from the save payload when every aspect is 1.0', () => {
    const base = fixture.project;
    const live = {
      ...hydrateProjectState(base, 'x'),
      mapMagnifications: defaultMagnifications(),
    };
    const payload = buildSavePayload(base, live);
    expect('map_magnification' in payload).toBe(false);
  });

  it('drops a stale on-disk value when the user dials back to 1.0', () => {
    // The base spread would otherwise resurrect the value the bundle was
    // loaded with — the same class of bug the spread exists to prevent, in
    // the opposite direction.
    const base = { ...fixture.project, map_magnification: { '9_16': 1.8, '4_5': 1.0, '16_9': 1.0 } };
    const live = {
      ...hydrateProjectState(base, 'x'),
      mapMagnifications: defaultMagnifications(),
    };
    expect('map_magnification' in buildSavePayload(base, live)).toBe(false);
  });

  it('persists a non-identity record verbatim, and round-trips it', () => {
    const base = fixture.project;
    const set = { '9_16': 1.5, '4_5': 0.8, '16_9': 1.0 };
    const payload = buildSavePayload(base, {
      ...hydrateProjectState(base, 'x'),
      mapMagnifications: set,
    });
    expect(payload.map_magnification).toEqual(set);
    // Reload → save again: the value survives untouched.
    const reloaded = hydrateProjectState(payload, 'x');
    expect(reloaded.mapMagnifications).toEqual(set);
    expect(buildSavePayload(payload, reloaded).map_magnification).toEqual(set);
  });
});
