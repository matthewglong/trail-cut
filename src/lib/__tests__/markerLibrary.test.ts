// Tests for the marker-library state helpers: the delete flow's
// revert-all-uses transform (`removeMarkerImage`) and the referenced-ids
// walk shared with the export path (`referencedMarkerImageIds`).

import { describe, it, expect } from 'vitest';
import { removeMarkerImage, referencedMarkerImageIds } from '../markerLibrary';
import {
  DEFAULT_MAP_SETTINGS,
  type Clip,
  type MapSettings,
  type MarkerImageRef,
  type Waypoint,
} from '../../types';

const IMG_A: MarkerImageRef = {
  id: 'aaaaaaaaaaaaaaaa',
  icon_file: 'assets/marker-icon-aaaaaaaaaaaaaaaa.png',
  source_file: 'assets/marker-source-aaaaaaaaaaaaaaaa.png',
  source_name: 'a.png',
  width: 100,
  height: 100,
};
const IMG_B: MarkerImageRef = {
  id: 'bbbbbbbbbbbbbbbb',
  icon_file: 'assets/marker-icon-bbbbbbbbbbbbbbbb.png',
  source_file: 'assets/marker-source-bbbbbbbbbbbbbbbb.svg',
  source_name: 'b.svg',
  width: 64,
  height: 64,
};

function makeClip(id: string, overrides: Clip['map_overrides']): Clip {
  return {
    id,
    path: `/v/${id}.mov`,
    filename: `${id}.mov`,
    created_at: null,
    duration_ms: null,
    gps: null,
    resolution: null,
    frame_rate: null,
    trim: null,
    focal_point: { x: 0.5, y: 0.5, zoom: 1 },
    effects: { stabilize: { enabled: false, shakiness: 5 }, speed: 1 },
    visible: true,
    map_overrides: overrides,
  } as Clip;
}

function makeWaypoint(id: string, extra: Partial<Waypoint>): Waypoint {
  return {
    id,
    position: { kind: 'fixed', lat: 47, lng: -122 },
    label: '',
    source: 'manual',
    ...extra,
  } as Waypoint;
}

function settingsWith(overrides: Partial<MapSettings>): MapSettings {
  return { ...DEFAULT_MAP_SETTINGS, ...overrides };
}

describe('removeMarkerImage', () => {
  it('drops the library entry and reverts every use across all channels', () => {
    const mapSettings = settingsWith({
      marker_images: [IMG_A, IMG_B],
      pov: {
        ...DEFAULT_MAP_SETTINGS.pov,
        marker: { kind: 'image', image_id: IMG_A.id },
      },
      waypoints: {
        ...DEFAULT_MAP_SETTINGS.waypoints,
        marker_image_id: IMG_A.id,
      },
    });
    const clips = [
      makeClip('c1', {
        pov: { marker: { kind: 'image', image_id: IMG_A.id } },
      }),
      makeClip('c2', {
        pov: { color: '#ff0000', marker: { kind: 'image', image_id: IMG_A.id } },
      }),
      makeClip('c3', null),
    ];
    const waypoints = [
      makeWaypoint('w1', { marker_image_id: IMG_A.id }),
      makeWaypoint('w2', { marker_image_id: IMG_B.id }),
      makeWaypoint('w3', {}),
    ];

    const next = removeMarkerImage({ mapSettings, clips, waypoints }, IMG_A.id);

    expect(next.mapSettings.marker_images).toEqual([IMG_B]);
    expect(next.mapSettings.pov.marker).toBeUndefined();
    expect(next.mapSettings.waypoints.marker_image_id).toBeUndefined();
    // c1 overrode ONLY the marker → its override bag collapses to null so
    // the override pill turns off.
    expect(next.clips[0].map_overrides).toBeNull();
    // c2 keeps its color override; only the marker key is stripped.
    expect(next.clips[1].map_overrides).toEqual({ pov: { color: '#ff0000' } });
    expect(next.waypoints[0].marker_image_id).toBeUndefined();
    // Other images' uses are untouched.
    expect(next.waypoints[1].marker_image_id).toBe(IMG_B.id);
  });

  it('keeps identity of untouched objects (no spurious re-renders)', () => {
    const mapSettings = settingsWith({ marker_images: [IMG_A, IMG_B] });
    const clips = [makeClip('c1', null)];
    const waypoints = [makeWaypoint('w1', { shape: 'pin' })];
    const next = removeMarkerImage({ mapSettings, clips, waypoints }, IMG_A.id);
    expect(next.clips[0]).toBe(clips[0]);
    expect(next.waypoints[0]).toBe(waypoints[0]);
    expect(next.mapSettings.pov).toBe(mapSettings.pov);
    expect(next.mapSettings.waypoints).toBe(mapSettings.waypoints);
  });

  it('does not touch shape-preset POV markers or shape overrides', () => {
    const mapSettings = settingsWith({
      marker_images: [IMG_A],
      pov: {
        ...DEFAULT_MAP_SETTINGS.pov,
        marker: { kind: 'shape', shape: 'ring' },
      },
    });
    const waypoints = [makeWaypoint('w1', { shape: 'square' })];
    const next = removeMarkerImage(
      { mapSettings, clips: [], waypoints },
      IMG_A.id,
    );
    expect(next.mapSettings.pov.marker).toEqual({ kind: 'shape', shape: 'ring' });
    expect(next.waypoints[0].shape).toBe('square');
  });
});

