// One-off probe: launch the renderer worker, drive it through one frame,
// and report (a) pixel statistics for the route-trail color band and
// (b) write the frame as PNG to /tmp for visual inspection.
//
// Drives the bundled dist/renderer.cjs over stdin/stdout — the same
// protocol the Rust orchestrator uses. Captures the length-prefixed
// raw RGBA frame and analyzes it.
//
// Run after `npm run build:renderer`:
//   node -r ts-node/register src-tauri/sidecars/renderer/__tests__/colorParityProbe.ts
// or directly via tsx:
//   npx tsx src-tauri/sidecars/renderer/__tests__/colorParityProbe.ts

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';

import { buildSetupPayload } from './setupFixture';

const here = __dirname;
const repoRoot = resolve(here, '..', '..', '..', '..');
const rendererCjs = resolve(here, '..', 'dist', 'renderer.cjs');
const chromeBin = resolve(
  repoRoot,
  'src-tauri',
  'binaries',
  'chrome-aarch64-apple-darwin',
  'Google Chrome for Testing.app',
  'Contents',
  'MacOS',
  'Google Chrome for Testing',
);

interface FrameResult {
  rgba: Buffer;
  width: number;
  height: number;
}

// Drive the worker for one frame. Stdout is a mixed stream: a
// `{"ready":true}\n` JSON line first, then 4-byte BE length + raw RGBA
// bytes. We split deterministically using known sizes.
async function captureOneFrame(transport: 'readpixels' | 'png'): Promise<FrameResult> {
  const setup = buildSetupPayload({
    framebufferW: 540,
    framebufferH: 960,
    fps: 30,
  });

  const env = {
    ...process.env,
    TRAILCUT_CHROME_BIN: chromeBin,
    TRAILCUT_RENDERER_TRANSPORT: transport,
    TRAILCUT_RENDERER_VERBOSE: '1',
  };

  const child = spawn(process.execPath, [rendererCjs], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (b) => process.stderr.write(b));

  const stdoutChunks: Buffer[] = [];
  child.stdout.on('data', (b: Buffer) => stdoutChunks.push(b));
  const stdoutDone = new Promise<void>((res) => child.stdout.on('end', () => res()));
  const exitDone = new Promise<number>((res) => child.on('exit', (c) => res(c ?? -1)));

  // Setup
  child.stdin.write(JSON.stringify(setup) + '\n');
  // Wait until the ready line is in our buffer
  const readyDeadline = Date.now() + 360_000;
  let readyOk = false;
  while (Date.now() < readyDeadline) {
    const buf = Buffer.concat(stdoutChunks);
    if (buf.includes(0x0a)) { readyOk = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!readyOk) {
    console.error(`[probe] still waiting for ready after ${(Date.now() - (readyDeadline - 360_000))}ms; collected stdout=${Buffer.concat(stdoutChunks).length}B`);
  }

  // Render frame 0
  child.stdin.write(JSON.stringify({ cmd: 'render', frame_index: 0, project_time_ms: 0 }) + '\n');

  // Wait for the frame bytes (ready line + 4 bytes length + len bytes)
  const expectedFrameBytes = setup.framebuffer.w * setup.framebuffer.h * 4;
  const frameDeadline = Date.now() + 180_000;
  while (Date.now() < frameDeadline) {
    const buf = Buffer.concat(stdoutChunks);
    const newlineIdx = buf.indexOf(0x0a);
    if (newlineIdx >= 0) {
      const after = buf.length - newlineIdx - 1;
      if (after >= 4 + expectedFrameBytes) break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  child.stdin.write(JSON.stringify({ cmd: 'shutdown' }) + '\n');
  child.stdin.end();
  await Promise.race([
    exitDone,
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  child.kill();
  await stdoutDone.catch(() => {});

  const stdout = Buffer.concat(stdoutChunks);
  const newlineIdx = stdout.indexOf(0x0a);
  if (newlineIdx < 0) throw new Error('no ready line in stdout');
  const readyLine = stdout.slice(0, newlineIdx).toString('utf8');
  if (!readyLine.includes('"ready":true')) {
    throw new Error(`unexpected first line: ${readyLine}`);
  }
  let off = newlineIdx + 1;
  if (stdout.length < off + 4) throw new Error('no frame length prefix');
  const len = stdout.readUInt32BE(off);
  off += 4;
  if (stdout.length < off + len) {
    throw new Error(`short frame: expected ${len}, got ${stdout.length - off}`);
  }
  const rgba = stdout.slice(off, off + len);
  if (rgba.length !== expectedFrameBytes) {
    throw new Error(`frame size mismatch: got ${rgba.length}, expected ${expectedFrameBytes}`);
  }

  return { rgba, width: setup.framebuffer.w, height: setup.framebuffer.h };
}

interface Stats {
  matchedCount: number;
  meanR: number;
  meanG: number;
  meanB: number;
  exemplars: string[];
}

// Find pixels matching the route-trail color band (target #ff6b35) and
// report mean RGB. Wide tolerance to catch shifted oranges.
function analyzeRouteTrail(rgba: Buffer, w: number, h: number): Stats {
  const targetR = 0xff;
  const targetG = 0x6b;
  const targetB = 0x35;

  let count = 0;
  let sumR = 0, sumG = 0, sumB = 0;
  const exemplars: string[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], a = rgba[i + 3];
      if (a < 200) continue;
      // Wide tolerance — looking for any orange-ish dominant-R/mid-G/low-B pixel.
      if (Math.abs(r - targetR) < 40 && Math.abs(g - targetG) < 35 && Math.abs(b - targetB) < 35) {
        count++;
        sumR += r; sumG += g; sumB += b;
        if (exemplars.length < 8 && (count % 50 === 0)) {
          exemplars.push(`(${x},${y}) rgba=${r},${g},${b},${a}`);
        }
      }
    }
  }
  return {
    matchedCount: count,
    meanR: count ? sumR / count : 0,
    meanG: count ? sumG / count : 0,
    meanB: count ? sumB / count : 0,
    exemplars,
  };
}

function summarize(name: string, result: FrameResult): void {
  const stats = analyzeRouteTrail(result.rgba, result.width, result.height);
  console.error(`\n=== ${name} ===`);

  // Sample some pixels across the frame for sanity.
  const sample = (x: number, y: number): string => {
    const i = (y * result.width + x) * 4;
    return `(${x},${y})=${result.rgba[i]},${result.rgba[i + 1]},${result.rgba[i + 2]},${result.rgba[i + 3]}`;
  };
  console.error(`  pixel samples:`);
  console.error(`    center:    ${sample(result.width >> 1, result.height >> 1)}`);
  console.error(`    top-left:  ${sample(10, 10)}`);
  console.error(`    bot-right: ${sample(result.width - 10, result.height - 10)}`);
  console.error(`    third:     ${sample(result.width / 3 | 0, result.height / 3 | 0)}`);
  console.error(`    two-thirds:${sample(2 * result.width / 3 | 0, 2 * result.height / 3 | 0)}`);

  // Compute a global RGB histogram-ish summary across all pixels.
  let totalR = 0, totalG = 0, totalB = 0, totalA = 0, npix = 0;
  let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
  for (let y = 0; y < result.height; y++) {
    for (let x = 0; x < result.width; x++) {
      const i = (y * result.width + x) * 4;
      const r = result.rgba[i], g = result.rgba[i + 1], b = result.rgba[i + 2], a = result.rgba[i + 3];
      totalR += r; totalG += g; totalB += b; totalA += a; npix++;
      if (r < minR) minR = r; if (r > maxR) maxR = r;
      if (g < minG) minG = g; if (g > maxG) maxG = g;
      if (b < minB) minB = b; if (b > maxB) maxB = b;
    }
  }
  console.error(
    `  global mean RGBA: ` +
    `(${(totalR / npix).toFixed(1)}, ${(totalG / npix).toFixed(1)}, ${(totalB / npix).toFixed(1)}, ${(totalA / npix).toFixed(1)})`,
  );
  console.error(`  ranges R[${minR}..${maxR}] G[${minG}..${maxG}] B[${minB}..${maxB}]`);

  console.error(`  target color: rgb(255, 107, 53)  // #ff6b35`);
  console.error(`  matched pixels (route-trail band): ${stats.matchedCount}`);
  console.error(
    `  mean RGB: (${stats.meanR.toFixed(1)}, ${stats.meanG.toFixed(1)}, ${stats.meanB.toFixed(1)})`,
  );
  console.error(
    `  delta from target: (${(stats.meanR - 255).toFixed(1)}, ${(stats.meanG - 107).toFixed(1)}, ${(stats.meanB - 53).toFixed(1)})`,
  );
  if (stats.exemplars.length > 0) {
    console.error(`  exemplars:`);
    for (const e of stats.exemplars) console.error(`    ${e}`);
  }

  const outDir = '/tmp';
  const pngPath = `${outDir}/trailcut-export-${name}.png`;
  const png = new PNG({ width: result.width, height: result.height });
  result.rgba.copy(png.data);
  const pngBuf = PNG.sync.write(png);
  writeFileSync(pngPath, pngBuf);
  console.error(`  wrote ${pngPath} (${pngBuf.length}B)`);
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const transports: Array<'readpixels' | 'png'> =
    args.length > 0
      ? (args.filter((a) => a === 'readpixels' || a === 'png') as Array<'readpixels' | 'png'>)
      : ['readpixels', 'png'];

  for (const t of transports) {
    console.error(`[probe] capturing one frame via transport=${t}...`);
    const result = await captureOneFrame(t);
    summarize(t, result);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
