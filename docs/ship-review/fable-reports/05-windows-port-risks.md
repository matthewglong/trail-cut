# Windows Port — Risk Register

**Scope:** TrailCut (Tauri 2; React/TS front end, Rust backend, FFmpeg CLI export pipeline, headless maplibre-native map renderer in a Node sidecar). Ships on macOS today; Windows is the near-term target. Nearly everything was built and validated macOS-only.

**Method:** each risk is classified **MEASURED** (validated on macOS, mechanism understood, portability is the question) / **ASSUMED** (believed portable, unverified) / **UNKNOWN** (no evidence either way), with the blast radius if it fails and the cheapest validation step (a probe, not a port). Ordered by blast radius × uncertainty. Code cited `file:line`. No human-time estimates — scope/risk/unknowns only.

**Author's note on the biggest surprise:** the two vendored maplibre-native patches that make the renderer work — readback-downsample (speed) and group-composite (halo correctness) — are **explicitly Metal-only in their own source comments**, and the Windows node binding renders through **OpenGL**, not Metal. That is the single fact that most changes the shape of the port. Details in Risk #1.

---

## (a) Top-5 "could sink the port" risks

### 1. The two vendored maplibre-native patches are Metal-only; Windows renders on OpenGL — MEASURED (that they won't run) / UNKNOWN (port cost)

**What the code says.** The renderer depends on two locally-vendored native patches staged into `src-tauri/binaries/mbgl-native-<triple>/`:

- **Patch: `readback-downsample`** — an on-GPU box-filter reduction. Its own header: *"backends may override with an on-GPU reduction (the Metal backend does)"* (`native/readback-downsample.patch:55-56`); the compute implementation is Metal-only (`#include <Metal/Metal.hpp>`, `computeCommandEncoder`, `readback-downsample.patch:273,366`). When the GPU path is absent, core falls back to the CPU box-filter — *the exact path measured as the export-speed bottleneck under CPU contention* (memory: export-speed forensics 2026-07-03; PROGRESS 2026-07-03 cont. 2).
- **Patch: `group-composite`** (halo self-overlap compositing, shipped v11, CANON §2.7) — *"Only the Metal backend honors the flags; the base fallback ... is Metal-only today"* (`native/group-composite.patch:35-37`), and the shader is `ShaderSource<…GroupCompositeShader, gfx::Backend::Type::Metal>` with a Metal-only `renderer_backend.cpp` (`group-composite.patch:170,372-375`). The GL renderer backend has **no** group-composite shader.

**What research says.** maplibre-native's Node binding builds with `MLN_WITH_OPENGL` on Windows (CMake preset `windows-opengl-node` in `node-release.yml`/`CMakePresets.json`) — desktop OpenGL via WGL, **not** ANGLE, EGL, Vulkan, or Metal. Windows/arm64 win32 prebuilts *do* ship (Node 22/24/26). So on Windows these two patches land on a backend that cannot execute either GPU path.

**Blast radius — two separate failures:**
- **Correctness (severe):** halo compositing silently no-ops on GL. The capability markers `readbackDownsample`/`groupComposite` are set **unconditionally** at module init (`ensure-binding.mjs:107-108,117` probes them; the patch sets them regardless of backend, `group-composite.patch:258-260`), so the "fail loud on missing capability" guard **will not fire** — the binding reports `groupComposite === true` while doing nothing. Result: every Windows export of a project using halos (a shipped feature; out-and-back retraces, GPS-jitter sunbursts) renders additive over-bright blooms instead of the composited halo. This is a wrong-output-that-passes-the-guard failure, the worst kind.
- **Speed:** readback-downsample reverts to the CPU box filter → the known 2.5–6× export slowdown under contention.

**Cheapest probe:** on a Windows box, run `native/ensure-binding.mjs`'s upstream-prebuilt path (win32 prebuilt exists), apply the two patches, and (i) assert whether the patches even *apply/compile* against the GL backend tree, (ii) render one halo test frame and one SSAA frame, (iii) diff against the macOS Metal golden. Expect the halo frame to differ structurally (not just ±LSB) — that confirms the GL no-op. Do this **before** any other Windows work; it gates whether the port needs a GL/Vulkan shader port of both patches (large, upstream-shaped scope) or a Vulkan-backend build instead.

