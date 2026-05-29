import { describe, it, expect } from 'vitest';
import {
  configsInCell,
  deriveFilename,
  deriveJobs,
  gridJobCount,
  slugifyProjectName,
} from '../exportFilenames';
import type { ExportGrid } from '../../types';

describe('slugifyProjectName', () => {
  it('lowercases ASCII names', () => {
    expect(slugifyProjectName('Hike2026')).toBe('hike2026');
  });

  it('replaces whitespace with single dashes', () => {
    expect(slugifyProjectName('My Hike Trip')).toBe('my-hike-trip');
  });

  it('collapses runs of separators', () => {
    expect(slugifyProjectName('My   Hike   Trip')).toBe('my-hike-trip');
  });

  it('drops emoji and unicode-punctuation entirely', () => {
    expect(slugifyProjectName('My Hike: 2026/04 🌲')).toBe('my-hike-2026-04');
  });

  it('drops punctuation and trims surrounding dashes', () => {
    expect(slugifyProjectName('!Hike?')).toBe('hike');
  });

  it('falls back when the slug would be empty', () => {
    expect(slugifyProjectName('')).toBe('trailcut-export');
    expect(slugifyProjectName('   ')).toBe('trailcut-export');
    expect(slugifyProjectName('!!!')).toBe('trailcut-export');
    expect(slugifyProjectName('🌲🏔️')).toBe('trailcut-export');
  });

  it('keeps digits adjacent to letters intact', () => {
    expect(slugifyProjectName('Hike 2026')).toBe('hike-2026');
    expect(slugifyProjectName('Trail-Cut 1.0')).toBe('trail-cut-1-0');
  });
});

describe('deriveFilename', () => {
  it('renders the mockup template for composite + sdr-h265', () => {
    expect(
      deriveFilename('Hike2026', '9_16', 'composite', '1080p', 'sdr_h265'),
    ).toBe('hike2026__9x16__1080__composite__sdr-h265.mp4');
  });

  it('uses .mov + prores token for map_only ProRes', () => {
    expect(
      deriveFilename('Hike2026', '4_5', 'map_only', '1080p', 'prores'),
    ).toBe('hike2026__4x5__1080__map-only__prores.mov');
  });

  it('uses .mov + prores token for video_only ProRes', () => {
    expect(
      deriveFilename('Hike2026', '16_9', 'video_only', '2160p', 'prores'),
    ).toBe('hike2026__16x9__4k__video-only__prores.mov');
  });

  it('uses .mp4 for the YouTube HDR target on composite', () => {
    expect(
      deriveFilename('Hike', '16_9', 'composite', '2160p', 'hdr_hlg'),
    ).toBe('hike__16x9__4k__composite__hdr-hlg.mp4');
  });

  it('uses .mov for ProRes master on composite (target overrides channel-default extension)', () => {
    // Pre-WS5 composite was always .mp4; WS5 ties extension to the target's
    // `containerExtension`, so composite + ProRes is .mov.
    expect(
      deriveFilename('Hike', '9_16', 'composite', '1080p', 'prores'),
    ).toBe('hike__9x16__1080__composite__prores.mov');
  });

  it('maps 2160p quality to the 4k token', () => {
    expect(
      deriveFilename('Hike', '9_16', 'composite', '2160p', 'sdr_h265'),
    ).toContain('__4k__');
  });

  it('maps intermediate qualities to bare-number tokens', () => {
    expect(
      deriveFilename('Hike', '9_16', 'composite', '720p', 'sdr_h265'),
    ).toContain('__720__');
    expect(
      deriveFilename('Hike', '9_16', 'composite', '1440p', 'sdr_h265'),
    ).toContain('__1440__');
  });

  it('replaces underscore in aspect with x', () => {
    const f = deriveFilename('hike', '9_16', 'composite', '1080p', 'sdr_h265');
    expect(f).toContain('9x16');
    expect(f).not.toContain('9_16');
  });

  it('applies slug fallback when project name is unrenderable', () => {
    expect(deriveFilename('', '9_16', 'composite', '1080p', 'sdr_h265')).toBe(
      'trailcut-export__9x16__1080__composite__sdr-h265.mp4',
    );
  });
});

