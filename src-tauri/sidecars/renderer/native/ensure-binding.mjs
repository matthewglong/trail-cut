// Provision the PATCHED maplibre-gl-native node binding the export
// renderer's native backend requires.
//
// The binding is upstream @maplibre/maplibre-gl-native at tag node-v6.4.1
// plus `expose-setGestureInProgress.patch` (53 lines, binding-only —
// platform/node/src/node_map.{cpp,hpp}; zero core-mbgl changes). The patch
// exposes `map.setGestureInProgress(bool)` to JS, the exact analogue of the
// GL JS `moving` painter flag our shipped renderer forces via
// painterPatch.ts. Without it, raster (satellite) layers pixel-snap on
// sub-pixel camera pans: 0.93 px RMS sawtooth vs 0.0795 px with the knob on
// (measured, .spike/native-gl/jitter-report.md; production route:
// .spike/native-gl/PRODUCTION_PATH.md).
//
// Staged layout (mirrors the npm package, resolvable by require()):
//   src-tauri/binaries/mbgl-native-<triple>/
//     index.js                — upstream JS wrapper (verbatim)
//     package.json            — upstream package manifest (verbatim)
//     lib/node-v<ABI>/mbgl.node — the patched native module
//
// Resolution order:
//   1. Already staged + verified (loads, has setGestureInProgress) → done.
//   2. Build from source: clone upstream at TAG into
//      src-tauri/binaries/.mbgl-src, apply the vendored patch, cmake build
//      (upstream's own macos-metal-node preset), stage, verify.
// There is NO silent-skip path: verification failure is a hard error with
// remediation instructions. CI caches the staged directory keyed on
// (tag, patch hash, ABI) so the ~5 min source build runs once per bump.
//
// Distribution status (PRODUCTION_PATH.md): the upstream PR is the exit
// ramp — NOT posted yet, Matthew decides when. Until then this script is
// the pinned interim artifact source (route 2/3); task 130 sidecar
// bundling ships the staged dir per platform like ffmpeg/exiftool/Chrome.
//
// Platform bounds: darwin (Metal) only today — the cmake preset and the
// jitter/colorimetry measurements are darwin-arm64. Windows is near-term:
// upstream's node-release.yml prebuilt matrix includes win32; when that
// route lands this script grows a fetch path per triple instead of a local
// cmake build. Fail loud, don't guess, on other hosts.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const tauriRoot = resolve(repoRoot, 'src-tauri');

const TAG = 'node-v6.4.1';
const PATCH = resolve(here, 'expose-setGestureInProgress.patch');
const ABI = process.versions.modules; // e.g. '127' for Node 22

function hostTargetTriple() {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  throw new Error(
    `[ensure-binding] unsupported host: platform=${platform} arch=${arch}. ` +
    `Only darwin is buildable today (cmake preset macos-metal-node). ` +
    `Windows rides upstream's node-release.yml prebuilt matrix — see ` +
    `.spike/native-gl/PRODUCTION_PATH.md route 2 and task 130.`,
  );
}

const triple = hostTargetTriple();
const stagedDir = resolve(tauriRoot, 'binaries', `mbgl-native-${triple}`);
const stagedNode = resolve(stagedDir, 'lib', `node-v${ABI}`, 'mbgl.node');

/** Load the staged binding in a child process and verify the patch method
 *  exists. Child process so a bad .node (wrong ABI, corrupt) can't take
 *  this script down with it. */
function verifyStaged() {
  if (!existsSync(stagedNode)) return { ok: false, why: `${stagedNode} missing` };
  const probe = spawnSync(
    process.execPath,
    ['-e', `
      const mbgl = require(${JSON.stringify(stagedDir)});
      const m = new mbgl.Map({ request: () => {}, ratio: 1 });
      if (typeof m.setGestureInProgress !== 'function') {
        console.error('binding loads but lacks setGestureInProgress — unpatched build?');
        process.exit(2);
      }
      m.release();
    `],
    { encoding: 'utf8' },
  );
  if (probe.status !== 0) {
    return { ok: false, why: `load probe failed (exit ${probe.status}): ${probe.stderr.trim()}` };
  }
  return { ok: true };
}

