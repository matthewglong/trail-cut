# Shipping-Dependency Research: FFmpeg / ExifTool / Node+Chromium Sidecars (task 130)

**Date:** 2026-06-11
**Scope:** What it actually takes to ship TrailCut's external runtime dependencies to thousands of end users on macOS (now) and Windows (near-term), instead of resolving them from `PATH`. Covers licensing, trustworthy binaries, signing/notarization, Tauri 2 sidecar mechanics, and the Chromium-renderer bundling question.
**Method:** Web research (June 2026) + direct codebase inspection. Every claim cites a file:line or URL.

---

## 0. Current state in the codebase (what task 130 has to replace)

All four runtime dependencies are resolved from the developer's `PATH` or repo-relative dev paths today:

| Dependency | Resolution today | Locations |
|---|---|---|
| `ffmpeg` | `Command::new("ffmpeg")` | `src-tauri/src/commands/ffmpeg.rs:266,322,575,629`; `src-tauri/src/export/ffmpeg_runner.rs:233`; hook for future bundled path exists at `src-tauri/src/export/encoder.rs:101-110` (`set_ffmpeg_path`, "task 130 will call this with the [bundled] path") |
| `ffprobe` | `PATH` via `export::mod::ffprobe_path` | comment at `src-tauri/src/commands/ffmpeg.rs:194`; `src-tauri/src/export/mod.rs:996` ("Sidecar bundling (task 130) will swap this for the bundled binary") |
| `exiftool` | `Command::new("exiftool")` | `src-tauri/src/util/exiftool.rs:22` (metadata read); `src-tauri/src/commands/ffmpeg.rs:501` (ICC embed into thumbnail JPEGs) |
| `node` | `PathBuf::from("node")` | `src-tauri/src/export/orchestrator.rs:80` (`node_path` default), spawned at `orchestrator.rs:409` |
| Chrome (renderer) | repo-relative dev path or `TRAILCUT_CHROME_BIN`; ships via `bundle.resources` | `src-tauri/src/export/orchestrator.rs:150-175` (`resolve_chrome`); `src-tauri/tauri.conf.json:43-45` (`"resources": ["binaries/chrome-*/**/*"]`); `src-tauri/sidecars/renderer/index.ts:265-289` (`chromeBinaryPath`, puppeteer-core launch) |

Measured locally (2026-06-11):
- `src-tauri/binaries/chrome-aarch64-apple-darwin` (Chrome for Testing .app tree) = **343 MB on disk**.
- Renderer bundle `src-tauri/sidecars/renderer/dist` = **9.1 MB** (the .cjs itself is cheap; Chrome + Node are the weight).

The renderer deliberately uses **full Chrome, not chrome-headless-shell**, because the shell has no GPU path on macOS — new headless mode routes WebGL through ANGLE→Metal (`src-tauri/sidecars/renderer/index.ts:2-18,285-289`). Any bundling decision must preserve a GPU-accelerated WebGL path or replace the renderer outright.

Encoder selection (`src-tauri/src/export/encoder.rs:318-461`) already prefers **hardware encoders first**: `hevc_videotoolbox` (line 343) and `h264_videotoolbox` (line 408) on macOS, with `libx265`/`libx264` as fallbacks (lines 350, 415, 449, 461), plus `prores_ks` (FFmpeg-native, line 323). The color pipeline hard-requires **zscale/libzimg** at every ingest path (`src-tauri/src/export/delivery.rs:40,178-182`; `src-tauri/tests/color_fixtures.rs` `assert_ffmpeg_has_zscale`; CLAUDE.md "Dependencies to have installed").

---

## 1. FFmpeg bundling

### 1.1 Licensing: LGPL core, GPL components, and the process-boundary question

