use crate::export::ffprobe::probe_clip;
use crate::util::color::{classify, log_development_lut_prefix, SourceColorClass};
use crate::util::fs::ensure_dir;
use crate::util::hash::path_hash;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// Bundled sRGB IEC 61966-2.1 ICC profile (~3KB), included at compile time.
/// Sourced from Apple's `/System/Library/ColorSync/Profiles/sRGB Profile.icc`
/// (the canonical IEC-published sRGB v2 profile, freely redistributable).
/// Materialized to a temp file on first use so we can pass it to ExifTool's
/// `-icc_profile<=` directive without depending on a runtime resource-path
/// lookup (sidecar bundling is deferred — see `commands::media::ffprobe_path`).
const SRGB_ICC_BYTES: &[u8] = include_bytes!("../../resources/sRGB.icc");

/// Build the FFmpeg argv for proxy generation, branching the `-vf` chain
/// on the source's color class. Pure / synchronous so the unit tests in
/// this module can assert on the produced flag set without spawning
/// FFmpeg or touching the filesystem (WS1 acceptance criterion: "New unit
/// test on the argv builder verifying each class branch produces the
/// expected flag set").
///
/// Branch table (matches `docs/color-pipeline/phase-1/WS1-proxy-pipeline.md`):
///
/// - `SdrBt709` / `Unknown` → normalize + retag, no tonemap.
/// - `HlgBt2020` → linearize HLG@npl=400, tonemap Hable to BT.709, retag.
/// - `PqBt2020` → linearize PQ@npl=1000 (explicit `tin=smpte2084`),
///   tonemap Hable to BT.709, retag.
/// - `DolbyVision` → Phase 1 treats as HLG base layer (RPU discarded);
///   same chain as `HlgBt2020`.
/// - Phase 2 log variants (`DLog`, `CLog*`, `GpLog`, `VLog`, `SLog*`) are
///   not produced by the Phase 1 classifier. If a user override surfaces
///   one before WS-log lands, we fall back to the SDR chain so the proxy
///   is still watchable (LUT development is Phase 2 scope).
///
/// Every branch ends with explicit output color tags (`-color_primaries
/// bt709 -color_trc bt709 -colorspace bt709 -color_range tv`) plus
/// `-movflags +faststart` so the moov atom sits at the front of the mp4
/// (Decision 4: proxies are always SDR BT.709 limited-range, viewable in
/// WKWebView without washout).
pub(crate) fn build_proxy_args(source: &str, dest: &str, class: SourceColorClass) -> Vec<String> {
    // SDR delivery tags applied to every output. The proxy is always
    // BT.709 limited-range — Decision 4 in design-decisions.md.
    const SDR_OUTPUT_TAGS: &[&str] = &[
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-colorspace",
        "bt709",
        "-color_range",
        "tv",
    ];

    // `setparams` tail forces frame-level color metadata on the final
    // BT.709 limited-range yuv420p output. Load-bearing for the
    // "Unknown" branch in particular: when the source has no color tags
    // (test fixture `no_color_metadata.mp4`), libx264's VUI duplicates
    // (`-x264-params colorprim=…`) reach the encoded stream BUT the mp4
    // muxer doesn't write a container-level `colr` atom — it writes
    // colr only when the upstream frames carry the color params. Adding
    // an explicit `setparams=…` filter on the output makes the muxer
    // emit colr unconditionally, which is the QuickTime per-frame
    // warning fix at the container level (WS6's `assert_single_colr_atom`
    // gate). Safe to include on every branch: idempotent when the
    // source is already tagged correctly (SDR / HLG / PQ paths all end
    // in BT.709 limited-range frames after their respective ingest).
    let setparams = "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=limited";

    // Per-class `-vf` chain. Each filtergraph ends in
    // `format=yuv420p,setparams=…` so libx264 gets a 4:2:0 8-bit input
    // with explicit BT.709 limited-range tagging.
    //
    // Fix #7: HDR branches (HLG / PQ / DolbyVision) linearise BEFORE
    // scaling. The `scale` filter is a non-linear-light pixel resampler;
    // running it on PQ / HLG encoded values would resample in the
    // perceptual / log domain, which crushes highlights and introduces
    // colour artefacts when downsizing 4K HDR → 720p SDR proxies. The
    // correct order is: linearise via inverse OETF/EOTF at float precision
    // → scale in linear light (cheap bilinear is fine on float) → tonemap
    // → encode to BT.709 SDR. The SDR / Unknown branch is intentionally
    // left in scale-first form — SDR Rec.709 is already in a perceptually
    // uniform regime; resampling there is the standard `scale` filter's
    // own assumption and introduces no measurable error. Adding a
    // working-space round-trip just for SDR proxies would slow down the
    // overwhelmingly common case (iPhone footage) for zero gain.
    let vf = match class {
        // SDR + Unknown share a branch — Unknown is the documented signal
        // to treat as SDR (see `SourceColorClass::Unknown` doc + WS1
        // acceptance criterion: "The `Unknown` class branch produces the
        // same output as the SDR branch").
        SourceColorClass::SdrBt709 | SourceColorClass::Unknown => {
            format!("scale=-2:720,format=yuv420p,{setparams}")
        }
        // HLG → linear @ npl=400 (BEFORE scale, Fix #7), tonemap Hable
        // preserving highlight color (`desat=0`), then re-encode to BT.709
        // limited-range. Dolby Vision (Phase 1) collapses onto this branch
        // — RPU is discarded, base layer is HLG. `bilinear` on float
        // gbrpf32le is the right scale filter choice: bicubic in linear
        // light is overkill (small quality gain, ~3× slower).
        SourceColorClass::HlgBt2020 | SourceColorClass::DolbyVision => {
            format!(
                "zscale=tin=arib-std-b67:t=linear:npl=400,format=gbrpf32le,\
             scale=-2:720:flags=bilinear,zscale=p=bt709,\
             tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,{setparams}"
            )
        }
        // PQ → linear @ npl=1000 with explicit `tin=smpte2084` so zscale
        // picks the right inverse EOTF even when the source's trc tag is
        // missing or wrong. Same Fix #7 reordering as HLG — linearise
        // before scale.
        SourceColorClass::PqBt2020 => {
            format!(
                "zscale=tin=smpte2084:t=linear:npl=1000,format=gbrpf32le,\
             scale=-2:720:flags=bilinear,zscale=p=bt709,\
             tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,{setparams}"
            )
        }
        // Phase 2 log variants (WS10). When a bundled `.cube` is
        // available for this class (`log_development_lut_prefix`
        // returns `Some`), splice `lut3d='…'` between `scale` and the
        // SDR finishing tail — the LUT develops the log curve into
        // BT.709 SDR, after which the remainder of the chain looks
        // identical to the SDR branch. When no LUT is bundled (V-Log /
        // S-Log*) or the slot holds only a placeholder file (DJI /
        // GoPro / Canon by default — see `resources/luts/README.md`),
        // we fall back to the SDR chain so the proxy is still
        // producible; the user sees flat/gray, matching pre-WS10
        // behaviour for log footage.
        SourceColorClass::DLog
        | SourceColorClass::CLog
        | SourceColorClass::CLog2
        | SourceColorClass::CLog3
        | SourceColorClass::GpLog
        | SourceColorClass::VLog
        | SourceColorClass::SLog2
        | SourceColorClass::SLog3 => match log_development_lut_prefix(class) {
            Some(lut3d) => format!("scale=-2:720,{lut3d},format=yuv420p,{setparams}"),
            None => format!("scale=-2:720,format=yuv420p,{setparams}"),
        },
    };

    let mut args: Vec<String> = vec![
        "-i".into(),
        source.to_string(),
        "-vf".into(),
        vf,
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "fast".into(),
        "-crf".into(),
        "28".into(),
        "-g".into(),
        "30".into(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "128k".into(),
    ];
    args.extend(SDR_OUTPUT_TAGS.iter().map(|s| s.to_string()));
    // libx264 VUI duplicate (WS6 regression flag, surfaced and fixed in
    // WS7). libx264 honors `-colorspace` and `-color_range` (those land
    // on the H.264 VUI via the encoder's own path), but *silently drops*
    // `-color_primaries` and `-color_trc` unless they're duplicated
    // inside `-x264-params colorprim=…:transfer=…:colormatrix=…`. Without
    // this splice the resulting mp4 reports `color_primaries=unknown` /
    // `color_transfer=unknown` to ffprobe, which violates Decision 4
    // ("proxies are always SDR BT.709 limited-range") and surfaces a
    // QuickTime per-frame color warning on the proxy itself. WS4
    // (delivery.rs::delivery_encoder_args) already emits the same splice
    // for its libx264 SDR-social targets; this keeps WS1 in sync.
    args.push("-x264-params".into());
    args.push("colorprim=bt709:transfer=bt709:colormatrix=bt709".into());
    // `+faststart` moves the moov atom to the front so WKWebView can
    // begin playback before the whole file is loaded (WS1 acceptance
    // criterion: "mp4 has moov atom at the front").
    args.push("-movflags".into());
    args.push("+faststart".into());
    args.push("-y".into());
    args.push(dest.to_string());
    args
}

/// Resolve the source's `SourceColorClass` for proxy generation. Probes
/// via the WS0 ffprobe helper and runs `classify` on the resulting
/// metadata; degrades to `Unknown` on any probe failure so a malformed /
/// missing-ffprobe install doesn't block proxy generation — `Unknown`
/// shares the SDR branch and produces a watchable (if conservatively
/// retagged) proxy.
async fn detect_source_color_class(source_path: &Path) -> SourceColorClass {
    // Same PATH-lookup strategy as `commands::media::ffprobe_path` /
    // `export::mod::ffprobe_path`. Sidecar bundling (export task 130)
    // will swap all three call sites in one go.
    let ffprobe = PathBuf::from("ffprobe");
    match probe_clip(&ffprobe, source_path).await {
        Ok(probed) => classify(&probed.color_metadata()),
        Err(e) => {
            // Observability in dev mode without surfacing an error to the
            // import pipeline. Matches `commands::media::populate_color_metadata`'s
            // "degrade to Unknown" stance.
            eprintln!(
                "proxy: ffprobe color probe failed for {}; defaulting to Unknown ({})",
                source_path.display(),
                e
            );
            SourceColorClass::Unknown
        }
    }
}

/// Generate a 720p H.264 proxy video via FFmpeg, stored in project bundle.
///
/// The filtergraph branches on the source's `SourceColorClass`: HDR
/// sources (HLG / PQ / Dolby Vision base layer) are tonemapped to BT.709
/// SDR via the Hable operator before encode, SDR (and `Unknown`) sources
/// are simply normalized and retagged. Every proxy is BT.709 SDR
/// limited-range with explicit color flags + `+faststart`, so WKWebView
/// can play it back without the washout symptom documented in
/// `docs/color-pipeline/background/investigation-findings.md`.
#[tauri::command]
pub async fn generate_proxy(source_path: String, project_dir: String) -> Result<String, String> {
    generate_proxy_inner(source_path, project_dir).await
}

/// WS9 — regenerate a proxy for a *specific* `SourceColorClass`, skipping
/// the ffprobe probe-and-classify step entirely. The frontend calls this
/// after the user confirms a source-format override on the clip: the
/// effective class is what the WS9 UI just wrote into
/// `user_color_class_override`, not what the source file's color tags say.
///
/// Without this entry point the regenerate would round-trip through
/// `detect_source_color_class` and see only the source's auto-detected
/// class — for a clip the user just declared as D-Log the regenerated
/// proxy would land on the SDR branch, defeating the whole point of the
/// override.
#[tauri::command]
pub async fn regenerate_proxy_for_class(
    source_path: String,
    project_dir: String,
    color_class: SourceColorClass,
) -> Result<String, String> {
    let proxies_dir = PathBuf::from(&project_dir).join("proxies");
    ensure_dir(&proxies_dir)?;

    let hash = path_hash(&source_path);
    let proxy_path = proxies_dir.join(format!("{}.mp4", hash));

    // Force regenerate — drop the cached file before kicking ffmpeg off.
    // Best-effort: a missing file is fine, anything else surfaces below.
    let _ = std::fs::remove_file(&proxy_path);

    let source_pathbuf = PathBuf::from(&source_path);
    if !source_pathbuf.exists() {
        return Err(format!("Source file not found: {}", source_path));
    }

    let proxy_str = proxy_path
        .to_str()
        .ok_or("Invalid proxy path")?
        .to_string();

    let args = build_proxy_args(&source_path, &proxy_str, color_class);

    let output = Command::new("ffmpeg")
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = std::fs::remove_file(&proxy_path);
        return Err(format!("FFmpeg proxy generation failed: {}", stderr));
    }

    Ok(proxy_str)
}

