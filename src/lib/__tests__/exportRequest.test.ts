// Pure-builder tests for `exportRequest.ts`.
//
// Invariants worth pinning here: layout fallback to `defaultLayout`, parity
// of `resolved` with what Rust will recompute, opaque pass-through of
// project state, and that the IPC envelope keys match the Rust shape.

import { describe, it, expect } from 'vitest';
import { buildExportRequest, pickLayout } from '../exportRequest';
import {
  defaultLayout,
  defaultPipLayout,
  defaultSplitLayout,
  resolveSlots,
} from '../layout';
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
  fps: 30,
  outputPath: '/tmp/out.mov',
  aspect: '9_16' as const,
  clips: [makeClip()],
  route: makeRoute(),
  mapSettings: DEFAULT_MAP_SETTINGS satisfies MapSettings,
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
