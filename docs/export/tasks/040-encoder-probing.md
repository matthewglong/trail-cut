# Task 040 — Encoder probing + selection

**Step**: Export pipeline (encoder selection — what FFmpeg flags the channel sinks emit)
**Estimated effort**: ~1 day (6–10h)
**Status**: pending
**Depends on**: nothing — pure FFmpeg-side work, parallel to the renderer worker / orchestrator stack. Lands before 060 (Channel B) so the channel sinks know which encoder to ask for.

## Goal

Build a Rust module that probes the bundled FFmpeg's encoder list, test-encodes a 1-frame clip per candidate to filter "in the build but the GPU/driver doesn't accept it," picks the best available encoder per encoder *class* (HEVC for Channel A; ProRes 4444 for Channels B and C; H.264 as a software fallback), and caches the result on disk. Subsequent calls hit the cache. The module is consumed by the channel sinks (lands in 060/090) when constructing their FFmpeg `-c:v` flag.

This implements PLAN.md §"Cross-platform strategy" → "Hardware-accelerated encoding" with two extensions called out as deferred questions in LAYOUT.md §9 and reconciled here:

1. PLAN.md's probe table lists only **H.264** encoders. LAYOUT.md §6 upgrades Channel A's codec to **H.265 (HEVC)** for `.mp4` deliverables. 040's probe covers HEVC encoders (`hevc_videotoolbox`, `hevc_nvenc`, `hevc_qsv`, `hevc_amf`, `libx265`) for Channel A's class. H.264 is retained as a separate class for the safety fallback if HEVC is fully unavailable on a given machine (rare; a contingency rather than a planned path).
2. ProRes 4444 (Channels B and C) is software-only via `prores_ks`. There's no probe *selection* — there's only one encoder — but the test-encode still runs to confirm the bundled FFmpeg has `prores_ks` compiled in and to capture a wall-clock baseline (LAYOUT.md §9 calls out "confirm performance and memory behavior on a representative export").

**The load-bearing invariant — the probe is run once per FFmpeg build, then cached.** The cache key includes the FFmpeg version string and platform; if either changes (user upgrades the bundled FFmpeg in a future TrailCut release, or copies the project between platforms), the cache invalidates and a fresh probe runs. The module never returns a stale "we tried this on a previous version" answer. This matches PLAN.md's "Probed once at first launch; cached" semantics — "first launch" is per-FFmpeg-version, not per-app-install.

## Files to touch