### 2. `global_config_dir()` reads `$HOME`, which is unset on Windows — MEASURED

`src-tauri/src/util/fs.rs:9`: `std::env::var("HOME").map_err(|_| "Cannot determine home directory")?`. Windows does not set `HOME` by default (it uses `USERPROFILE` / the Known Folder API). This function backs `recent_projects_path()`, the encoder-probe cache (`encoder.json`), and `camera_presets_path()` (`fs.rs:15-26`, `encoder.rs:139`). On Windows every one of these returns `Err("Cannot determine home directory")`.

**Blast radius:** recents never persist (home gallery empties every launch); the encoder probe never caches so it re-runs its multi-encoder test-encode sweep on **every** export (`select_encoder` → `probe_all`, `encoder.rs:217-227`); camera presets are lost. Not a crash, but core state management is broken app-wide. Note this is **distinct** from the Tauri asset-protocol `$HOME` scope (`tauri.conf.json:27`), which Tauri resolves via the `dirs` crate and *does* work on Windows — so the config-store break is easy to miss because the front-end file serving still functions.

**Cheapest probe:** none needed to confirm the defect (the code is unambiguous). Fix is `dirs::home_dir()` / `dirs::config_dir()` (already a transitive dep via Tauri). Probe only the *fix*: assert `global_config_dir()` resolves under `%USERPROFILE%\.trailcut` on Windows.

### 3. Golden-frame / jitter / crispness gates are macOS-Metal baselines; Windows is GL and unmeasured — MEASURED (macOS) / UNKNOWN (Windows)

The mechanical verdict (`.spike/native-gl/MECHANICAL_VERDICT.md`, CANON §2.5) explicitly lists Windows/ANGLE as **unmeasured**, and the golden gate tolerates only a ±1-LSB Metal boot wobble. MapLibre's own project states Metal was conformed to OpenGL *"without adjusting the acceptable pixel difference threshold … aside from a handful of exceptions"* and maintains **per-platform** expected-image baselines compared with pixelmatch — i.e., cross-backend output is "within threshold," **not** bit-exact. A ±1-LSB gate captured on Metal will not pass against GL.

**Blast radius:** the whole visual-regression safety net (jitter, crispness, HDR tracers, golden frames) is invalid on Windows until re-baselined; worse, the *actual* jitter/crispness behavior on the GL backend is unknown — the native-jitter spike (memory: native renderer jitter) proved jitter-free on the **vector** basemap on **Metal at 4K**; that result does not transfer to GL.

**Cheapest probe:** capture a Windows-GL golden set for the existing gate scenes, diff against the macOS set, and quantify the delta (max channel error, structural vs noise). This tells you whether Windows needs its own baseline set (cheap) or whether GL introduces real jitter/crispness regressions (expensive).

### 4. Export filtergraph is passed inline in argv; Windows CreateProcess caps the command line at 32,767 chars — MEASURED (mechanism) / UNKNOWN (whether real graphs exceed it)

The composite filtergraph is emitted as a string inside `plan.argv` and spawned via `Command::new(ffmpeg_path).args(&plan.argv)` (`filtergraph.rs:35`, consumed at `ffmpeg_sink.rs:104`, `ffmpeg_runner.rs:65`). Rust's `Command` calls `CreateProcessW` directly (no `cmd.exe`), so the hard ceiling is **32,767 characters** (Raymond Chen / MS docs). macOS/`execve` has a far larger `ARG_MAX`, so this has never bitten. Our composite graphs scale with clip count × (per-clip color conversion + crop/speed + map overlay + halo core/falloff layers + waypoint symbols) and can grow large.

**Blast radius:** a big project (many clips, halos + waypoints on each) exports fine on macOS and fails to spawn ffmpeg on Windows only — a data-dependent, "works on my machine" failure that surfaces at a customer, not in a smoke test.

**Cheapest probe:** dump the `filter_complex` string for a worst-case project (max clips, all decorations + halos) and measure its char length against 32,767. If it's within ~2× of the ceiling, route it through `-/filter_complex <file>` (or `-filter_complex_script`, both confirmed present on gyan/BtbN Windows builds) unconditionally — this also helps macOS robustness and is cheap.

### 5. No `CREATE_NO_WINDOW` on any subprocess spawn — MEASURED

