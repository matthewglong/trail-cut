# 04 — Upstream maplibre-native PR: risk calculus & sequencing

**Author:** Fable (ship-review research lane) · **Date:** 2026-07-07 · **Status:** analysis only — nothing posted, no code changed.

> Scope note: the launching brief described **two** vendored patches. The tree now
> carries **three** (`src-tauri/sidecars/renderer/native/`): patch 3
> `group-composite.patch` (801 lines, core + binding + build-system) landed
> 2026-07-07 for the halo compositing feature (CANON §2.7). Patch 3 dominates the
> risk calculus below and is the reason several conclusions differ from the brief's
> framing.

---

## TL;DR

- **Drift is currently near-zero.** We pin `node-v6.4.1`; upstream's newest tag is
  `node-v6.5.0-pre.1` (a pre-release). We are one minor behind, on the latest
  *stable* node tag. Patch 1 already verified to apply clean to the pre-release.
- **The three patches have wildly different upstream futures.** Patch 1 (binding-only,
  cold file) is a clean, ready PR. Patch 2 (readback downsample, has a portable CPU
  fallback) is a plausible but larger PR. Patch 3 (group-composite, Metal-only core)
  should **not** be upstreamed in its current shape — **upstream is already solving
  its problem declaratively** (`line-layer-opacity`/`fill-layer-opacity`, merged in
  gl-js via PR #7570; open request #4298 to bring it to native). Upstreaming our
  imperative `setGroupComposite` API would be rejected or orphaned.
- **Windows is the real exposure, and patch 3 is the blocker — independent of any
  PR decision.** The node binding uses OpenGL/EGL/Vulkan on Windows, never Metal.
  Patch 2 degrades gracefully there (bit-identical CPU fallback). Patch 3 does **not**:
  its `groupComposite` capability marker is set `true` **unconditionally**, but the
  non-Metal offscreen path silently drops depth/stencil, so on Windows the halo
  composite renders **wrong coverage with no loud failure**. This must be fixed before
  Windows ships regardless of whether we ever open a PR.
- **Recommendation:** post patch 1 now; hold patch 2 as a vendored stopgap with a
  drafted PR ready; do **not** upstream patch 3 — instead track #4298, drop the
  preview-side gl-js halo patch in favor of the released style property (verify version),
  and give patch 3 a real non-Metal backend path (or a loud capability gate) before
  Windows. Fallback if upstream is unresponsive is unchanged and cheap: keep the
  fork-CI/vendored-binary route we already run.

---

## Situational facts (researched, 2026-07-07)

**Release cadence & drift.** node-v tags in order end at: … `node-v6.4.0`,
`node-v6.4.1-pre.0`, **`node-v6.4.1` (our pin)**, `node-v6.5.0-pre.1`. So upstream has
produced exactly one pre-release past our pin. The node platform is **actively
maintained** — recent merged node PRs (all by core collaborator `acalcutt`): node v26
support / drop v20 (#4322, Jun 2026), replace `node-pre-gyp-github` with gh-release
(#4329, Jun 2026), NAN + node-pre-gyp update (#4128, Feb 2026), node v24 + **Windows
arm64** support (#3760, Sep 2025). Prebuilt binaries now cover **Node 22/24/26** on
**Ubuntu 24.04, macOS, Windows — both x86_64 and arm64** (`node-release.yml` matrix:
`ubuntu-24.04`, `ubuntu-24.04-arm`, `macos-15-intel`, `macos-15`, `windows-2022`,
`windows-11-arm`). The brief's older reading ("Ubuntu 20.04 + macOS 12 only") is stale;
**win32 prebuilts do exist today.**

**Governance / process.** Non-trivial PRs are accepted/rejected at the monthly Technical
Steering Committee meeting; a 5-member Governing Board (elected yearly at FOSS4G) owns
strategy/finance. The **bounty program was sun-set (effective 2026-03-31)** and is being
replaced by an undefined "contributor recognition" system — so there is **no paid
fast-track** for our patches. Node-platform throughput is effectively gated on one core
collaborator (`acalcutt`) plus the TSC for anything non-trivial.

**Renderer state (matters for patch 2/3 drift).** The Drawable-based modularized renderer
is *mostly complete*, available behind a feature flag, with the **legacy renderer still
the default** and still receiving changes. Metal is built on the drawable path. The Metal
renderer internals our patches touch are therefore an **actively-evolving zone**, not
frozen (see §A).

**Upstream already owns patch 3's problem — declaratively.** `fill-layer-opacity` /
`line-layer-opacity` (feature-uniform, "overlapping features render as a single surface
at the given opacity") were **added to maplibre-gl-js and released** (PR #7570). The
matching native request is **open** (`maplibre-native#4298`, filed 2026-05-17, no PR yet,
no backend/node coverage). This is the exact semantics of our halo group compositing,
arrived at from the other direction (a paint property instead of an imperative
`setGroupComposite`). Consequence threaded through B/D below.

---

## A. Drift-risk assessment (cost per upstream release to stay forked)

Rebase surface = which upstream files each patch touches × how hot those files are in
recent history. Measured from upstream commit history:

| Patch | Lines | Files touched | Hotness of touched files | Rebase risk |
|---|---:|---|---|---|
| **1 — setGestureInProgress** | 53 | `platform/node/src/node_map.{cpp,hpp}` only | `node_map.cpp` is **cold**: last substantive change Feb 2026 (hillshade), before that Feb/Mar 2025, then 2023. The patch adds a prototype method next to `setPitch` — a stable anchor region. | **Very low.** Already re-verified clean on `node-v6.5.0-pre.1`. |
| **2 — readback-downsample** | 410 | `platform/default/{src,include}/mbgl/gfx/headless_{backend,frontend}`, `.../mtl/headless_backend`, `include/mbgl/mtl/offscreen_texture.hpp`, `src/mbgl/mtl/offscreen_texture.cpp`, `platform/node/src/node_map.cpp` | Headless platform-default files are moderately stable; the **Metal `offscreen_texture.cpp`** sits in the drawable/Metal subsystem that is under active optimization. | **Low–moderate.** Additive (new overloads + a new render option); collisions likely limited to signature/context churn in the Metal offscreen path. |
| **3 — group-composite** | 801 | **build system** (`CMakeLists.txt`, `cmake/metal.cmake`), core renderer (`renderer.cpp`, `renderer_impl.{cpp,hpp}`, `paint_parameters.hpp`, `gfx/context.{hpp,cpp}`), Metal (`mtl/context.hpp`, `mtl/renderer_backend.cpp`), **new** shader files + `shader_source.hpp`, `renderer/group_composite.hpp`, binding `node_map.{cpp,hpp}` | **Hot.** `renderer_impl.cpp`: ~7 commits Dec 2025–Apr 2026 including *"Fix scissor rectangle size"*, *"Disable scissor test when clearing on OpenGL"*, *"frustum offset when map is resized"* — i.e. **stencil/scissor/pass work directly adjacent to this patch's `resetTileClippingMasks` stencil fix**. `mtl/renderer_backend.cpp`: *"UBO consolidation"* (Jan 2025), *"Rename Symbol SDF shader"* (May 2025), *"fill-extrusion instancing"* (May 2026) — and the patch **reuses the heatmap shader's UBO layout/slots**, so UBO/shader-table churn can break it semantically, not just textually. | **High.** Both textual (build files, shader tables) and **semantic** (stencil bookkeeping, UBO layout) collision risk against a live subsystem. |

**Net:** patch 1 costs essentially nothing to carry. Patch 2 costs a small, mechanical
rebase per upstream bump. Patch 3 is the one that will genuinely hurt on rebase, and it
sits on top of code upstream is changing for adjacent reasons — the worst combination.

---

## B. PR strategy (per patch)

**Patch 1 — post now, as-is.** It's the textbook upstreamable change: binding-only, zero
core risk, exposes an *existing public core API* (`mbgl::Map::setGestureInProgress`) the
same way `setZoom/setBearing/setPitch` are already exposed, with a fully-measured
justification (0.93 px sawtooth → 0.0795 px, build-parity A/B). A ready package already
exists at `.spike/native-gl/UPSTREAM_PR_DRAFT.md`. It benefits every headless node user
animating a camera path, not just us — the ideal "generic option" framing. Orphan risk is
low: the only plausible different shape upstream might prefer is an `aligned:false` render
option, and the draft already offers that as a fallback. **Merge transfers the carry cost
to zero and lands the fix in stock prebuilts (incl. Windows).**

**Patch 2 — keep vendored; have the PR drafted but don't lead with it.** The
upstream-palatable framing exists and is real: "an optional backend-side box-downsample
render option for headless renderers, so supersampled captures don't ship the full
framebuffer across the GPU→CPU boundary" — a generic win for any headless/tile-server
user doing SSAA. It already ships a portable CPU fallback in core, which is exactly what
makes it reviewable. But it's a bigger ask (touches core headless paths + a Metal compute
pass), the review will be slower, and the payoff is performance, not correctness — so we
lose little by carrying it. **Sequence it after patch 1 lands** (establishes reviewer
trust and a relationship) and only if we're already engaged. Orphan risk: low-moderate —
upstream could add a different capture API, but nothing suggests they're working on one.

**Patch 3 — do NOT upstream in its current shape.** Two independent reasons:

1. **It's the wrong shape for upstream.** A Metal-only core compute/stencil pass with a
   new imperative `Renderer::setGroupComposites` API, a new shader, build-system edits,
   and an admitted non-Metal descope (base `createOffscreenTexture` ignores depth/stencil)
   is a large review with a self-declared portability hole. The patch's own README says
   the non-Metal flag-honoring "is required before any upstream PR."
2. **Upstream is already solving the same problem the other way.** `line-layer-opacity` /
   `fill-layer-opacity` (feature-uniform opacity — overlapping features composite as one
   surface) are **merged and released in maplibre-gl-js** (#7570), and **requested for
   native** (#4298). That is the accepted direction: a **declarative paint property**, not
   an imperative group API. Posting `setGroupComposite` would collide with maintainers'
   chosen model and is likely to be declined or, worse, merged-then-orphaned when the
   property lands on native.

   **Nuance that keeps patch 3 alive for now:** `*-layer-opacity` is **per single layer**.
   Our halo composite groups a **layer *pair*** (outer + fully-feathered core) into one
   coat — `haloGroupPolicy(outer, core)` composites two different layers as a unit. So the
   released property is a **drop-in only for the single-layer halo cases** (waypoint / POV
   circle halos); it does **not** by itself reproduce the outer+core group. Patch 3 is
   therefore not fully orphaned — but its *export-side* justification shrinks to the
   multi-layer grouping, and its *preview-side* twin can likely be retired today (see D).

---

## C. Windows dependency chain (the near-term ship exposure)

What the Windows port needs from this binding, and what breaks on drift:

1. **A patched binary, one way or another.** An *unpatched* upstream Windows prebuilt has
   none of our three capabilities. `nativeBackend.ts` **refuses to render** without
   `setGestureInProgress`, and fails loud without `readbackDownsample` on supersampled
   exports. So "just fetch upstream's win32 prebuilt" does **not** work until patch 1 (and
   patch 2's capability) are either upstreamed or built into a fork binary. The interim
   plan (PRODUCTION_PATH.md route 2/3: fork → run `node-release.yml` → ship the staged
   `mbgl-native-<triple>` dir via task 130) is the correct shape and **does** produce
   win32/arm64 patched binaries.

2. **Backend reality: Windows is never Metal.** The node addon builds against
   OpenGL/EGL/Vulkan on Windows (`windows-opengl|egl|vulkan` presets). Per-patch
   consequence:
   - **Patch 1:** backend-agnostic (pure transform state). ✅ Works on Windows.
   - **Patch 2:** the Metal compute pass won't run, but the patch ships a **bit-identical
     CPU fallback** in `gfx/headless_backend.cpp`, and the `readbackDownsample` capability
     is set **`true` unconditionally**. ✅ Windows gets correct output, CPU-bound (the
     55–90 ms/frame cost the Metal path was added to remove returns — a *performance*
     regression on Windows, not a correctness one).
   - **Patch 3:** ❌ **Broken on Windows, silently.** `groupComposite` is set **`true`
     unconditionally**, but `Context::createOffscreenTexture(size, type, depth, stencil)`
     on the base/non-Metal path **ignores the depth/stencil flags** (verified in the patch:
     `bool /*depth*/, bool /*stencil*/ → createOffscreenTexture(size, type)`). Without the
     stencil attachment, line layers can't tile-clip in the offscreen pass, so halo
     coverage stacks `1−(1−α)^k` at tile boundaries — the exact bug the composite was built
     to kill. Because the capability lies (`true`), the consumer's "fail loud on missing
     capability" guard **cannot catch it** — Windows renders wrong halos with no error.
     (Best case it instead hits the Metal-only shader and fails at draw; either way, not
     shippable.)

**Bottom line for the "no fork needed" ship-review conclusion:** it holds for patches 1
and 2. Patch 3 breaks it — **Windows needs either a real non-Metal group-composite backend
path, or a Metal-gated capability marker (so the guard fails loud instead of mis-rendering)
plus a decision to ship Windows without engine-level halo compositing**, before the Windows
port. This is orthogonal to the PR decision and is the single most important Windows action
item.

---

## D. Recommendation & sequencing

1. **Post patch 1 now** (`.spike/native-gl/UPSTREAM_PR_DRAFT.md`, as drafted). It is the
   cheapest, cleanest, highest-leverage move: it lands the raster-jitter fix in stock
   prebuilts including Windows, retires a carry cost entirely, and opens a maintainer
   relationship for later patches. Meanwhile keep riding the vendored patch until it's
   merged+released, then drop the patch and pin the released version (re-run the jitter A/B
   as the regression gate, per PRODUCTION_PATH.md).

2. **Fix patch 3's Windows behavior before the Windows port — regardless of PR plans.**
   Minimum: gate the `groupComposite` capability marker on an actual Metal/stencil-capable
   backend so the loud-fail guard fires on Windows instead of mis-rendering. Better:
   implement the non-Metal depth/stencil offscreen path (the descope the README already
   names). Decide explicitly whether Windows ships with engine-level halo compositing or
   without it in v1.

3. **Retire patch 3's *preview* twin, don't grow it.** `fill-layer-opacity` /
   `line-layer-opacity` are released in maplibre-gl-js. **Verify the property exists in the
   gl-js version we vendor (we pin `maplibre-gl 5.22.0`, patch
   `patches/maplibre-gl+5.22.0.patch`); if it landed in a later 5.x, weigh a bump.** If
   available, replace the preview-side vendored halo patch with the native paint property
   for the single-layer halo cases and let `mapVisuals` emit the property there — smaller
   vendored surface, one fewer engine patch to carry. Keep the imperative composite only
   where the outer+core *pair* grouping genuinely needs it.

4. **Hold patch 2 vendored; keep its PR drafted.** Post it only after patch 1 lands and
   only if we're engaged upstream. It's a performance nicety with a portable fallback —
   low downside to carrying, real review cost to pushing.

5. **Do NOT upstream patch 3's imperative API.** Instead: 👍/comment on `#4298`, and when
   `*-layer-opacity` reaches the native Metal/node renderer, migrate the export side to the
   property and delete patch 3. If we want to *accelerate* that, the high-value upstream
   contribution is **helping implement `#4298` on the native renderer** (the accepted
   shape), not landing our bespoke API — that's the version of "contributing patch 3" that
   maintainers would actually take.

**Fallback if upstream is unresponsive** (realistic — one node maintainer, no bounty
fast-track, TSC gate for non-trivial PRs): change nothing operationally. We already run the
fork-CI / vendored-binary route (`ensure-binding.mjs` builds from source on macOS; task 130
ships the staged per-triple dir like ffmpeg/exiftool). Carrying patch 1 costs ~nothing
(cold file), patch 2 a mechanical rebase per bump, patch 3 we were going to replace with
the upstream property anyway. The unresponsiveness scenario mainly costs us **patch 3's
Windows correctness**, which item 2 fixes on our own regardless.

**One distribution watch-item:** upstream is mid-migration off `node-pre-gyp`
(→ gh-release #4329, → `prebuild-install` draft #3819). If our fork/route-2 plan overrides
`binary.host` to resolve a fork's release assets, that resolution mechanism is changing
under us — pin against a specific upstream commit's packaging and re-check when we build
the Windows fork binary.

---

## E. Open questions for Matthew (with recommendations)

1. **Appetite for posting under your name/org?** Patch 1 is a strong, self-contained first
   PR with measured evidence and a friendly generic framing — low reputational risk, and
   it opens the door for the rest. *Recommendation: yes, post patch 1; it's the best
   possible first impression and the cheapest carry-cost win.* If you'd rather not engage
   publicly at all, the fork/vendored route still ships — patch 1 just stays a carried
   diff (near-zero cost).

2. **Windows v1 halo policy.** Ship Windows *without* engine-level halo compositing (gate
   the capability so it fails loud / falls back to plain per-layer alpha), or block the
   Windows port until the non-Metal offscreen path is implemented? *Recommendation: gate
   the capability honestly now (kills the silent-wrong-render), ship Windows on plain alpha
   for halos in v1, and pursue `#4298` as the real fix — halo self-overlap darkening is a
   visible-only-on-retrace/jitter defect, acceptable to defer on one platform for one
   release; a silently-wrong composite is not.*

3. **Preview-engine simplification appetite.** Are you willing to bump/verify the vendored
   `maplibre-gl` to pick up released `*-layer-opacity` and drop the preview halo patch?
   *Recommendation: worth it — it removes one of the two "ship-together" vendored engine
   patches and aligns the preview with upstream's accepted model.*

4. **Investment in `#4298`.** Do you want to be the contributor who lands feature-uniform
   opacity on the native renderer (the accepted shape), converting our vendored patch 3
   into upstreamed maintenance-transferred code? *Recommendation: attractive medium-term —
   it's the only version of "upstream patch 3" that survives review — but scope it
   deliberately (it's core Metal + the other backends), and it is not on the Windows
   critical path (item 2 is). Not a v1 blocker.*
