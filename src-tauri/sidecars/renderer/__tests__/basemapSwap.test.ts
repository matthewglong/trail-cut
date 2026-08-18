// Per-clip basemap (`camera.map_style`) in the EXPORT path.
//
// The preview has always honored a per-clip map_style override (MapView's
// "Switch base map style" effect calls `setStyle` on the selected clip's
// resolved settings). The export did not: the renderer built ONE style from
// PROJECT settings at setup and never revisited it, so a project whose clips
// override to satellite exported the project default end to end.
//
// Two layers of coverage here:
//   1. scene.ts — `buildFramePayload` must report the ACTIVE clip's basemap,
//      flipping exactly at the transition span's `cutMs` (the instant the
//      video hard-cuts and `activeClipIdAt` switches clips). Pure, no engine.
//   2. nativeBackend.ts — a style change must trigger exactly ONE engine
//      rebuild, and that rebuild must put the sources, layers, icons and
//      paints back, because `map.load()` wipes them (mbgl
//      `Style::Impl::parse`: `sources.clear(); layers.clear(); images =
//      makeMutable<ImageImpls>()`). Driven through a fake binding injected
//      via the backend's `bindingLoader` seam — no native artifact needed.
//
// Run via `npm run test:renderer`.

import { describe, it, expect } from 'vitest';

import { buildSetupPayload } from './setupFixture';
import { buildStaticScene, buildFramePayload } from '../scene';
import { NativeBackend } from '../nativeBackend';
import type { FramePayload, SetupCmd } from '../backend';
import type { TileCache } from '../tileCache';
import { indexRoute } from '../../../../src/lib/routeLocation';
import { SATELLITE_STYLE } from '../../../../src/lib/mapVisuals/styleSpec';
import type { Clip, MapStyleId } from '../../../../src/types';

const T0 = Date.parse('2024-06-01T12:00:00.000-07:00');

function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

/** Two back-to-back 2s clips; `styleB` (when given) rides clip-b as a
 *  per-clip `camera.map_style` override — the exact shape MapToolbar writes
 *  (`setCamera({ map_style })` → `MapOverrides.camera.map_style`, which is
 *  what `resolveMapSettings` merges). */
function clipsWithOverride(styleB?: MapStyleId): Clip[] {
  const base: Omit<Clip, 'id' | 'created_at' | 'map_overrides'> = {
    path: '/dev/null/clip.mov',
    filename: 'clip.mov',
    duration_ms: 2000,
    gps: { lat: 37.7749, lng: -122.4194 },
    resolution: '1920x1080',
    frame_rate: 30,
    trim: { in_ms: 0, out_ms: 2000 },
    focal_point: { x: 0.5, y: 0.5, zoom: 1 },
    effects: { stabilize: { enabled: false, shakiness: 0 }, speed: 1 },
    visible: true,
    pix_fmt: null,
    color_primaries: null,
    color_trc: null,
    color_space: null,
    color_range: null,
    has_dolby_vision: false,
    camera_make: null,
    camera_model: null,
    source_color_class: 'unknown',
  };
  return [
    { ...base, id: 'clip-a', created_at: iso(0), map_overrides: null },
    {
      ...base,
      id: 'clip-b',
      created_at: iso(2000),
      map_overrides: styleB ? { camera: { map_style: styleB } } : null,
    },
  ];
}

function fixture(styleB?: MapStyleId) {
  const payload = buildSetupPayload({ clips: clipsWithOverride(styleB) });
  const indexedRoute = payload.route ? indexRoute(payload.route) : null;
  // The seam INTO clip-b — the one transition span with a real source clip.
  const span = payload.timeline.transitionSpans.find(
    (s: { fromClipId: string | null; toClipId: string }) =>
      s.fromClipId === 'clip-a' && s.toClipId === 'clip-b',
  );
  if (!span) {
    throw new Error(
      'fixture: compileTimeline produced no clip-a → clip-b transition span; ' +
      'the 2-clip timeline assumption behind these tests no longer holds',
    );
  }
  return { payload, indexedRoute, span };
}