/// Shared body for `generate_proxy`. Probes the source for its color
/// class, branches the proxy filtergraph accordingly, and short-circuits
/// when the cached proxy already exists on disk. The override-aware
/// regenerate path lives in `regenerate_proxy_for_class` — it bypasses
/// both the probe and the cache short-circuit.
async fn generate_proxy_inner(
    source_path: String,
    project_dir: String,
) -> Result<String, String> {
    let proxies_dir = PathBuf::from(&project_dir).join("proxies");
    ensure_dir(&proxies_dir)?;

    let hash = path_hash(&source_path);
    let proxy_path = proxies_dir.join(format!("{}.mp4", hash));

    if proxy_path.exists() {
        return proxy_path
            .to_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "Invalid proxy path".to_string());
    }

    let source_pathbuf = PathBuf::from(&source_path);
    if !source_pathbuf.exists() {
        return Err(format!("Source file not found: {}", source_path));
    }

    let proxy_str = proxy_path
        .to_str()
        .ok_or("Invalid proxy path")?
        .to_string();

    // Decide the ingest branch by probing the source. The import pipeline
    // (`commands::media`) already probed and persisted the color class on
    // the `Clip` model, but `generate_proxy` is a one-shot Tauri command
    // that's called from the frontend with just `(sourcePath, projectDir)`
    // — re-probing here keeps the contract narrow and avoids piping the
    // class through the IPC boundary as an untyped string. The ffprobe
    // call is cached in-process so a same-export re-probe is free.
    let class = detect_source_color_class(&source_pathbuf).await;
    let args = build_proxy_args(&source_path, &proxy_str, class);

    let output = Command::new("ffmpeg")
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = std::fs::remove_file(&proxy_path);
        return Err(format!("FFmpeg proxy generation failed: {}", stderr));
    }

    Ok(proxy_str)
}