There are zero `creation_flags` / `CREATE_NO_WINDOW` / `CommandExt` usages in the backend (grep: none). Every spawn — ffmpeg (`ffmpeg_runner.rs:65`, `ffmpeg_sink.rs:104`, `commands/ffmpeg.rs:266,322,575,629`, `encoder.rs:249,271,508`), ffprobe (`ffprobe.rs:120`), exiftool (`util/exiftool.rs:22`, `commands/ffmpeg.rs:501`), and the Node renderer workers (`orchestrator.rs:409`) — will pop a console window on Windows. Proxy generation, thumbnailing, import, encoder probing, and *every export worker* each flash a black console.

**Blast radius:** for a consumer app shipping to thousands, this reads as broken/malware-ish — windows flashing throughout normal use, and N console windows during export. Cosmetic, but ship-blocking for a polished product. Fix is a one-line `#[cfg(windows)] .creation_flags(0x08000000)` at each spawn (or a small spawn wrapper).

**Cheapest probe:** run any single ffmpeg-invoking flow on Windows (e.g. import → proxy gen) and watch for the console flash; confirms all sites share the defect.

---

## (b) Full risk register (ordered by severity = blast radius × uncertainty)

| # | Risk | Area | Class | Blast radius | Cheapest validation probe |
|---|------|------|-------|--------------|---------------------------|
| 1 | maplibre-native patches (readback-downsample, group-composite) are Metal-only; Windows binding is OpenGL. Capability markers set unconditionally → fail-loud guard won't catch the GL no-op | Renderer | MEASURED / UNKNOWN | Halo export **wrong** (silent); export **slow** (CPU downsample fallback) | Apply both patches to a Windows GL prebuilt; render a halo + SSAA frame, diff vs macOS golden; check whether patches even compile against GL tree |
| 2 | `global_config_dir()` uses `std::env::var("HOME")` (unset on Windows) | Paths | MEASURED | Recents never persist; encoder probe re-runs every export; camera presets lost | Confirmed by inspection (`fs.rs:9`); probe the fix resolves `%USERPROFILE%\.trailcut` |
| 3 | Golden/jitter/crispness gates are macOS-Metal; Windows GL unmeasured; ±1-LSB tolerance won't survive backend change | Renderer / CI | MEASURED / UNKNOWN | Visual safety net invalid on Windows; possible real GL jitter/crispness regressions | Capture Windows-GL golden set, diff vs macOS, quantify delta magnitude |
| 4 | Inline `filter_complex` in argv vs 32,767-char CreateProcess limit | External CLI | MEASURED / UNKNOWN | Large projects fail to spawn ffmpeg on Windows only (data-dependent) | Dump worst-case `filter_complex`, measure length; if near ceiling, switch to `-/filter_complex` file |
| 5 | No `CREATE_NO_WINDOW` on any spawn | External CLI | MEASURED | Console windows flash on every ffmpeg/ffprobe/exiftool/node call; N consoles during export | Run one proxy-gen flow on Windows, observe flash |
| 6 | Renderer binding has no Windows staging path: `host_target_triple()` returns `"unsupported-host"` (`orchestrator.rs:204-210`); `ensure-binding.mjs:85-89` errors on non-darwin (no win32 fetch path yet) | Renderer / Packaging | MEASURED | Renderer binding cannot be located/built on Windows until task 130 grows the win32 branch | Add win32 triples + prebuilt-fetch to `ensure-binding.mjs`; assert `resolve_mbgl_native` finds the staged dir |
| 7 | Node runtime not bundled — sidecar spawns bare `node` from PATH (`orchestrator.rs:110`) | Packaging | MEASURED | End users have no Node → export can't start (true on macOS too, but Windows users even less likely to have Node) | Bundle a Node runtime (or a compiled sidecar); point `node_path` at it |
| 8 | Bundled Windows ffmpeg must include **libzimg (zscale)** AND **libx265** or the color pipeline + crispness gate fail loud (`assert_ffmpeg_has_zscale`, `color_fixtures.rs:63`; libx265-first policy, `encoder.rs:387-419`) | External CLI / Packaging | MEASURED | Color pipeline hard-fails without zscale; decorations go mushy without libx265 (hardware HEVC crushes chroma edges, memory: decoration-crispness) | Ship gyan.dev *full/essentials* or BtbN **gpl** (both have libzimg + libx265); BtbN **lgpl** lacks x265 — do not use it. Run the color suite against the bundled binary |
| 9 | `write_atomic` uses `std::fs::rename` over the destination; Windows fails with a sharing violation if the target is open/locked, and Rust std doesn't guarantee POSIX-semantics replace (`fs.rs:65`) | Paths | ASSUMED | `project.json` unlikely held open (low), but **proxy regeneration** while the video player holds the proxy open in WebView2 will fail the replace (Windows locks open files; macOS does not) | On Windows, regenerate a proxy while it's playing in the preview; observe rename failure. Consider `ReplaceFileW`/tempfile-persist |
| 10 | ExifTool on Windows is `exiftool.exe` **plus** a required `exiftool_files/` folder, not a lone binary | Packaging | MEASURED | Bundling `exiftool.exe` alone (task 130) breaks import — no Perl runtime | Bundle both, co-located; verify `run_exiftool` reads `CreationDate` from an iPhone clip on Windows |
| 11 | Windows hardware-encoder fallback path unproven — the `#[cfg(target_os="windows")]` candidate list exists (`encoder.rs:387-419,452-484`) but no `hevc_nvenc/qsv/amf` test-encode has ever run | Encoders | ASSUMED | libx265 is primary so fidelity is safe; but on a libx265-less user build, fallback selection is untested (test-encode args may be rejected by a real driver) | On Windows GPUs, run `probe_all()` and confirm each hardware candidate's `test_extra_args` is accepted (`encoder.rs:502`) |
| 12 | Fractional DPR (1.25 / 1.5 / 1.75) and per-monitor DPI changes on Windows vs macOS integer 2× | Rendering / DPI | ASSUMED | `previewDisplayScale`/pixelRatio levers (`src/lib/layout.ts`, MAP_RENDERING_PLAN) assume clean ratios; fractional DPR → fuzzy 1px decoration edges, and DPR changes when the window crosses monitors | Run preview at 125%/150% and on a mixed-DPI multi-monitor setup; check decoration crispness and that pixelRatio re-reads on monitor move |
| 13 | Code signing + SmartScreen for a new publisher; EV no longer grants instant reputation (MS change, Mar 2024) | Packaging / Distribution | MEASURED (industry) | Early adopters see "Windows protected your PC" until download reputation accrues, regardless of OV vs EV | Decision, not a probe — see open questions. Evaluate Azure Trusted Signing |
| 14 | NSIS `externalBin` sidecars may not be replaced on upgrade (Tauri open issue #15134) | Packaging | MEASURED (upstream) | Stale bundled ffmpeg/exiftool/renderer left behind after an app update → version skew | Version sidecar filenames or force clean replace; test an in-place upgrade |
| 15 | `convertFileSrc(`${projectDir}/${ref.icon_file}`)` builds paths with `/` against Windows backslash `projectDir` (`MapView.tsx:807`, `MarkerSection.tsx:173`, `HomeScreen.tsx:80`) | Paths / Assets | ASSUMED | Mixed-separator paths usually work (Windows accepts `/`), but drive-letter + UNC + the asset-scope match against `$HOME/**` should be confirmed for marker/thumbnail loading | Load a project with marker-library images on Windows; confirm tiles render (asset protocol resolves the path) |
| 16 | WebView2 HEVC/HDR preview limitations | Preview | MEASURED → LOW | **Mitigated:** proxies are always libx264 H.264, tonemapped to SDR bt709 (`commands/ffmpeg.rs:104-150`), so the preview never decodes HEVC/HDR. H.264 is native in WebView2. Only a concern if the preview ever plays source directly | Confirm preview plays a proxy on a stock Windows 10/11 WebView2 (expected fine) |
| 17 | Long paths (>260 `MAX_PATH`) for bundled CLI sidecars on deep `.trailcut` bundle paths | Paths | ASSUMED | Rust std auto-handles `\\?\` since 1.58, but shelled-out ffmpeg/exiftool on a deeply-nested user-chosen bundle path can still hit MAX_PATH without the `longPathAware` manifest + registry opt-in | Put a `.trailcut` bundle at a >260-char path; run an export; watch for ffmpeg path-open failures |
| 18 | `git`-less CI: whole suite assumes brew-provisioned `ffmpeg-full`; Windows CI leg needs a libzimg+libx265 ffmpeg on PATH or every color test panics immediately via `assert_ffmpeg_has_zscale` | CI | MEASURED | No Windows CI coverage until the runner is provisioned with a correct ffmpeg; the loud precondition fires first | Add a Windows CI leg that installs gyan/BtbN-gpl ffmpeg; run `cargo test` and see which precondition panics fire |
| 19 | stdio protocol line-ending / binary-mode assumptions in the sidecar (`orchestrator.rs` uses `AsyncBufReadExt` line reads; frames cross as base64 text per memory) | Renderer / IPC | ASSUMED → LOW | Node `process.stdout.write` with explicit `\n` stays `\n`; frames are base64 text (no binary CRLF translation). Low risk but unverified on Windows | Run one render on Windows; confirm frame parity (no truncation/CRLF corruption) |

---

## (c) Recommended validation sequence (cheapest-first, de-risk the most before porting)

The goal is to answer the expensive/unknown questions with cheap probes before committing to any port work. Ordered so each step either kills a top risk or unlocks the next.

1. **Static confirmations (no Windows box needed).** Fix-scope the two guaranteed defects now: `HOME` → `dirs::home_dir` (Risk #2), and add `CREATE_NO_WINDOW` at every spawn (Risk #5). Both are unambiguous from the code; no probe required, just the fix + a Windows smoke test later. Also measure the worst-case `filter_complex` length (Risk #4) — pure macOS-side dump, tells you immediately whether the 32K ceiling is in play.

2. **The renderer patch probe (Risk #1 — the port-shaping question).** On a single Windows box: fetch the upstream win32 node prebuilt, apply `readback-downsample` and `group-composite`, and see whether they (a) compile against the GL backend tree at all, (b) produce correct halo output. This one probe determines whether the renderer port is "re-baseline goldens" (cheap) or "port two Metal shaders to GL/Vulkan, or build the Vulkan node backend" (large). Everything else is minor by comparison — do this before scheduling the port.

3. **Golden delta quantification (Risk #3).** On the same box, capture the GL golden set for the existing gate scenes and diff against macOS. Decides whether Windows needs only its own baselines or whether GL has real jitter/crispness regressions.

4. **ffmpeg build validation (Risks #8, #11, #18).** Bundle a candidate Windows ffmpeg (gyan full or BtbN gpl), run the color suite and `probe_all()` against it. Confirms zscale + libx265 presence and that the Windows hardware-encoder candidates are accepted by real drivers.

5. **End-to-end packaging smoke (Risks #6, #7, #10, #14, #15, #17, #19).** Wire the Windows triples into `ensure-binding.mjs`/`host_target_triple`, bundle Node + ffmpeg + exiftool(+folder), build an NSIS installer, install on a clean Windows VM, and run import → preview → export end to end. This surfaces the packaging-layer risks together.

6. **DPI + preview polish (Risks #12, #16).** Last, because they're refinements, not blockers: check preview crispness at fractional scaling and on mixed-DPI multi-monitor.

Steps 1 and 2 are the leverage points: step 1 removes two certain defects for near-zero cost, and step 2 answers the one question that decides the size of the whole port.

---

## (d) Open questions for Matthew (with recommendations)

1. **Renderer backend on Windows: port the Metal patches to GL, or build the Vulkan node backend?** The two patches are Metal-only and the stock Windows node binding is OpenGL. maplibre-native now has a Vulkan renderer; a Vulkan node build might be a cleaner target than back-porting shaders to legacy GL. **Recommendation:** run the Risk #1 probe first, then decide — but bias toward whichever backend upstream is investing in (Vulkan) rather than sinking shader work into GL. Either way, budget for re-baselining goldens per backend (Risk #3). This is the decision the whole port hangs on.

2. **Group-composite fail-loud gap.** The capability marker is set unconditionally, so the "fail loud on missing capability" contract (CANON §2.7) does **not** protect Windows — the binding claims the capability and silently no-ops. **Recommendation:** make the marker backend-conditional (only `true` when the compositing path actually exists) so the existing guard catches GL/unported backends instead of shipping wrong halos. Small change, closes a silent-wrong-output hole.

3. **FFmpeg build + licensing.** libx265 forces GPL on the distributed ffmpeg (both gyan and BtbN-gpl). Shipping to thousands makes this a licensing posture, not just a technical pick. **Recommendation:** gyan.dev *full* or BtbN **gpl** (both carry libzimg + libx265 + MediaFoundation/NVENC/QSV/AMF); explicitly do **not** ship BtbN *lgpl* (no x265). Confirm you're comfortable distributing GPL ffmpeg alongside the proprietary app (dynamic-link/aggregate, standard for this pattern).

4. **Code signing tier.** As of March 2024, EV certs no longer skip SmartScreen — OV and EV both earn reputation through download volume. **Recommendation:** don't pay the EV premium expecting an instant clean pass. Evaluate **Azure Trusted Signing** (Microsoft's managed service) as the modern low-friction route; accept that early adopters may see a SmartScreen prompt until reputation accrues, and factor that into launch comms.

5. **WebView2 rendering reproducibility.** Evergreen WebView2 auto-updates could drift the preview's Chromium rendering across user machines and over time. **Recommendation:** for an app whose whole premise is preview/export parity, consider `fixedVersion` WebView2 (larger installer, reproducible rendering) rather than the default `downloadBootstrapper` — weigh installer bloat against silent rendering drift.

6. **Atomic-save robustness on Windows.** `write_atomic`'s rename-over-existing is fine for `project.json` but not for the proxy-regenerate-while-playing case (Windows locks open files). **Recommendation:** confirm via the Risk #9 probe; if it bites, close the player's handle before regen or move to `ReplaceFileW`/`tempfile` persist.

---

## Appendix — what is *already* Windows-ready (de-risked)

- **Encoder candidate lists exist for Windows** — `encoder.rs` has real `#[cfg(target_os="windows")]` HEVC (`libx265` → `hevc_nvenc`/`qsv`/`amf`) and H.264 (`h264_nvenc`/`qsv`/`amf` → `libx264`) branches (`encoder.rs:387-419,452-484`), libx265-first per the crispness policy. The *policy* is ported; only the *runtime acceptance* of the hardware fallbacks is unproven (Risk #11).
- **Preview codec is safe** — proxies are always libx264 H.264 tonemapped to SDR (`commands/ffmpeg.rs`), and H.264 is native in WebView2, so the HEVC/HDR WebView2 caveats don't touch the preview (Risk #16).
- **`std::fs::rename` does overwrite on Windows** — the atomic-save premise holds for the common case; only the open/locked-target edge is a risk (Risk #9).
- **maplibre-native ships win32 prebuilts** (x64 + arm64, Node 22/24/26) — the binding doesn't have to be built from source on Windows; `ensure-binding.mjs` just needs a fetch branch (Risk #6).
- **Rust std auto-handles long paths** (`\\?\` since 1.58) for its own fs calls — only the shelled-out CLIs need the manifest opt-in (Risk #17).
- **Tauri's `$HOME` asset scope resolves on Windows** (via `dirs`), so front-end file serving works even though the Rust `global_config_dir` `HOME` read does not — don't conflate the two (Risk #2).

---

### Sources (external research)
- maplibre-native Windows node backend = OpenGL, win32 prebuilts ship: `node-release.yml` + `CMakePresets.json` (`windows-opengl-node`), `platform/node/README.md`; Metal↔GL "within threshold, not exact" + per-platform baselines: MapLibre Nov-2023 newsletter, render-tests docs.
- Windows ffmpeg builds (libzimg + libx265 + MediaFoundation/NVENC/QSV/AMF): gyan.dev/ffmpeg/builds, github.com/BtbN/FFmpeg-Builds (gpl vs lgpl). CreateProcess 32,767 limit: MS "Old New Thing" 2003-12-10. `-/filter_complex` / `-filter_complex_script`: ffmpeg.org/ffmpeg.html. `CREATE_NO_WINDOW` 0x08000000: Rust `CommandExt` docs. ExifTool `.exe` + `exiftool_files/`: exiftool.org.
- Tauri 2 Windows installer/externalBin + WebView2 (`downloadBootstrapper` default, `fixedVersion`): v2.tauri.app/distribute/windows-installer, tauri issue #15134. SmartScreen/EV change Mar 2024: learn.microsoft.com SmartScreen reputation + DigiCert alert. `std::fs::rename` Windows semantics + open-file sharing violation: doc.rust-lang.org/std/fs/fn.rename, rust-lang/rust#123985. Fractional DPR on Windows: Chromium/WebView2 report 1.25/1.5/1.75.