const styleAt = (
  payload: SetupCmd,
  indexedRoute: ReturnType<typeof indexRoute>,
  t: number,
): MapStyleId => buildFramePayload(payload, indexedRoute, t).basemap.styleId;

describe('per-clip basemap — frame payload', () => {
  it('the setup scene carries the PROJECT basemap, not any clip override', () => {
    const { payload } = fixture('satellite');
    const scene = buildStaticScene(payload);
    expect(scene.basemap.styleId).toBe('default');
    expect(scene.basemap.add3dBuildings).toBe(false);
    expect(scene.basemap.buildingsLayer).toBeNull();
  });

  it('the style flips exactly at the cut, not at the start of the transition', () => {
    const { payload, indexedRoute, span } = fixture('satellite');
    // Sanity: the transition window has a pre-cut half to be wrong about.
    expect(span.cutMs).toBeGreaterThan(span.startMs);

    expect(styleAt(payload, indexedRoute, 0)).toBe('default');
    expect(styleAt(payload, indexedRoute, span.startMs)).toBe('default');
    expect(styleAt(payload, indexedRoute, span.cutMs - 1)).toBe('default');
    expect(styleAt(payload, indexedRoute, span.cutMs)).toBe('satellite');
    expect(styleAt(payload, indexedRoute, span.endMs)).toBe('satellite');
  });

  it("a '3d' override carries the buildings layer and pitch with it", () => {
    const { payload, indexedRoute, span } = fixture('3d');
    const before = buildFramePayload(payload, indexedRoute, span.cutMs - 1)
      .basemap;
    const after = buildFramePayload(payload, indexedRoute, span.cutMs).basemap;

    expect(before.styleId).toBe('default');
    expect(before.add3dBuildings).toBe(false);
    expect(before.buildingsLayer).toBeNull();
    expect(before.defaultPitch).toBe(0);

    expect(after.styleId).toBe('3d');
    expect(after.add3dBuildings).toBe(true);
    expect((after.buildingsLayer as { id: string }).id).toBe('3d-buildings');
    expect(after.defaultPitch).toBe(60);
    // default and 3d SHARE the style URL — styleId, not `style`, is the
    // comparison key a backend may use to detect a basemap change.
    expect(after.style).toBe(before.style);
  });

  it('with no override every frame reports the project basemap', () => {
    const { payload, indexedRoute, span } = fixture();
    for (const t of [0, span.startMs, span.cutMs, span.endMs]) {
      expect(styleAt(payload, indexedRoute, t)).toBe('default');
    }
  });

  it('the pitch the export actually renders is per-clip too (compiled timeline)', () => {
    // cameraIntent compiles each clip's intent from that clip's RESOLVED
    // settings, so a per-clip '3d' override already pitches the export
    // camera. Pinning it here because the basemap swap would be half a
    // feature if the camera stayed flat.
    const { payload, indexedRoute, span } = fixture('3d');
    const before = buildFramePayload(payload, indexedRoute, span.startMs - 1);
    const after = buildFramePayload(
      payload,
      indexedRoute,
      payload.timeline.totalDurationMs - 1,
    );
    expect(before.camera.pitch).toBe(0);
    expect(after.camera.pitch).toBe(60);
  });
});

// ---- Backend-level: one rebuild per change, and the scene comes back -------

interface AddedImage {
  id: string;
  options: { width: number; height: number; pixelRatio: number; sdf: boolean };
}

/** Records every mutation the backend makes, per loaded style generation. */
class FakeMap {
  loads: unknown[] = [];
  /** Sources the BACKEND added. Style-provided sources are tracked
   *  separately (`styleSources`) so scene-restoration assertions compare
   *  like with like across a swap between styles with different sources. */
  sources: string[] = [];
  /** Last spec each source was added with — the swap path's seed data. */
  sourceSpecs = new Map<string, Record<string, unknown>>();
  /** Source ids the loaded style itself declares (e.g. `openmaptiles` in
   *  liberty, `satellite` in the inline raster style). */
  styleSources: string[] = [];
  layers: string[] = [];
  images: AddedImage[] = [];
  paints: Array<[string, string, unknown]> = [];
  layouts: Array<[string, string, unknown]> = [];
  groupComposites: unknown[] = [];
  gestureCalls = 0;
  released = false;