describe('referencedMarkerImageIds', () => {
  it('collects ids from every channel: project pov, clip overrides, project waypoints, per-waypoint', () => {
    const mapSettings = settingsWith({
      marker_images: [IMG_A, IMG_B],
      pov: {
        ...DEFAULT_MAP_SETTINGS.pov,
        marker: { kind: 'image', image_id: 'pov-project' },
      },
      waypoints: {
        ...DEFAULT_MAP_SETTINGS.waypoints,
        marker_image_id: 'wp-project',
      },
    });
    const clips = [
      makeClip('c1', {
        pov: { marker: { kind: 'image', image_id: 'pov-clip' } },
      }),
      makeClip('c2', { pov: { marker: { kind: 'shape', shape: 'ring' } } }),
    ];
    const waypoints = [makeWaypoint('w1', { marker_image_id: 'wp-entity' })];

    const ids = referencedMarkerImageIds(mapSettings, clips, waypoints);
    expect(ids).toEqual(
      new Set(['pov-project', 'pov-clip', 'wp-project', 'wp-entity']),
    );
  });

  it('returns an empty set for a default project', () => {
    expect(
      referencedMarkerImageIds(DEFAULT_MAP_SETTINGS, [], []),
    ).toEqual(new Set());
  });

  it('does NOT intersect with the library — missing ids surface to the caller', () => {
    const mapSettings = settingsWith({
      marker_images: [], // corrupt: reference without an entry
      pov: {
        ...DEFAULT_MAP_SETTINGS.pov,
        marker: { kind: 'image', image_id: 'ghost' },
      },
    });
    expect(referencedMarkerImageIds(mapSettings, [], [])).toEqual(
      new Set(['ghost']),
    );
  });
});

describe('clip-level waypoints marker overrides (per-clip override expansion)', () => {
  it('referencedMarkerImageIds collects ids from map_overrides.waypoints.marker', () => {
    const clips = [
      makeClip('c1', {
        waypoints: { marker: { shape: 'circle', marker_image_id: IMG_A.id } },
      }),
      makeClip('c2', { waypoints: { marker: { shape: 'diamond' } } }),
    ];
    const ids = referencedMarkerImageIds(DEFAULT_MAP_SETTINGS, clips, []);
    expect(ids).toEqual(new Set([IMG_A.id]));
  });

  it('removeMarkerImage strips a clip-level waypoints marker override and prunes empties', () => {
    const clips = [
      makeClip('c1', {
        waypoints: { marker: { shape: 'circle', marker_image_id: IMG_A.id } },
      }),
      makeClip('c2', {
        waypoints: {
          mode: 'none',
          marker: { shape: 'circle', marker_image_id: IMG_A.id },
        },
      }),
      makeClip('c3', {
        waypoints: { marker: { shape: 'circle', marker_image_id: IMG_B.id } },
      }),
    ];
    const next = removeMarkerImage(
      {
        mapSettings: settingsWith({ marker_images: [IMG_A, IMG_B] }),
        clips,
        waypoints: [],
      },
      IMG_A.id,
    );
    // c1 only had the marker override — collapses to "no overrides".
    expect(next.clips[0].map_overrides).toBeNull();
    // c2 keeps its other waypoint override.
    expect(next.clips[1].map_overrides).toEqual({ waypoints: { mode: 'none' } });
    // c3 references a different image — untouched (identity preserved).
    expect(next.clips[2]).toBe(clips[2]);
  });

  it('removeMarkerImage handles a clip referencing the image via BOTH pov and waypoints overrides', () => {
    const clips = [
      makeClip('c1', {
        pov: { marker: { kind: 'image', image_id: IMG_A.id } },
        waypoints: { marker: { shape: 'pin', marker_image_id: IMG_A.id } },
      }),
    ];
    const next = removeMarkerImage(
      {
        mapSettings: settingsWith({ marker_images: [IMG_A] }),
        clips,
        waypoints: [],
      },
      IMG_A.id,
    );
    expect(next.clips[0].map_overrides).toBeNull();
  });
});