function run(cmd, args, opts = {}) {
  console.error(`[ensure-binding] $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    throw new Error(`[ensure-binding] ${cmd} ${args.join(' ')} failed (exit ${r.status})`);
  }
}

function requireTool(name, hint) {
  const r = spawnSync(name, ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error(
      `[ensure-binding] required tool '${name}' not found. ${hint}\n` +
      `Full prereq set: brew install cmake ninja ccache pkg-config glfw libuv`,
    );
  }
}

function buildFromSource() {
  requireTool('cmake', 'brew install cmake');
  requireTool('ninja', 'brew install ninja');
  requireTool('git', 'install Xcode CLI tools');

  const srcDir = resolve(tauriRoot, 'binaries', '.mbgl-src');
  if (!existsSync(srcDir)) {
    run('git', [
      'clone', '--depth', '1', '--branch', TAG,
      '--recurse-submodules', '--shallow-submodules',
      'https://github.com/maplibre/maplibre-native.git', srcDir,
    ]);
  }

  // Apply the vendored patch, idempotently: `--check` fails either when the
  // patch no longer fits the tree (real error) or when it is already
  // applied — `--reverse --check` succeeding distinguishes the latter.
  const check = spawnSync('git', ['apply', '--check', PATCH], { cwd: srcDir });
  if (check.status === 0) {
    run('git', ['apply', PATCH], { cwd: srcDir });
  } else {
    const reverse = spawnSync('git', ['apply', '--reverse', '--check', PATCH], { cwd: srcDir });
    if (reverse.status !== 0) {
      throw new Error(
        `[ensure-binding] ${PATCH} neither applies nor is already applied at ${TAG} — ` +
        `the source tree at ${srcDir} is dirty or the tag moved. Delete the dir and retry.`,
      );
    }
    console.error('[ensure-binding] patch already applied');
  }

  run('cmake', ['--preset', 'macos-metal-node', '-DCMAKE_BUILD_TYPE=Release'], { cwd: srcDir });
  run('cmake', [
    '--build', 'build', '--target', `mbgl-node.abi-${ABI}`,
    '-j', String(os.cpus().length),
  ], { cwd: srcDir });

  // Locate the built module. Upstream's per-ABI target drops
  // mbgl-node.abi-<ABI>.node under build/platform/node (exact subpath has
  // shifted across releases — search rather than hardcode).
  const found = spawnSync('find', [
    resolve(srcDir, 'build', 'platform', 'node'),
    '-name', `mbgl-node.abi-${ABI}.node`,
  ], { encoding: 'utf8' });
  const builtPath = found.stdout.split('\n').map((s) => s.trim()).filter(Boolean)[0];
  if (!builtPath) {
    throw new Error(
      `[ensure-binding] build succeeded but mbgl-node.abi-${ABI}.node not found under ` +
      `${srcDir}/build/platform/node`,
    );
  }

  mkdirSync(dirname(stagedNode), { recursive: true });
  copyFileSync(resolve(srcDir, 'platform', 'node', 'index.js'), resolve(stagedDir, 'index.js'));
  copyFileSync(resolve(srcDir, 'platform', 'node', 'package.json'), resolve(stagedDir, 'package.json'));
  copyFileSync(builtPath, stagedNode);
  console.error(`[ensure-binding] staged ${builtPath} → ${stagedNode}`);
}

const pre = verifyStaged();
if (pre.ok && !process.argv.includes('--force-build')) {
  console.error(`[ensure-binding] patched binding present + verified at ${stagedDir} (abi ${ABI})`);
  process.exit(0);
}
console.error(`[ensure-binding] staged binding not usable: ${pre.ok ? 'forced rebuild' : pre.why}`);
buildFromSource();
const post = verifyStaged();
if (!post.ok) {
  throw new Error(`[ensure-binding] post-build verification FAILED: ${post.why}`);
}
console.error(`[ensure-binding] patched binding built + verified at ${stagedDir} (abi ${ABI})`);
