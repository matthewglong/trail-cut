import { describe, it, expect } from 'vitest';
import {
  deriveFilename,
  deriveJobs,
  slugifyProjectName,
} from '../exportFilenames';
import type { ExportSelection } from '../../types';

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
  it('uses .mp4 for composite', () => {
    expect(deriveFilename('Hike2026', '9_16', 'composite')).toBe(
      'hike2026-9_16-composite.mp4',
    );
  });

  it('uses .mov for map_only', () => {
    expect(deriveFilename('Hike2026', '4_5', 'map_only')).toBe(
      'hike2026-4_5-map_only.mov',
    );
  });

  it('uses .mov for video_only', () => {
    expect(deriveFilename('Hike2026', '16_9', 'video_only')).toBe(
      'hike2026-16_9-video_only.mov',
    );
  });

  it('keeps the underscore aspect token', () => {
    const f = deriveFilename('hike', '9_16', 'composite');
    expect(f).toContain('9_16');
    expect(f).not.toContain('9:16');
  });

  it('applies slug fallback when project name is unrenderable', () => {
    expect(deriveFilename('', '9_16', 'composite')).toBe(
      'trailcut-export-9_16-composite.mp4',
    );
  });
});

describe('deriveJobs', () => {
  it('returns no jobs when nothing is selected', () => {
    const sel: ExportSelection = { aspects: [], channels: [], output_dir: null };
    expect(deriveJobs('Hike', '/Users/u/out', sel)).toEqual([]);
  });

  it('returns no jobs when aspects are empty', () => {
    const sel: ExportSelection = { aspects: [], channels: ['composite'], output_dir: null };
    expect(deriveJobs('Hike', '/Users/u/out', sel)).toEqual([]);
  });

  it('returns no jobs when channels are empty', () => {
    const sel: ExportSelection = { aspects: ['9_16'], channels: [], output_dir: null };
    expect(deriveJobs('Hike', '/Users/u/out', sel)).toEqual([]);
  });

  it('produces aspect-major ordering (outer loop = aspects)', () => {
    const sel: ExportSelection = {
      aspects: ['9_16', '4_5'],
      channels: ['composite', 'map_only'],
      output_dir: null,
    };
    const jobs = deriveJobs('Hike', '/out', sel);
    expect(jobs.map((j) => j.id)).toEqual([
      '9_16-composite',
      '9_16-map_only',
      '4_5-composite',
      '4_5-map_only',
    ]);
  });

  it('preserves selection order for both axes', () => {
    const sel: ExportSelection = {
      aspects: ['16_9', '9_16'],
      channels: ['video_only', 'composite'],
      output_dir: null,
    };
    const jobs = deriveJobs('Hike', '/out', sel);
    expect(jobs.map((j) => j.id)).toEqual([
      '16_9-video_only',
      '16_9-composite',
      '9_16-video_only',
      '9_16-composite',
    ]);
  });

  it('joins outputDir + filename with a single separator (no trailing slash)', () => {
    const sel: ExportSelection = { aspects: ['9_16'], channels: ['composite'], output_dir: null };
    const [job] = deriveJobs('Hike', '/Users/u/out', sel);
    expect(job.outputPath).toBe('/Users/u/out/hike-9_16-composite.mp4');
  });

  it('joins outputDir + filename without doubling when outputDir has trailing slash', () => {
    const sel: ExportSelection = { aspects: ['9_16'], channels: ['composite'], output_dir: null };
    const [job] = deriveJobs('Hike', '/Users/u/out/', sel);
    expect(job.outputPath).toBe('/Users/u/out/hike-9_16-composite.mp4');
  });

  it('passes folder paths with spaces through verbatim', () => {
    const sel: ExportSelection = { aspects: ['9_16'], channels: ['composite'], output_dir: null };
    const [job] = deriveJobs('Hike', '/Users/u/My Folder', sel);
    expect(job.outputPath).toBe('/Users/u/My Folder/hike-9_16-composite.mp4');
  });

  it('produces a stable id per (aspect, channel) pair', () => {
    const sel: ExportSelection = {
      aspects: ['9_16', '4_5', '16_9'],
      channels: ['composite', 'map_only', 'video_only'],
      output_dir: null,
    };
    const jobs = deriveJobs('Hike', '/out', sel);
    expect(jobs).toHaveLength(9);
    const ids = jobs.map((j) => j.id);
    expect(new Set(ids).size).toBe(9);
  });

  it('every job carries the aspect, channel, and resolved outputPath', () => {
    const sel: ExportSelection = {
      aspects: ['9_16'],
      channels: ['composite', 'map_only', 'video_only'],
      output_dir: null,
    };
    const jobs = deriveJobs('Hike2026', '/out', sel);
    expect(jobs).toEqual([
      {
        id: '9_16-composite',
        aspect: '9_16',
        channel: 'composite',
        outputPath: '/out/hike2026-9_16-composite.mp4',
      },
      {
        id: '9_16-map_only',
        aspect: '9_16',
        channel: 'map_only',
        outputPath: '/out/hike2026-9_16-map_only.mov',
      },
      {
        id: '9_16-video_only',
        aspect: '9_16',
        channel: 'video_only',
        outputPath: '/out/hike2026-9_16-video_only.mov',
      },
    ]);
  });
});