describe('transition traveling-playhead markers', () => {
  /** A transition block whose custom (unsynced) traveling playhead wears
   *  image `id`. */
  const transitionWithImage = (id: string, enabled = true) => ({
    travel: {
      enabled,
      sync: false,
      playhead: {
        ...DEFAULT_MAP_SETTINGS.pov,
        marker: { kind: 'image' as const, image_id: id },
      },
    },
  });

  it('referencedMarkerImageIds collects traveling-playhead markers (project + per-clip, enabled or not)', () => {
    const mapSettings = settingsWith({
      marker_images: [IMG_A, IMG_B],
      // Disabled on purpose — config survives an off-toggle, so the
      // reference still counts.
      transition: transitionWithImage(IMG_A.id, false),
    });
    const clips = [makeClip('c1', { transition: transitionWithImage(IMG_B.id) })];
    const ids = referencedMarkerImageIds(mapSettings, clips, []);
    expect(ids).toEqual(new Set([IMG_A.id, IMG_B.id]));
  });

  it('removeMarkerImage strips the traveling-playhead marker but keeps the block (toggles + eases + style survive)', () => {
    const mapSettings = settingsWith({
      marker_images: [IMG_A],
      transition: {
        ...transitionWithImage(IMG_A.id),
        travel: { ...transitionWithImage(IMG_A.id).travel, draw_route: false },
        ease_in: { style: 'pop', speed: 'fast' },
      },
    });
    const next = removeMarkerImage(
      { mapSettings, clips: [], waypoints: [] },
      IMG_A.id,
    );
    const travel = next.mapSettings.transition?.travel;
    expect(travel?.enabled).toBe(true);
    expect(travel?.draw_route).toBe(false);
    expect(travel?.sync).toBe(false);
    // The custom style survives with its marker reverted to the dot; the
    // eases ride along untouched.
    expect(travel?.playhead).toBeDefined();
    expect(travel?.playhead?.marker).toBeUndefined();
    expect(next.mapSettings.transition?.ease_in).toEqual({
      style: 'pop',
      speed: 'fast',
    });
  });

  it('removeMarkerImage strips a clip-level transition override marker; the override survives', () => {
    const clips = [
      makeClip('c1', { transition: transitionWithImage(IMG_A.id) }),
      makeClip('c2', {
        pov: { marker: { kind: 'image', image_id: IMG_A.id } },
        transition: transitionWithImage(IMG_A.id, false),
      }),
      makeClip('c3', {
        transition: {
          travel: {
            enabled: true,
            sync: false,
            playhead: {
              ...DEFAULT_MAP_SETTINGS.pov,
              marker: { kind: 'shape', shape: 'ring' },
            },
          },
        },
      }),
    ];
    const mapSettings = settingsWith({ marker_images: [IMG_A] });
    const next = removeMarkerImage(
      { mapSettings, clips, waypoints: [] },
      IMG_A.id,
    );
    // c1: transition-only override keeps its (marker-stripped) blob.
    expect(next.clips[0].map_overrides?.transition?.travel?.enabled).toBe(true);
    expect(
      next.clips[0].map_overrides?.transition?.travel?.playhead?.marker,
    ).toBeUndefined();
    // c2: both the normal POV marker and the traveling-playhead marker are
    // stripped; the transition blob itself survives with enabled=false.
    expect(next.clips[1].map_overrides?.pov).toBeUndefined();
    expect(next.clips[1].map_overrides?.transition?.travel?.enabled).toBe(false);
    expect(
      next.clips[1].map_overrides?.transition?.travel?.playhead?.marker,
    ).toBeUndefined();
    // c3: shape travel markers are untouched (identity preserved).
    expect(next.clips[2]).toBe(clips[2]);
  });
});
