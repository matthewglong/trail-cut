// Pure-builder tests for `exportRequest.ts`.
//
// Invariants worth pinning here: layout fallback to `defaultLayout`, parity
// of `resolved` with what Rust will recompute, opaque pass-through of
// project state, and that the IPC envelope keys match the Rust shape.

import { describe, it, expect } from 'vitest';
import {
  buildExportRequest,
  buildJobRequest,
  pickLayout,
  resolveFrameRate,
  type ExportRequestContext,
} from '../exportRequest';
import {
  defaultLayout,
  defaultPipLayout,
  defaultSplitLayout,
  resolveSlots,
} from '../layout';
import type { ExportJob } from '../exportFilenames';
import type { AspectRatio, Clip, MapSettings, Route, ProjectLayouts } from '../../types';
import { DEFAULT_MAP_SETTINGS } from '../../types';

function makeClip(): Clip {
  return {
    id: 'clip-a',
    path: '/dev/null/clip-a.mov',
    filename: 'clip-a.mov',
    created_at: '2024-06-01T12:00:00.000-07:00',
    duration_ms: 2000,
    gps: { lat: 37.7749, lng: -122.4194 },
    resolution: '1920x1080',
    frame_rate: 30,
    trim: { in_ms: 0, out_ms: 2000 },
    focal_point: { x: 0.5, y: 0.5, zoom: 1 },
    effects: { stabilize: { enabled: false, shakiness: 0 }, speed: 1 },
    visible: true,
    map_overrides: null,
    // WS0 color metadata defaults.
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
}

function makeRoute(): Route {
  return {
    source_path: '/dev/null/route.gpx',
    format: 'gpx',
    trackpoints: [
      { lat: 37.7749, lng: -122.4194, elevation: 50, timestamp: '2024-06-01T12:00:00.000-07:00' },
      { lat: 37.7755, lng: -122.4180, elevation: 55, timestamp: '2024-06-01T12:00:01.000-07:00' },
      { lat: 37.7760, lng: -122.4170, elevation: 60, timestamp: '2024-06-01T12:00:02.000-07:00' },
    ],
  };
}

const baseInputs = () => ({
  channel: 'map_only' as const,
  outputPath: '/tmp/out.mov',
  aspect: '9_16' as const,
  clips: [makeClip()],
  route: makeRoute(),
  mapSettings: DEFAULT_MAP_SETTINGS satisfies MapSettings,
  waypoints: [],
  transitionFeel: 'natural' as const,
});

describe('pickLayout', () => {
  it('falls back to defaultLayout when project has no layouts', () => {
    const layout = pickLayout(undefined, '9_16');
    expect(layout).toEqual(defaultLayout('9_16'));
  });

  it('falls back to defaultLayout when the aspect is null', () => {
    const layouts: ProjectLayouts = { '9_16': null, '16_9': null, '4_5': null };
    const layout = pickLayout(layouts, '9_16');
    expect(layout).toEqual(defaultLayout('9_16'));
  });

  it('returns the project layout when configured', () => {
    const custom = defaultLayout('16_9');
    const layouts: ProjectLayouts = { '9_16': null, '16_9': custom, '4_5': null };
    expect(pickLayout(layouts, '16_9')).toBe(custom);
  });
});

describe('buildExportRequest', () => {
  it('produces a payload whose resolved field matches resolveSlots', () => {
    const req = buildExportRequest(baseInputs());
    expect(req.layout.resolved).toEqual(
      resolveSlots(req.layout.layout, req.layout.aspect),
    );
  });

  it('emits the IPC envelope keys Rust expects', () => {
    const req = buildExportRequest(baseInputs());
    // Snake_case Rust shape: channel/fps/output_path/layout + flattened project state.
    expect(req).toHaveProperty('channel', 'map_only');
    expect(req).toHaveProperty('fps', 30);
    expect(req).toHaveProperty('output_path', '/tmp/out.mov');
    expect(req).toHaveProperty('layout');
    // Project state, opaque pass-through.
    expect(req).toHaveProperty('timeline');
    expect(req.timeline).toHaveProperty('totalDurationMs');
    expect(req).toHaveProperty('route');
    expect(req).toHaveProperty('clips');
    expect(req).toHaveProperty('mapSettings');
  });

  it('uses defaultLayout when the project layouts are missing', () => {
    const req = buildExportRequest(baseInputs());
    expect(req.layout.layout).toEqual(defaultLayout('9_16'));
  });

  it('respects the project layout override when present', () => {
    const inputs = {
      ...baseInputs(),
      layouts: {
        '9_16': defaultPipLayout('16_9'), // intentionally swapped
        '16_9': null,
        '4_5': null,
      } satisfies ProjectLayouts,
    };
    const req = buildExportRequest(inputs);
    expect(req.layout.layout).toEqual(defaultPipLayout('16_9'));
  });

  it('reads the stored layout, not a regenerated default (task 080)', () => {
    // Mutate a stored PiP 9:16 layout to a value the default factory would
    // never produce (`inset.x = 0.5` vs the default's 0.65). The export
    // request must round-trip *that* mutated value, proving the export reads
    // the project-bundle source of truth rather than rebuilding via
    // `pickLayout`'s fallback. This is the load-bearing assertion of 080:
    // if it's in the project on disk, it's what the export uses.
    const baseline = defaultPipLayout('9_16');
    const stored = {
      ...baseline,
      inset: { ...baseline.inset, x: 0.5 },
    };
    const inputs = {
      ...baseInputs(),
      layouts: {
        '9_16': stored,
        '16_9': null,
        '4_5': null,
      } satisfies ProjectLayouts,
    };
    const req = buildExportRequest(inputs);
    expect(req.layout.layout).toEqual(stored);
    if (req.layout.layout.mode !== 'pip') {
      throw new Error('built layout must remain PiP');
    }
    expect(req.layout.layout.inset.x).toBe(0.5);
    // And the resolved slot rect must reflect the mutated input — same
    // guard, one layer down, so a future "regenerate from default after
    // resolveSlots" regression fails here too.
    const expected = resolveSlots(stored, '9_16');
    expect(req.layout.resolved).toEqual(expected);
  });

  it('round-trips a video_only payload (channel passed through verbatim)', () => {
    // Task 070: the wire shape is identical between channels, only the
    // string differs. Rust dispatches on `req.channel.as_str()`. This pins
    // the string and asserts the project state needed by the video_only
    // branch (clips, layout, timeline) is in place.
    const inputs = { ...baseInputs(), channel: 'video_only' as const };
    const req = buildExportRequest(inputs);
    expect(req.channel).toBe('video_only');
    expect(req.layout.resolved).toEqual(
      resolveSlots(req.layout.layout, req.layout.aspect),
    );
    // The video_only Rust branch reads clips out of the flattened state.
    expect(Array.isArray(req.clips)).toBe(true);
    expect(req.clips.length).toBeGreaterThan(0);
    // Timeline is still required (validate_request reads totalDurationMs).
    expect(req.timeline).toHaveProperty('totalDurationMs');
  });

  it('round-trips a composite payload (channel passed through verbatim)', () => {
    // Task 090: Channel A is the deliverable — same wire shape as B/C,
    // only the channel string differs. The Rust composite branch reads
    // the same flattened project state plus the rawvideo input from the
    // orchestrator (no IPC change). This pins the string and asserts the
    // project state needed by the composite branch (clips, layout,
    // timeline) is in place.
    const inputs = { ...baseInputs(), channel: 'composite' as const };
    const req = buildExportRequest(inputs);
    expect(req.channel).toBe('composite');
    expect(req.layout.resolved).toEqual(
      resolveSlots(req.layout.layout, req.layout.aspect),
    );
    // The composite Rust branch reads clips out of the flattened state.
    expect(Array.isArray(req.clips)).toBe(true);
    expect(req.clips.length).toBeGreaterThan(0);
    // Timeline is still required (validate_request reads totalDurationMs).
    expect(req.timeline).toHaveProperty('totalDurationMs');
  });
});

describe('pickLayout — fully-seeded projects (task 100)', () => {
  // Acceptance: `pickLayout`'s fallback is cold for fully-seeded projects.
  // Post-100 fresh projects ship with all three aspects populated, so an
  // export against any aspect must read the seeded value, not synthesize
  // via `defaultLayout`.
  const seeded: ProjectLayouts = {
    '9_16': defaultPipLayout('9_16'),
    '4_5': defaultPipLayout('4_5'),
    '16_9': defaultPipLayout('16_9'),
  };
  const aspects: AspectRatio[] = ['9_16', '4_5', '16_9'];
  for (const aspect of aspects) {
    it(`${aspect}: returns the seeded value, not the fallback`, () => {
      const layout = pickLayout(seeded, aspect);
      expect(layout).toBe(seeded[aspect]);
    });
  }
});

describe('buildExportRequest — Phase 1 export-controls scaffolding', () => {
  // Phase 1 adds four new wire fields with sensible defaults. Existing callers
  // pass no new inputs; the compiled request must surface every new field
  // populated to its default. Phases 2/3/4 will consume them.
  it('populates new fields with defaults when no new inputs are passed', () => {
    const req = buildExportRequest(baseInputs());
    // resolution lives inside the layout descriptor (mirrors Rust's
    // LayoutDescriptor.resolution with `#[serde(default)]`).
    expect(req.layout).toHaveProperty('resolution', '1080p');
    // Top-level wire fields use snake_case to match the Rust serde shape.
    expect(req).toHaveProperty('codec_preference', 'auto');
    expect(req).toHaveProperty('audio_bitrate_kbps', 256);
    expect(req).toHaveProperty('fps', 30);
    // WS5: delivery_target on the wire. Default mirrors Rust's
    // `default_delivery_target` (= ProresMaster) so back-compat captures
    // deserialize identically on both sides.
    expect(req).toHaveProperty('delivery_target', 'prores');
    expect(req).toHaveProperty('warnings');
    expect(req.warnings).toEqual([]);
  });

  it('threads an explicit deliveryTarget onto the wire as delivery_target', () => {
    const req = buildExportRequest({
      ...baseInputs(),
      deliveryTarget: 'hdr_hlg',
    });
    expect(req.delivery_target).toBe('hdr_hlg');
  });
});

describe('buildExportRequest — Split-legality enforcement (task 100)', () => {
  // The validator at the IPC boundary rejects inverse-orientation Split
  // layouts. The configurator (110) constrains its swap toggle so the UI
  // can't produce these; this throw backstops file-level edits and IPC
  // tampering. Mirrors `validate_request` in `src-tauri/src/export/mod.rs`.
  it('throws on left-side video at 9:16', () => {
    const inputs = {
      ...baseInputs(),
      layouts: {
        '9_16': { mode: 'split', video_side: 'left', divider: 0.5 },
        '4_5': null,
        '16_9': null,
      } as ProjectLayouts,
    };
    expect(() => buildExportRequest(inputs)).toThrow(/inverse-orientation/);
  });

  it('throws on top-side video at 16:9', () => {
    const inputs = {
      ...baseInputs(),
      aspect: '16_9' as const,
      layouts: {
        '9_16': null,
        '4_5': null,
        '16_9': { mode: 'split', video_side: 'top', divider: 0.5 },
      } as ProjectLayouts,
    };
    expect(() => buildExportRequest(inputs)).toThrow(/inverse-orientation/);
  });

  it('accepts a legal split orientation per aspect', () => {
    for (const aspect of ['9_16', '4_5', '16_9'] as const) {
      const inputs = {
        ...baseInputs(),
        aspect,
        layouts: {
          '9_16': aspect === '9_16' ? defaultSplitLayout(aspect) : null,
          '4_5': aspect === '4_5' ? defaultSplitLayout(aspect) : null,
          '16_9': aspect === '16_9' ? defaultSplitLayout(aspect) : null,
        } as ProjectLayouts,
      };
      expect(() => buildExportRequest(inputs)).not.toThrow();
    }
  });
});

describe('resolveFrameRate — Phase 2 export-controls', () => {
  // Helper: build a visible clip with a given `frame_rate`. The other
  // fields don't matter for fps resolution, but they have to satisfy the
  // `Clip` type — clone from `makeClip` and override.
  const clipAt = (frameRate: number | null, visible = true): Clip => ({
    ...makeClip(),
    frame_rate: frameRate,
    visible,
  });

  describe('auto', () => {
    it('empty visible-clip list → fps 30, no warnings', () => {
      const result = resolveFrameRate({ kind: 'auto' }, []);
      expect(result.fps).toBe(30);
      expect(result.warnings).toEqual([]);
    });

    it('all clips report frame_rate: 30 → fps 30', () => {
      const result = resolveFrameRate(
        { kind: 'auto' },
        [clipAt(30), clipAt(30), clipAt(30)],
      );
      expect(result.fps).toBe(30);
      expect(result.warnings).toEqual([]);
    });

    it('mixed 30/60 sources → fps 60 (snap up to highest tier)', () => {
      const result = resolveFrameRate(
        { kind: 'auto' },
        [clipAt(30), clipAt(60), clipAt(30)],
      );
      expect(result.fps).toBe(60);
      expect(result.warnings).toEqual([]);
    });

    it('all clips at 24 → fps 24', () => {
      const result = resolveFrameRate(
        { kind: 'auto' },
        [clipAt(24), clipAt(24)],
      );
      expect(result.fps).toBe(24);
      expect(result.warnings).toEqual([]);
    });

    it('clips with frame_rate: undefined → fps 30 (missing-metadata fallback)', () => {
      // `Clip.frame_rate` is `number | null` on the wire; the helper treats
      // any non-numeric value (including missing) as "no source fps" and
      // falls back to the 30-fps default. Mixing `null` clips into a list
      // exercises the filter path.
      const result = resolveFrameRate(
        { kind: 'auto' },
        [clipAt(null), clipAt(null)],
      );
      expect(result.fps).toBe(30);
      expect(result.warnings).toEqual([]);
    });

    it('ignores invisible clips when computing max source fps', () => {
      // A 60-fps hidden clip mustn't pull the auto-resolved fps up to 60.
      // The visible-only filter is what makes the helper's contract sensible
      // for a user who's trimmed their timeline down to 30-fps sources.
      const result = resolveFrameRate(
        { kind: 'auto' },
        [clipAt(60, false), clipAt(30, true)],
      );
      expect(result.fps).toBe(30);
      expect(result.warnings).toEqual([]);
    });
  });

  describe('explicit', () => {
    it('fps 60 with all 30-fps sources → fps 60 + warning', () => {
      const result = resolveFrameRate(
        { kind: 'explicit', fps: 60 },
        [clipAt(30), clipAt(30)],
      );
      expect(result.fps).toBe(60);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(/exceeds max source fps 30/);
    });

    it('fps 30 with no visible clips → fps 30 + no warning', () => {
      // Empty / no-metadata sources don't gate explicit choices — the
      // warning is only meaningful when we actually know the source fps.
      const result = resolveFrameRate({ kind: 'explicit', fps: 30 }, []);
      expect(result.fps).toBe(30);
      expect(result.warnings).toEqual([]);
    });

    it('fps 30 with all 60-fps sources → fps 30 + no warning (downsampling is fine)', () => {
      const result = resolveFrameRate(
        { kind: 'explicit', fps: 30 },
        [clipAt(60), clipAt(60)],
      );
      expect(result.fps).toBe(30);
      expect(result.warnings).toEqual([]);
    });
  });
});

describe('buildExportRequest — Phase 2 frame rate plumbing', () => {
  // The builder must thread `frameRate` through `resolveFrameRate` and
  // surface the resolved `fps` + any warnings on the compiled wire shape.
  it('default (no frameRate input) → fps 30, no warnings', () => {
    const req = buildExportRequest(baseInputs());
    expect(req.fps).toBe(30);
    expect(req.warnings).toEqual([]);
  });

  it('auto + a 60-fps visible source → fps 60', () => {
    const inputs = {
      ...baseInputs(),
      clips: [{ ...makeClip(), frame_rate: 60 }],
      frameRate: { kind: 'auto' as const },
    };
    const req = buildExportRequest(inputs);
    expect(req.fps).toBe(60);
    expect(req.warnings).toEqual([]);
  });

  it('explicit fps 60 with 30-fps sources → fps 60 + warning surfaces on the wire', () => {
    const inputs = {
      ...baseInputs(),
      frameRate: { kind: 'explicit' as const, fps: 60 as const },
    };
    const req = buildExportRequest(inputs);
    expect(req.fps).toBe(60);
    expect(req.warnings).toHaveLength(1);
    expect(req.warnings[0]).toMatch(/exceeds max source fps 30/);
  });
});

describe('buildExportRequest — Phase 5 end-to-end controls plumbing', () => {
  // Integration coverage for the export-controls plan: a single
  // `buildExportRequest` call with every Phase 1–4 knob set to a non-default
  // value must surface every value on the compiled wire shape, with the right
  // snake_case keys and the right resolved layout dims. This is the load-bearing
  // assertion that Phase 1's wire-protocol additions, Phase 2's frame-rate
  // resolution, and Phase 4's resolution-aware `resolveSlots` all compose.
  it('threads resolution / codecPreference / audioBitrateKbps / frameRate-auto onto the wire', () => {
    // 60-fps source clip so `frameRate: { kind: 'auto' }` resolves to 60
    // (snaps up to the max source-fps tier).
    const sixtyFpsClip: Clip = { ...makeClip(), frame_rate: 60 };
    const inputs = {
      ...baseInputs(),
      // Keep 9:16 from baseInputs() — short edge for 2160p 9:16 is 2160,
      // long edge is trunc(2160 * 16 / 9) = 3840. Asserted below.
      clips: [sixtyFpsClip],
      resolution: '2160p' as const,
      codecPreference: 'h264' as const,
      audioBitrateKbps: 192,
      frameRate: { kind: 'auto' as const },
    };
    const req = buildExportRequest(inputs);

    // Top-level Phase 1/2/3 wire fields (snake_case to match Rust serde).
    expect(req.codec_preference).toBe('h264');
    expect(req.audio_bitrate_kbps).toBe(192);
    expect(req.fps).toBe(60); // Auto resolved against the 60-fps source.
    expect(req.warnings).toEqual([]); // No warnings for matched Auto.

    // Phase 4: resolution lives on the layout descriptor and drives the
    // resolved output dims. 9:16 @ 2160p → 2160×3840.
    expect(req.layout.resolution).toBe('2160p');
    expect(req.layout.resolved.output).toEqual({ w: 2160, h: 3840 });
  });
});

describe('buildJobRequest — per-job quality + fps', () => {
  // The grid-modal redesign queues per-cell exports that interleave multiple
  // resolutions and frame rates from a single editor state. `buildJobRequest`
  // is the per-job adapter: shared project context goes in once, then each
  // `ExportJob` carries its own quality + fps + aspect + channel. The wire
  // shape stays identical to `buildExportRequest`'s output.
  const ctx = (): ExportRequestContext => ({
    clips: [makeClip()],
    route: makeRoute(),
    mapSettings: DEFAULT_MAP_SETTINGS satisfies MapSettings,
    waypoints: [],
    transitionFeel: 'natural',
  });

  const job = (overrides: Partial<ExportJob> = {}): ExportJob => ({
    id: '9_16-map_only-1080p-30-prores-cfg-a',
    aspect: '9_16',
    channel: 'map_only',
    quality: '1080p',
    fps: 30,
    deliveryTarget: 'prores',
    outputPath: '/tmp/out.mov',
    ...overrides,
  });

  it('threads job.quality onto the wire as layout.resolution + resolved dims', () => {
    const req = buildJobRequest(ctx(), job({ quality: '2160p' }));
    expect(req.layout.resolution).toBe('2160p');
    // 9:16 @ 2160p: short edge 2160, long edge trunc(2160 * 16 / 9) = 3840.
    expect(req.layout.resolved.output).toEqual({ w: 2160, h: 3840 });
  });

  it('threads job.fps onto the wire-level fps (explicit choice)', () => {
    const req = buildJobRequest(ctx(), job({ fps: 60 }));
    expect(req.fps).toBe(60);
    // 30-fps source vs 60-fps explicit choice → warning fires (frames will
    // be duplicated). This pins that the per-job fps goes through the same
    // `resolveFrameRate` path as `buildExportRequest`'s `frameRate` input.
    expect(req.warnings).toHaveLength(1);
    expect(req.warnings[0]).toMatch(/exceeds max source fps 30/);
  });

  it('threads job.aspect / job.channel / job.outputPath verbatim', () => {
    const req = buildJobRequest(
      ctx(),
      job({ aspect: '16_9', channel: 'composite', outputPath: '/tmp/x.mov' }),
    );
    expect(req.layout.aspect).toBe('16_9');
    expect(req.channel).toBe('composite');
    expect(req.output_path).toBe('/tmp/x.mov');
  });

  it('threads context project state (clips / route / mapSettings) opaquely', () => {
    const context = ctx();
    const req = buildJobRequest(context, job());
    expect(req.clips).toBe(context.clips);
    expect(req.route).toBe(context.route);
    expect(req.mapSettings).toBe(context.mapSettings);
  });

  it('produces distinct requests from the same context for different jobs', () => {
    // The queue's invariant: one shared compile of project state, one per-job
    // adapter call. Two jobs from the same context must differ only by what
    // the job carries (quality, fps, aspect, channel, outputPath).
    const context = ctx();
    const a = buildJobRequest(
      context,
      job({ id: 'a', quality: '1080p', fps: 30, outputPath: '/tmp/a.mov' }),
    );
    const b = buildJobRequest(
      context,
      job({ id: 'b', quality: '2160p', fps: 60, outputPath: '/tmp/b.mov' }),
    );
    expect(a.layout.resolution).toBe('1080p');
    expect(b.layout.resolution).toBe('2160p');
    expect(a.fps).toBe(30);
    expect(b.fps).toBe(60);
    expect(a.output_path).toBe('/tmp/a.mov');
    expect(b.output_path).toBe('/tmp/b.mov');
  });

  it('threads job.deliveryTarget onto the wire as delivery_target', () => {
    const req = buildJobRequest(
      ctx(),
      job({ channel: 'composite', deliveryTarget: 'hdr_hlg' }),
    );
    expect(req.delivery_target).toBe('hdr_hlg');
  });

  it('honors the context layouts override for the job aspect', () => {
    // `pickLayout` runs against context.layouts; if the project has a stored
    // layout for the job's aspect, it must reach the wire. This pins that
    // per-job quality/fps don't bypass the layout-pick path.
    const stored = defaultPipLayout('16_9');
    const context: ExportRequestContext = {
      ...ctx(),
      layouts: { '9_16': null, '4_5': null, '16_9': stored },
    };
    const req = buildJobRequest(context, job({ aspect: '16_9' }));
    expect(req.layout.layout).toBe(stored);
  });
});

describe('buildExportRequest — marker library path resolution (schema v11)', () => {
  const IMAGE_A = {
    id: '0123456789abcdef',
    icon_file: 'assets/pov-icon-0123456789abcdef.png',
    source_file: 'assets/pov-source-0123456789abcdef.png',
    source_name: 'will.png',
    width: 300,
    height: 376,
  };
  const IMAGE_B = {
    id: 'fedcba9876543210',
    icon_file: 'assets/marker-icon-fedcba9876543210.png',
    source_file: 'assets/marker-source-fedcba9876543210.svg',
    source_name: 'flag.svg',
    width: 512,
    height: 512,
  };
  const withLibrary = (): MapSettings => ({
    ...DEFAULT_MAP_SETTINGS,
    marker_images: [IMAGE_A, IMAGE_B],
    pov: {
      ...DEFAULT_MAP_SETTINGS.pov,
      marker: { kind: 'image', image_id: IMAGE_A.id },
    },
  });

  it('injects an absolute asset path onto EVERY library entry of the wire copy only', () => {
    const inputs = { ...baseInputs(), mapSettings: withLibrary(), projectDir: '/Users/x/Hike.trailcut' };
    const req = buildExportRequest(inputs);
    expect(req.mapSettings.marker_images[0].path).toBe(
      '/Users/x/Hike.trailcut/assets/pov-icon-0123456789abcdef.png',
    );
    // Every entry gets a path — the sidecar decides what's referenced.
    expect(req.mapSettings.marker_images[1].path).toBe(
      '/Users/x/Hike.trailcut/assets/marker-icon-fedcba9876543210.png',
    );
    // Everything else on the refs survives verbatim.
    expect(req.mapSettings.marker_images[0].icon_file).toBe(IMAGE_A.icon_file);
    expect(req.mapSettings.marker_images[0].source_name).toBe('will.png');
    // The marker selection rides through untouched.
    expect(req.mapSettings.pov.marker).toEqual({
      kind: 'image',
      image_id: IMAGE_A.id,
    });
    // The INPUT settings object must not be mutated — `path` is a
    // wire-copy-only field (never lands in React state / persistence).
    expect(inputs.mapSettings.marker_images[0].path).toBeUndefined();
    expect(inputs.mapSettings.marker_images[1].path).toBeUndefined();
  });

  it('throws loudly when the library is non-empty but projectDir is missing', () => {
    expect(() =>
      buildExportRequest({ ...baseInputs(), mapSettings: withLibrary() }),
    ).toThrow(/marker_images is non-empty but no\s+projectDir/);
  });

  it('does not touch mapSettings when the library is empty', () => {
    const inputs = { ...baseInputs(), projectDir: '/Users/x/Hike.trailcut' };
    const req = buildExportRequest(inputs);
    expect(req.mapSettings).toBe(inputs.mapSettings);
    expect(req.mapSettings.marker_images).toEqual([]);
  });

  it('threads projectDir from the shared context through buildJobRequest', () => {
    const context: ExportRequestContext = {
      clips: [makeClip()],
      route: makeRoute(),
      mapSettings: withLibrary(),
      waypoints: [],
      projectDir: '/Users/x/Hike.trailcut',
    };
    const j: ExportJob = {
      id: 'job-1',
      aspect: '9_16',
      channel: 'composite',
      quality: '1080p',
      fps: 30,
      deliveryTarget: 'sdr_h265',
      outputPath: '/tmp/out.mp4',
      filename: 'out.mp4',
    } as unknown as ExportJob;
    const req = buildJobRequest(context, j);
    expect(req.mapSettings.marker_images[0].path).toBe(
      '/Users/x/Hike.trailcut/assets/pov-icon-0123456789abcdef.png',
    );
  });
});