  constructor(private readonly renderBytes: number) {}

  load(style: unknown): void {
    this.loads.push(style);
    // Mirror mbgl `Style::Impl::parse`: a reload drops all sources, layers
    // and images, then installs the NEW style's own. Anything the backend
    // fails to re-add stays missing, which is what makes the assertions
    // below meaningful.
    this.sources = [];
    this.sourceSpecs.clear();
    this.layers = [];
    this.images = [];
    this.styleSources = Object.keys(
      (style as { sources?: Record<string, unknown> }).sources ?? {},
    );
  }
  addSource(id: string, spec: Record<string, unknown>): void {
    if (this.sources.includes(id)) {
      throw new Error(`FakeMap: duplicate addSource ${id}`);
    }
    this.sources.push(id);
    this.sourceSpecs.set(id, spec);
  }
  removeSource(id: string): void {
    const i = this.sources.indexOf(id);
    if (i === -1) throw new Error(`FakeMap: removeSource of absent ${id}`);
    this.sources.splice(i, 1);
  }
  addLayer(layer: unknown): void {
    const spec = layer as { id: string; source?: string };
    if (
      spec.source !== undefined
      && !this.sources.includes(spec.source)
      && !this.styleSources.includes(spec.source)
    ) {
      // Same shape as mbgl: a layer against a source the style doesn't have
      // throws. The 3D-buildings add relies on exactly this (soft-failure on
      // styles without `openmaptiles`).
      throw new Error(
        `FakeMap: addLayer ${spec.id} against missing source ${spec.source}`,
      );
    }
    this.layers.push(spec.id);
  }
  removeLayer(id: string): void {
    const i = this.layers.indexOf(id);
    if (i === -1) throw new Error(`FakeMap: removeLayer of absent ${id}`);
    this.layers.splice(i, 1);
  }
  addImage(id: string, _data: Buffer, options: AddedImage['options']): void {
    this.images.push({ id, options });
  }
  setPaintProperty(layerId: string, prop: string, value: unknown): void {
    if (!this.layers.includes(layerId)) {
      throw new Error(`FakeMap: setPaintProperty on missing layer ${layerId}`);
    }
    this.paints.push([layerId, prop, value]);
  }
  setLayoutProperty(layerId: string, prop: string, value: unknown): void {
    if (!this.layers.includes(layerId)) {
      throw new Error(`FakeMap: setLayoutProperty on missing layer ${layerId}`);
    }
    this.layouts.push([layerId, prop, value]);
  }
  setGestureInProgress(): void {
    this.gestureCalls += 1;
  }
  setGroupComposite(groups: unknown): void {
    this.groupComposites.push(groups);
  }
  render(
    _options: unknown,
    cb: (err: Error | null, buffer?: Buffer) => void,
  ): void {
    cb(null, Buffer.alloc(this.renderBytes));
  }
  release(): void {
    this.released = true;
  }
}

/** Tile cache stub. Only the style fetch reaches it in these tests (the fake
 *  map never requests tiles), and the ONLY URL style is the liberty URL — a
 *  request for anything else means the backend took a path this fake does not
 *  model, so it fails loud instead of returning empty bytes. */
function fakeTileCache(fetched: string[]): TileCache {
  return {
    get(url, _fetcher, cb) {
      fetched.push(url);
      if (!url.startsWith('https://tiles.openfreemap.org/')) {
        cb(new Error(`fakeTileCache: unexpected fetch of ${url}`));
        return;
      }
        // Stand-in for the OpenFreeMap liberty style. It must declare
      // `openmaptiles` — that is the source the 3D-buildings layer extrudes
      // from, and whether it exists is the whole soft-failure condition.
      cb(
        null,
        Buffer.from(
          JSON.stringify({
            version: 8,
            sources: { openmaptiles: { type: 'vector', tiles: [] } },
            layers: [],
          }),
        ),
      );
    },
    stats: () => ({ hits: 0, misses: 0, bytesRead: 0, bytesWritten: 0 }),
  };
}

