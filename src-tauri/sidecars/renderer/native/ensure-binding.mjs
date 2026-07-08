// Provision the PATCHED maplibre-gl-native node binding the export
// renderer's native backend requires.
//
// The binding is upstream @maplibre/maplibre-gl-native at tag node-v6.4.1
// plus three vendored patches:
//   1. `expose-setGestureInProgress.patch` (binding-only —
//      platform/node/src/node_map.{cpp,hpp}; zero core-mbgl changes).
//      Exposes `map.setGestureInProgress(bool)` to JS, the exact analogue
//      of the GL JS `moving` painter flag our shipped renderer forces via
//      painterPatch.ts. Without it, raster (satellite) layers pixel-snap on
//      sub-pixel camera pans: 0.93 px RMS sawtooth vs 0.0795 px with the
//      knob on (measured, .spike/native-gl/jitter-report.md; production
//      route: .spike/native-gl/PRODUCTION_PATH.md).
//   2. `readback-downsample.patch` (binding + headless readback path).
//      Adds the render option `downsample: {factor, width, height}` — an
//      exact integer box filter run backend-side (on-GPU compute under
//      Metal) before readback, so SSAA exports never ship the full
//      supersampled framebuffer to JS nor box-filter it on the CPU
//      (55–90% of per-frame cost pre-patch, and 2.5–6× worse under CPU
//      contention). Byte-identical semantics to nativeBackend.ts's
//      boxDownsample (zero-pad, (sum+n/2)/n truncated). Capability marker:
//      `mbgl.readbackDownsample === true`.
//   3. `group-composite.patch` (core + binding). Adds engine-level
//      group-opacity compositing — `map.setGroupComposite([{layers,
//      opacity}])` — modeled on the heatmap layer's offscreen pass: each
//      configured group's member layers render into a full-viewport RGBA8
//      offscreen texture, skipped in the main passes, then composite once
//      src-over at the group opacity at the topmost member's z-slot. New
//      Metal shader (heatmap-texture minus the color-ramp lookup).
//      Capability marker: `mbgl.groupComposite === true`. Motivation:
//      translucent halo self-overlap darkening (jitter sunbursts + the
//      legitimate out-and-back retrace both double-blend under plain alpha
//      compositing) — measured exact in
//      `.spike/halo-composite/VERDICT.md`. Feature unused (no groups
//      configured) renders byte-identical to the unpatched-for-this-feature
//      binding.
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
const PATCHES = [
  resolve(here, 'expose-setGestureInProgress.patch'),
  resolve(here, 'readback-downsample.patch'),
  resolve(here, 'group-composite.patch'),
];
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
      if (mbgl.readbackDownsample !== true) {
        console.error('binding loads but lacks the readbackDownsample capability — unpatched build?');
        process.exit(2);
      }
      const m = new mbgl.Map({ request: () => {}, ratio: 1 });
      if (typeof m.setGestureInProgress !== 'function') {
        console.error('binding loads but lacks setGestureInProgress — unpatched build?');
        process.exit(2);
      }
      if (mbgl.groupComposite !== true) {
        console.error('binding loads but lacks the groupComposite capability — unpatched build?');
        process.exit(2);
      }
      if (typeof m.setGroupComposite !== 'function') {
        console.error('binding loads but lacks setGroupComposite — unpatched build?');
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

  // Detect how much of the patch stack is already applied, then forward-apply
  // only the remainder. Per-patch idempotency checks that REVERSE-check each
  // patch alone, in isolation, against the fully-patched tree are UNSOUND as
  // soon as two patches touch the same file: group-composite.patch (patch 3)
  // and expose-setGestureInProgress.patch (patch 1) both edit
  // platform/node/src/node_map.{cpp,hpp}. Reversing patch 1 alone while
  // patch 3's edits to that same file are still present changes the
  // surrounding context patch 1's hunks expect, so `git apply --reverse
  // --check` on patch 1 fails even though patch 1 genuinely is applied —
  // shared-file poisoning of the per-patch reverse-check, not tree drift
  // (confirmed 2026-07-07 by a manual reverse/reapply round trip that came
  // back byte-identical). A single combined `git apply --check` across
  // multiple patch files doesn't fix this either — verified empirically that
  // multi-file `--check` does NOT reliably simulate cumulative state (a
  // two-patch same-file repro where patch B depends on patch A's hunk lands
  // fine via a real multi-file `git apply`, but the identical multi-file
  // `--check` invocation reports "does not apply").
  //
  // FORWARD single-patch checks don't have this problem: `git apply --check`
  // on patch i alone just asks "does the tree's current on-disk content match
  // patch i's expected pre-image", a single-file, single-direction question
  // with no cross-patch ordering ambiguity. Scanning patches in order, the
  // first one whose forward check succeeds marks the applied/pending
  // boundary — patches before it must already be applied (their pre-images
  // no longer match) and patches from it onward are pending. If no patch's
  // forward check succeeds, the stack is either fully applied or the tree is
  // broken; disambiguate with exactly one reverse-check of the TOPMOST patch
  // alone — safe because nothing is stacked on top of it, so it can never
  // suffer the shared-file poisoning above.
  let appliedPrefix = PATCHES.length;
  for (let i = 0; i < PATCHES.length; i++) {
    const forward = spawnSync('git', ['apply', '--check', PATCHES[i]], { cwd: srcDir });
    if (forward.status === 0) {
      appliedPrefix = i;
      break;
    }
  }

  if (appliedPrefix === PATCHES.length) {
    const topPatch = PATCHES[PATCHES.length - 1];
    const topReverse = spawnSync('git', ['apply', '--reverse', '--check', topPatch], { cwd: srcDir });
    if (topReverse.status !== 0) {
      throw new Error(
        `[ensure-binding] no patch forward-applies, and the topmost patch (${topPatch}) does ` +
        `not reverse either at ${TAG} — the source tree at ${srcDir} is dirty or the tag moved. ` +
        `Delete the dir and retry.`,
      );
    }
    console.error(`[ensure-binding] patches already applied: ${PATCHES.length}/${PATCHES.length}`);
  } else {
    console.error(
      `[ensure-binding] applying patches ${appliedPrefix + 1}..${PATCHES.length} ` +
      `on applied prefix ${appliedPrefix}`,
    );
    for (const patch of PATCHES.slice(appliedPrefix)) {
      run('git', ['apply', patch], { cwd: srcDir });
    }
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
