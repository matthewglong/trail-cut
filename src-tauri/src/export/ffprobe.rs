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

#[derive(Debug, Clone, PartialEq)]
pub struct ProbedClip {
    pub width: u32,
    pub height: u32,
    pub has_audio: bool,
    /// Duration reported by FFmpeg's container parser (`format.duration`),
    /// in seconds. Used for sanity checking; the per-clip trim drives the
    /// actual filtergraph extents.
    pub container_duration_s: f64,
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

    let output = Command::new(ffprobe_path)
        .args([
            "-v",
            "error",
            "-show_streams",
            "-show_format",
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

    let width = video
        .get("width")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| FfprobeError::ParseFailed {
            source_path: source_path.to_string_lossy().into_owned(),
            reason: "video.width missing or non-integer".to_string(),
        })? as u32;
    let height = video
        .get("height")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| FfprobeError::ParseFailed {
            source_path: source_path.to_string_lossy().into_owned(),
            reason: "video.height missing or non-integer".to_string(),
        })? as u32;

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

    Ok(ProbedClip {
        width,
        height,
        has_audio,
        container_duration_s,
    })
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
}
