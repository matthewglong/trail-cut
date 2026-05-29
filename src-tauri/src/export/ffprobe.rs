// Narrow ffprobe wrapper used by Channel C (070) — and Channel A (090) —
// to detect audio-stream presence and verify source dimensions parse cleanly.
//
// ffprobe is invoked with `-v error -show_streams -show_format -of json`,
// the JSON is parsed, and the relevant fields are pulled out. Cross-export
// caching (persistent on disk) is deferred; v1 caches in-process by
// `(source_path, mtime)` for the duration of one export.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::SystemTime;

use serde_json::Value;
use tokio::process::Command;

pub use crate::export::error::FfprobeError;
use crate::util::color::ColorMetadata;

#[derive(Debug, Clone, PartialEq)]
pub struct ProbedClip {
    pub width: u32,
    pub height: u32,
    pub has_audio: bool,
    /// Duration reported by FFmpeg's container parser (`format.duration`),
    /// in seconds. Used for sanity checking; the per-clip trim drives the
    /// actual filtergraph extents.
    pub container_duration_s: f64,
    // ---- Color metadata (WS0 — color pipeline foundation) ----
    //
    // These fields are populated from the same ffprobe call that gives us
    // dims + duration. `classify()` in `crate::util::color` turns them into
    // a `SourceColorClass`. All five stream-level color tags are `Option`
    // because real-world files routinely lack any individual field; ditto
    // the camera identification.
    pub pix_fmt: Option<String>,
    pub color_primaries: Option<String>,
    /// ffprobe JSON spells this `color_transfer`; the codebase canonicalises
    /// to the BT.709/BT.2020 spec's "TRC" shorthand here. `parse_ffprobe_json`
    /// reads from the `color_transfer` JSON key and lands it on this field.
    pub color_trc: Option<String>,
    pub color_space: Option<String>,
    pub color_range: Option<String>,
    /// `true` when the source's video stream carries a DOVI side-data block.
    /// Detected by walking `stream.side_data_list` for an entry whose
    /// `side_data_type` is `"DOVI configuration record"` (FFmpeg's name for
    /// the parsed `dvcC` / `dvvC` / `hvcE` boxes; presence is sufficient,
    /// `rpu_present_flag` distinctions are deferred to a later phase).
    pub has_dolby_vision: bool,
    /// QuickTime container manufacturer tag (`com.apple.quicktime.make`).
    /// Falls back to a substring scan of the encoder string for non-Apple
    /// devices (`"DJI"`, `"GoPro"`) so Phase 2 log-format detection has a
    /// signal to work with for non-Apple cameras.
    pub camera_make: Option<String>,
    /// QuickTime container model tag (`com.apple.quicktime.model`). Same
    /// fallback strategy as `camera_make`.
    pub camera_model: Option<String>,
}

impl ProbedClip {
    /// Project the color-relevant fields out of a probed clip into the
    /// `ColorMetadata` shape `util::color::classify` consumes. Lets the
    /// import pipeline call `classify(&probed.color_metadata())` without
    /// hand-rolling the 8-field copy each time.
    pub fn color_metadata(&self) -> ColorMetadata {
        ColorMetadata {
            pix_fmt: self.pix_fmt.clone(),
            color_primaries: self.color_primaries.clone(),
            color_trc: self.color_trc.clone(),
            color_space: self.color_space.clone(),
            color_range: self.color_range.clone(),
            has_dolby_vision: self.has_dolby_vision,
            camera_make: self.camera_make.clone(),
            camera_model: self.camera_model.clone(),
        }
    }
}

/// In-process cache keyed by `(source_path, mtime)`. A single export
/// re-probes the same clip multiple times across validation steps; the
/// cache cuts that to one ffprobe spawn per clip.
static PROBE_CACHE: Mutex<Option<HashMap<(PathBuf, SystemTime), ProbedClip>>> = Mutex::new(None);

fn cache_get(key: &(PathBuf, SystemTime)) -> Option<ProbedClip> {
    let guard = PROBE_CACHE.lock().ok()?;
    guard.as_ref()?.get(key).cloned()
}

fn cache_put(key: (PathBuf, SystemTime), value: ProbedClip) {
    let Ok(mut guard) = PROBE_CACHE.lock() else {
        return;
    };
    guard.get_or_insert_with(HashMap::new).insert(key, value);
}

