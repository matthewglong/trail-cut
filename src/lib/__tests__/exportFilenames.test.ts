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
  it('renders the mockup template for composite', () => {
    expect(deriveFilename('Hike2026', '9_16', 'composite', '1080p')).toBe(
      'hike2026__9x16__1080__composite.mp4',
    );
  });

  it('uses .mov + map-only token for map_only', () => {
    expect(deriveFilename('Hike2026', '4_5', 'map_only', '1080p')).toBe(
      'hike2026__4x5__1080__map-only.mov',
    );
  });

  it('uses .mov + video-only token for video_only', () => {
    expect(deriveFilename('Hike2026', '16_9', 'video_only', '2160p')).toBe(
      'hike2026__16x9__4k__video-only.mov',
    );
  });

  it('maps 2160p quality to the 4k token', () => {
    expect(deriveFilename('Hike', '9_16', 'composite', '2160p')).toContain('__4k__');
  });

  it('maps intermediate qualities to bare-number tokens', () => {
    expect(deriveFilename('Hike', '9_16', 'composite', '720p')).toContain('__720__');
    expect(deriveFilename('Hike', '9_16', 'composite', '1440p')).toContain('__1440__');
  });

  it('replaces underscore in aspect with x', () => {
    const f = deriveFilename('hike', '9_16', 'composite', '1080p');
    expect(f).toContain('9x16');
    expect(f).not.toContain('9_16');
  });

  it('applies slug fallback when project name is unrenderable', () => {
    expect(deriveFilename('', '9_16', 'composite', '1080p')).toBe(
      'trailcut-export__9x16__1080__composite.mp4',
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
    expect(job.outputPath).toBe('/Users/u/out/hike__9x16__1080__composite.mp4');
  });

  it('joins outputDir + filename without doubling slashes when outputDir trails with /', () => {
    const grid: ExportGrid = {
      cells: { '9_16-composite': [{ id: 'a', quality: '1080p', fps: 30 }] },
      output_dir: null,
    };
    const [job] = deriveJobs('Hike', '/Users/u/out/', grid);
    expect(job.outputPath).toBe('/Users/u/out/hike__9x16__1080__composite.mp4');
  });

  it('passes folder paths with spaces through verbatim', () => {
    const grid: ExportGrid = {
      cells: { '9_16-composite': [{ id: 'a', quality: '1080p', fps: 30 }] },
      output_dir: null,
    };
    const [job] = deriveJobs('Hike', '/Users/u/My Folder', grid);
    expect(job.outputPath).toBe('/Users/u/My Folder/hike__9x16__1080__composite.mp4');
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

  it('every job carries aspect, channel, quality, fps, and an outputPath', () => {
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
    expect(job.outputPath).toBe('/out/hike2026__9x16__4k__composite.mp4');
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
