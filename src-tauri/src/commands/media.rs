use crate::export::ffprobe::probe_clip;
use crate::models::*;
use crate::util::color::{classify, suggest_log_format, SourceColorClass};
use crate::util::exiftool::{is_video_file, run_exiftool};
use std::path::{Path, PathBuf};

/// Scan a directory for video files and extract metadata via ExifTool, then
/// probe each one with ffprobe to populate color metadata (WS0).
#[tauri::command]
pub async fn scan_directory(path: String) -> Result<Vec<ClipMetadata>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let mut video_files: Vec<String> = Vec::new();
    let entries = std::fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if is_video_file(&path) {
            if let Some(p) = path.to_str() {
                video_files.push(p.to_string());
            }
        }
    }

    let mut clips = run_exiftool(&video_files)?;
    populate_color_metadata(&mut clips).await;
    Ok(clips)
}

/// Import videos from any mix of files and directories.
///
/// Two-pass extraction:
///   1. ExifTool — GPS, timestamps, duration, dims (existing behavior).
///   2. ffprobe (WS0) — color tags + DV side-data + camera identification.
///
/// Split pass because ExifTool and ffprobe disagree about color metadata
/// (ExifTool's tags don't map cleanly to FFmpeg's color regime model, and
/// the brief explicitly forbids extending ExifTool's tag list — see
/// `WS0-foundation.md` §"Out of scope"). Failures in the ffprobe pass are
/// non-fatal: a clip whose probe fails lands with `source_color_class =
/// Unknown` (treated as SDR downstream) and the import still succeeds.
#[tauri::command]
pub async fn import_media(paths: Vec<String>) -> Result<Vec<ClipMetadata>, String> {
    let mut video_files: Vec<String> = Vec::new();

    for p in paths {
        let path = Path::new(&p);
        if !path.exists() {
            continue;
        }
        if path.is_dir() {
            if let Ok(entries) = std::fs::read_dir(path) {
                for entry in entries.flatten() {
                    let entry_path = entry.path();
                    if is_video_file(&entry_path) {
                        if let Some(s) = entry_path.to_str() {
                            video_files.push(s.to_string());
                        }
                    }
                }
            }
        } else if is_video_file(path) {
            video_files.push(p);
        }
    }

    let mut clips = run_exiftool(&video_files)?;
    populate_color_metadata(&mut clips).await;
    Ok(clips)
}

/// WS0: run `probe_clip` on every imported clip and copy the color signals
/// and classifier verdict onto `ClipMetadata`. Mutates in place so the
/// caller doesn't have to thread a second collection through the import flow.
///
/// Concurrency: capped at 8 in-flight probes via a Tokio `Semaphore` to
/// match the export-path concurrency budget (`probe_clips_capped` in
/// `export::mod.rs`). Without the cap a 60-clip import would saturate the
/// OS file-handle limit on macOS.
///
/// Failure mode: per-clip. A clip whose ffprobe call fails (corrupt file,
/// missing binary, etc.) keeps the default `Unknown` color class and the
/// import continues. Downstream pipeline treats `Unknown` as SDR Rec.709,
/// so a probe failure degrades gracefully — the user still gets a working
/// (if conservatively-tagged) project.
async fn populate_color_metadata(clips: &mut [ClipMetadata]) {
    use tokio::sync::Semaphore;

    if clips.is_empty() {
        return;
    }

    let ffprobe_bin = ffprobe_path();
    let sem = std::sync::Arc::new(Semaphore::new(8));

    // Spawn one task per clip with a stable index so we can write the
    // results back into the slice in any completion order.
    let mut handles = Vec::with_capacity(clips.len());
    for (idx, clip) in clips.iter().enumerate() {
        let sem = sem.clone();
        let ffprobe = ffprobe_bin.clone();
        let path = PathBuf::from(&clip.path);
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.expect("semaphore");
            (idx, probe_clip(&ffprobe, &path).await)
        }));
    }

    for h in handles {
        let Ok((idx, result)) = h.await else { continue };
        let Ok(probed) = result else {
            // Probe failed — keep the Unknown default. The eprintln gives
            // CLI/dev-mode observability without forcing the import to fail.
            eprintln!(
                "ffprobe color probe failed for {}; defaulting to Unknown",
                clips[idx].path,
            );
            continue;
        };
        let meta = probed.color_metadata();
        let class = classify(&meta);
        // WS8 — only suggest log when the auto-detected class is SDR or
        // Unknown. A clip already detected as HDR (HLG/PQ) or DV is never a
        // log candidate; suggesting log on top would be a hard contradiction
        // for the UI to display. The knowledge base also has its own
        // HDR-transfer gate, but skipping the call entirely is the cleaner
        // contract — `suggested_log_class` stays `None` for any clip whose
        // `source_color_class` isn't SDR/Unknown.
        let suggestion = match class {
            SourceColorClass::SdrBt709 | SourceColorClass::Unknown => suggest_log_format(&meta),
            _ => None,
        };
        let clip = &mut clips[idx];
        clip.pix_fmt = meta.pix_fmt;
        clip.color_primaries = meta.color_primaries;
        clip.color_trc = meta.color_trc;
        clip.color_space = meta.color_space;
        clip.color_range = meta.color_range;
        clip.has_dolby_vision = meta.has_dolby_vision;
        clip.camera_make = meta.camera_make;
        clip.camera_model = meta.camera_model;
        clip.source_color_class = class;
        clip.suggested_log_class = suggestion;
        // Phase 1 never sets a user override at import time. Phase 2's
        // source-format UI populates `user_color_class_override` separately
        // — typically by promoting `suggested_log_class` into it after the
        // user confirms.
    }
}

/// Locate the `ffprobe` binary. Mirrors the helper in `export::mod.rs`
/// (kept duplicated here so this module isn't forced to take a dep on the
/// whole export namespace). When sidecar bundling lands (task 130 in the
/// export plan), both helpers will switch to the bundled binary together.
fn ffprobe_path() -> PathBuf {
    PathBuf::from("ffprobe")
}