/// Probe `source_path` with `ffprobe`. Returns dims, audio presence, and
/// container duration. Cached in-process; misses spawn ffprobe.
pub async fn probe_clip(ffprobe_path: &Path, source_path: &Path) -> Result<ProbedClip, FfprobeError> {
    let mtime = source_path
        .metadata()
        .and_then(|m| m.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let key = (source_path.to_path_buf(), mtime);
    if let Some(cached) = cache_get(&key) {
        return Ok(cached);
    }

    // WS0 expanded the requested fields. The brief (`WS0-foundation.md`
    // §"Extend `ProbedClip` and ffprobe call") shows a `-select_streams v:0`
    // shape, but the cache key contract pre-dating WS0 also demands
    // `has_audio` — detected by looking for any audio stream. We satisfy both
    // by NOT narrowing to v:0 and instead pulling the union of color +
    // side-data + container tags across all streams. `codec_type` lands in
    // the requested entries so the audio-presence scan still works.
    //
    // The explicit `-show_entries` narrows the JSON payload to exactly what
    // we read; the alternative (`-show_streams` + `-show_format`) would
    // return everything implicitly but bloats the per-clip cache entry.
    let output = Command::new(ffprobe_path)
        .args([
            "-v",
            "error",
            "-show_entries",
            // Fix #8: also pull `tags` off the streams. Some containers
            // (MKV, AVI, some MP4 variants) store the encoder string on the
            // video stream rather than on the format tags, and a few iPhone
            // exports tag it under `handler_name`. `stream=...:stream_tags`
            // is `ffprobe`'s catch-all for per-stream metadata.
            "stream=codec_type,pix_fmt,color_primaries,color_transfer,color_space,color_range,width,height,duration",
            "-show_entries",
            // `rotate` is the legacy QuickTime/MP4 per-stream rotation tag;
            // modern files carry it as a Display Matrix side-data entry
            // instead (see `rotation` below). We read both.
            "stream_tags=encoder,handler_name,rotate",
            "-show_entries",
            // `rotation` is exposed on the `Display Matrix` side-data entry
            // (a float, e.g. -90.0). FFmpeg auto-rotates (default
            // `-autorotate on`) so the filtergraph receives DISPLAY-oriented
            // frames — we must swap coded W/H to match (see below).
            "stream_side_data=side_data_type,dv_profile,dv_level,rpu_present_flag,rotation",
            "-show_entries",
            "format=duration",
            "-show_entries",
            // Fix #8: `com.apple.quicktime.software` is QuickTime's
            // post-production "Software" tag (e.g. set by iMovie / Compressor
            // when re-encoding). When the original `encoder` field is
            // overwritten by a post-processing pass, the software tag often
            // still carries the recognisable substring (e.g. "DJI") that
            // identifies the original camera vendor.
            "format_tags=com.apple.quicktime.make,com.apple.quicktime.model,encoder,com.apple.quicktime.software",
            "-of",
            "json",
        ])
        .arg(source_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| FfprobeError::SpawnFailed {
            source_path: source_path.to_string_lossy().into_owned(),
            reason: e.to_string(),
        })?;

    if !output.status.success() {
        return Err(FfprobeError::ProbeFailed {
            source_path: source_path.to_string_lossy().into_owned(),
            reason: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }

    let probed = parse_ffprobe_json(&output.stdout, source_path)?;
    cache_put(key, probed.clone());
    Ok(probed)
}

fn parse_ffprobe_json(bytes: &[u8], source_path: &Path) -> Result<ProbedClip, FfprobeError> {
    let json: Value = serde_json::from_slice(bytes).map_err(|e| FfprobeError::ParseFailed {
        source_path: source_path.to_string_lossy().into_owned(),
        reason: e.to_string(),
    })?;

    let streams = json
        .get("streams")
        .and_then(|v| v.as_array())
        .ok_or_else(|| FfprobeError::ParseFailed {
            source_path: source_path.to_string_lossy().into_owned(),
            reason: "missing streams[]".to_string(),
        })?;

    let video = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(|v| v.as_str()) == Some("video"))
        .ok_or_else(|| FfprobeError::ParseFailed {
            source_path: source_path.to_string_lossy().into_owned(),
            reason: "no video stream".to_string(),
        })?;

    let coded_width = video
        .get("width")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| FfprobeError::ParseFailed {
            source_path: source_path.to_string_lossy().into_owned(),
            reason: "video.width missing or non-integer".to_string(),
        })? as u32;
    let coded_height = video
        .get("height")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| FfprobeError::ParseFailed {
            source_path: source_path.to_string_lossy().into_owned(),
            reason: "video.height missing or non-integer".to_string(),
        })? as u32;

    // Rotation awareness. FFmpeg auto-rotates by default (`-autorotate on`),
    // so every frame the filtergraph sees is in DISPLAY orientation — for a
    // ±90°/±270° rotation that's the coded dimensions swapped. The crop math
    // in `compute_focal_crop` operates in that same post-rotation space, and
    // the HTML5 preview reads `video.videoWidth/videoHeight` (also display
    // dims), so reporting display W/H here is what keeps preview and export
    // in agreement. Without this, a portrait video pane produces a crop taller
    // than the (landscape) rotated frame and FFmpeg's `crop` filter rejects it.
    let (width, height) = if rotation_swaps_axes(video) {
        (coded_height, coded_width)
    } else {
        (coded_width, coded_height)
    };

    let has_audio = streams
        .iter()
        .any(|s| s.get("codec_type").and_then(|v| v.as_str()) == Some("audio"));

    // `format.duration` is the canonical container duration. Some sources
    // (raw streams) omit it; fall back to the video stream's duration.
    let container_duration_s = json
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .or_else(|| {
            video
                .get("duration")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<f64>().ok())
        })
        .unwrap_or(0.0);

    // ---- WS0: color metadata extraction ----
    //
    // All five stream-level color tags read straight off the video stream.
    // They're optional in the JSON; `as_str_owned` returns None for any
    // shape we don't expect (numeric, null, absent), so we never error here
    // on a quirky-but-otherwise-decodable file.
    let pix_fmt = as_str_owned(video.get("pix_fmt"));
    let color_primaries = as_str_owned(video.get("color_primaries"));
    // ffprobe's JSON key is `color_transfer`; we canonicalise to "trc"
    // (transfer characteristics) on the Rust side to match the BT.709 /
    // BT.2020 spec naming used throughout the color pipeline docs.
    let color_trc = as_str_owned(video.get("color_transfer"));
    let color_space = as_str_owned(video.get("color_space"));
    let color_range = as_str_owned(video.get("color_range"));

    // Dolby Vision detection — walk the video stream's side_data_list for an
    // entry whose `side_data_type` is `"DOVI configuration record"` (FFmpeg's
    // user-facing name for the parsed `dvcC`/`dvvC`/`hvcE` boxes). Mere
    // presence is sufficient for Phase 1; profile-level distinctions get
    // wired in later if/when we add per-profile delivery paths.
    let has_dolby_vision = video
        .get("side_data_list")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter().any(|entry| {
                entry
                    .get("side_data_type")
                    .and_then(|v| v.as_str())
                    .map(|s| s.eq_ignore_ascii_case("DOVI configuration record"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);

    // Camera identification — QuickTime container tags first, encoder string
    // fallback for non-Apple devices. The fallback is intentionally narrow
    // (DJI, GoPro) per the WS0 brief; Phase 2 widens the set when log-format
    // detection arrives.
    //
    // Fix #8: when `format.tags.encoder` is missing (MKV, AVI, some MP4
    // variants), the encoder identifier may live in one of several other
    // places. Consult a small priority-ordered list before giving up:
    //   1. `format.tags.encoder` (the original WS0 path)
    //   2. `format.tags.com.apple.quicktime.software` (post-prod tag that
    //      sometimes preserves the original camera vendor substring)
    //   3. any video stream's `tags.encoder` (Matroska / AVI convention)
    //   4. any video stream's `tags.handler_name` (iPhone MOV variant —
    //      occasionally the only place a DJI / GoPro string survives a
    //      round-trip through QuickTime)
    // The make/model tags themselves (`com.apple.quicktime.make`/`.model`)
    // are checked first via the existing path; the encoder-fallback search
    // only runs when those are absent.
    let format_tags = json.get("format").and_then(|f| f.get("tags"));
    let camera_make = as_str_owned(format_tags.and_then(|t| t.get("com.apple.quicktime.make")));
    let camera_model = as_str_owned(format_tags.and_then(|t| t.get("com.apple.quicktime.model")));
    let (camera_make, camera_model) = match (camera_make, camera_model) {
        (None, None) => {
            // Walk the fallback list in priority order. Return the first
            // candidate that produces a non-None camera identification.
            let encoder_candidates = collect_encoder_candidates(&json, streams);
            let mut resolved = (None, None);
            for cand in encoder_candidates {
                let (m, mo) = detect_camera_from_encoder(Some(cand.as_str()));
                if m.is_some() || mo.is_some() {
                    resolved = (m, mo);
                    break;
                }
            }
            resolved
        }
        (existing_make, existing_model) => (existing_make, existing_model),
    };

    Ok(ProbedClip {
        width,
        height,
        has_audio,
        container_duration_s,
        pix_fmt,
        color_primaries,
        color_trc,
        color_space,
        color_range,
        has_dolby_vision,
        camera_make,
        camera_model,
    })
}

/// True when the video stream's display rotation is an odd multiple of 90°
/// (±90 / ±270), i.e. the orientation FFmpeg auto-rotates into has the coded
/// width and height swapped. Reads the rotation from two sources, in order:
///
///   1. The `Display Matrix` side-data entry's `rotation` field (modern MP4 /
///      MOV — a float like `-90.000000`).
///   2. The legacy per-stream `tags.rotate` (older containers — a string or
///      integer like `"90"`).
///
/// The angle is normalized into `[0, 360)` and we test `round(angle) % 180 ==
/// 90`. A pure 180° flip does NOT swap axes, so it correctly returns false.
fn rotation_swaps_axes(video: &Value) -> bool {
    let rotation = video
        .get("side_data_list")
        .and_then(|v| v.as_array())
        .and_then(|list| {
            list.iter().find_map(|entry| {
                let is_matrix = entry
                    .get("side_data_type")
                    .and_then(|v| v.as_str())
                    .map(|s| s.eq_ignore_ascii_case("Display Matrix"))
                    .unwrap_or(false);
                if !is_matrix {
                    return None;
                }
                // `rotation` may arrive as a JSON number or a string.
                entry.get("rotation").and_then(|v| {
                    v.as_f64()
                        .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
                })
            })
        })
        .or_else(|| {
            video
                .get("tags")
                .and_then(|t| t.get("rotate"))
                .and_then(|v| {
                    v.as_f64()
                        .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
                })
        });

    match rotation {
        Some(deg) if deg.is_finite() => {
            // Normalize into [0, 360), then test for an odd quarter-turn.
            let norm = deg.rem_euclid(360.0).round() as i64 % 360;
            norm % 180 == 90
        }
        _ => false,
    }
}

/// Helper: coerce a `serde_json::Value` reference into an owned `String`
/// when (and only when) it's a JSON string. Numbers, nulls, and missing
/// values all return `None`. Used throughout `parse_ffprobe_json` to pull
/// the optional color/camera tags without panicking on quirky shapes.
fn as_str_owned(v: Option<&Value>) -> Option<String> {
    v.and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// Fix #8 — fallback search order for encoder-bearing strings when the
/// QuickTime `make`/`model` tags are absent. Returns the candidates in
/// priority order; `detect_camera_from_encoder` is invoked on each in turn
/// and the first that produces a non-None match wins.
///
/// The priorities mirror real-world container behaviour:
///   1. `format.tags.encoder` — the canonical MP4 / MOV slot.
///   2. `format.tags.com.apple.quicktime.software` — post-prod tag that
///      sometimes preserves a recognisable camera-vendor substring when a
///      file has been re-encoded by iMovie / Compressor / Final Cut.
///   3. `stream.tags.encoder` for any video stream — Matroska (MKV) and
///      AVI store the encoder here rather than at the container level.
///   4. `stream.tags.handler_name` for any video stream — iPhone MOVs
///      occasionally surface camera vendor strings here when a round-trip
///      strips the format-level tags.
///
/// Strings are returned as owned `String` because the underlying serde
/// `Value` slices have arbitrary lifetimes. Empty strings are filtered
/// out so the matcher doesn't waste a pass on a "" tag.
fn collect_encoder_candidates(json: &Value, streams: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let format_tags = json.get("format").and_then(|f| f.get("tags"));

    let push_if_str = |out: &mut Vec<String>, v: Option<&Value>| {
        if let Some(s) = v.and_then(|v| v.as_str()) {
            if !s.is_empty() {
                out.push(s.to_string());
            }
        }
    };

    // 1. format.tags.encoder
    push_if_str(&mut out, format_tags.and_then(|t| t.get("encoder")));
    // 2. format.tags.com.apple.quicktime.software
    push_if_str(
        &mut out,
        format_tags.and_then(|t| t.get("com.apple.quicktime.software")),
    );

    // 3. + 4. video-stream-level tags. Iterate every video stream in
    // declaration order so we prefer the primary stream's tags; a
    // multi-stream file is rare in this app's input set but the deterministic
    // order keeps the fallback predictable.
    for s in streams {
        if s.get("codec_type").and_then(|v| v.as_str()) != Some("video") {
            continue;
        }
        let stream_tags = s.get("tags");
        push_if_str(&mut out, stream_tags.and_then(|t| t.get("encoder")));
        push_if_str(&mut out, stream_tags.and_then(|t| t.get("handler_name")));
    }

    out
}

/// Encoder-string fallback for `camera_make` / `camera_model` when the
/// QuickTime make/model tags are absent. Pattern-matches the two
/// non-Apple devices the WS0 brief calls out explicitly (DJI, GoPro).
/// Returns `(make, model)` — model is set when we recognise the substring
/// even if the encoder string itself is the only signal, so the pair stays
/// useful for grouping clips later (Phase 2's "set source format for all
/// DJI Mavic 3 clips" affordance).
fn detect_camera_from_encoder(encoder: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(enc) = encoder else { return (None, None); };
    let upper = enc.to_ascii_uppercase();
    if upper.contains("DJI") {
        return (Some("DJI".to_string()), Some(enc.to_string()));
    }
    if upper.contains("GOPRO") {
        return (Some("GoPro".to_string()), Some(enc.to_string()));
    }
    (None, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_VIDEO_AUDIO: &str = r#"{
        "streams": [
            {"codec_type": "video", "width": 1920, "height": 1080, "duration": "2.500000"},
            {"codec_type": "audio", "sample_rate": "48000", "channels": 2}
        ],
        "format": {"duration": "2.520000"}
    }"#;

    const SAMPLE_VIDEO_ONLY: &str = r#"{
        "streams": [
            {"codec_type": "video", "width": 3840, "height": 2160, "duration": "1.000000"}
        ],
        "format": {}
    }"#;

    const SAMPLE_NO_VIDEO: &str = r#"{
        "streams": [
            {"codec_type": "audio"}
        ],
        "format": {"duration": "5.0"}
    }"#;

    #[test]
    fn parse_with_audio() {
        let p =
            parse_ffprobe_json(SAMPLE_VIDEO_AUDIO.as_bytes(), Path::new("/x.mov")).unwrap();
        assert_eq!(p.width, 1920);
        assert_eq!(p.height, 1080);
        assert!(p.has_audio);
        assert!((p.container_duration_s - 2.52).abs() < 1e-6);
    }

    #[test]
    fn parse_video_only_falls_back_to_stream_duration() {
        let p = parse_ffprobe_json(SAMPLE_VIDEO_ONLY.as_bytes(), Path::new("/x.mov")).unwrap();
        assert_eq!(p.width, 3840);
        assert_eq!(p.height, 2160);
        assert!(!p.has_audio);
        assert!((p.container_duration_s - 1.0).abs() < 1e-6);
    }

    // iPhone 17 Pro clip: coded 1080x1920 with a Display Matrix rotation of
    // -90°. FFmpeg auto-rotates to a 1920x1080 display frame, so the reported
    // dims must be swapped to match the orientation the filtergraph crops.
    const SAMPLE_DISPLAY_MATRIX_90: &str = r#"{
        "streams": [
            {
                "codec_type": "video", "width": 1080, "height": 1920, "duration": "6.0",
                "side_data_list": [
                    {"side_data_type": "DOVI configuration record"},
                    {"side_data_type": "Display Matrix", "rotation": -90.000000}
                ]
            }
        ],
        "format": {"duration": "6.0"}
    }"#;

    // Legacy container: rotation lives in the per-stream `rotate` tag (string).
    const SAMPLE_TAG_ROTATE_270: &str = r#"{
        "streams": [
            {
                "codec_type": "video", "width": 1080, "height": 1920, "duration": "6.0",
                "tags": {"rotate": "270"}
            }
        ],
        "format": {"duration": "6.0"}
    }"#;

    // 180° flip must NOT swap axes.
    const SAMPLE_DISPLAY_MATRIX_180: &str = r#"{
        "streams": [
            {
                "codec_type": "video", "width": 1920, "height": 1080, "duration": "6.0",
                "side_data_list": [
                    {"side_data_type": "Display Matrix", "rotation": 180.0}
                ]
            }
        ],
        "format": {"duration": "6.0"}
    }"#;

    #[test]
    fn display_matrix_quarter_turn_swaps_dims() {
        let p =
            parse_ffprobe_json(SAMPLE_DISPLAY_MATRIX_90.as_bytes(), Path::new("/x.mov")).unwrap();
        assert_eq!(p.width, 1920);
        assert_eq!(p.height, 1080);
        // DOVI side-data alongside the Display Matrix still parses.
        assert!(p.has_dolby_vision);
    }

    #[test]
    fn legacy_rotate_tag_swaps_dims() {
        let p =
            parse_ffprobe_json(SAMPLE_TAG_ROTATE_270.as_bytes(), Path::new("/x.mov")).unwrap();
        assert_eq!(p.width, 1920);
        assert_eq!(p.height, 1080);
    }

    #[test]
    fn half_turn_does_not_swap_dims() {
        let p =
            parse_ffprobe_json(SAMPLE_DISPLAY_MATRIX_180.as_bytes(), Path::new("/x.mov")).unwrap();
        assert_eq!(p.width, 1920);
        assert_eq!(p.height, 1080);
    }

    #[test]
    fn parse_rejects_missing_video_stream() {
        let err = parse_ffprobe_json(SAMPLE_NO_VIDEO.as_bytes(), Path::new("/x.mov")).unwrap_err();
        match err {
            FfprobeError::ParseFailed { reason, .. } => {
                assert!(reason.contains("no video stream"), "reason: {}", reason);
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn parse_rejects_garbage() {
        let err = parse_ffprobe_json(b"not json", Path::new("/x.mov")).unwrap_err();
        assert!(matches!(err, FfprobeError::ParseFailed { .. }));
    }

    // ---- WS0: color extraction tests ----

    /// Realistic iPhone HLG capture — `arib-std-b67` transfer on BT.2020
    /// primaries, 10-bit 4:2:0, container carries the QuickTime camera
    /// tags. Mirrors the layout `ffprobe -show_entries` actually emits for
    /// an iPhone 15 Pro 4K60 HLG clip.
    const SAMPLE_IPHONE_HLG: &str = r#"{
        "streams": [
            {
                "codec_type": "video",
                "width": 3840,
                "height": 2160,
                "duration": "5.000000",
                "pix_fmt": "yuv420p10le",
                "color_primaries": "bt2020",
                "color_transfer": "arib-std-b67",
                "color_space": "bt2020nc",
                "color_range": "tv"
            },
            {"codec_type": "audio", "sample_rate": "48000"}
        ],
        "format": {
            "duration": "5.020000",
            "tags": {
                "com.apple.quicktime.make": "Apple",
                "com.apple.quicktime.model": "iPhone 15 Pro",
                "encoder": "HEVC"
            }
        }
    }"#;

    /// Realistic iPhone SDR capture — plain bt709 across the board, 8-bit.
    const SAMPLE_IPHONE_SDR: &str = r#"{
        "streams": [
            {
                "codec_type": "video",
                "width": 1920,
                "height": 1080,
                "duration": "3.000000",
                "pix_fmt": "yuv420p",
                "color_primaries": "bt709",
                "color_transfer": "bt709",
                "color_space": "bt709",
                "color_range": "tv"
            },
            {"codec_type": "audio"}
        ],
        "format": {
            "duration": "3.030000",
            "tags": {
                "com.apple.quicktime.make": "Apple",
                "com.apple.quicktime.model": "iPhone 12"
            }
        }
    }"#;

    /// Dolby Vision Profile 8.4 — base layer tags itself as HLG/BT.2020;
    /// the video stream carries a `DOVI configuration record` side-data
    /// entry. WS0's classifier must pick DolbyVision over HlgBt2020.
    const SAMPLE_DOLBY_VISION: &str = r#"{
        "streams": [
            {
                "codec_type": "video",
                "width": 3840,
                "height": 2160,
                "pix_fmt": "yuv420p10le",
                "color_primaries": "bt2020",
                "color_transfer": "arib-std-b67",
                "color_space": "bt2020nc",
                "color_range": "tv",
                "side_data_list": [
                    {
                        "side_data_type": "DOVI configuration record",
                        "dv_profile": 8,
                        "dv_level": 9,
                        "rpu_present_flag": 1
                    }
                ]
            }
        ],
        "format": {"duration": "1.000000"}
    }"#;

    /// DJI Mavic 3 capture — no QuickTime make/model tags but the `encoder`
    /// string carries the "DJI" marker. Camera fallback must catch this.
    const SAMPLE_DJI_NO_QT_TAGS: &str = r#"{
        "streams": [
            {
                "codec_type": "video",
                "width": 3840,
                "height": 2160,
                "pix_fmt": "yuv420p10le",
                "color_primaries": "bt709",
                "color_transfer": "bt709",
                "color_space": "bt709",
                "color_range": "tv"
            }
        ],
        "format": {
            "duration": "2.000000",
            "tags": {"encoder": "DJI Avatar Encoder"}
        }
    }"#;

    /// A file with no color tags at all — color fields land as None,
    /// `has_dolby_vision` stays false.
    const SAMPLE_NO_COLOR: &str = r#"{
        "streams": [
            {"codec_type": "video", "width": 640, "height": 480, "duration": "1.0"}
        ],
        "format": {"duration": "1.0"}
    }"#;

    #[test]
    fn parse_extracts_hlg_color_tags_and_apple_camera() {
        let p = parse_ffprobe_json(SAMPLE_IPHONE_HLG.as_bytes(), Path::new("/x.mov")).unwrap();
        assert_eq!(p.pix_fmt.as_deref(), Some("yuv420p10le"));
        assert_eq!(p.color_primaries.as_deref(), Some("bt2020"));
        assert_eq!(p.color_trc.as_deref(), Some("arib-std-b67"));
        assert_eq!(p.color_space.as_deref(), Some("bt2020nc"));
        assert_eq!(p.color_range.as_deref(), Some("tv"));
        assert!(!p.has_dolby_vision);
        assert_eq!(p.camera_make.as_deref(), Some("Apple"));
        assert_eq!(p.camera_model.as_deref(), Some("iPhone 15 Pro"));
        // Sanity: pre-WS0 fields still work.
        assert_eq!(p.width, 3840);
        assert!(p.has_audio);
    }

    #[test]
    fn parse_extracts_sdr_color_tags() {
        let p = parse_ffprobe_json(SAMPLE_IPHONE_SDR.as_bytes(), Path::new("/x.mov")).unwrap();
        assert_eq!(p.color_trc.as_deref(), Some("bt709"));
        assert_eq!(p.color_primaries.as_deref(), Some("bt709"));
        assert!(!p.has_dolby_vision);
        assert_eq!(p.camera_model.as_deref(), Some("iPhone 12"));
    }

    #[test]
    fn parse_detects_dolby_vision_side_data() {
        let p =
            parse_ffprobe_json(SAMPLE_DOLBY_VISION.as_bytes(), Path::new("/x.mov")).unwrap();
        assert!(
            p.has_dolby_vision,
            "DOVI configuration record in side_data_list must set has_dolby_vision"
        );
        // The base-layer HLG tags still come through so consumers can see
        // both signals; classify() in `util::color` picks DV over HLG.
        assert_eq!(p.color_trc.as_deref(), Some("arib-std-b67"));
    }

    #[test]
    fn parse_falls_back_to_encoder_string_for_dji() {
        let p =
            parse_ffprobe_json(SAMPLE_DJI_NO_QT_TAGS.as_bytes(), Path::new("/x.mov")).unwrap();
        assert_eq!(p.camera_make.as_deref(), Some("DJI"));
        assert!(p.camera_model.as_deref().unwrap_or("").contains("DJI"));
    }

    // ---- Fix #8: encoder fallback to non-`format.tags.encoder` keys ----

    /// MKV exported from a GoPro via an editor that wrote the encoder
    /// identifier onto the video stream's `tags.encoder` rather than the
    /// container-level `format.tags.encoder`. Matroska's natural convention.
    const SAMPLE_MKV_GOPRO_STREAM_ENCODER: &str = r#"{
        "streams": [
            {
                "codec_type": "video",
                "width": 1920,
                "height": 1080,
                "pix_fmt": "yuv420p",
                "color_primaries": "bt709",
                "color_transfer": "bt709",
                "color_space": "bt709",
                "color_range": "tv",
                "tags": {"encoder": "GoPro AVC encoder"}
            }
        ],
        "format": {"duration": "2.000000", "tags": {"title": "edit"}}
    }"#;

    /// MP4 re-encoded via Compressor / Final Cut: original `encoder` is
    /// gone, but the post-prod `com.apple.quicktime.software` tag still
    /// carries the DJI substring from the source workflow.
    const SAMPLE_QT_SOFTWARE_PRESERVES_DJI: &str = r#"{
        "streams": [
            {
                "codec_type": "video",
                "width": 3840,
                "height": 2160,
                "pix_fmt": "yuv420p10le",
                "color_primaries": "bt709",
                "color_transfer": "bt709",
                "color_space": "bt709",
                "color_range": "tv"
            }
        ],
        "format": {
            "duration": "2.000000",
            "tags": {
                "com.apple.quicktime.software": "DJI Edit 3.5"
            }
        }
    }"#;

    /// AVI/MOV where the only place a recognisable identifier survives is
    /// the video stream's `handler_name` (occasionally happens after a
    /// QuickTime round-trip).
    const SAMPLE_HANDLER_NAME_FALLBACK: &str = r#"{
        "streams": [
            {
                "codec_type": "video",
                "width": 1920,
                "height": 1080,
                "pix_fmt": "yuv420p",
                "tags": {"handler_name": "GoPro Handler"}
            }
        ],
        "format": {"duration": "1.000000", "tags": {}}
    }"#;

    /// Truly missing — no make/model tags, no encoder anywhere. Fix #8
    /// must still return `None`/`None` gracefully (the pre-fix behaviour
    /// for this shape).
    const SAMPLE_NO_ENCODER_ANYWHERE: &str = r#"{
        "streams": [
            {
                "codec_type": "video",
                "width": 1920,
                "height": 1080,
                "pix_fmt": "yuv420p"
            }
        ],
        "format": {"duration": "1.000000", "tags": {"title": "anonymous"}}
    }"#;

    #[test]
    fn parse_falls_back_to_stream_tags_encoder_for_mkv_gopro() {
        // Fix #8 acceptance: when `format.tags.encoder` is absent but the
        // video stream carries `tags.encoder="GoPro …"`, the camera
        // identification must still resolve to GoPro.
        let p = parse_ffprobe_json(
            SAMPLE_MKV_GOPRO_STREAM_ENCODER.as_bytes(),
            Path::new("/x.mkv"),
        )
        .unwrap();
        assert_eq!(p.camera_make.as_deref(), Some("GoPro"), "expected GoPro from stream encoder");
        assert!(
            p.camera_model.as_deref().unwrap_or("").contains("GoPro"),
            "model should preserve the stream encoder string"
        );
    }

    #[test]
    fn parse_falls_back_to_quicktime_software_for_post_processed_dji() {
        // Fix #8 acceptance: re-encoded MP4 with no `format.tags.encoder`
        // but `com.apple.quicktime.software` carrying "DJI Edit 3.5".
        let p = parse_ffprobe_json(
            SAMPLE_QT_SOFTWARE_PRESERVES_DJI.as_bytes(),
            Path::new("/x.mp4"),
        )
        .unwrap();
        assert_eq!(p.camera_make.as_deref(), Some("DJI"), "expected DJI from software tag");
    }

    #[test]
    fn parse_falls_back_to_stream_handler_name_for_gopro_roundtrip() {
        // Fix #8 acceptance: the last-resort fallback. handler_name is
        // typically descriptive ("VideoHandler") rather than identifying,
        // but in the rare case where it carries a vendor string the
        // identification still resolves.
        let p = parse_ffprobe_json(
            SAMPLE_HANDLER_NAME_FALLBACK.as_bytes(),
            Path::new("/x.mov"),
        )
        .unwrap();
        assert_eq!(p.camera_make.as_deref(), Some("GoPro"));
    }

    #[test]
    fn parse_returns_none_when_no_encoder_signal_anywhere() {
        // Fix #8 graceful-fail criterion: absence of every fallback key
        // must still produce None/None, not a panic or a false-positive
        // match.
        let p = parse_ffprobe_json(
            SAMPLE_NO_ENCODER_ANYWHERE.as_bytes(),
            Path::new("/x.mov"),
        )
        .unwrap();
        assert!(p.camera_make.is_none());
        assert!(p.camera_model.is_none());
    }

    #[test]
    fn parse_format_encoder_still_wins_over_stream_fallbacks() {
        // Priority order regression guard: when both `format.tags.encoder`
        // and a stream-level fallback are populated, the format-level
        // (canonical) tag must take precedence. Pre-Fix #8 behaviour
        // pulled only this key — that contract must hold.
        let json = r#"{
            "streams": [
                {
                    "codec_type": "video",
                    "width": 1920,
                    "height": 1080,
                    "pix_fmt": "yuv420p",
                    "tags": {"encoder": "GoPro Handler"}
                }
            ],
            "format": {
                "duration": "1.0",
                "tags": {"encoder": "DJI Avatar Encoder"}
            }
        }"#;
        let p = parse_ffprobe_json(json.as_bytes(), Path::new("/x.mp4")).unwrap();
        // Both DJI (format) and GoPro (stream) would match; format wins.
        assert_eq!(p.camera_make.as_deref(), Some("DJI"));
    }

    #[test]
    fn collect_encoder_candidates_order_matches_priority_list() {
        // White-box check on the helper: returns up to four candidates
        // for a fully-populated input, in the documented priority order.
        let json: Value = serde_json::from_str(
            r#"{
                "streams": [
                    {
                        "codec_type": "audio",
                        "tags": {"encoder": "AAC"}
                    },
                    {
                        "codec_type": "video",
                        "tags": {"encoder": "stream-enc", "handler_name": "vid-handler"}
                    }
                ],
                "format": {
                    "tags": {
                        "encoder": "format-enc",
                        "com.apple.quicktime.software": "qt-software"
                    }
                }
            }"#,
        )
        .unwrap();
        let streams = json.get("streams").unwrap().as_array().unwrap();
        let candidates = collect_encoder_candidates(&json, streams);
        assert_eq!(
            candidates,
            vec![
                "format-enc".to_string(),
                "qt-software".to_string(),
                "stream-enc".to_string(),
                "vid-handler".to_string(),
            ],
            "audio-stream tags must be ignored; video-stream tags follow format-level"
        );
    }

    #[test]
    fn parse_returns_none_for_missing_color_fields() {
        let p = parse_ffprobe_json(SAMPLE_NO_COLOR.as_bytes(), Path::new("/x.mov")).unwrap();
        assert!(p.pix_fmt.is_none());
        assert!(p.color_primaries.is_none());
        assert!(p.color_trc.is_none());
        assert!(p.color_space.is_none());
        assert!(p.color_range.is_none());
        assert!(!p.has_dolby_vision);
        assert!(p.camera_make.is_none());
        assert!(p.camera_model.is_none());
    }

    #[test]
    fn parse_classifies_via_util_color() {
        // Cross-module sanity: the data we extract here, when fed into
        // `util::color::classify`, produces the right SourceColorClass. The
        // import pipeline composes these two pieces, so this guards the
        // composition without spinning up the full import command.
        use crate::util::color::{classify, ColorMetadata, SourceColorClass};

        let hlg = parse_ffprobe_json(SAMPLE_IPHONE_HLG.as_bytes(), Path::new("/x.mov")).unwrap();
        let meta = ColorMetadata {
            pix_fmt: hlg.pix_fmt,
            color_primaries: hlg.color_primaries,
            color_trc: hlg.color_trc,
            color_space: hlg.color_space,
            color_range: hlg.color_range,
            has_dolby_vision: hlg.has_dolby_vision,
            camera_make: hlg.camera_make,
            camera_model: hlg.camera_model,
        };
        assert_eq!(classify(&meta), SourceColorClass::HlgBt2020);

        let sdr = parse_ffprobe_json(SAMPLE_IPHONE_SDR.as_bytes(), Path::new("/x.mov")).unwrap();
        let meta = ColorMetadata {
            pix_fmt: sdr.pix_fmt,
            color_primaries: sdr.color_primaries,
            color_trc: sdr.color_trc,
            color_space: sdr.color_space,
            color_range: sdr.color_range,
            has_dolby_vision: sdr.has_dolby_vision,
            camera_make: sdr.camera_make,
            camera_model: sdr.camera_model,
        };
        assert_eq!(classify(&meta), SourceColorClass::SdrBt709);

        let dv =
            parse_ffprobe_json(SAMPLE_DOLBY_VISION.as_bytes(), Path::new("/x.mov")).unwrap();
        let meta = ColorMetadata {
            pix_fmt: dv.pix_fmt,
            color_primaries: dv.color_primaries,
            color_trc: dv.color_trc,
            color_space: dv.color_space,
            color_range: dv.color_range,
            has_dolby_vision: dv.has_dolby_vision,
            camera_make: dv.camera_make,
            camera_model: dv.camera_model,
        };
        assert_eq!(classify(&meta), SourceColorClass::DolbyVision);

        let unknown =
            parse_ffprobe_json(SAMPLE_NO_COLOR.as_bytes(), Path::new("/x.mov")).unwrap();
        let meta = ColorMetadata {
            pix_fmt: unknown.pix_fmt,
            color_primaries: unknown.color_primaries,
            color_trc: unknown.color_trc,
            color_space: unknown.color_space,
            color_range: unknown.color_range,
            has_dolby_vision: unknown.has_dolby_vision,
            camera_make: unknown.camera_make,
            camera_model: unknown.camera_model,
        };
        assert_eq!(classify(&meta), SourceColorClass::Unknown);
    }
}