describe('deriveJobs', () => {
  const emptyGrid: ExportGrid = { cells: {}, output_dir: null };

  it('returns no jobs when grid is empty', () => {
    expect(deriveJobs('Hike', '/out', emptyGrid)).toEqual([]);
  });

  it('walks cells in (aspect, channel) display order', () => {
    const grid: ExportGrid = {
      cells: {
        '9_16-composite': [{ id: 'a', quality: '1080p', fps: 30 }],
        '4_5-map_only': [{ id: 'b', quality: '1080p', fps: 30 }],
        '16_9-composite': [{ id: 'c', quality: '1080p', fps: 30 }],
      },
      output_dir: null,
    };
    const jobs = deriveJobs('Hike', '/out', grid);
    // Aspect order is ['16_9', '4_5', '9_16']; within a tier, cell-walk
    // order is preserved.
    expect(jobs.map((j) => `${j.aspect}-${j.channel}`)).toEqual([
      '16_9-composite',
      '4_5-map_only',
      '9_16-composite',
    ]);
  });

  it('sorts all jobs by quality tier (fastest first), preserving cell order within tier', () => {
    const grid: ExportGrid = {
      cells: {
        '9_16-composite': [
          { id: 'a', quality: '2160p', fps: 30 },
          { id: 'b', quality: '1080p', fps: 30 },
        ],
        '16_9-composite': [{ id: 'c', quality: '1080p', fps: 30 }],
      },
      output_dir: null,
    };
    const jobs = deriveJobs('Hike', '/out', grid);
    expect(jobs.map((j) => `${j.aspect}-${j.quality}`)).toEqual([
      '16_9-1080p',
      '9_16-1080p',
      '9_16-2160p',
    ]);
  });

  it('joins outputDir + filename with a single separator', () => {
    const grid: ExportGrid = {
      cells: { '9_16-composite': [{ id: 'a', quality: '1080p', fps: 30 }] },
      output_dir: null,
    };
    const [job] = deriveJobs('Hike', '/Users/u/out', grid);
    // composite chip without explicit delivery_target resolves to
    // sdr_h265 (channel default) → .mp4, sdr-h265 token.
    expect(job.outputPath).toBe(
      '/Users/u/out/hike__9x16__1080__composite__sdr-h265.mp4',
    );
  });

  it('joins outputDir + filename without doubling slashes when outputDir trails with /', () => {
    const grid: ExportGrid = {
      cells: { '9_16-composite': [{ id: 'a', quality: '1080p', fps: 30 }] },
      output_dir: null,
    };
    const [job] = deriveJobs('Hike', '/Users/u/out/', grid);
    expect(job.outputPath).toBe(
      '/Users/u/out/hike__9x16__1080__composite__sdr-h265.mp4',
    );
  });

  it('passes folder paths with spaces through verbatim', () => {
    const grid: ExportGrid = {
      cells: { '9_16-composite': [{ id: 'a', quality: '1080p', fps: 30 }] },
      output_dir: null,
    };
    const [job] = deriveJobs('Hike', '/Users/u/My Folder', grid);
    expect(job.outputPath).toBe(
      '/Users/u/My Folder/hike__9x16__1080__composite__sdr-h265.mp4',
    );
  });

  it('every job id is unique across a full 9-cell grid with 2 configs per cell', () => {
    const cells: ExportGrid['cells'] = {};
    const aspects = ['16_9', '4_5', '9_16'] as const;
    const channels = ['composite', 'map_only', 'video_only'] as const;
    for (const aspect of aspects) {
      for (const channel of channels) {
        cells[`${aspect}-${channel}`] = [
          { id: `${aspect}-${channel}-1`, quality: '1080p', fps: 30 },
          { id: `${aspect}-${channel}-2`, quality: '2160p', fps: 60 },
        ];
      }
    }
    const grid: ExportGrid = { cells, output_dir: null };
    const jobs = deriveJobs('Hike', '/out', grid);
    expect(jobs).toHaveLength(18);
    const ids = jobs.map((j) => j.id);
    expect(new Set(ids).size).toBe(18);
  });

  it('every job carries aspect, channel, quality, fps, deliveryTarget, and an outputPath', () => {
    const grid: ExportGrid = {
      cells: {
        '9_16-composite': [{ id: 'cfg', quality: '2160p', fps: 60 }],
      },
      output_dir: null,
    };
    const [job] = deriveJobs('Hike2026', '/out', grid);
    expect(job.aspect).toBe('9_16');
    expect(job.channel).toBe('composite');
    expect(job.quality).toBe('2160p');
    expect(job.fps).toBe(60);
    // No explicit delivery_target → composite default = sdr_h265.
    expect(job.deliveryTarget).toBe('sdr_h265');
    expect(job.outputPath).toBe(
      '/out/hike2026__9x16__4k__composite__sdr-h265.mp4',
    );
  });

  it('honors an explicit delivery_target on the chip', () => {
    const grid: ExportGrid = {
      cells: {
        '16_9-composite': [
          { id: 'a', quality: '2160p', fps: 30, delivery_target: 'hdr_hlg' },
        ],
      },
      output_dir: null,
    };
    const [job] = deriveJobs('Hike', '/out', grid);
    expect(job.deliveryTarget).toBe('hdr_hlg');
    expect(job.outputPath).toBe(
      '/out/hike__16x9__4k__composite__hdr-hlg.mp4',
    );
  });

  it('emits two distinct jobs when one cell holds two chips with different delivery targets', () => {
    // Acceptance criterion: "Multi-select works: picking TikTok + YouTube HDR
    // produces two output files." Two chips in the same cell, same
    // (quality, fps), different targets → two jobs with two filenames.
    const grid: ExportGrid = {
      cells: {
        '16_9-composite': [
          { id: 'a', quality: '1080p', fps: 30, delivery_target: 'sdr_h265' },
          { id: 'b', quality: '1080p', fps: 30, delivery_target: 'hdr_hlg' },
        ],
      },
      output_dir: null,
    };
    const jobs = deriveJobs('Hike', '/out', grid);
    expect(jobs).toHaveLength(2);
    // `.sort()` is lexicographic — `hdr_hlg` < `sdr_h265`.
    expect(jobs.map((j) => j.deliveryTarget).sort()).toEqual([
      'hdr_hlg',
      'sdr_h265',
    ]);
    const paths = jobs.map((j) => j.outputPath).sort();
    expect(paths).toEqual([
      '/out/hike__16x9__1080__composite__hdr-hlg.mp4',
      '/out/hike__16x9__1080__composite__sdr-h265.mp4',
    ]);
  });

  it('falls back to prores for map_only chips without explicit target', () => {
    const grid: ExportGrid = {
      cells: { '9_16-map_only': [{ id: 'a', quality: '1080p', fps: 30 }] },
      output_dir: null,
    };
    const [job] = deriveJobs('Hike', '/out', grid);
    expect(job.deliveryTarget).toBe('prores');
    expect(job.outputPath).toBe('/out/hike__9x16__1080__map-only__prores.mov');
  });
});

