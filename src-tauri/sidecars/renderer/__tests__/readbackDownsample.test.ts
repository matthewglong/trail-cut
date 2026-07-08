// Parity pin for the binding's in-render SSAA reduction
// (native/readback-downsample.patch): the render option
// `downsample: {factor, width, height}` must produce byte-identical output
// to nativeBackend.ts's boxDownsample applied to the full-size render of
// the same scene — boxDownsample IS the executable spec (zero-pad,
// (sum + n/2)/n truncated, premultiplied gamma-space averaging).
//
// Why two content tiers:
//   - The flat-background scene is a SHARP probe of the rounding mode
//     despite being visually trivial: every 2×2 block averages 4 equal
//     bytes, so sum+half = 4v+2 and the exact quotient is v+0.5 — truncate
//     gives v, while a round/round-half-even kernel would drift +1 on ~half
//     of all byte values. It must be BYTE-IDENTICAL between paths (and
//     deterministic: no partial-coverage pixels exist for GPU AA wobble to
//     touch).
//   - The geojson-fill scene exercises real mixed blocks (edge coverage).
//     Same-process back-to-back renders of a static scene are deterministic
//     in practice, but the golden gate's measured ±1-LSB AA-edge wobble
//     class gets the same allowance here: channel delta ≤ 1 on ≤ 0.1% of
//     pixels; anything more is a real kernel divergence.
//
// Loud preconditions (docs/CANON.md §1.11): a missing staged binding FAILS
// the suite — never skips — matching every other renderer precondition.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

import { boxDownsample } from '../nativeBackend';

// Mirrors nativeBackend.ts bindingDir() (dev layout; no env override here —
// the test pins the staged artifact the app itself would load).
function bindingDir(): string {
  const triple = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  return resolve(__dirname, '..', '..', '..', 'binaries', `mbgl-native-${triple}`);
}

interface MbglMapLike {
  load(style: unknown): void;
  render(
    options: Record<string, unknown>,
    cb: (err: Error | null, buffer?: Buffer) => void,
  ): void;
  release(): void;
}

interface MbglModuleLike {
  Map: new (options: { ratio: number; request: (...args: unknown[]) => void }) => MbglMapLike;
  readbackDownsample?: boolean;
}

const CSS_W = 64;
const CSS_H = 48;
const RATIO = 2; // fb = 128×96
const FB_W = CSS_W * RATIO;
const FB_H = CSS_H * RATIO;
const FACTOR = 2;
const OUT_W = FB_W / FACTOR;
const OUT_H = FB_H / FACTOR;

const CAMERA = { center: [0, 0] as [number, number], zoom: 2, bearing: 0, pitch: 0 };

// Inline styles — zero external resources, so the request bridge is never
// called and the test needs no network/tile cache.
const FLAT_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#5a7c33' } }],
};

const FILL_STYLE = {
  version: 8,
  sources: {
    tri: {
      type: 'geojson',
      data: {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          // Deliberately non-axis-aligned so fill edges produce partial
          // coverage (the mixed 2×2 blocks the box filter must average).
          coordinates: [[[-40, -20], [55, -35], [10, 45], [-40, -20]]],
        },
      },
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#1b2a49' } },
    { id: 'tri', type: 'fill', source: 'tri', paint: { 'fill-color': '#e0b040', 'fill-opacity': 0.85 } },
  ],
};

let mbgl: MbglModuleLike;

function renderOnce(map: MbglMapLike, options: Record<string, unknown>): Promise<Buffer> {
  return new Promise((res, rej) => {
    map.render(options, (err, buffer) => {
      if (err || !buffer) rej(err ?? new Error('render returned no buffer'));
      else res(buffer);
    });
  });
}

async function renderBothPaths(style: unknown): Promise<{ binding: Buffer; reference: Buffer }> {
  const map = new mbgl.Map({ ratio: RATIO, request: () => {} });
  try {
    map.load(style);
    const base = { width: CSS_W, height: CSS_H, ...CAMERA };
    const full = await renderOnce(map, base);
    expect(full.length).toBe(FB_W * FB_H * 4);
    const binding = await renderOnce(map, {
      ...base,
      downsample: { factor: FACTOR, width: OUT_W, height: OUT_H },
    });
    return { binding, reference: boxDownsample(full, FB_W, FB_H, FB_W, FB_H, FACTOR) };
  } finally {
    map.release();
  }
}

function diffStats(a: Buffer, b: Buffer): { maxDelta: number; diffPixels: number } {
  let maxDelta = 0;
  let diffPixels = 0;
  for (let i = 0; i < a.length; i += 4) {
    let pixelDiff = false;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a[i + c] - b[i + c]);
      if (d > 0) {
        pixelDiff = true;
        if (d > maxDelta) maxDelta = d;
      }
    }
    if (pixelDiff) diffPixels++;
  }
  return { maxDelta, diffPixels };
}

beforeAll(() => {
  const dir = bindingDir();
  if (!existsSync(join(dir, 'package.json'))) {
    throw new Error(
      `Staged maplibre-gl-native binding missing at ${dir} — the readback-downsample ` +
      'parity test cannot run without it. Run `npm run build:native-binding` first. ' +
      '(Loud-failure rule: this suite never skips on missing preconditions.)',
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  mbgl = require(dir) as MbglModuleLike;
});

describe('readback-downsample binding patch', () => {
  it('advertises the capability marker', () => {
    expect(mbgl.readbackDownsample).toBe(true);
  });

  it('is byte-identical to boxDownsample on a flat scene (rounding-mode probe)', async () => {
    const { binding, reference } = await renderBothPaths(FLAT_STYLE);
    expect(binding.length).toBe(OUT_W * OUT_H * 4);
    expect(binding.equals(reference)).toBe(true);
  });

  it('matches boxDownsample on fill edges within the ±1-LSB GPU wobble class', async () => {
    const { binding, reference } = await renderBothPaths(FILL_STYLE);
    expect(binding.length).toBe(OUT_W * OUT_H * 4);
    const { maxDelta, diffPixels } = diffStats(binding, reference);
    const pixelCount = OUT_W * OUT_H;
    expect(maxDelta).toBeLessThanOrEqual(1);
    expect(diffPixels).toBeLessThanOrEqual(Math.ceil(pixelCount * 0.001));
  });
});
