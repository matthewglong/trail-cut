// Per-frame perf probe for the chromium renderer worker.
//
// Spawns the bundled worker, runs setup + N frames, and parses the
// always-on `[renderer] frame K t=Tms total=Xms eval=Xms ...` summary
// lines from the worker's stderr. Reports min/median/p95/avg per phase.
//
// Run with:
//   node -r ts-node/register src-tauri/sidecars/renderer/__tests__/perfProbe.ts
//   # transport defaults to readpixels; pass --png to compare:
//   node -r ts-node/register src-tauri/sidecars/renderer/__tests__/perfProbe.ts --png
//
// The probe uses the synthetic 1-clip 2s setup fixture (default OpenFreeMap
// style + minimal route). For a "real" measurement against a heavy 71-clip
// project, run an actual export from the app — this probe is for quick
// signal during perf iteration.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';

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

const TRANSPORT = process.argv.includes('--png') ? 'png' : 'readpixels';
const VERBOSE = process.argv.includes('--verbose');
const FRAMES = (() => {
  const i = process.argv.indexOf('--frames');
  if (i >= 0 && process.argv[i + 1]) return parseInt(process.argv[i + 1], 10);
  return 20;
})();
const VIEWPORT_W = 1080;
const VIEWPORT_H = 1920;

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx];
}

function avg(arr: number[]): number {
  if (arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

interface ParsedFrame {
  frame: number;
  total: number;
  eval: number;
  shot?: number;
  decode: number;
  write: number;
}

function parseFrameLine(line: string): ParsedFrame | null {
  // [renderer] frame K t=Tms total=Xms eval=Xms shot=...|read=embedded decode=Xms write=Xms ...
  const m = line.match(/\[renderer\] frame (\d+) t=\d+ms total=(\d+)ms eval=(\d+)ms (?:shot=(\d+)ms png=\d+B|read=embedded) decode=(\d+)ms write=(\d+)ms/);
  if (!m) return null;
  return {
    frame: parseInt(m[1], 10),
    total: parseInt(m[2], 10),
    eval: parseInt(m[3], 10),
    shot: m[4] ? parseInt(m[4], 10) : undefined,
    decode: parseInt(m[5], 10),
    write: parseInt(m[6], 10),
  };
}

async function main(): Promise<void> {
  console.error(`[perfProbe] transport=${TRANSPORT} frames=${FRAMES} viewport=${VIEWPORT_W}x${VIEWPORT_H} verbose=${VERBOSE}`);

  const setup = buildSetupPayload({
    viewportW: VIEWPORT_W,
    viewportH: VIEWPORT_H,
    fps: 30,
  });

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    TRAILCUT_CHROME_BIN: chromeBin,
    TRAILCUT_RENDERER_TRANSPORT: TRANSPORT,
  };
  if (VERBOSE) env.TRAILCUT_RENDERER_VERBOSE = '1';

  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [rendererCjs],
    { env, stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const frames: ParsedFrame[] = [];
  let setupMs = 0;
  let stderrBuf = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrBuf += chunk;
    let nl = stderrBuf.indexOf('\n');
    while (nl >= 0) {
      const line = stderrBuf.slice(0, nl);
      stderrBuf = stderrBuf.slice(nl + 1);
      const setupM = line.match(/\[renderer\] setup done in (\d+)ms/);
      if (setupM) setupMs = parseInt(setupM[1], 10);
      const f = parseFrameLine(line);
      if (f) frames.push(f);
      // Echo all lines so the user can see worker chatter live.
      process.stderr.write(line + '\n');
      nl = stderrBuf.indexOf('\n');
    }
  });

  // Drain stdout so we don't backpressure the worker.
  let stdoutBytes = 0;
  child.stdout.on('data', (chunk: Buffer) => { stdoutBytes += chunk.length; });

  const sendCmd = (obj: unknown): void => {
    child.stdin.write(JSON.stringify(obj) + '\n');
  };

  sendCmd(setup);

  // Wait for {"ready":true} on stdout. We're greedy-draining stdout above,
  // so just poll setupMs (set by stderr setup-summary line). Cap wait at 90s.
  const startWait = Date.now();
  while (setupMs === 0 && Date.now() - startWait < 90_000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (setupMs === 0) {
    console.error('[perfProbe] setup did not complete in 90s — aborting');
    child.kill('SIGKILL');
    process.exit(1);
  }
  console.error(`[perfProbe] setup completed in ${setupMs}ms`);

  // Issue render commands one-at-a-time. The worker is single-threaded
  // and will queue, but we want clean per-frame measurements so we'll
  // wait between commands.
  const fps = 30;
  for (let i = 0; i < FRAMES; i++) {
    sendCmd({ cmd: 'render', frame_index: i, project_time_ms: Math.floor((i * 1000) / fps) });
    // Wait until the corresponding frame line arrives.
    const before = frames.length;
    const t0 = Date.now();
    while (frames.length === before && Date.now() - t0 < 60_000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    if (frames.length === before) {
      console.error(`[perfProbe] frame ${i} timed out — aborting`);
      child.kill('SIGKILL');
      process.exit(1);
    }
  }

  sendCmd({ cmd: 'shutdown' });
  child.stdin.end();

  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });

  // Drop frame 0 (cold cache + first paint) from steady-state stats.
  const steady = frames.slice(1);

  const fmt = (vals: number[]): string =>
    `min=${Math.min(...vals)} med=${pct(vals, 50)} p95=${pct(vals, 95)} avg=${avg(vals).toFixed(1)} max=${Math.max(...vals)}`;

  console.error('');
  console.error('=== perfProbe results ===');
  console.error(`transport: ${TRANSPORT}`);
  console.error(`viewport:  ${VIEWPORT_W}x${VIEWPORT_H}`);
  console.error(`frames:    ${frames.length} (cold=1, steady=${steady.length})`);
  console.error(`setup:     ${setupMs}ms`);
  console.error(`stdout:    ${stdoutBytes}B`);
  console.error(`frame 0 (cold): total=${frames[0]?.total ?? '?'}ms eval=${frames[0]?.eval ?? '?'}ms decode=${frames[0]?.decode ?? '?'}ms`);
  console.error(`steady total:  ${fmt(steady.map((f) => f.total))}`);
  console.error(`steady eval:   ${fmt(steady.map((f) => f.eval))}`);
  if (TRANSPORT === 'png') {
    console.error(`steady shot:   ${fmt(steady.map((f) => f.shot ?? 0))}`);
  }
  console.error(`steady decode: ${fmt(steady.map((f) => f.decode))}`);
  console.error(`steady write:  ${fmt(steady.map((f) => f.write))}`);
}

main().catch((e) => {
  console.error('[perfProbe] error:', e);
  process.exit(1);
});