describe('gridJobCount', () => {
  it('returns 0 for an empty grid', () => {
    expect(gridJobCount({ cells: {}, output_dir: null })).toBe(0);
  });

  it('sums configs across all cells', () => {
    const grid: ExportGrid = {
      cells: {
        '9_16-composite': [
          { id: 'a', quality: '1080p', fps: 30 },
          { id: 'b', quality: '2160p', fps: 60 },
        ],
        '4_5-map_only': [{ id: 'c', quality: '1080p', fps: 30 }],
      },
      output_dir: null,
    };
    expect(gridJobCount(grid)).toBe(3);
  });
});

describe('configsInCell', () => {
  it('returns the configs in the given cell', () => {
    const grid: ExportGrid = {
      cells: { '9_16-composite': [{ id: 'a', quality: '1080p', fps: 30 }] },
      output_dir: null,
    };
    expect(configsInCell(grid, '9_16', 'composite')).toEqual([
      { id: 'a', quality: '1080p', fps: 30 },
    ]);
  });

  it('returns [] when the cell has no entry', () => {
    expect(configsInCell({ cells: {}, output_dir: null }, '9_16', 'composite')).toEqual([]);
  });
});

describe('deriveFilename — full token matrix', () => {
  // Pin every (aspect, channel, quality) combination against the channel-
  // default delivery target. WS5 ties the extension to the target, not the
  // channel, so composite cases use the sdr_h265 default (mp4 +
  // sdr-h265 token) and map_only/video_only use prores
  // (mov + prores token).
  const aspects = [
    ['9_16', '9x16'],
    ['4_5', '4x5'],
    ['16_9', '16x9'],
  ] as const;
  const channels = [
    ['composite', 'composite', 'mp4', 'sdr_h265', 'sdr-h265'],
    ['map_only', 'map-only', 'mov', 'prores', 'prores'],
    ['video_only', 'video-only', 'mov', 'prores', 'prores'],
  ] as const;
  const qualities = [
    ['720p', '720'],
    ['1080p', '1080'],
    ['1440p', '1440'],
    ['2160p', '4k'],
  ] as const;

  for (const [aspect, aspectTok] of aspects) {
    for (const [channel, channelTok, ext, target, targetTok] of channels) {
      for (const [quality, qualityTok] of qualities) {
        it(`${aspect} · ${channel} · ${quality} · ${target} → __${aspectTok}__${qualityTok}__${channelTok}__${targetTok}.${ext}`, () => {
          expect(deriveFilename('Hike', aspect, channel, quality, target)).toBe(
            `hike__${aspectTok}__${qualityTok}__${channelTok}__${targetTok}.${ext}`,
          );
        });
      }
    }
  }
});