/// Build the FFmpeg argv for thumbnail generation, branching the `-vf` chain
/// on the source's color class. Pure / synchronous so the unit tests in this
/// module can assert on the produced flag set without spawning FFmpeg or
/// touching the filesystem (WS2 acceptance criterion: "New unit tests cover
/// each color class branch").
///
/// Mirrors `build_proxy_args` but with three deltas:
///   1. `-ss <t>` is placed *before* `-i` (input-seek, ~10x faster than
///      output-seek on large files — WS2's "fix `generate_thumbnail` seek
///      form" requirement).
///   2. Output is a single mjpeg frame (`-frames:v 1 -c:v mjpeg -q:v 3`)
///      rather than an H.264 stream.
///   3. Each `-vf` chain ends in `format=yuvj420p` (note the `j` — full
///      range) so the JPEG carries the full 0..255 sweep, and the output
///      color tags advertise sRGB transfer (`iec61966-2-1`) + PC range, the
///      JPEG-correct combination from WS2's "Common output settings" table.
///
/// `seconds` is the seek offset in floating-point seconds — the caller
/// formats it from whatever unit it has (ms / frames / etc). Scale target
/// is 160px tall (vs 720 for proxies); everything else matches the WS1
/// per-class chains.
pub(crate) fn build_thumbnail_args(
    source: &str,
    dest: &str,
    seconds: f64,
    class: SourceColorClass,
) -> Vec<String> {
    // sRGB delivery tags applied to every JPEG output. JPEG uses the sRGB
    // transfer function (`iec61966-2-1`), not BT.709 transfer, and full
    // range (PC) — see WS2 §"Common output settings".
    const SRGB_OUTPUT_TAGS: &[&str] = &[
        "-color_primaries",
        "bt709",
        "-color_trc",
        "iec61966-2-1",
        "-colorspace",
        "bt709",
        "-color_range",
        "pc",
    ];

    // Per-class `-vf` chain. Each filtergraph ends in `format=yuvj420p`
    // (full-range 4:2:0) so the mjpeg encoder writes a full-range JPEG —
    // matching the `-color_range pc` output tag.
    //
    // Fix #7: HDR branches linearise BEFORE scaling, same as the proxy
    // chain. Downsizing PQ / HLG-encoded values directly bakes in
    // resampling artefacts in the perceptual / log domain; linearising
    // first puts the resample in light-linear float where bilinear is
    // both correct and cheap. SDR / Unknown stays scale-first — its
    // values are already perceptually uniform (no zscale=t=linear in
    // play), and a working-space round-trip would slow down the
    // overwhelmingly common iPhone path for no measurable colour gain.
    let vf = match class {
        // SDR + Unknown share a branch — Unknown is the documented signal
        // to treat as SDR (see `SourceColorClass::Unknown` doc + WS2
        // acceptance criterion: SDR thumbnail "renders correctly (no
        // regression)").
        SourceColorClass::SdrBt709 | SourceColorClass::Unknown => {
            "scale=-2:160,format=yuvj420p".to_string()
        }
        // HLG → linear @ npl=400 (BEFORE scale, Fix #7), tonemap Hable
        // preserving highlight color (`desat=0`), then convert to BT.709
        // full-range for JPEG. Dolby Vision (Phase 1) collapses onto this
        // branch — RPU is discarded, base layer is HLG.
        SourceColorClass::HlgBt2020 | SourceColorClass::DolbyVision => {
            "zscale=tin=arib-std-b67:t=linear:npl=400,format=gbrpf32le,\
             scale=-2:160:flags=bilinear,zscale=p=bt709,\
             tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=pc,format=yuvj420p"
                .to_string()
        }
        // PQ → linear @ npl=1000 with explicit `tin=smpte2084`. Same
        // Fix #7 reordering as HLG, full-range output.
        SourceColorClass::PqBt2020 => {
            "zscale=tin=smpte2084:t=linear:npl=1000,format=gbrpf32le,\
             scale=-2:160:flags=bilinear,zscale=p=bt709,\
             tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=pc,format=yuvj420p"
                .to_string()
        }
        // Phase 2 log variants (WS10). Mirrors the WS1 proxy branch:
        // splice `lut3d='…'` between `scale` and the full-range JPEG
        // pixel-format tail when a bundled LUT exists, else fall back
        // to the SDR chain. The LUT output is BT.709 SDR full-range —
        // perfectly aligned with the `yuvj420p` JPEG output format.
        SourceColorClass::DLog
        | SourceColorClass::CLog
        | SourceColorClass::CLog2
        | SourceColorClass::CLog3
        | SourceColorClass::GpLog
        | SourceColorClass::VLog
        | SourceColorClass::SLog2
        | SourceColorClass::SLog3 => match log_development_lut_prefix(class) {
            Some(lut3d) => format!("scale=-2:160,{lut3d},format=yuvj420p"),
            None => "scale=-2:160,format=yuvj420p".to_string(),
        },
    };

    let mut args: Vec<String> = vec![
        // Input-seek (`-ss` before `-i`) — ~10x faster on large files than
        // the output-seek form. WS2 calls this out as a defect fix for the
        // existing `generate_thumbnail`.
        "-ss".into(),
        format!("{:.3}", seconds),
        "-i".into(),
        source.to_string(),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        vf,
        "-c:v".into(),
        "mjpeg".into(),
        "-q:v".into(),
        "3".into(),
    ];
    args.extend(SRGB_OUTPUT_TAGS.iter().map(|s| s.to_string()));
    args.push("-y".into());
    args.push(dest.to_string());
    args
}

/// Materialize the bundled sRGB ICC profile to a process-wide temp file on
/// first call. The path is cached in a `OnceLock` so concurrent thumbnail
/// generation reads the same file. Returns the path or `None` if the temp
/// write fails (the caller logs and skips ICC embedding — the four
/// `-color_*` flags on the ffmpeg output are the minimum-acceptable
/// fallback per WS2 §"ICC profile embedding").
fn srgb_icc_path() -> Option<&'static PathBuf> {
    static ICC_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
    ICC_PATH
        .get_or_init(|| {
            let mut path = std::env::temp_dir();
            path.push("trailcut-sRGB-IEC61966-2.1.icc");
            // Re-write on every fresh process boot so a partial / truncated
            // write from a prior crash gets replaced. ICC profile contents
            // are deterministic (compile-time const).
            match std::fs::write(&path, SRGB_ICC_BYTES) {
                Ok(()) => Some(path),
                Err(e) => {
                    eprintln!(
                        "thumbnail: failed to materialize sRGB ICC profile at {}: {}",
                        path.display(),
                        e
                    );
                    None
                }
            }
        })
        .as_ref()
}