async function bootBackend(payload: SetupCmd) {
  const maps: FakeMap[] = [];
  const fetched: string[] = [];
  const backend = new NativeBackend(fakeTileCache(fetched), () => ({
    Map: class {
      constructor() {
        const m = new FakeMap(payload.readback.w * payload.readback.h * 4);
        maps.push(m);
        return m as unknown as FakeMap;
      }
    } as never,
    readbackDownsample: true,
    groupComposite: true,
  }));
  await backend.setup(payload);
  return { backend, maps, fetched, map: maps[0] };
}

describe('per-clip basemap — native backend rebuild', () => {
  it('swaps once at the cut and puts the whole scene back', async () => {
    const { payload, indexedRoute, span } = fixture('satellite');
    const { backend, map, fetched } = await bootBackend(payload);

    const sourcesAfterSetup = [...map.sources];
    const layersAfterSetup = [...map.layers];
    const imageIdsAfterSetup = map.images.map((i) => i.id);
    expect(map.loads).toHaveLength(1);
    expect(sourcesAfterSetup).toContain('route-full');
    expect(layersAfterSetup.length).toBeGreaterThan(0);
    expect(imageIdsAfterSetup.length).toBeGreaterThan(0);

    // Frames on clip-a (project default) — no reload.
    let index = 0;
    const render = async (t: number): Promise<void> => {
      await backend.renderFrame(
        buildFramePayload(payload, indexedRoute, t) as FramePayload,
        index++,
      );
    };
    await render(0);
    await render(span.cutMs - 1);
    expect(map.loads).toHaveLength(1);

    // The cut frame — exactly one reload, to the satellite style. Satellite
    // is an INLINE spec, so it must not go through the URL fetch path.
    const fetchesBefore = fetched.length;
    await render(span.cutMs);
    expect(map.loads).toHaveLength(2);
    expect(map.loads[1]).toBe(SATELLITE_STYLE);
    expect(fetched.length).toBe(fetchesBefore);

    // …and the scene survived it. FakeMap.load() cleared all three buckets,
    // and its addLayer/setPaintProperty guards would have thrown on a
    // half-restored style, so equality here is the real check.
    expect(map.sources).toEqual(sourcesAfterSetup);
    expect(map.layers).toEqual(layersAfterSetup);
    expect(map.images.map((i) => i.id)).toEqual(imageIdsAfterSetup);
    // Group composite re-asserted after the rebuild (it lives on the
    // Renderer, not the Style, but the backend's dedup cache must not drift).
    expect(map.groupComposites.length).toBeGreaterThan(1);

    // Later frames on clip-b hold the swapped style — no thrash.
    await render(span.endMs);
    await render(payload.timeline.totalDurationMs - 1);
    expect(map.loads).toHaveLength(2);

    await backend.shutdown();
  });

  it("a default→'3d' swap reloads and brings the buildings layer with it", async () => {
    // default and 3d share the style URL, so a backend comparing STYLES
    // rather than styleIds would miss this entirely — and the 3D buildings
    // layer would never appear in the export.
    const { payload, indexedRoute, span } = fixture('3d');
    const { backend, map, fetched } = await bootBackend(payload);
    expect(map.layers).not.toContain('3d-buildings');
    const fetchesBefore = fetched.length;

    await backend.renderFrame(
      buildFramePayload(payload, indexedRoute, span.cutMs) as FramePayload,
      0,
    );
    expect(map.loads).toHaveLength(2);
    // The buildings layer is the FIRST thing applyScene adds, so it sits
    // beneath the whole decoration stack — same order as MapView.
    expect(map.layers[0]).toBe('3d-buildings');
    // Shared URL ⇒ shared parse: no second style fetch.
    expect(fetched.length).toBe(fetchesBefore);
    await backend.shutdown();
  });

  it('recycle rebuilds on the basemap the export is mid-way through', async () => {
    // The orchestrator recycles every 60 frames. Rebuilding on the PROJECT
    // default there would load + populate a basemap the very next frame
    // discards — once per recycle cycle, for the whole of any overriding
    // clip.
    const { payload, indexedRoute, span } = fixture('satellite');
    const { backend, maps, map } = await bootBackend(payload);
    await backend.renderFrame(
      buildFramePayload(payload, indexedRoute, span.cutMs) as FramePayload,
      0,
    );
    expect(map.loads).toHaveLength(2);

    await backend.recycle();
    expect(maps).toHaveLength(2);
    const recycled = maps[1];
    expect(map.released).toBe(true);
    // One load on the fresh map, and it is the satellite style — not the
    // project default followed by a swap.
    expect(recycled.loads).toEqual([SATELLITE_STYLE]);

    await backend.renderFrame(
      buildFramePayload(payload, indexedRoute, span.endMs) as FramePayload,
      1,
    );
    expect(recycled.loads).toHaveLength(1);
    await backend.shutdown();
  });

  it('never reloads when no clip overrides the style', async () => {
    const { payload, indexedRoute, span } = fixture();
    const { backend, map } = await bootBackend(payload);
    let index = 0;
    for (const t of [0, span.startMs, span.cutMs, span.endMs]) {
      await backend.renderFrame(
        buildFramePayload(payload, indexedRoute, t) as FramePayload,
        index++,
      );
    }
    expect(map.loads).toHaveLength(1);
    await backend.shutdown();
  });

  it('the swap frame seeds the dynamic sources from THAT frame, not the setup placeholder', async () => {
    const { payload, indexedRoute, span } = fixture('satellite');
    const { backend, map } = await bootBackend(payload);
    const frame = buildFramePayload(
      payload,
      indexedRoute,
      span.cutMs,
    ) as FramePayload;
    await backend.renderFrame(frame, 0);
    expect(map.loads).toHaveLength(2);

    // The frame's own live-marker + route-trail data must be what went back
    // into the rebuilt style. Re-seeding from the setup placeholder instead
    // would render one marker-less, trail-less frame at every style cut.
    const framePoint = frame.sources.find(([id]) => id === 'live-marker')![1] as {
      features: unknown[];
    };
    expect(framePoint.features.length).toBeGreaterThan(0);
    const seededPoint = map.sourceSpecs.get('live-marker')!.data as {
      features: unknown[];
    };
    expect(seededPoint).toEqual(framePoint);
    // route-trail rides the same path. This fixture is route mode 'full', so
    // the frame's trail is the degenerate empty LineString, which the native
    // boundary normalizes to an empty FeatureCollection (port contract 3) —
    // pinned in that normalized form rather than skipped.
    const frameTrail = frame.sources.find(([id]) => id === 'route-trail')![1] as {
      geometry: { coordinates: unknown[] };
    };
    expect(frameTrail.geometry.coordinates).toHaveLength(0);
    expect(map.sourceSpecs.get('route-trail')!.data).toEqual({
      type: 'FeatureCollection',
      features: [],
    });
    // route-full carries no per-frame data, so it keeps the static seed.
    expect(map.sourceSpecs.get('route-full')!.data).toEqual(
      buildStaticScene(payload).staticSources.find(
        ([id]) => id === 'route-full',
      )![1].data,
    );

    // …and the dedup cache agrees, so the refresh immediately after the
    // rebuild finds nothing to change (no layer churn).
    const layersAfterSwap = [...map.layers];
    await backend.renderFrame(frame, 1);
    expect(map.loads).toHaveLength(2);
    expect(map.layers).toEqual(layersAfterSwap);
    await backend.shutdown();
  });
});