describe('deriveFilename — fps invariant', () => {
  // fps differences within a cell are blocked by the duplicate-disable rule
  // in the secondary modal, so fps doesn't need to live in the filename. The
  // schema comment in exportFilenames.ts spells this out; the test pins it
  // so a regression that re-introduces fps in the token list trips here.
  it('fps does not appear in the filename', () => {
    const f = deriveFilename('Hike', '9_16', 'composite', '1080p', 'sdr_h265');
    for (const fps of ['24', '30', '60']) {
      expect(f.includes(fps)).toBe(false);
    }
  });
});

describe('deriveJobs — job id schema', () => {
  // Per-job id format:
  // `${aspect}-${channel}-${quality}-${fps}-${delivery_target}-${config.id}`.
  // The trailing config.id keeps ids unique when two chips in the same cell
  // share (quality, fps, delivery_target) mid-edit.
  it('id encodes aspect-channel-quality-fps-target-config.id', () => {
    const grid: ExportGrid = {
      cells: { '9_16-composite': [{ id: 'cfg-x', quality: '1080p', fps: 30 }] },
      output_dir: null,
    };
    const [job] = deriveJobs('Hike', '/out', grid);
    expect(job.id).toBe('9_16-composite-1080p-30-sdr_h265-cfg-x');
  });

  it('keeps ids distinct when two chips share (quality, fps, target) in the same cell', () => {
    // The grid model technically forbids this (the secondary modal disables
    // duplicate tuples in add mode), but the chip-edit-mid-stream race
    // could produce it transiently. The id trailing config.id keeps the
    // queue safe.
    const grid: ExportGrid = {
      cells: {
        '9_16-composite': [
          { id: 'cfg-a', quality: '1080p', fps: 30 },
          { id: 'cfg-b', quality: '1080p', fps: 30 },
        ],
      },
      output_dir: null,
    };
    const jobs = deriveJobs('Hike', '/out', grid);
    expect(jobs.map((j) => j.id)).toEqual([
      '9_16-composite-1080p-30-sdr_h265-cfg-a',
      '9_16-composite-1080p-30-sdr_h265-cfg-b',
    ]);
  });
});

describe('deriveJobs — stable sort within quality tier', () => {
  // Sort is by quality tier only; within a tier the cell-walk order
  // (aspect-row × channel-col) is preserved. A stable sort is the contract;
  // pin it so a future swap to a non-stable algorithm (or comparator change)
  // doesn't silently re-order the queue.
  it('three composite-1080p configs across aspects keep aspect-walk order', () => {
    const grid: ExportGrid = {
      cells: {
        '9_16-composite': [{ id: 'last', quality: '1080p', fps: 30 }],
        '4_5-composite': [{ id: 'mid', quality: '1080p', fps: 30 }],
        '16_9-composite': [{ id: 'first', quality: '1080p', fps: 30 }],
      },
      output_dir: null,
    };
    const jobs = deriveJobs('Hike', '/out', grid);
    expect(jobs.map((j) => j.aspect)).toEqual(['16_9', '4_5', '9_16']);
  });

  it('mixed-quality cell preserves config order within tier after sort', () => {
    // Within the 1080p tier the user added cfg-second first, cfg-fourth
    // later; the sort must preserve that.
    const grid: ExportGrid = {
      cells: {
        '16_9-composite': [
          { id: 'cfg-first', quality: '720p', fps: 30 },
          { id: 'cfg-second', quality: '1080p', fps: 30 },
          { id: 'cfg-third', quality: '720p', fps: 60 },
          { id: 'cfg-fourth', quality: '1080p', fps: 60 },
        ],
      },
      output_dir: null,
    };
    const jobs = deriveJobs('Hike', '/out', grid);
    // 720 tier first, in original order; then 1080 tier, in original order.
    // Each id now carries the resolved delivery target (composite default =
    // sdr_h265).
    expect(jobs.map((j) => j.id)).toEqual([
      '16_9-composite-720p-30-sdr_h265-cfg-first',
      '16_9-composite-720p-60-sdr_h265-cfg-third',
      '16_9-composite-1080p-30-sdr_h265-cfg-second',
      '16_9-composite-1080p-60-sdr_h265-cfg-fourth',
    ]);
  });
});