- FFmpeg itself is **LGPL v2.1+ by default**; enabling GPL components (notably **libx264, libx265**) via `--enable-gpl` makes **the whole binary GPL**: "if those parts get used the GPL applies to all of FFmpeg." Checklist items from the official legal page ([ffmpeg.org/legal.html](https://www.ffmpeg.org/legal.html)):
  - "Compile FFmpeg **without** `--enable-gpl` and **without** `--enable-nonfree`."
  - "Make sure your program is not using any GPL libraries (notably libx264)."
  - "Distribute the source code of FFmpeg, no matter if you modified it or not" — the source-offer obligation applies to LGPL *and* GPL distribution.
  - LGPL-section advice about **dynamic linking** applies to apps that *link* libav* libraries. TrailCut does not link FFmpeg — it execs the CLI binary.
- **Process boundary (the load-bearing legal fact):** the FSF GPL FAQ says "pipes, sockets and command-line arguments are communication mechanisms normally used between two separate programs," and mere aggregation (shipping programs side by side) "has no effect on the other program." Invoking a GPL `ffmpeg` binary via `exec` + CLI args + pipes is the canonical "separate programs" case; intimacy only arises from "sharing complex data structures" in a shared address space ([GNU GPL FAQ, MereAggregation/exec sections](https://www.gnu.org/licenses/gpl-faq.en.html#MereAggregation)). TrailCut's filtergraph strings and stdin frame pipes are classic arm's-length CLI usage.
  - Consequence: **TrailCut does not have to become GPL to bundle a GPL ffmpeg binary.** The GPL obligations attach to the ffmpeg binary itself: ship its license text, and provide the *exact corresponding source* (config line + source tarball, e.g. hosted on TrailCut's site or repo). This is not fringe lawyering — it is the FSF's own published position on exec-level communication, though note the FAQ's "it depends on intimacy" hedge means a conservative counsel review is still prudent before ship.
- **What shipping apps actually do** — both patterns exist:
  - **Bundle GPL ffmpeg outright:** LosslessCut (Electron, on the Mac App Store) bundles a GPL ffmpeg binary and is itself GPL-2.0 ([github.com/mifi/lossless-cut](https://github.com/mifi/lossless-cut), [losslesscut.net](https://losslesscut.net/)). HandBrake, Shotcut, Kdenlive, OBS similarly ship GPL.
  - **External-download pattern:** Audacity historically required a *separate FFmpeg download* "to comply with licensing requirements" — driven by codec licensing concerns, not just GPL ([manual.audacityteam.org/man/license.html](https://manual.audacityteam.org/man/license.html), [free-codecs.com FFmpeg-for-Audacity guide](https://www.free-codecs.com/guides/how-to-install-ffmpeg-for-audacity.htm)). This pattern is a *product-quality cost* (first-run friction, offline failure, support burden) and is exactly the "fix your environment" anti-pattern CLAUDE.md forbids as a product answer.
  - Proprietary apps that bundle FFmpeg as **LGPL builds** (no libx264/x265, relying on hardware encoders or licensed codecs) include Descript — see their maintained fork of static binaries ([github.com/descriptinc/ffmpeg-ffprobe-static](https://github.com/descriptinc/ffmpeg-ffprobe-static)); Telegram/Discord link LGPL libav*.
- **Patents are orthogonal to copyright license.** H.264/HEVC are patent-encumbered regardless of GPL/LGPL ([ffmpeg.org/legal.html](https://www.ffmpeg.org/legal.html); [x264.org/licensing](https://x264.org/licensing/)). The Via Licensing Alliance (acquired MPEG LA, 2023) AVC royalty table: **$0.00 for the first 1–100,000 branded encoder/decoder units per year**, $0.20/unit for 100,001–5M ([via-la.com AVC license fees](https://www.via-la.com/licensing-programs/avc-h-264/)). TrailCut at "thousands of users" is far inside the free tier for AVC; HEVC pools (Access Advance / Via-LA HEVC) have their own (less generous) terms — but note that **VideoToolbox/Media Foundation hardware encoders shift the codec implementation to the OS vendor's licensed silicon/OS path**, which is the practical reason most small apps using hw encode never engage the pools.

### 1.2 What this means for TrailCut specifically

TrailCut's encoder table already prefers `*_videotoolbox` on macOS with `libx264/x265` as fallback (`encoder.rs:340-420`). Two viable ship configurations:

1. **LGPL static ffmpeg (recommended baseline):** build with `--enable-videotoolbox` (macOS) / Media Foundation or AMF/NVENC/QSV (Windows), `--enable-libzimg` (zimg is **WTFPL**, LGPL-compatible — [github.com/sekrit-twc/zimg](https://github.com/sekrit-twc/zimg)), `prores_ks` (native, LGPL). **No libx264/x265 in the shipped binary** — the encoder probe's fallback chain simply never finds them, which is already handled (`candidates_for` probes what the binary has). Cost: machines where hw encode is missing/broken have no software H.264/HEVC fallback; on Apple Silicon + modern Windows GPUs this is a small population, but it must become a *loud* probe error, not silence (per the loud-failure rule).
2. **GPL static ffmpeg + source offer (max capability):** keep libx264/libx265 software fallback; comply with GPL *for the ffmpeg binary only* (license text in about-box, config line, hosted source tarball matching the build). Supported by the FSF exec-boundary position above and by precedent (LosslessCut et al.).

Either way: **the external-download pattern is not needed** and should be rejected for product reasons.

### 1.3 Trustworthy prebuilt static binaries (state of 2025–2026)

- **Windows:** [gyan.dev CODEX builds](https://www.gyan.dev/ffmpeg/builds/) (linked from ffmpeg.org; GPL-configured "essentials"/"full") and [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (daily CI builds, **both GPL and LGPL variants**, win64 + linux64; reproducible from public GitHub Actions). BtbN's LGPL variant is the closest off-the-shelf match for strategy (1) on Windows — verify zimg + Media Foundation/AMF/NVENC flags per release.
- **macOS:** [evermeet.cx](https://evermeet.cx/ffmpeg/) (officially linked from ffmpeg.org/download.html; **Intel-only**, GPL-configured) and [ffmpeg.martin-riedl.de](https://www.animmouse.com/p/ffmpeg-binaries/) (arm64 + Intel, regularly updated). **BtbN does not produce macOS builds.** There is no widely-blessed *LGPL arm64 macOS* static build — for strategy (1) on macOS, TrailCut should build its own in CI (an ffmpeg build script pinning the config line, which doubles as the GPL/LGPL "exact corresponding source" artifact). npm wrappers ([eugeneware/ffmpeg-static](https://github.com/eugeneware/ffmpeg-static), [descriptinc/ffmpeg-ffprobe-static](https://github.com/descriptinc/ffmpeg-ffprobe-static), [Tyrrrz/FFmpegBin](https://github.com/Tyrrrz/FFmpegBin)) repackage the above sources and are useful as provenance references, not as a supply chain.
- **Supply-chain note:** whichever source is chosen, pin exact versions + SHA-256 in the repo and verify in CI; the color pipeline's zscale hard requirement means **CI must assert `-filters` contains `zscale` on the actual shipped binary** (extend the existing `assert_ffmpeg_has_zscale` pattern in `src-tauri/tests/color_fixtures.rs` to run against the bundled binary, not the dev `PATH` one).

### 1.4 macOS notarization / Windows signing of bundled CLI binaries

- **macOS:** notarization requires that *every Mach-O in the bundle* (main app, helpers, sidecars, dylibs, nested frameworks) be codesigned with **hardened runtime** (`codesign -o runtime`) under the Developer ID identity; Gatekeeper checks the notarization ticket on first launch ([Apple dev forums thread on bundled-executable warnings](https://developer.apple.com/forums/thread/117816); [twocanoes notarization overview](https://twocanoes.com/apple-ramps-up-fight-against-malware-with-notarization-stapling-and-hardening/)). Static ffmpeg/exiftool binaries from third parties arrive **unsigned or ad-hoc signed** — they must be re-signed with TrailCut's identity during bundling.
- **Tauri handles app signing + notarization** when `APPLE_CERTIFICATE`/`APPLE_API_KEY` etc. are provided ([v2.tauri.app/distribute/sign/macos](https://v2.tauri.app/distribute/sign/macos/)), and the bundler signs sidecar binaries as part of the bundle — but there is field history of `externalBin` breaking notarization ([tauri#11992 "Codesigning and notarization issue when using ExternalBin"](https://github.com/tauri-apps/tauri/issues/11992); [discussion #12803 on sidecar + extra libs](https://github.com/tauri-apps/tauri/discussions/12803)). Plan for a verification step in CI: `codesign --verify --deep --strict` + `spctl --assess` + a notarize dry run on the real bundle *with all binaries present*, treated as a release gate.
- **Hardened-runtime entitlement gotcha specific to this app:** Chrome/Node JITs need `com.apple.security.cs.allow-jit` (and Chrome's own helpers carry their own entitlements — see §4). FFmpeg/ExifTool need no special entitlements.
- **Windows:** Authenticode signing is required in practice to pass SmartScreen for an app distributed to thousands. The 2025–2026 path of least resistance is **Azure Trusted Signing (renamed "Azure Artifact Signing")** — cloud-based, ~$9.99/month, no hardware token, open to organizations (US/CA/EU/UK) and individual developers (US/CA), integrates with GitHub Actions ([azure.microsoft.com/products/artifact-signing](https://azure.microsoft.com/en-us/products/artifact-signing); [Hanselman walkthrough](https://www.hanselman.com/blog/automatically-signing-a-windows-exe-with-azure-trusted-signing-dotnet-sign-and-github-actions); [textslashplain.com Authenticode-in-2025](https://textslashplain.com/2025/03/12/authenticode-in-2025-azure-trusted-signing/)). Note: **EV certificates no longer bypass SmartScreen reputation** (behavior removed 2024) — reputation accrues per-certificate over time regardless ([learn.microsoft.com code-signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)). Sign the installer *and* the bundled ffmpeg/ffprobe/exiftool/node exes.

---

## 2. ExifTool

### 2.1 What TrailCut actually uses it for (narrow!)

Two call sites only:
1. **Metadata read** (`src-tauri/src/util/exiftool.rs:22-32`): `-GPSLatitude -GPSLongitude -CreationDate -CreateDate -MediaCreateDate -Duration -ImageSize -VideoFrameRate -n` on iPhone `.mov/.mp4` — with the fallback chain CreationDate → CreateDate → MediaCreateDate (timezone-correct iPhone timestamp; CLAUDE.md "Key design decisions").
2. **sRGB ICC profile embed** into thumbnail JPEGs (`src-tauri/src/commands/ffmpeg.rs:501-506`, `-icc_profile<=file -overwrite_original`).

### 2.2 Bundling reality (the Perl problem)

- **Windows:** the official ExifTool Windows package is a **self-contained `exiftool(-k).exe` + `exiftool_files` folder embedding Strawberry Perl** — drop-in bundleable, no system Perl needed ([exiftool.org](https://exiftool.org/), [exiftool install guide](https://deepwiki.com/exiftool/exiftool/2-installation-guide)). This is the standard way Windows apps (e.g. XnViewMP ecosystem) ship it.
- **macOS:** the official `.pkg` installs the script + lib tree and **relies on the system `/usr/bin/perl`**. macOS still ships Perl (Sequoia 15.2 has Perl 5.34.1; still present in Tahoe), but Apple has formally deprecated built-in scripting runtimes since Catalina: "In future versions of macOS, scripting language runtimes won't be available by default" ([Apple via mjtsai.com](https://mjtsai.com/blog/2019/06/04/scripting-languages-to-be-removed/); [HN confirmation Perl still present on Sequoia](https://news.ycombinator.com/item?id=42496988)). Python was already removed; Perl is on borrowed time. Phil Harvey himself prefers *not* to bundle Perl: "I'm hoping it won't become necessary to bundle it with ExifTool because that is something I would rather avoid" ([exiftool forum topic 11490](https://exiftool.org/forum/index.php?topic=11490.0)). The portable layout (script + `lib/` directory relocated together) works inside an app bundle but still needs *a* Perl.
- Bundling a relocatable Perl on macOS is doable but is the heaviest, most fragile of all the options (dozens of dylibs/modules to sign for notarization).

### 2.3 The Rust-native alternative (recommended)

- **[nom-exif](https://github.com/mindeng/nom-exif)** (pure Rust, actively maintained, [docs.rs/nom-exif](https://docs.rs/nom-exif/latest/nom_exif/)) parses **MOV/MP4 QuickTime metadata including `com.apple.quicktime.creationdate` as ISO-8601 *with timezone offset*** (e.g. `2019-02-12T15:27:12+08:00`), exposes time components + offset, and reads GPS (`com.apple.quicktime.location.ISO6709`). That covers the exact `CreationDate`-with-timezone requirement that drove the ExifTool choice (CLAUDE.md "CreationDate over CreateDate"), plus GPSLatitude/Longitude.
- `CreateDate`/`MediaCreateDate` fallbacks are plain `mvhd`/`mdhd` atoms (UTC) — trivially readable in Rust (nom-exif or the `mp4` crate). `Duration`, `ImageSize`, `VideoFrameRate` are *already obtainable from the bundled ffprobe* (one fewer tool with no information loss).
- The ICC-embed call site is replaceable with a small Rust JPEG APP2 writer (e.g. `img-parts` crate) or by having ffmpeg attach the profile — it is 20 lines of glue either way, and the current code already treats ICC-embed failure as non-fatal (`commands/ffmpeg.rs:507-516` logs and returns Ok).
- **Recommendation: drop ExifTool from the ship manifest entirely.** Validate nom-exif against the existing iPhone fixture corpus (CreationDate fallback-chain parity test, loud-fail style) before deleting `util/exiftool.rs`. This removes the entire Perl/notarization problem on both platforms and one PATH dependency. Keep ExifTool as a dev-only diff tool.

---

## 3. Tauri 2 sidecar mechanics

- **`bundle.externalBin`**: list paths (without extension); for each entry a real file named `<name>-<target-triple>` (e.g. `ffmpeg-aarch64-apple-darwin`, `ffmpeg-x86_64-pc-windows-msvc.exe`) must exist; the bundler strips the suffix and places the binary next to the app executable ([v2.tauri.app/develop/sidecar](https://v2.tauri.app/develop/sidecar/)). Find the host triple with `rustc --print host-tuple`.
- Executing from **Rust** can use `tauri_plugin_shell`'s `sidecar()` API, but TrailCut's export pipeline spawns processes directly with `std::process::Command` — that is fine; the only thing needed is **path resolution to the bundle location** (Tauri exposes it via `tauri::process::current_binary` / resource-dir APIs; the codebase already has the pattern in `resolve_chrome`, `orchestrator.rs:159-175`, and the prepared `set_ffmpeg_path` hook, `encoder.rs:101-110`). Frontend-invokable shell permissions are *not* needed since all spawning is in Rust — keep it that way (smaller capability surface).
- **Single-file constraint:** `externalBin` copies *single files*. ffmpeg/ffprobe/exiftool-as-static-binary and a Node binary fit; **Chrome's .app directory tree does not**, which is exactly why the codebase already routes Chrome through `bundle.resources` instead (`orchestrator.rs:155-159` comment: "ships via `bundle.resources` (directory copy) rather than `bundle.externalBin` (single-file copy)"; `tauri.conf.json:43-45`).
- **Per-platform selection:** the triple suffix gives per-arch binaries automatically; the resources glob `binaries/chrome-*/**/*` currently ships **whatever chrome dirs exist in the repo** — on a multi-target build this would ship the wrong arch's Chrome too unless made per-target (use platform-specific `bundle > resources` overrides in `tauri.conf.<platform>.json`).
- **Auto-update implications:** the Tauri updater replaces the **entire app bundle** (macOS `.tar.gz` of the .app; Windows full NSIS/MSI re-run) — there are **no delta updates** ([v2.tauri.app/plugin/updater](https://v2.tauri.app/plugin/updater/)). Sidecars/resources are versioned with the app (good: no skew between app ↔ ffmpeg ↔ renderer protocol), but **every update download includes all bundled binaries**. With Chrome inside, every minor TrailCut update is a ~350+ MB download per user; without Chrome it's ~50–80 MB. This is the single biggest argument in §4.

---

## 4. The Chromium renderer sidecar

### 4.1 What's actually being shipped today

Renderer = Node script (`dist`, 9.1 MB) + `puppeteer-core` driving **Google Chrome for Testing** (full Chrome, new headless mode, GPU WebGL via ANGLE→Metal — `sidecars/renderer/index.ts:2-18,285-300`), plus a **Node runtime currently taken from `PATH`** (`orchestrator.rs:80`) — i.e., end users would need Node installed, which is a ship-blocker on its own.

### 4.2 Licensing problem: Chrome for Testing is not redistributable

- Chrome for Testing is "created purely for browser automation and testing purposes… not meant to be used for regular browsing" and is intentionally not listed on the Chrome download page ([developer.chrome.com/blog/chrome-for-testing](https://developer.chrome.com/blog/chrome-for-testing)). The GoogleChromeLabs repo's Apache-2.0 LICENSE covers **the tooling repo, not the browser binaries** ([github.com/GoogleChromeLabs/chrome-for-testing LICENSE](https://github.com/GoogleChromeLabs/chrome-for-testing/blob/main/LICENSE)).
- The binaries are Google Chrome builds governed by Google's Terms of Service, which state: **"You may not copy, modify, distribute, sell, or lease any part of our services or software."** ([policies.google.com/terms](https://policies.google.com/terms); Chrome ToS incorporates these — [google.com/chrome/terms](https://www.google.com/chrome/terms/)). Redistribution requests have historically been tracked and not granted ([Chromium issue 40210441](https://issues.chromium.org/issues/40210441); [Google support thread on container redistribution](https://support.google.com/chrome/thread/192878846)).
- **Conclusion: bundling Chrome for Testing inside the shipped .app is a licensing violation**, independent of size concerns. Lawful variants: (a) **download-at-first-run** into app data via `@puppeteer/browsers` (what puppeteer-based tools do — but: first-run network requirement, 250+ MB download, export breaks offline, and Google's "testing purposes" framing still makes end-user distribution gray); (b) ship an **open-source Chromium build** (BSD; e.g. Playwright's Chromium or a maintained Chromium fork) — legal, but TrailCut then owns security updates for a browser; (c) drop Chromium from the ship manifest (below).

### 4.3 Size / signing / update reality if Chromium ships anyway

- Local measurement: **343 MB on disk** for one arch (`src-tauri/binaries/chrome-aarch64-apple-darwin`); Chrome mac downloads run ~250 MB compressed ([uptodown/fileion listings ~247–259 MB](https://google-chrome.en.uptodown.com/mac/download)). TrailCut's own app would be a rounding error next to it.
- Notarization: Chrome.app is Google-signed; nested apps signed by another team inside your bundle are notarizable but fragile (helper apps, entitlements like `allow-jit`, XPC services must stay intact; re-signing Chrome is its own project). Every TrailCut auto-update re-downloads it (§3).
- A Node runtime must also ship (user-installed Node is not assumable): either `node` as an `externalBin` (~80 MB unpacked) or compile the renderer to a single binary — Node SEA is now first-class (`--build-sea` since Node 25.5, Jan 2026: [nodejs.org SEA docs](https://nodejs.org/api/single-executable-applications.html), [joyeecheung.github.io SEA improvements](https://joyeecheung.github.io/blog/2026/01/26/improving-single-executable-application-building-for-node-js/)); `bun build --compile` / `deno compile` are alternatives. All produce ~60–90 MB binaries (the runtime is embedded). Workable; Chrome remains the elephant.

### 4.4 Alternatives to shipping Chromium

1. **System WebView (Tauri hidden window): not viable for offscreen frame capture.** wry/tao have no offscreen rendering — long-standing open feature requests ([wry#391](https://github.com/tauri-apps/wry/issues/391), [tao#289](https://github.com/tauri-apps/tao/issues/289), [wry discussion #373 "Headless mode"](https://github.com/tauri-apps/wry/discussions/373)); suggested workarounds are "hide the window and screenshot it," which gives no deterministic frame-by-frame readback, no control over compositor timing, and no guaranteed pixel format — unacceptable for a frame-accurate export pipeline. (Servo-backend offscreen exists but is experimental and not the WKWebView/WebView2 path: [servo.org embedding update](https://servo.org/blog/2024/01/19/embedding-update/).)
2. **maplibre-native (recommended direction).** MapLibre Native is C++ with **Metal/Vulkan/OpenGL backends** and an officially published Node binding **[@maplibre/maplibre-gl-native](https://www.npmjs.com/package/@maplibre/maplibre-gl-native)** for headless render-to-buffer ([platform/node README](https://github.com/maplibre/maplibre-native/blob/main/platform/node/README.md), [maplibre.org/projects/native](https://maplibre.org/projects/native/)); there is also a Rust binding path (maplibre-native core is linkable; community `maplibre-native` Rust bindings exist) which would remove Node *and* Chromium from the ship manifest. **The codebase has already spiked this and reached GO**: the `.spike/native-gl` work concluded maplibre-native is jitter-free on the vector basemap at 4K (memory: "Native renderer jitter spike — GO"). License: BSD-2-Clause. This eliminates: CfT licensing, 343 MB payload, Chrome notarization, CDP base64 frame transport cap (memory: 100 MB CDP cap), and the Node-from-PATH gap — at the cost of porting the mapVisuals tuple application and per-frame protocol from `sidecars/renderer/` to the native renderer, and validating preview/export parity (the mapVisuals single-source contract is the porting seam; style JSON + per-frame tuples are renderer-agnostic by design).
3. **Keep Chromium but download-at-first-run** (`@puppeteer/browsers` into `~/Library/Application Support/TrailCut`): smallest engineering delta, but first-run network + offline export failure + CfT terms gray zone + you babysit Chrome versions forever. Acceptable only as a stopgap.

---

## 5. Recommended shipping strategy

Ranked by confidence; each item independently shippable.

1. **FFmpeg/ffprobe: bundle via `externalBin`, per-target static builds, pinned + checksummed.**
   - Baseline config: **LGPL build** with `videotoolbox` (macOS) / MF+AMF+NVENC+QSV (Windows), `libzimg` (WTFPL), `prores_ks`. Windows: BtbN LGPL variant as the starting point; macOS arm64: own CI build (no blessed LGPL arm64 build exists).
   - If software x264/x265 fallback is judged necessary: ship a **GPL build + source offer** instead — the FSF exec-boundary position and LosslessCut precedent support a proprietary app exec'ing a GPL binary; get one counsel pass before ship.
   - AVC patent exposure at "thousands of units" is $0 (first 100k units/year free, Via-LA).
   - Wire through the existing `set_ffmpeg_path` hook (`encoder.rs:110`) + a single resolution module so *every* `Command::new("ffmpeg")` call site (5+ today) goes through one resolver — current duplication is itself a ship risk.
   - CI gate: run `assert_ffmpeg_has_zscale` and the encoder probe against the **bundled** binary; fail loud.
2. **ExifTool: don't bundle — replace.** Port the two call sites to Rust (`nom-exif` for CreationDate-with-timezone + GPS; ffprobe for duration/size/fps; small Rust ICC embed). Parity-test against the iPhone fixture corpus first. This deletes the Perl problem on both OSes.
3. **Chromium renderer: do not ship Chrome for Testing — it isn't licensed for redistribution.** Adopt the already-GO maplibre-native renderer as the export path (preferred; also kills the Node dependency if done via Rust binding, and the 343 MB/auto-update tax). If schedule forces an interim: download CfT at first run via `@puppeteer/browsers` and ship Node via `externalBin` or a SEA-compiled renderer — explicitly marked stopgap.
4. **Signing: macOS** — Tauri-driven Developer ID signing + notarization with hardened runtime; add a release-gate CI job that bundles *all* binaries and runs `codesign --verify --deep --strict`, `spctl --assess`, plus a real notarize submit (externalBin notarization has a bug history: tauri#11992). **Windows** — Azure Artifact Signing (~$10/mo, US individual OK) signing installer + every bundled .exe.
5. **Updates:** accept full-bundle updates (no Tauri deltas); keeping Chromium out of the bundle is what keeps updates in the tens-of-MB range.

### Source list (primary)
- https://www.ffmpeg.org/legal.html
- https://www.gnu.org/licenses/gpl-faq.en.html#MereAggregation
- https://www.via-la.com/licensing-programs/avc-h-264/
- https://x264.org/licensing/
- https://github.com/BtbN/FFmpeg-Builds · https://www.gyan.dev/ffmpeg/builds/ · https://evermeet.cx/ffmpeg/
- https://github.com/sekrit-twc/zimg (WTFPL)
- https://exiftool.org/ · https://exiftool.org/forum/index.php?topic=11490.0
- https://github.com/mindeng/nom-exif · https://docs.rs/nom-exif/latest/nom_exif/
- https://v2.tauri.app/develop/sidecar/ · https://v2.tauri.app/distribute/sign/macos/ · https://v2.tauri.app/plugin/updater/
- https://github.com/tauri-apps/tauri/issues/11992 · https://github.com/tauri-apps/wry/issues/391 · https://github.com/tauri-apps/tao/issues/289
- https://developer.chrome.com/blog/chrome-for-testing · https://policies.google.com/terms · https://www.google.com/chrome/terms/
- https://azure.microsoft.com/en-us/products/artifact-signing · https://www.hanselman.com/blog/automatically-signing-a-windows-exe-with-azure-trusted-signing-dotnet-sign-and-github-actions · https://textslashplain.com/2025/03/12/authenticode-in-2025-azure-trusted-signing/
- https://www.npmjs.com/package/@maplibre/maplibre-gl-native · https://github.com/maplibre/maplibre-native/blob/main/platform/node/README.md
- https://nodejs.org/api/single-executable-applications.html · https://joyeecheung.github.io/blog/2026/01/26/improving-single-executable-application-building-for-node-js/
- https://github.com/mifi/lossless-cut · https://manual.audacityteam.org/man/license.html
- https://mjtsai.com/blog/2019/06/04/scripting-languages-to-be-removed/ · https://news.ycombinator.com/item?id=42496988