- New: `src-tauri/src/export/encoder.rs` — probe + selection module. Public surface: `EncoderClass` enum (`Hevc`, `H264`, `ProResAlpha`), `EncoderChoice` struct (name, codec args), `select_encoder(class) -> Result<EncoderChoice, EncoderError>`, `probe_all() -> Result<EncoderProbe, EncoderError>`. Internal: candidate chains per platform, single-frame test-encode helper.
- New: `src-tauri/src/export/encoder_cache.rs` — disk cache at `{global_config_dir()}/encoder.json`. Reads on first call, writes after a fresh probe. Keyed by `(ffmpeg_version, platform_target_triple)`. Folded into `encoder.rs` if the file would be small (<50 LOC) — split if it grows.
- Modified: `src-tauri/src/export/mod.rs` — `mod encoder;` and re-export the public surface.
- New: `src-tauri/src/commands/encoder.rs` — Tauri command `probe_encoders() -> EncoderProbeResult` for the UI (export-settings dialog showing "Hardware encoder: VideoToolbox H.265"). Discoverable via `commands::*` re-export. Optional in v1; landing it now is cheap and unblocks the export-settings UI.
- Modified: `src-tauri/src/lib.rs` — register `probe_encoders` in `tauri::generate_handler![...]`.
- Modified: `src-tauri/src/commands/mod.rs` — re-export the new module.
- New: `src-tauri/tests/encoder_probe.rs` — integration test against the system `ffmpeg`. Refuses to run if `ffmpeg --version` fails (mirrors 030's worker-bundle guard). Asserts: probe returns a non-empty choice for each class, the cache file is written, a second probe call hits the cache (verified via instrumentation or stat-mtime check), bumping a fake `ffmpeg_version` in the cache invalidates it.
- Modified: `src-tauri/Cargo.toml` — no new deps. `serde`, `serde_json`, `thiserror` already added in 030.
- Modified: `docs/export/tasks/README.md` — flip 040 to ⬜→🟡→✅ as it progresses; link this file.
- Untouched in this task: any frontend code (the command exists but the dialog that consumes it is part of the export-settings UI deferred to 060+). The renderer worker, orchestrator, and FFmpeg sinks (none of which exist as concrete sinks yet) are unaffected.

## Deliverables

A Rust module at `src-tauri/src/export/encoder.rs`:

```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum EncoderClass {
    Hevc,         // Channel A's deliverable: H.265 in .mp4
    H264,         // Software fallback (libx264) if HEVC fully unavailable
    ProResAlpha,  // Channels B and C: prores_ks profile 4444 with alpha
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncoderChoice {
    pub class: EncoderClass,
    pub name: String,                     // "hevc_videotoolbox", "prores_ks", ...
    pub kind: EncoderKind,                // Hardware | Software
    pub codec_args: Vec<String>,          // additional -c:v family flags (CRF/quality, profile, pix_fmt, etc.)
    pub probe_wall_clock_ms: u32,         // 1-frame test-encode wall-clock
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum EncoderKind { Hardware, Software }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncoderProbe {
    pub ffmpeg_version: String,
    pub platform: String,                 // target_triple string
    pub probed_at_unix_ms: u64,
    pub choices: HashMap<EncoderClass, EncoderChoice>,
}

#[derive(thiserror::Error, Debug)]
pub enum EncoderError { /* IoError, FfmpegMissing, NoEncoderForClass(class), CacheCorrupt, ... */ }

pub fn select_encoder(class: EncoderClass) -> Result<EncoderChoice, EncoderError>;
pub fn probe_all() -> Result<EncoderProbe, EncoderError>;
```

Probe procedure (matches PLAN.md §"Cross-platform strategy" → "Hardware-accelerated encoding" + the H.265 / ProRes extensions):

1. **`ffmpeg -hide_banner -encoders`**. Parse stdout for the encoder names. Build a per-class candidate list intersecting "in the build" with "in the platform's preferred chain":

   | Platform | HEVC try order | H.264 try order | ProResAlpha |
   |---|---|---|---|
   | macOS | `hevc_videotoolbox` → `libx265` | `h264_videotoolbox` → `libx264` | `prores_ks` |
   | Windows | `hevc_nvenc` → `hevc_qsv` → `hevc_amf` → `libx265` | `h264_nvenc` → `h264_qsv` → `h264_amf` → `libx264` | `prores_ks` |
   | Linux (dev/CI) | `libx265` | `libx264` | `prores_ks` |

2. **Test-encode per candidate**. For each candidate that passed the encoder-list filter, spawn FFmpeg with a synthetic 1-frame input — `-f lavfi -i color=c=black:s=320x240:r=30:d=0.04 -frames:v 1 -c:v {candidate} {class_args} -f null -` — and check exit code. This catches "encoder is in the build but the GPU/driver rejects it at init" (common with NVENC on machines with old drivers, or VideoToolbox in headless CI without a GPU). Wall-clock the test-encode and stash in `probe_wall_clock_ms`.

3. **Pick the first success per class.** Hardware encoders are preferred per the chain order; software encoders sit at the end of each chain as the safety fallback. ProRes is single-candidate; "selection" is just "verify it works."

4. **Class-specific args.** The probe's `codec_args` carries the per-class flags downstream sinks will pass as-is. Defaults:
   - HEVC: `["-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-crf", "17"]` for software; `["-tag:v", "hvc1", "-q:v", "65"]` for `videotoolbox`; `["-rc", "vbr", "-cq", "23"]` for `nvenc`. CRF 17 ≈ visually lossless per LAYOUT.md §6.
   - H.264: `["-pix_fmt", "yuv420p", "-crf", "18"]` for `libx264`; `["-q:v", "60"]` for `videotoolbox`; `["-rc", "vbr", "-cq", "21"]` for `nvenc`.
   - ProResAlpha: `["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-vendor", "apl0"]`. (`apl0` matches Apple's vendor tag so Premiere/FCP recognize it as ProRes 4444.)

5. **Cache the result.** Serialize `EncoderProbe` to `{global_config_dir()}/encoder.json`. On the next `select_encoder(class)` call, deserialize the file. If `ffmpeg_version` (from `ffmpeg -version`'s first line) and `platform` (Rust's `target::triple` at compile time) match the cached values, return the cached `EncoderChoice`. If either diverges, re-probe and overwrite. If the file is missing or malformed, re-probe.

6. **Lazy probe on first `select_encoder`.** The probe is **not** run at app launch; the first export action triggers it. Probe wall-clock is ~5–15s on a cold run (one test-encode per candidate × 2–4 candidates per class × 3 classes). Subsequent exports hit the cache (<1ms). This matches PLAN.md's "Probed once at first launch" intent — "first launch *per FFmpeg version*" — without holding up app startup. The Tauri command `probe_encoders()` lets the UI front-run the probe in background if desired.

7. **Error surface.** `EncoderError::NoEncoderForClass(class)` if every candidate fails (unlikely; libx264/libx265/prores_ks are all in the bundled GPL FFmpeg builds). `EncoderError::FfmpegMissing` if `ffmpeg -version` fails to spawn. `EncoderError::CacheCorrupt` is recoverable internally — the module re-probes and overwrites.

## Acceptance criteria

- [ ] `cargo build` (in `src-tauri`) succeeds with the new module wired into `lib.rs` and the new command registered.
- [ ] `cargo clippy --all-targets -- -D warnings` (in `src-tauri`) is clean.
- [ ] **Integration test passes** (`cargo test --test encoder_probe`):
  - Refuses to run with a clear error if `ffmpeg -version` fails (mirrors 030's `dist/renderer.cjs` guard).
  - Calls `probe_all()`, asserts:
    - `choices` contains an entry for each of `Hevc`, `H264`, `ProResAlpha`.
    - On macOS: HEVC's chosen `name` is `hevc_videotoolbox` OR `libx265` (varies by hardware); H.264 is `h264_videotoolbox` OR `libx264`; ProResAlpha is `prores_ks`.
    - On Linux (CI): HEVC is `libx265`, H.264 is `libx264`, ProResAlpha is `prores_ks`.
    - All three `probe_wall_clock_ms` values are > 0 and < 30_000.
  - Asserts `{global_config_dir()}/encoder.json` exists after the call.
  - Calls `select_encoder(EncoderClass::Hevc)` a second time, asserts the wall-clock is <50ms (cache hit).
  - Mutates the on-disk cache to set `ffmpeg_version: "fake"`, calls `select_encoder` again, asserts the cache is overwritten with a fresh probe (verifiable via the new probe's `probed_at_unix_ms` being newer than the mutation's mtime).
- [ ] **Tauri command** `probe_encoders()` returns the `EncoderProbe` (or its serializable shape) over IPC. Frontend wiring is not in scope for 040; the command's existence is the deliverable.
- [ ] **No reimplementation of channel-side filtergraph logic.** Grep at acceptance time:
  - `grep -nE "filter_complex|overlay=|concat=" src-tauri/src/export/encoder.rs` returns nothing — encoder selection produces `-c:v` flags only. Channel filtergraphs are 060/070/090's concern.
- [ ] `cargo test --test orchestrator` and `npm run test:run` continue to pass.
- [ ] `docs/export/tasks/README.md` row 040 flipped to ✅, this file linked.

## Implementation notes

**Why three classes, not two.** Channel A is HEVC per LAYOUT.md §6. Channels B and C are ProRes 4444. H.264 isn't currently used by any channel — but every machine has H.264 hardware, and "HEVC totally unavailable" is a real failure mode (very old Intel iGPUs, virtualized environments). Keeping `H264` in the class enum lets a future user-facing "Compatibility Mode" switch fall back to H.264 in `.mp4` without re-architecting the probe. It's free to include now.

**Why probe at the file boundary, not as a Tauri startup hook.** Probing eagerly at app launch means a 5–15s blocking dance on first install before the UI is interactive. Probing lazily on first export means the user pays the cost only when they're already committed to waiting for an export. The Tauri command exposes the probe to the UI for cases where the export-settings dialog wants to display "Hardware: VideoToolbox H.265" before the export starts; calling it at dialog-open time spreads the cost without blocking startup.

**Why test-encode 1 frame instead of trusting `-encoders`.** PLAN.md explicitly calls this out: "test-encode a 1-frame clip per supported encoder (catches 'encoder is in the build but the GPU/driver doesn't support the API version' failures, which are common on NVENC)." Listing an encoder in `-encoders` only proves it was compiled in, not that it'll initialize on this machine. The 1-frame test runs a `lavfi` color source through the encoder's full init path including hardware context creation.

**Synthetic input for the test-encode.** `-f lavfi -i color=c=black:s=320x240:r=30:d=0.04` produces a single 320×240 black frame at 30fps for 40ms (`d=0.04` ≈ one frame). 320×240 is small enough that even the slowest software encoder finishes in ms; large enough that hardware encoders accept it (some reject sub-256 dimensions). The encoded output goes to `-f null -` so there's no disk write to clean up. Wall-clock includes encoder init, which is the dominant cost we're measuring (a hardware encoder that takes 8s to spin up its context is a yellow flag for production exports — log but don't reject).

**Cache versioning.** Including `ffmpeg_version` (the full first line of `ffmpeg -version`, e.g. `ffmpeg version 6.1.1-tessus`) and `platform` (Rust's `std::env::consts::ARCH` + `OS` joined, e.g. `aarch64-darwin`) in the cache means: a TrailCut update that bumps the bundled FFmpeg invalidates the cache automatically; a project moved between Mac and Windows machines via copy doesn't carry stale cache forward. Both the cache write and read serialize through `serde_json` — adding a new field in a future task is a straightforward `#[serde(default)]` addition.

**`{global_config_dir()}/encoder.json` follows the existing convention.** `recent.json` lives at `~/.trailcut/recent.json` per `src-tauri/src/util/fs.rs::recent_projects_path()`. The encoder cache sits next to it: `~/.trailcut/encoder.json`. No additional path-resolution logic; reuse `global_config_dir()`. The tile cache from 035 is also under `~/.trailcut/`; the directory is the natural single-tenant config root.

**ProRes test-encode shape.** The `lavfi` color input is RGB by default; `prores_ks -profile:v 4444 -pix_fmt yuva444p10le` requires alpha. Probe args: `-f lavfi -i color=c=black@0.5:s=320x240:r=30:d=0.04` — the `@0.5` adds an alpha channel via lavfi's RGBA support. Or, alternately, `-vf format=yuva444p10le` ahead of the encoder. Pick whichever produces a clean 1-frame `prores_ks -f null -` round-trip on macOS + Linux without warnings.

**HEVC `tag:v hvc1`.** macOS's QuickTime/Finder play `.mp4` with HEVC only if the codec tag is `hvc1` (the default `hev1` is rejected by the older container reader). Setting `-tag:v hvc1` is a free correctness win for our deliverable; bake it into `codec_args` for HEVC.

**Why no progressive bitrate selection.** Each encoder's `codec_args` is a fixed default. CRF 17 (HEVC), CRF 18 (H.264), profile 4444 (ProRes) — these are picks from the encoder's well-trodden visually-lossless settings. Surfacing them as user-tunable knobs is a future feature (export-quality preset). 040 ships the defaults inside the probe's output so downstream sinks don't have to know per-encoder flag conventions.

**`select_encoder(class)` vs `probe_all()`.** `probe_all()` is the full "run the probe right now and return the result" entry point — used by the Tauri command and the integration test. `select_encoder(class)` is the lazy + cached entry point — used by channel sinks. They share internals; `select_encoder` is a one-class shortcut that hits the cache first and falls back to `probe_all()` on miss.

**Stderr capture.** A failing test-encode produces FFmpeg stderr; capture it (last 4 KB) and stash inside an internal-only debug field. Don't surface to the user (FFmpeg stderr is too verbose for end-user dialogs); do log to the Tauri log file via `tracing::warn!`. This matches the pattern in 030's worker stderr forwarding.

**Bundled vs system FFmpeg.** Today the codebase calls `ffmpeg` from PATH (`Command::new("ffmpeg")` in `src-tauri/src/commands/ffmpeg.rs`). Task 130 will switch to a per-platform bundled binary at `binaries/ffmpeg-<target-triple>`. The encoder module reads the FFmpeg path from a `OnceCell<PathBuf>` resolver — for v1 returns `"ffmpeg"`; 130 swaps the resolver to the bundled path. Same pattern the orchestrator's `node_path` follows.

**Not in 040: encoder selection at runtime.** The actual `-c:v {encoder}` flag injection into the channel sinks lands in 060/070/090. 040 ships the *picker*; the *consumer* arrives with the sinks. This split lets 040 land independently and lets 060+ test against a stable encoder-selection contract.

## Open questions deferred to follow-up tasks

- **User-tunable quality presets.** "Quick draft" / "High quality" / "Visually lossless" picks. Wraps `select_encoder(class)` with a quality knob that adjusts `codec_args` at the call site. Out of scope; lands when the export-settings UI is real (60+).
- **Two-pass encoding.** Some encoders (libx264/libx265 with `-pass 1` then `-pass 2`) produce smaller files at the same quality. Doubles encode time; not justified for the headline deliverable. Future option.
- **VBR vs CBR selection.** All current `codec_args` use VBR or CRF. CBR is irrelevant for exported deliverables. Skip.
- **GPU memory pressure.** NVENC on a busy GPU can fail mid-export with `out of memory`. Probing doesn't catch this — the test-encode is small. Mitigate with a fallback-on-error path inside the channel sink (catch the encoder-init failure, retry once with the next-tier encoder). Out of scope here; documented as a known v1 limitation.
- **Probe parallelism.** The candidates are tested sequentially. Doing them in parallel would shave seconds off cold probe but multiplies hardware contention. Not worth it; cold probe is a one-time cost per FFmpeg build.
- **Bundled FFmpeg path resolution.** Task 130 swaps `Command::new("ffmpeg")` for the bundled `binaries/ffmpeg-<target-triple>`. 040 reads the path from a resolver cell and is unaffected by the swap.

## Doc tie-in

- PLAN.md §"Cross-platform strategy" → "Hardware-accelerated encoding" — this task implements the probe table plus the H.265 and ProRes extensions reconciled here.
- LAYOUT.md §6 — Channel A is HEVC in `.mp4`; Channels B and C are ProRes 4444 in `.mov` with alpha. The encoder classes in 040 line up 1:1 with those choices.
- LAYOUT.md §9 — "PLAN.md's probe focuses on H.264. ProRes 4444 is software-only via `prores_ks` — confirm performance and memory behavior on a representative export, and whether it warrants its own probe entry." 040 answers: yes, ProRes gets its own class with a confirmation test-encode; no selection because there's only one candidate.
- After 040 lands, the channel sinks in 060/070/090 ask `select_encoder(EncoderClass::Hevc)` (or `ProResAlpha`) for their `-c:v` and per-codec args, with the full chain (videotoolbox → libx265, etc.) pre-vetted on this machine.