/// Embed the bundled sRGB ICC profile into a JPEG via ExifTool. FFmpeg's
/// `mjpeg` encoder does not embed ICC profiles natively (WS2 §"ICC profile
/// embedding"), so we shell out post-encode. Best-effort: on any failure
/// (missing exiftool binary, IO error, profile-write failure) we log and
/// return Ok — the JPEG still carries the four `-color_*` output tags from
/// ffmpeg, which is the minimum-acceptable fallback per WS2's spec.
fn embed_srgb_icc(jpeg_path: &Path) -> Result<(), String> {
    let Some(icc_path) = srgb_icc_path() else {
        // The materialize step already logged the underlying error.
        return Ok(());
    };
    // ExifTool's `-icc_profile<=<file>` directive reads the ICC profile
    // bytes from `<file>` and writes them into the JPEG's APP2 marker.
    // `-overwrite_original` skips the `.jpg_original` backup — we already
    // own the freshly-written JPEG, no need for a sidecar copy.
    let output = Command::new("exiftool")
        .arg(format!("-icc_profile<={}", icc_path.display()))
        .arg("-overwrite_original")
        .arg(jpeg_path)
        .output();
    match output {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => {
            eprintln!(
                "thumbnail: exiftool ICC embed failed for {} ({}): {}",
                jpeg_path.display(),
                o.status,
                String::from_utf8_lossy(&o.stderr).trim(),
            );
            Ok(())
        }
        Err(e) => {
            eprintln!(
                "thumbnail: failed to spawn exiftool for {}: {}",
                jpeg_path.display(),
                e
            );
            Ok(())
        }
    }
}

/// Extract a thumbnail frame at a specific time offset from a video via
/// FFmpeg, stored in project bundle. Used by split clips so each segment gets
/// a thumbnail matching its trim.in_ms. Filename incorporates at_ms so
/// multiple segments of the same source don't collide on disk.
///
/// WS2: branches the `-vf` chain on the source's `SourceColorClass` so HDR
/// sources (HLG / PQ / Dolby Vision base layer) get tonemapped instead of
/// rendering washed-out / gray. Output is a full-range sRGB JPEG with an
/// embedded ICC profile.
#[tauri::command]
pub async fn generate_thumbnail_at(
    source_path: String,
    at_ms: u64,
    project_dir: String,
) -> Result<String, String> {
    let thumbs_dir = PathBuf::from(&project_dir).join("thumbnails");
    ensure_dir(&thumbs_dir)?;

    let hash = path_hash(&source_path);
    let thumb_path = thumbs_dir.join(format!("{}_{}_thumb.jpg", hash, at_ms));

    if thumb_path.exists() {
        return thumb_path
            .to_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "Invalid thumbnail path".to_string());
    }

    let source_pathbuf = PathBuf::from(&source_path);
    if !source_pathbuf.exists() {
        return Err(format!("Source file not found: {}", source_path));
    }

    let thumb_str = thumb_path
        .to_str()
        .ok_or("Invalid thumbnail path")?
        .to_string();

    let seconds = at_ms as f64 / 1000.0;

    // Same probe-and-classify dance as `generate_proxy`. The probe is
    // cached in-process (`crate::export::ffprobe::PROBE_CACHE`), so when
    // both `generate_thumbnail` and `generate_proxy` fire for the same
    // source the second call is a free cache hit.
    let class = detect_source_color_class(&source_pathbuf).await;
    let args = build_thumbnail_args(&source_path, &thumb_str, seconds, class);

    let output = Command::new("ffmpeg")
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = std::fs::remove_file(&thumb_path);
        return Err(format!("FFmpeg thumbnail extraction failed: {}", stderr));
    }

    // Best-effort ICC embed. Failures are logged but don't fail the call —
    // the JPEG still carries the four `-color_*` output tags from ffmpeg
    // (the minimum-acceptable fallback per WS2 §"ICC profile embedding").
    embed_srgb_icc(&thumb_path)?;

    Ok(thumb_str)
}

