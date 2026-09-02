// WS9 — useMediaImport tests covering the import-flow contract that the
// QA review caught issues with:
//
//   - Initial proxy for a D-Log clip must route through
//     `regenerate_proxy_for_class` (the class-aware path), not
//     `generate_proxy` (auto-detect). Otherwise the first frame the user
//     sees is rendered as SDR for an entire log clip.
//   - `buildPresetOverrides` correctly maps preset camera keys to override
//     entries.
//   - The source-format dialog is gated on `suggested_log_class`: when
//     no clip has a suggestion, the dialog must NOT open (QA important
//     #10). Presets, if any, are applied silently in that case.

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildPresetOverrides,
  useMediaImport,
} from '../useMediaImport';
import type { CameraPreset, Clip, ClipGroup, ClipMetadata, Route, Waypoint } from '../../types';
import { newClipFromMetadata } from '../../utils/clips';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class<T> {
    onmessage: ((ev: T) => void) | null = null;
  },
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

function metaFixture(over: Partial<ClipMetadata> = {}): ClipMetadata {
  return {
    id: 'm1',
    path: '/tmp/m1.mov',
    filename: 'm1.mov',
    created_at: '2026-01-01T00:00:00Z',
    duration_ms: 1000,
    gps: null,
    resolution: null,
    frame_rate: null,
    pix_fmt: null,
    color_primaries: null,
    color_trc: null,
    color_space: null,
    color_range: null,
    has_dolby_vision: false,
    camera_make: null,
    camera_model: null,
    source_color_class: 'sdr_bt709',
    ...over,
  };
}

interface HookHarness {
  clips: Clip[];
  waypoints: Waypoint[];
  clipGroups: ClipGroup[];
  selectedClipId: string | null;
  route: Route | null;
}

/** Wrap `useMediaImport` with simple `useState`-backed setters so the
 *  test can read the resulting state without juggling external stores. */
