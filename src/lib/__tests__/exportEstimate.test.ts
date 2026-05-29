import { describe, it, expect } from 'vitest';
import { estimateJob, estimateQueue } from '../exportEstimate';
import type { ExportJob } from '../exportFilenames';

function job(id: string, channel: ExportJob['channel']): ExportJob {
  return {
    id,
    aspect: '9_16',
    channel,
    quality: '1080p',
    fps: 30,
    deliveryTarget: 'prores',
    outputPath: '',
  };
}

describe('estimateJob', () => {
  it('combines startup cost (0.5s × N) with composite encode factor 0.4', () => {
    // 10 clips × 0.5 = 5s startup; 60s × 0.4 = 24s encode → 29s total.
    expect(estimateJob(10, 60, 'composite')).toBeCloseTo(29);
  });

  it('uses 0.3× factor for map_only', () => {
    // 10 clips × 0.5 = 5s startup; 60s × 0.3 = 18s encode → 23s total.
    expect(estimateJob(10, 60, 'map_only')).toBeCloseTo(23);
  });

  it('uses 0.6× factor for video_only', () => {
    // 10 clips × 0.5 = 5s startup; 60s × 0.6 = 36s encode → 41s total.
    expect(estimateJob(10, 60, 'video_only')).toBeCloseTo(41);
  });

  it('returns 0 for an empty timeline with no clips', () => {
    expect(estimateJob(0, 0, 'composite')).toBe(0);
  });

  it('scales linearly with clip count', () => {
    const a = estimateJob(10, 60, 'composite');
    const b = estimateJob(20, 60, 'composite');
    expect(b - a).toBeCloseTo(5);
  });

  it('scales linearly with timeline duration', () => {
    const a = estimateJob(10, 60, 'composite');
    const b = estimateJob(10, 120, 'composite');
    expect(b - a).toBeCloseTo(24);
  });
});

describe('estimateQueue', () => {
  it('returns 0 for an empty queue', () => {
    expect(estimateQueue([], 10, 60)).toBe(0);
  });

  it('sums per-job estimates across the queue', () => {
    const jobs = [
      job('a', 'composite'),
      job('b', 'map_only'),
      job('c', 'video_only'),
    ];
    // 29 + 23 + 41 = 93s.
    expect(estimateQueue(jobs, 10, 60)).toBeCloseTo(93);
  });

  it('a 9-job full multi-select with 70 clips × 5min timeline lands in tens of minutes', () => {
    const channels: ExportJob['channel'][] = [
      'composite',
      'map_only',
      'video_only',
    ];
    const jobs: ExportJob[] = [];
    for (const aspect of ['9_16', '4_5', '16_9'] as const) {
      for (const channel of channels) {
        jobs.push({
          id: `${aspect}-${channel}`,
          aspect,
          channel,
          quality: '1080p',
          fps: 30,
          deliveryTarget: 'prores',
          outputPath: '',
        });
      }
    }
    const totalSec = estimateQueue(jobs, 70, 300);
    // Sanity: 9 × (70 × 0.5) = 315s startup; encode = 300 × (0.4+0.3+0.6) × 3
    // = 300 × 3.9 = 1170s. Total ≈ 1485s ≈ 24.75min — well into "tens of
    // minutes" territory.
    expect(totalSec).toBeGreaterThan(20 * 60);
    expect(totalSec).toBeLessThan(40 * 60);
  });
});