/// Extract a thumbnail frame from a video via FFmpeg, stored in project bundle.
///
/// WS2: branches the `-vf` chain on the source's `SourceColorClass`, fixes
/// the seek form to input-seek (`-ss` before `-i` — ~10x faster on large
/// files), and embeds an sRGB ICC profile in the output JPEG.
#[tauri::command]
pub async fn generate_thumbnail(source_path: String, project_dir: String) -> Result<String, String> {
    let thumbs_dir = PathBuf::from(&project_dir).join("thumbnails");
    ensure_dir(&thumbs_dir)?;

    let hash = path_hash(&source_path);
    let thumb_path = thumbs_dir.join(format!("{}_thumb.jpg", hash));

    if thumb_path.exists() {
        return thumb_path
            .to_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "Invalid thumbnail path".to_string());
    }

    let source_pathbuf = PathBuf::from(&source_path);
    if !source_pathbuf.exists() {
        return Err(format!("Source file not found: {}", source_path));
    }

    let thumb_str = thumb_path
        .to_str()
        .ok_or("Invalid thumbnail path")?
        .to_string();

    let class = detect_source_color_class(&source_pathbuf).await;
    // Match the pre-WS2 fixed 1s seek offset — only the seek *form* (now
    // input-seek, before `-i`) changes here.
    let args = build_thumbnail_args(&source_path, &thumb_str, 1.0, class);

    let output = Command::new("ffmpeg")
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = std::fs::remove_file(&thumb_path);
        return Err(format!("FFmpeg thumbnail extraction failed: {}", stderr));
    }

    embed_srgb_icc(&thumb_path)?;

    Ok(thumb_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Find the first occurrence of `flag` in `argv` and return the value
    /// that follows it (the standard ffmpeg `-flag value` convention).
    fn arg_value<'a>(argv: &'a [String], flag: &str) -> Option<&'a str> {
        argv.iter()
            .position(|a| a == flag)
            .and_then(|i| argv.get(i + 1))
            .map(String::as_str)
    }

    fn assert_common_thumbnail_flags(argv: &[String]) {
        // Input-seek form: `-ss <t>` must come BEFORE `-i <src>`. The WS2
        // brief calls out the prior output-seek form as a defect (~10x
        // slow-down on large files).
        let ss_idx = argv.iter().position(|a| a == "-ss").expect("-ss present");
        let i_idx = argv.iter().position(|a| a == "-i").expect("-i present");
        assert!(
            ss_idx < i_idx,
            "-ss must precede -i for input-seek; got -ss@{} -i@{}",
            ss_idx,
            i_idx
        );

        // Common mjpeg + sRGB tagging that every branch carries.
        assert_eq!(arg_value(argv, "-c:v"), Some("mjpeg"));
        assert_eq!(arg_value(argv, "-q:v"), Some("3"));
        assert_eq!(arg_value(argv, "-frames:v"), Some("1"));
        assert_eq!(arg_value(argv, "-color_primaries"), Some("bt709"));
        // JPEG uses sRGB transfer (iec61966-2-1), NOT bt709 transfer.
        assert_eq!(arg_value(argv, "-color_trc"), Some("iec61966-2-1"));
        assert_eq!(arg_value(argv, "-colorspace"), Some("bt709"));
        // JPEG is full-range (pc) — matches the yuvj420p pix format.
        assert_eq!(arg_value(argv, "-color_range"), Some("pc"));

        // Output is the last positional arg; `-y` precedes it.
        let y_idx = argv.iter().position(|a| a == "-y").expect("-y present");
        assert_eq!(argv.len(), y_idx + 2, "dest path must follow -y at end");
    }

    #[test]
    fn thumbnail_sdr_branch_has_no_tonemap() {
        let argv = build_thumbnail_args("/in.mov", "/out.jpg", 1.0, SourceColorClass::SdrBt709);
        assert_common_thumbnail_flags(&argv);
        let vf = arg_value(&argv, "-vf").expect("-vf present");
        // SDR chain is just scale + full-range JPEG pixel format. No
        // zscale, no tonemap.
        assert_eq!(vf, "scale=-2:160,format=yuvj420p");
        assert!(!vf.contains("tonemap"), "SDR must not tonemap: {vf}");
        assert!(!vf.contains("zscale"), "SDR must not zscale: {vf}");
    }

    #[test]
    fn thumbnail_unknown_matches_sdr_branch() {
        // WS2 acceptance criterion mirrors WS1's: Unknown is the
        // documented "treat as SDR" signal. The two branches must produce
        // byte-identical argv.
        let sdr = build_thumbnail_args("/in.mov", "/out.jpg", 0.5, SourceColorClass::SdrBt709);
        let unk = build_thumbnail_args("/in.mov", "/out.jpg", 0.5, SourceColorClass::Unknown);
        assert_eq!(sdr, unk);
    }

    #[test]
    fn thumbnail_hlg_branch_tonemaps_at_npl_400() {
        let argv = build_thumbnail_args("/in.mov", "/out.jpg", 1.0, SourceColorClass::HlgBt2020);
        assert_common_thumbnail_flags(&argv);
        let vf = arg_value(&argv, "-vf").expect("-vf present");
        // HLG: linearize @ npl=400, tonemap Hable, full-range JPEG output.
        // PQ-only `tin=smpte2084` must NOT appear (HLG is the source's
        // declared transfer).
        assert!(vf.contains("npl=400"), "HLG must use npl=400: {vf}");
        assert!(vf.contains("tonemap=hable"), "HLG must tonemap Hable: {vf}");
        assert!(vf.contains("desat=0"), "HLG must preserve highlight color: {vf}");
        assert!(vf.contains("format=yuvj420p"), "HLG must end in full-range JPEG fmt: {vf}");
        assert!(!vf.contains("npl=1000"), "HLG must not use PQ npl: {vf}");
        assert!(!vf.contains("tin=smpte2084"), "HLG must not declare PQ input: {vf}");
    }

    #[test]
    fn thumbnail_pq_branch_tonemaps_at_npl_1000_with_explicit_input_trc() {
        let argv = build_thumbnail_args("/in.mov", "/out.jpg", 2.5, SourceColorClass::PqBt2020);
        assert_common_thumbnail_flags(&argv);
        let vf = arg_value(&argv, "-vf").expect("-vf present");
        assert!(vf.contains("npl=1000"), "PQ must use npl=1000: {vf}");
        assert!(
            vf.contains("tin=smpte2084"),
            "PQ must explicitly declare smpte2084 input trc: {vf}"
        );
        assert!(vf.contains("tonemap=hable"), "PQ must tonemap Hable: {vf}");
        assert!(vf.contains("format=yuvj420p"), "PQ must end in full-range JPEG fmt: {vf}");
    }

    #[test]
    fn thumbnail_dolby_vision_uses_hlg_chain() {
        // Phase 1: Dolby Vision discards RPU and treats the base layer as
        // HLG (matches WS1's policy).
        let dv = build_thumbnail_args("/in.mov", "/out.jpg", 1.0, SourceColorClass::DolbyVision);
        let hlg = build_thumbnail_args("/in.mov", "/out.jpg", 1.0, SourceColorClass::HlgBt2020);
        assert_eq!(dv, hlg);
    }

    // ---- Fix #7: HDR thumbnail/proxy linearise BEFORE scale ----

    #[test]
    fn thumbnail_hlg_branch_linearises_before_scale() {
        // Fix #7 acceptance: HDR sources must linearise (`zscale=t=linear`)
        // BEFORE the `scale` filter resamples. Running `scale` on
        // PQ/HLG-encoded values resamples in the perceptual/log domain,
        // baking in artefacts (highlight crush, colour shift) on the way
        // from 4K HDR source → 160px SDR thumbnail. The correct order:
        // linearise at float precision → scale in linear light → tonemap
        // → encode.
        let argv = build_thumbnail_args("/in.mov", "/out.jpg", 1.0, SourceColorClass::HlgBt2020);
        let vf = arg_value(&argv, "-vf").expect("-vf present");
        let linear_idx = vf.find("zscale=tin=arib-std-b67:t=linear").unwrap_or_else(|| {
            panic!("HLG must use zscale linearise step; got: {vf}")
        });
        let scale_idx = vf
            .find("scale=-2:160")
            .unwrap_or_else(|| panic!("HLG must scale to 160px; got: {vf}"));
        assert!(
            linear_idx < scale_idx,
            "Fix #7: HLG linearise (idx={linear_idx}) must precede scale (idx={scale_idx}); got: {vf}",
        );
        // Bilinear is the right scale flag in linear light — bicubic would
        // be overkill (small quality gain, ~3× slower on float).
        assert!(
            vf.contains("scale=-2:160:flags=bilinear"),
            "HLG scale must use bilinear in linear light: {vf}",
        );
        // gbrpf32le must appear once between linearise and scale.
        assert!(vf.contains("format=gbrpf32le"), "HLG must hop through float: {vf}");
    }

    #[test]
    fn thumbnail_pq_branch_linearises_before_scale() {
        let argv = build_thumbnail_args("/in.mov", "/out.jpg", 1.0, SourceColorClass::PqBt2020);
        let vf = arg_value(&argv, "-vf").expect("-vf present");
        let linear_idx = vf.find("zscale=tin=smpte2084:t=linear").unwrap_or_else(|| {
            panic!("PQ must use zscale linearise step with tin=smpte2084; got: {vf}")
        });
        let scale_idx = vf
            .find("scale=-2:160")
            .unwrap_or_else(|| panic!("PQ must scale to 160px; got: {vf}"));
        assert!(
            linear_idx < scale_idx,
            "Fix #7: PQ linearise (idx={linear_idx}) must precede scale (idx={scale_idx}); got: {vf}",
        );
        assert!(
            vf.contains("scale=-2:160:flags=bilinear"),
            "PQ scale must use bilinear in linear light: {vf}",
        );
    }

    #[test]
    fn thumbnail_sdr_branch_stays_scale_first() {
        // Fix #7 decision: SDR proxies/thumbnails are intentionally NOT
        // reordered. SDR Rec.709 is perceptually uniform; resampling in
        // gamma space is the standard `scale` filter's own assumption and
        // introduces no measurable error. Adding a working-space round-trip
        // for SDR would slow down the iPhone path (the overwhelmingly
        // common case) for zero gain.
        let argv = build_thumbnail_args("/in.mov", "/out.jpg", 1.0, SourceColorClass::SdrBt709);
        let vf = arg_value(&argv, "-vf").expect("-vf present");
        assert!(
            vf.starts_with("scale="),
            "SDR thumbnail must remain scale-first (Fix #7 decision): {vf}",
        );
        assert!(!vf.contains("zscale=t=linear"), "SDR must not linearise: {vf}");
    }

    #[test]
    fn thumbnail_seek_offset_threads_through() {
        // The `seconds` param is formatted with 3 decimal places into the
        // `-ss` slot. Callers (notably `generate_thumbnail_at`) rely on
        // sub-second precision for split clips.
        let argv =
            build_thumbnail_args("/in.mov", "/out.jpg", 12.345, SourceColorClass::SdrBt709);
        assert_eq!(arg_value(&argv, "-ss"), Some("12.345"));
    }

    #[test]
    fn thumbnail_log_variants_without_real_lut_fall_back_to_sdr() {
        // WS10 policy: log variants that have either no bundled LUT
        // slot (V-Log / S-Log*) or a placeholder file in their slot
        // (DJI / GoPro / Canon by default — see
        // `src-tauri/resources/luts/README.md` for the licensing
        // posture) fall back to the SDR chain. This keeps the proxy /
        // thumbnail pipeline producing watchable frames for an
        // undeclared / user-overridden log clip even when we can't
        // legally redistribute the vendor LUT.
        //
        // For variants that DO have a real LUT bundled at build time
        // (rebuild after dropping a `.cube` into `resources/luts/`),
        // the chain instead carries an `lut3d='…'` splice — see
        // `thumbnail_log_variants_with_real_lut_apply_lut3d` below.
        let sdr = build_thumbnail_args("/in.mov", "/out.jpg", 1.0, SourceColorClass::SdrBt709);
        for class in [
            SourceColorClass::DLog,
            SourceColorClass::CLog,
            SourceColorClass::CLog2,
            SourceColorClass::CLog3,
            SourceColorClass::GpLog,
            SourceColorClass::VLog,
            SourceColorClass::SLog2,
            SourceColorClass::SLog3,
        ] {
            // Skip variants where a real LUT has replaced the
            // placeholder — those land in the LUT-bearing test below.
            if log_development_lut_prefix(class).is_some() {
                continue;
            }
            let argv = build_thumbnail_args("/in.mov", "/out.jpg", 1.0, class);
            assert_eq!(argv, sdr, "{:?} should fall back to SDR chain", class);
        }
    }

    #[test]
    fn thumbnail_log_variants_with_real_lut_apply_lut3d() {
        // Cross-cutting check: whenever a log variant resolves a real
        // bundled LUT (i.e. someone built with a `.cube` dropped into
        // `resources/luts/`), the `-vf` chain must carry the
        // `lut3d='…'` splice between `scale` and `format=yuvj420p`.
        // Default ship state is all placeholders, so this test is a
        // no-op until a real LUT lands; that's intentional — it's a
        // tripwire for the day a vendor LUT becomes redistributable.
        for class in [
            SourceColorClass::DLog,
            SourceColorClass::GpLog,
            SourceColorClass::CLog,
            SourceColorClass::CLog2,
            SourceColorClass::CLog3,
        ] {
            let Some(prefix) = log_development_lut_prefix(class) else {
                continue;
            };
            let argv = build_thumbnail_args("/in.mov", "/out.jpg", 1.0, class);
            let vf = arg_value(&argv, "-vf").expect("-vf present");
            assert!(
                vf.contains(&prefix),
                "{:?}: -vf must contain {}: {}",
                class,
                prefix,
                vf,
            );
            // LUT comes after the resize and before the JPEG pixel-fmt
            // tail. Ordering matters: applying the LUT post-scale is
            // ~10x cheaper for full-res log sources.
            let scale_idx = vf.find("scale=").expect("scale= must come before lut3d");
            let lut_idx = vf.find("lut3d=").expect("lut3d= must appear");
            let fmt_idx = vf.find("format=yuvj420p").expect("yuvj420p must come after lut3d");
            assert!(
                scale_idx < lut_idx && lut_idx < fmt_idx,
                "{:?}: ordering must be scale → lut3d → format; got {}",
                class,
                vf,
            );
            assert_common_thumbnail_flags(&argv);
        }
    }

    #[test]
    fn srgb_icc_profile_materializes_with_expected_signature() {
        // Sanity: the bundled ICC bytes survive `include_bytes!` intact
        // and the materialize step actually writes them. Catches a
        // missing / truncated resources/sRGB.icc at compile time on the
        // const side and at first-call time here.
        assert_eq!(SRGB_ICC_BYTES.len(), 3144, "sRGB.icc must be 3144 bytes");
        // ICC profiles tag their preferred CMM at byte 4 onwards; the
        // Apple-shipped IEC profile uses `Lino` (Linotronic — historical).
        assert_eq!(&SRGB_ICC_BYTES[4..8], b"Lino", "expected Linotronic CMM tag");
        let path = srgb_icc_path().expect("materialize must succeed in tests");
        let on_disk = std::fs::read(path).expect("read back materialized file");
        assert_eq!(on_disk, SRGB_ICC_BYTES, "on-disk profile must match the bundled bytes");
    }

    // ---- WS1: proxy argv builder tests ----
    //
    // WS1 acceptance criterion: "New unit test on the argv builder
    // verifying each class branch produces the expected flag set." Each
    // test targets one branch of `build_proxy_args` and asserts on both
    // the filtergraph (`-vf` value) and the SDR-delivery tail
    // (`-color_*` + `-movflags +faststart`).

    /// Common assertions every `build_proxy_args` output must satisfy
    /// regardless of class — the SDR delivery tags, faststart, CRF /
    /// codec / audio passthrough, and source/dest positioning. Factored
    /// out so each per-branch test stays focused on the branch-specific
    /// filter shape (matches the `assert_common_thumbnail_flags`
    /// pattern used by the WS2 tests above).
    fn assert_common_proxy_flags(argv: &[String]) {
        // SDR delivery tagging — every proxy is BT.709 limited-range
        // (Decision 4 in design-decisions.md).
        assert_eq!(arg_value(argv, "-color_primaries"), Some("bt709"));
        assert_eq!(arg_value(argv, "-color_trc"), Some("bt709"));
        assert_eq!(arg_value(argv, "-colorspace"), Some("bt709"));
        assert_eq!(arg_value(argv, "-color_range"), Some("tv"));
        // libx264 VUI duplicate (WS7 fix for the WS6-flagged regression).
        // Without this splice libx264 silently drops `-color_primaries`
        // and `-color_trc` from the H.264 VUI; ffprobe then reports the
        // proxy as primaries=unknown / transfer=unknown and QuickTime
        // surfaces a per-frame color warning. Mate to delivery.rs's
        // `-x264-params` splice on the social-SDR targets.
        assert_eq!(
            arg_value(argv, "-x264-params"),
            Some("colorprim=bt709:transfer=bt709:colormatrix=bt709"),
        );
        // `+faststart` so WKWebView can begin playback before the whole
        // file is loaded (WS1 acceptance criterion: "mp4 has moov atom
        // at the front").
        assert_eq!(arg_value(argv, "-movflags"), Some("+faststart"));
        // Existing codec / CRF / GOP / audio settings must survive (WS1
        // out-of-scope: "Changing CRF, codec, or audio settings").
        assert_eq!(arg_value(argv, "-c:v"), Some("libx264"));
        assert_eq!(arg_value(argv, "-preset"), Some("fast"));
        assert_eq!(arg_value(argv, "-crf"), Some("28"));
        assert_eq!(arg_value(argv, "-g"), Some("30"));
        assert_eq!(arg_value(argv, "-c:a"), Some("aac"));
        assert_eq!(arg_value(argv, "-b:a"), Some("128k"));
        // Source / dest positioning: `-i <src>` near the front, dest as
        // the last token. `-y` for overwrite is preserved from the
        // pre-WS1 argv (and must precede the dest).
        assert_eq!(arg_value(argv, "-i"), Some("/tmp/src.mov"));
        let y_idx = argv.iter().position(|a| a == "-y").expect("-y present");
        assert_eq!(argv.len(), y_idx + 2, "dest path must follow -y at end");
        assert_eq!(argv.last().map(String::as_str), Some("/tmp/out.mp4"));
    }

    #[test]
    fn proxy_sdr_branch_has_no_tonemap_just_normalize_and_retag() {
        let argv = build_proxy_args(
            "/tmp/src.mov",
            "/tmp/out.mp4",
            SourceColorClass::SdrBt709,
        );
        let vf = arg_value(&argv, "-vf").expect("-vf present");
        // SDR chain: scale → 4:2:0 pixel format → explicit color params
        // via setparams (load-bearing for the colr atom on Unknown-class
        // inputs that share this branch; see WS7 fix in `build_proxy_args`).
        assert_eq!(
            vf,
            "scale=-2:720,format=yuv420p,\
             setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=limited",
        );
        // SDR must not invoke the zscale → tonemap chain.
        assert!(!vf.contains("zscale"), "SDR branch must not zscale: {vf}");
        assert!(!vf.contains("tonemap"), "SDR branch must not tonemap: {vf}");
        assert_common_proxy_flags(&argv);
    }

    #[test]
    fn proxy_unknown_branch_matches_sdr_branch_byte_for_byte() {
        // WS1 acceptance criterion: "The `Unknown` class branch produces
        // the same output as the SDR branch."
        let sdr = build_proxy_args(
            "/tmp/src.mov",
            "/tmp/out.mp4",
            SourceColorClass::SdrBt709,
        );
        let unknown = build_proxy_args(
            "/tmp/src.mov",
            "/tmp/out.mp4",
            SourceColorClass::Unknown,
        );
        assert_eq!(sdr, unknown);
    }

    #[test]
    fn proxy_hlg_branch_uses_npl_400_linearize_then_hable_tonemap() {
        let argv = build_proxy_args(
            "/tmp/src.mov",
            "/tmp/out.mp4",
            SourceColorClass::HlgBt2020,
        );
        let vf = arg_value(&argv, "-vf").expect("-vf present");
        // HLG-specific: npl=400 for the inverse OETF (per ARCHITECTURE.md
        // "Ingest formulas (Phase 1)" — HLG row).
        assert!(vf.contains("npl=400"), "HLG branch must set npl=400: {vf}");
        // Must NOT carry a `tin=` hint — HLG's trc is read from the
        // source's tag (the PQ branch is the one that overrides via
        // `tin=smpte2084`).
        assert!(
            !vf.contains("tin=smpte2084"),
            "HLG branch must not force PQ input trc: {vf}"
        );
        // Hable tonemap preserving highlight color.
        assert!(
            vf.contains("tonemap=hable:desat=0"),
            "HLG branch must use Hable tonemap with desat=0: {vf}"
        );
        // Float-precision intermediate, then re-encode to BT.709 limited.
        assert!(vf.contains("gbrpf32le"), "HLG must use float intermediate: {vf}");
        assert!(
            vf.contains("zscale=t=bt709:m=bt709:r=tv"),
            "HLG must retag to BT.709 limited: {vf}"
        );
        // Tail: yuv420p pixel format followed by `setparams` so the mp4
        // muxer writes a colr atom (WS7 colr-atom fix).
        assert!(
            vf.contains("format=yuv420p,setparams=colorspace=bt709"),
            "HLG must end at yuv420p + setparams: {vf}",
        );
        assert!(vf.ends_with("range=limited"), "HLG must end at setparams range=limited: {vf}");
        assert_common_proxy_flags(&argv);
    }

    #[test]
    fn proxy_pq_branch_uses_npl_1000_with_explicit_smpte2084_input() {
        let argv = build_proxy_args(
            "/tmp/src.mov",
            "/tmp/out.mp4",
            SourceColorClass::PqBt2020,
        );
        let vf = arg_value(&argv, "-vf").expect("-vf present");
        // PQ-specific: npl=1000 + explicit `tin=smpte2084` so zscale
        // picks the right inverse EOTF even when the source tag is
        // missing or wrong (per WS1 brief).
        assert!(vf.contains("npl=1000"), "PQ branch must set npl=1000: {vf}");
        assert!(
            vf.contains("tin=smpte2084"),
            "PQ branch must force PQ input trc: {vf}"
        );
        // Same Hable + retag tail as HLG.
        assert!(vf.contains("tonemap=hable:desat=0"));
        assert!(vf.contains("zscale=t=bt709:m=bt709:r=tv"));
        assert!(vf.contains("format=yuv420p,setparams=colorspace=bt709"));
        assert!(vf.ends_with("range=limited"));
        assert_common_proxy_flags(&argv);
    }

    #[test]
    fn proxy_dolby_vision_branch_collapses_onto_hlg_chain() {
        // Phase 1: Dolby Vision treats the HLG base layer (RPU
        // discarded). The argv must equal the HLG branch byte-for-byte.
        let dv = build_proxy_args(
            "/tmp/src.mov",
            "/tmp/out.mp4",
            SourceColorClass::DolbyVision,
        );
        let hlg = build_proxy_args(
            "/tmp/src.mov",
            "/tmp/out.mp4",
            SourceColorClass::HlgBt2020,
        );
        assert_eq!(dv, hlg);
    }

    // ---- Fix #7: HDR proxy linearises BEFORE scale ----

    #[test]
    fn proxy_hlg_branch_linearises_before_scale_fix_7() {
        // Fix #7 acceptance: HLG sources must linearise before the
        // `scale=-2:720` downscaler runs. Otherwise the resample happens
        // in HLG's perceptual log space, baking in highlight crush and
        // colour shift on the way down to the 720p SDR proxy. Compare to
        // pre-fix behaviour: chain started with `scale=-2:720,zscale=…`.
        let argv = build_proxy_args(
            "/tmp/src.mov",
            "/tmp/out.mp4",
            SourceColorClass::HlgBt2020,
        );
        let vf = arg_value(&argv, "-vf").expect("-vf present");
        let linear_idx = vf.find("zscale=tin=arib-std-b67:t=linear").unwrap_or_else(|| {
            panic!("HLG must use zscale linearise step; got: {vf}")
        });
        let scale_idx = vf
            .find("scale=-2:720")
            .unwrap_or_else(|| panic!("HLG must scale to 720p; got: {vf}"));
        assert!(
            linear_idx < scale_idx,
            "Fix #7: HLG linearise (idx={linear_idx}) must precede scale (idx={scale_idx}); got: {vf}",
        );
        assert!(
            vf.contains("scale=-2:720:flags=bilinear"),
            "HLG proxy scale must use bilinear in linear light: {vf}",
        );
        assert!(vf.contains("format=gbrpf32le"), "HLG proxy must hop through float: {vf}");
        // setparams tail must still be at the end (Decision 4 / WS6 colr
        // atom requirement).
        assert!(vf.ends_with("range=limited"), "setparams tail must still anchor end: {vf}");
        assert_common_proxy_flags(&argv);
    }

    #[test]
    fn proxy_pq_branch_linearises_before_scale_fix_7() {
        let argv = build_proxy_args(
            "/tmp/src.mov",
            "/tmp/out.mp4",
            SourceColorClass::PqBt2020,
        );
        let vf = arg_value(&argv, "-vf").expect("-vf present");
        let linear_idx = vf.find("zscale=tin=smpte2084:t=linear").unwrap_or_else(|| {
            panic!("PQ must linearise with tin=smpte2084; got: {vf}")
        });
        let scale_idx = vf
            .find("scale=-2:720")
            .unwrap_or_else(|| panic!("PQ must scale to 720p; got: {vf}"));
        assert!(
            linear_idx < scale_idx,
            "Fix #7: PQ linearise (idx={linear_idx}) must precede scale (idx={scale_idx}); got: {vf}",
        );
        assert!(
            vf.contains("scale=-2:720:flags=bilinear"),
            "PQ proxy scale must use bilinear in linear light: {vf}",
        );
        assert!(vf.ends_with("range=limited"), "setparams tail must still anchor end: {vf}");
        assert_common_proxy_flags(&argv);
    }

    #[test]
    fn proxy_sdr_branch_stays_scale_first_fix_7() {
        // Fix #7 decision (matches the thumbnail twin): SDR proxies are
        // intentionally NOT reordered. SDR Rec.709 is perceptually
        // uniform — resampling in gamma space is what the standard `scale`
        // filter expects and introduces no measurable error. Adding a
        // working-space round-trip just for SDR would slow down the
        // iPhone path (the overwhelmingly common case) for zero gain.
        let argv = build_proxy_args(
            "/tmp/src.mov",
            "/tmp/out.mp4",
            SourceColorClass::SdrBt709,
        );
        let vf = arg_value(&argv, "-vf").expect("-vf present");
        assert!(
            vf.starts_with("scale="),
            "SDR proxy must remain scale-first (Fix #7 decision): {vf}",
        );
        assert!(!vf.contains("zscale=t=linear"), "SDR must not linearise: {vf}");
    }

    #[test]
    fn proxy_log_variants_without_real_lut_fall_back_to_sdr_branch() {
        // WS10 policy mirroring the thumbnail test: log variants whose
        // bundled `.cube` slot is empty or holds only a placeholder
        // (default ship state — see `src-tauri/resources/luts/README.md`)
        // share the SDR branch so the proxy is still producible. A
        // user-overridden log clip with no real LUT renders flat/gray
        // but doesn't crash the pipeline.
        let sdr = build_proxy_args(
            "/tmp/src.mov",
            "/tmp/out.mp4",
            SourceColorClass::SdrBt709,
        );
        for class in [
            SourceColorClass::DLog,
            SourceColorClass::CLog,
            SourceColorClass::CLog2,
            SourceColorClass::CLog3,
            SourceColorClass::GpLog,
            SourceColorClass::VLog,
            SourceColorClass::SLog2,
            SourceColorClass::SLog3,
        ] {
            if log_development_lut_prefix(class).is_some() {
                continue;
            }
            let argv = build_proxy_args("/tmp/src.mov", "/tmp/out.mp4", class);
            assert_eq!(argv, sdr, "log variant {:?} must match SDR branch", class);
        }
    }

    #[test]
    fn proxy_log_variants_with_real_lut_apply_lut3d_between_scale_and_format() {
        // WS10 tripwire: when a vendor LUT has been dropped into
        // `resources/luts/` and the build picks it up, the proxy
        // chain must splice `lut3d='…'` between `scale=` and
        // `format=yuv420p,setparams=…`. Default ship state is all
        // placeholders, so this test is a no-op until a real LUT is
        // present. Mirror to `thumbnail_log_variants_with_real_lut_apply_lut3d`.
        for class in [
            SourceColorClass::DLog,
            SourceColorClass::GpLog,
            SourceColorClass::CLog,
            SourceColorClass::CLog2,
            SourceColorClass::CLog3,
        ] {
            let Some(prefix) = log_development_lut_prefix(class) else {
                continue;
            };
            let argv = build_proxy_args("/tmp/src.mov", "/tmp/out.mp4", class);
            let vf = arg_value(&argv, "-vf").expect("-vf present");
            assert!(
                vf.contains(&prefix),
                "{:?}: -vf must contain {}: {}",
                class,
                prefix,
                vf,
            );
            let scale_idx = vf.find("scale=").expect("scale= must precede lut3d");
            let lut_idx = vf.find("lut3d=").expect("lut3d= must appear");
            let fmt_idx = vf
                .find("format=yuv420p")
                .expect("yuv420p must follow lut3d");
            assert!(
                scale_idx < lut_idx && lut_idx < fmt_idx,
                "{:?}: order must be scale → lut3d → format=yuv420p; got {}",
                class,
                vf,
            );
            // Output color tags + faststart must survive the new
            // splice — Decision 4's "proxies are always SDR BT.709
            // limited-range" still holds because the LUT lands in
            // BT.709 SDR before encode.
            assert_common_proxy_flags(&argv);
        }
    }

    #[test]
    fn proxy_argv_keeps_input_before_filtergraph_and_output_last() {
        // FFmpeg is order-sensitive: `-i <source>` must precede the `-vf`
        // and codec flags it scopes; dest must be the final token. Guard
        // against an accidental rewrite that shuffles the order.
        let argv = build_proxy_args(
            "/tmp/src.mov",
            "/tmp/out.mp4",
            SourceColorClass::HlgBt2020,
        );
        let i_idx = argv.iter().position(|a| a == "-i").expect("-i must appear");
        let vf_idx = argv.iter().position(|a| a == "-vf").expect("-vf must appear");
        let dest_idx = argv.len() - 1;
        assert!(i_idx < vf_idx, "-i must precede -vf (got -i@{i_idx} -vf@{vf_idx})");
        assert!(vf_idx < dest_idx, "-vf must precede dest");
    }
}