function harness(projectDir: string | null) {
  const captured: HookHarness = {
    clips: [],
    waypoints: [],
    clipGroups: [],
    selectedClipId: null,
    route: null,
  };
  const setClips: React.Dispatch<React.SetStateAction<Clip[]>> = (action) => {
    captured.clips = typeof action === 'function' ? (action as (prev: Clip[]) => Clip[])(captured.clips) : action;
  };
  const setWaypoints: React.Dispatch<React.SetStateAction<Waypoint[]>> = (action) => {
    captured.waypoints =
      typeof action === 'function' ? (action as (prev: Waypoint[]) => Waypoint[])(captured.waypoints) : action;
  };
  const setClipGroups: React.Dispatch<React.SetStateAction<ClipGroup[]>> = (action) => {
    captured.clipGroups =
      typeof action === 'function' ? (action as (prev: ClipGroup[]) => ClipGroup[])(captured.clipGroups) : action;
  };
  const setSelectedClipId: React.Dispatch<React.SetStateAction<string | null>> = (action) => {
    captured.selectedClipId =
      typeof action === 'function'
        ? (action as (prev: string | null) => string | null)(captured.selectedClipId)
        : action;
  };
  const setRoute: React.Dispatch<React.SetStateAction<Route | null>> = (action) => {
    captured.route = typeof action === 'function' ? (action as (prev: Route | null) => Route | null)(captured.route) : action;
  };

  const rendered = renderHook(() =>
    useMediaImport({
      projectDir,
      // Read at render time: tests that seed `captured.clips` must
      // `rendered.rerender()` so the hook's clips ref picks it up.
      clips: captured.clips,
      setClips,
      setSelectedClipId,
      setRoute,
      setWaypoints,
      setClipGroups,
    }),
  );

  return { rendered, captured };
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe('buildPresetOverrides', () => {
  it('returns an empty map when no presets', () => {
    const overrides = buildPresetOverrides([metaFixture()], []);
    expect(overrides.size).toBe(0);
  });

  it('matches presets by (make, model) and emits override per matching clip', () => {
    const a = metaFixture({ id: 'a', camera_make: 'DJI', camera_model: 'Mavic 3' });
    const b = metaFixture({ id: 'b', camera_make: 'DJI', camera_model: 'Mavic 3' });
    const c = metaFixture({ id: 'c', camera_make: 'Apple', camera_model: 'iPhone 15 Pro' });
    const presets: CameraPreset[] = [
      { make: 'DJI', model: 'Mavic 3', color_class: 'd_log' },
    ];
    const overrides = buildPresetOverrides([a, b, c], presets);
    expect(overrides.get('a')).toBe('d_log');
    expect(overrides.get('b')).toBe('d_log');
    expect(overrides.has('c')).toBe(false);
  });

  it('skips clips with missing make/model', () => {
    // The Unknown bucket can't possibly match a preset — guard against
    // a future bug where empty strings accidentally collide.
    const noMake = metaFixture({ id: 'u', camera_make: null, camera_model: null });
    const overrides = buildPresetOverrides(
      [noMake],
      [{ make: '', model: '', color_class: 'd_log' }],
    );
    expect(overrides.size).toBe(0);
  });
});

describe('useMediaImport — initial proxy routes via class-aware path', () => {
  it('confirming a D-Log group at import generates the initial proxy with regenerate_proxy_for_class', async () => {
    // Simulate the WS9 dialog confirming D-Log for a DJI Mavic clip.
    // `_finalizeImport` applies the override to the staged metadata BEFORE
    // generateProxiesAndThumbnails runs, so the first proxy invocation
    // must hit `regenerate_proxy_for_class` with `colorClass: 'd_log'`.
    // A naïve `generate_proxy` call here would re-probe the file, see
    // plain bt709, and render the proxy as SDR for the entire clip.
    const projectDir = '/tmp/proj.trailcut';
    const { rendered } = harness(projectDir);
    invokeMock.mockResolvedValue('/tmp/proj.trailcut/proxies/x.mp4');

    const overrides = new Map<string, 'd_log' | null>([['djic1', 'd_log']]);
    // Seed a pending import manually by calling the internal flow path.
    // We mimic what `importPaths` would do after the dialog opened: set
    // pending, then call confirmPendingImport. Easier here to drive the
    // public surface directly via `importPaths`.
    // First call: `import_media` returns one Mavic clip with a suggestion.
    invokeMock.mockImplementationOnce(async (cmd: string) => {
      expect(cmd).toBe('import_media');
      return [
        metaFixture({
          id: 'djic1',
          path: '/tmp/dji.mov',
          camera_make: 'DJI',
          camera_model: 'Mavic 3',
          source_color_class: 'sdr_bt709',
          suggested_log_class: 'd_log',
        }),
      ];
    });
    // Second call: `get_camera_presets` returns empty.
    invokeMock.mockImplementationOnce(async (cmd: string) => {
      expect(cmd).toBe('get_camera_presets');
      return [];
    });

    // Kick off the import. The dialog will be staged (because the clip
    // has a suggestion), but the test drives the confirm path directly.
    await act(async () => {
      // `importPaths` is hook-internal; the public surface uses
      // `handleImportFiles`/`handleImportFolder`. We can drive
      // `confirmPendingImport` once pending state lands.
      // Simpler: call the file-picker entry once we mock dialog.open.
      // For clarity, drive through `importPaths` via the exposed
      // `handleImportFolder` — but that calls `open()` from
      // `@tauri-apps/plugin-dialog`, which is mocked. Stub it.
      const dialogModule = await import('@tauri-apps/plugin-dialog');
      (dialogModule.open as ReturnType<typeof vi.fn>).mockResolvedValue('/tmp/folder');
      await rendered.result.current.handleImportFolder();
    });

    // After the import, pendingImportClips should be set (the dialog
    // would now be visible). Confirm with the D-Log override.
    expect(rendered.result.current.pendingImportClips?.clips).toHaveLength(1);

    // Subsequent invocations: thumbnail + proxy. Track which proxy
    // command name fires.
    invokeMock.mockReset();
    invokeMock.mockResolvedValue('/tmp/proxies/djic1.mp4');

    await act(async () => {
      await rendered.result.current.confirmPendingImport(overrides, []);
    });

    await waitFor(() => {
      // generate_thumbnail and regenerate_proxy_for_class both fire.
      const cmds = invokeMock.mock.calls.map((args) => args[0] as string);
      expect(cmds).toContain('regenerate_proxy_for_class');
      // Critically: NOT the auto-detect path.
      expect(cmds).not.toContain('generate_proxy');
    });

    // Inspect the regenerate_proxy_for_class call — must carry the D-Log
    // class derived from `effectiveSourceClass(clip)`.
    const regenCall = invokeMock.mock.calls.find(
      (args) => args[0] === 'regenerate_proxy_for_class',
    );
    expect(regenCall).toBeDefined();
    const payload = regenCall![1] as { sourcePath: string; projectDir: string; colorClass: string };
    expect(payload.colorClass).toBe('d_log');
    expect(payload.sourcePath).toBe('/tmp/dji.mov');
  });

  it('clips without override use cache-friendly generate_proxy at import', async () => {
    // The auto-detected SDR/HDR path keeps using `generate_proxy` so the
    // cache short-circuit fires on re-open (we don't want to re-render
    // 50 proxies every time the user opens a project).
    const projectDir = '/tmp/proj.trailcut';
    const { rendered } = harness(projectDir);

    // One clip, no suggestion → dialog must be skipped (bonus fix #10),
    // import goes straight through with empty preset map.
    invokeMock.mockImplementationOnce(async () => [
      metaFixture({
        id: 'iphone1',
        path: '/tmp/iphone.mov',
        camera_make: 'Apple',
        camera_model: 'iPhone 15 Pro',
        source_color_class: 'hlg_bt2020',
      }),
    ]);
    invokeMock.mockImplementationOnce(async () => []); // get_camera_presets
    invokeMock.mockResolvedValue('/tmp/proxies/iphone1.mp4');

    await act(async () => {
      const dialogModule = await import('@tauri-apps/plugin-dialog');
      (dialogModule.open as ReturnType<typeof vi.fn>).mockResolvedValue('/tmp/folder');
      await rendered.result.current.handleImportFolder();
    });

    await waitFor(() => {
      const cmds = invokeMock.mock.calls.map((args) => args[0] as string);
      expect(cmds).toContain('generate_proxy');
    });
    // No override, so the class-aware path must not fire for this case.
    const cmds = invokeMock.mock.calls.map((args) => args[0] as string);
    expect(cmds).not.toContain('regenerate_proxy_for_class');
  });
});

describe('useMediaImport — dialog gating on suggested_log_class (QA #10)', () => {
  it('does NOT open the dialog when no clip has a suggested_log_class', async () => {
    // QA finding: a pure SDR/HDR batch shouldn't pop a "Confirm source
    // formats" dialog — there's nothing log-related to confirm. The
    // import should land directly with auto-detected classes.
    const projectDir = '/tmp/proj.trailcut';
    const { rendered, captured } = harness(projectDir);

    invokeMock.mockImplementationOnce(async () => [
      metaFixture({
        id: 'iphone1',
        path: '/tmp/iphone.mov',
        camera_make: 'Apple',
        camera_model: 'iPhone 15 Pro',
        source_color_class: 'hlg_bt2020',
      }),
      metaFixture({
        id: 'iphone2',
        path: '/tmp/iphone2.mov',
        camera_make: 'Apple',
        camera_model: 'iPhone 15 Pro',
        source_color_class: 'hlg_bt2020',
      }),
    ]);
    invokeMock.mockImplementationOnce(async () => []); // presets
    invokeMock.mockResolvedValue('/tmp/proxies/x.mp4');

    await act(async () => {
      const dialogModule = await import('@tauri-apps/plugin-dialog');
      (dialogModule.open as ReturnType<typeof vi.fn>).mockResolvedValue('/tmp/folder');
      await rendered.result.current.handleImportFolder();
    });

    // Dialog must not be staged.
    expect(rendered.result.current.pendingImportClips).toBeNull();
    // Clips must have landed directly.
    expect(captured.clips).toHaveLength(2);
    // Neither clip has an override (auto-detected SDR/HDR wins).
    expect(captured.clips[0].user_color_class_override).toBeUndefined();
    expect(captured.clips[1].user_color_class_override).toBeUndefined();
  });

  it('opens the dialog when at least one clip has a suggested_log_class', async () => {
    const projectDir = '/tmp/proj.trailcut';
    const { rendered, captured } = harness(projectDir);

    invokeMock.mockImplementationOnce(async () => [
      metaFixture({
        id: 'iphone1',
        path: '/tmp/iphone.mov',
        camera_make: 'Apple',
        camera_model: 'iPhone 15 Pro',
        source_color_class: 'hlg_bt2020',
      }),
      metaFixture({
        id: 'mavic1',
        path: '/tmp/mavic.mov',
        camera_make: 'DJI',
        camera_model: 'Mavic 3',
        suggested_log_class: 'd_log',
      }),
    ]);
    invokeMock.mockImplementationOnce(async () => []); // presets

    await act(async () => {
      const dialogModule = await import('@tauri-apps/plugin-dialog');
      (dialogModule.open as ReturnType<typeof vi.fn>).mockResolvedValue('/tmp/folder');
      await rendered.result.current.handleImportFolder();
    });

    // Dialog staged with both clips (so the user sees the whole batch in
    // context, not just the suggested one).
    expect(rendered.result.current.pendingImportClips?.clips).toHaveLength(2);
    // Clips not yet promoted to state — they're waiting on the dialog.
    expect(captured.clips).toHaveLength(0);
  });

  it('silently applies matching presets when dialog is skipped due to no suggestions', async () => {
    // Edge case: no log suggestion but a preset matches. The preset
    // represents a prior user opt-in via "Remember", so applying it
    // without re-prompting matches the contract. The proxy invocation
    // for the matched clip must go through the class-aware path so the
    // preset's declared class drives the initial render.
    const projectDir = '/tmp/proj.trailcut';
    const { rendered, captured } = harness(projectDir);

    invokeMock.mockImplementationOnce(async () => [
      metaFixture({
        id: 'mavic1',
        path: '/tmp/mavic.mov',
        camera_make: 'DJI',
        camera_model: 'Mavic 3',
        source_color_class: 'sdr_bt709',
        // No suggestion — but a preset exists below.
      }),
    ]);
    invokeMock.mockImplementationOnce(async () => [
      { make: 'DJI', model: 'Mavic 3', color_class: 'd_log' } as CameraPreset,
    ]);
    invokeMock.mockResolvedValue('/tmp/proxies/x.mp4');

    await act(async () => {
      const dialogModule = await import('@tauri-apps/plugin-dialog');
      (dialogModule.open as ReturnType<typeof vi.fn>).mockResolvedValue('/tmp/folder');
      await rendered.result.current.handleImportFolder();
    });

    // No dialog.
    expect(rendered.result.current.pendingImportClips).toBeNull();
    // Clip landed with the preset override applied.
    expect(captured.clips).toHaveLength(1);
    expect(captured.clips[0].user_color_class_override).toBe('d_log');

    // Initial proxy must have used the class-aware path so the D-Log
    // ingest chain drives the first frame.
    await waitFor(() => {
      const cmds = invokeMock.mock.calls.map((args) => args[0] as string);
      expect(cmds).toContain('regenerate_proxy_for_class');
    });
    const regen = invokeMock.mock.calls.find((args) => args[0] === 'regenerate_proxy_for_class');
    expect((regen![1] as { colorClass: string }).colorClass).toBe('d_log');
  });
});

describe('useMediaImport — clip groups re-normalize against the post-merge order', () => {
  // Phase B integrity (docs/CLIP_GROUPS_HANDOFF.md §1, "Import re-sort"):
  // `mergeClips` re-sorts chronologically, so a group's run can be
  // interleaved by an import. The single policy splits/dissolves it — never
  // silently absorbs the newcomer.
  function seedGroupedClips(captured: HookHarness) {
    captured.clips = [
      newClipFromMetadata(metaFixture({ id: 'a', path: '/tmp/a.mov', created_at: '2026-01-01T00:00:01Z' })),
      newClipFromMetadata(metaFixture({ id: 'c', path: '/tmp/c.mov', created_at: '2026-01-01T00:00:03Z' })),
    ];
    captured.clipGroups = [{ id: 'g1', clip_ids: ['a', 'c'] }];
  }

  async function importOne(rendered: ReturnType<typeof harness>['rendered'], meta: ClipMetadata) {
    invokeMock.mockImplementationOnce(async () => [meta]);
    invokeMock.mockImplementationOnce(async () => []); // presets
    invokeMock.mockResolvedValue('/tmp/proxies/x.mp4');
    await act(async () => {
      const dialogModule = await import('@tauri-apps/plugin-dialog');
      (dialogModule.open as ReturnType<typeof vi.fn>).mockResolvedValue('/tmp/folder');
      await rendered.result.current.handleImportFolder();
    });
  }

  it('dissolves a group whose run an import interleaves', async () => {
    const { rendered, captured } = harness('/tmp/proj.trailcut');
    seedGroupedClips(captured);
    rendered.rerender();

    await importOne(rendered, metaFixture({ id: 'b', path: '/tmp/b.mov', created_at: '2026-01-01T00:00:02Z' }));

    expect(captured.clips.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    // a and c are no longer contiguous → two runs of 1 → both dissolve.
    expect(captured.clipGroups).toEqual([]);
  });

  it('keeps a group intact when the import lands outside its run', async () => {
    const { rendered, captured } = harness('/tmp/proj.trailcut');
    seedGroupedClips(captured);
    rendered.rerender();

    await importOne(rendered, metaFixture({ id: 'd', path: '/tmp/d.mov', created_at: '2026-01-01T00:00:04Z' }));

    expect(captured.clips.map((c) => c.id)).toEqual(['a', 'c', 'd']);
    expect(captured.clipGroups).toEqual([{ id: 'g1', clip_ids: ['a', 'c'] }]);
  });
});
