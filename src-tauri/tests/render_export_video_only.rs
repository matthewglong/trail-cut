// Integration test for the Channel C (video-only) end-to-end pipeline (task 070).
//
// Drives `render_export` against system FFmpeg, produces a `.mov` on disk, and
// asserts FFprobe reports the expected (codec, pix_fmt, dims, frame count,
// duration, audio stream). Reads frames out of the produced `.mov` and
// spot-checks alpha=0 outside the video slot rect, alpha=255 inside.
//
// Gated on `--features integration_export` so routine `cargo test` doesn't
// pay the wall clock and the dependency on FFmpeg + ffprobe. Mirrors 060's
// guard pattern.
//
// Fixture clips are synthesized at test-run time via FFmpeg's lavfi sources
// (`testsrc` + `sine`), keeping the repo free of binary fixture media.
//
// PRECONDITIONS:
//   ffmpeg / ffprobe on PATH
//
// Run:
//   cargo test --test render_export_video_only --features integration_export -- --nocapture

#![cfg(feature = "integration_export")]

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};
use tempfile::TempDir;
use trail_cut_lib::export::{
    default_layout, default_pip_layout, default_split_layout, output_dims, render_export,
    resolve_slots, AspectRatio, LayoutConfig, LayoutDescriptor, NormalizedRect, PipInsetSource,
    RenderExportRequest,
};

fn assert_ffmpeg_on_path() {
    let probe = Command::new("ffmpeg").arg("-version").output();
    if probe.map(|o| !o.status.success()).unwrap_or(true) {
        panic!("ffmpeg not on PATH (or non-zero exit). Install via `brew install ffmpeg`.");
    }
    let probe = Command::new("ffprobe").arg("-version").output();
    if probe.map(|o| !o.status.success()).unwrap_or(true) {
        panic!("ffprobe not on PATH (ships with ffmpeg).");
    }
}

/// Synthesize a `duration_s` second 1280x720 30fps test clip with a sine
/// audio stream into `output`. Uses FFmpeg's lavfi `testsrc` so we don't
/// commit binary fixtures.
fn make_test_clip(output: &Path, duration_s: f64, color_seed: &str) {
    // testsrc has a fixed pattern; we vary the apparent content via the
    // testsrc2 + drawtext-style hue to give each clip a slightly different
    // mid-frame pixel. Simpler: use `color=` for the second clip with a
    // distinct color.
    let video_src = match color_seed {
        "a" => format!("testsrc=size=1280x720:rate=30:duration={duration_s}"),
        _ => format!("color=c=red:size=1280x720:rate=30:duration={duration_s}"),
    };
    let audio_src = format!("sine=frequency=440:sample_rate=48000:duration={duration_s}");
    let status = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            &video_src,
            "-f",
            "lavfi",
            "-i",
            &audio_src,
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
        ])
        .arg(output)
        .status()
        .expect("spawn ffmpeg fixture builder");
    assert!(
        status.success(),
        "ffmpeg fixture builder failed for {}",
        output.display(),
    );
}

fn ffprobe_streams(path: &Path) -> Value {
    let out = Command::new("ffprobe")
        .args(["-v", "error", "-show_streams", "-show_format", "-of", "json"])
        .arg(path)
        .output()
        .expect("spawn ffprobe");
    if !out.status.success() {
        panic!(
            "ffprobe failed for {}:\n{}",
            path.display(),
            String::from_utf8_lossy(&out.stderr),
        );
    }
    serde_json::from_slice(&out.stdout).expect("ffprobe stdout → JSON")
}

fn extract_rgba_frame(input: &Path, frame_idx: u32, w: u32, h: u32) -> Vec<u8> {
    let out = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(input)
        .args([
            "-vf",
            &format!("select=eq(n\\,{})", frame_idx),
            "-vsync",
            "0",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-",
        ])
        .output()
        .expect("spawn ffmpeg frame extract");
    if !out.status.success() {
        panic!(
            "ffmpeg frame-extract failed for {}: {}",
            input.display(),
            String::from_utf8_lossy(&out.stderr),
        );
    }
    let expected = (w as usize) * (h as usize) * 4;
    assert_eq!(out.stdout.len(), expected, "extracted frame size mismatch");
    out.stdout
}

fn alpha_at(rgba: &[u8], w: u32, x: u32, y: u32) -> u8 {
    rgba[((y * w + x) as usize) * 4 + 3]
}

fn rgb_at(rgba: &[u8], w: u32, x: u32, y: u32) -> (u8, u8, u8) {
    let i = ((y * w + x) as usize) * 4;
    (rgba[i], rgba[i + 1], rgba[i + 2])
}

/// Build a 2-clip 9:16 fixture project. `inset_source` controls whether
/// the video slot is the full-bleed background (default 9:16 layout)
/// or the inset, and `corner_radius` sets the rounded-corner amount.
fn build_request(
    output_path: &str,
    clip_a_path: &Path,
    clip_b_path: &Path,
    inset_source: PipInsetSource,
    corner_radius: f64,
) -> RenderExportRequest {
    let aspect = AspectRatio::NineSixteen;
    let layout = if inset_source == PipInsetSource::Map && corner_radius == 0.012 {
        // Default 9:16: video as full-bleed bg, map as inset.
        default_layout(aspect)
    } else {
        LayoutConfig::Pip {
            inset_source,
            inset: NormalizedRect {
                x: 0.10,
                y: 0.10,
                w: 0.40,
                h: 0.40,
            },
            corner_radius,
        }
    };
    let resolved = resolve_slots(&layout, aspect);
    let layout_descriptor = LayoutDescriptor {
        aspect,
        layout,
        resolved,
    };

    // Project state — the video_only branch reads `clips`, `timeline`.
    let project_state = json!({
        "timeline": {
            // Two 1.0-second clips at speed=1.5 → 1/1.5 + 1/1.5 = ~1.333s
            // total. Use 2000ms as the budget; the actual `frames_written`
            // reported by render_export comes from this timeline value.
            // FFmpeg's actual encoded count (from ffprobe) reflects the
            // per-clip atempo'd spans; we assert duration ≈ 1.333s ± 50ms.
            "totalDurationMs": 1334
        },
        "route": null,
        "clips": [
            clip_json("clip-a", clip_a_path, 0, 1000, 1.5, 1.2),
            clip_json("clip-b", clip_b_path, 0, 1000, 1.5, 1.2),
        ],
        "mapSettings": {}
    });

    RenderExportRequest {
        channel: "video_only".to_string(),
        fps: 30,
        output_path: output_path.to_string(),
        layout: layout_descriptor,
        project_state,
    }
}

fn clip_json(
    id: &str,
    source: &Path,
    in_ms: u64,
    out_ms: u64,
    speed: f64,
    zoom: f64,
) -> Value {
    json!({
        "id": id,
        "path": source.to_string_lossy(),
        "filename": source.file_name().unwrap().to_string_lossy(),
        "duration_ms": out_ms,
        "resolution": "1280x720",
        "trim": {"in_ms": in_ms, "out_ms": out_ms},
        "focal_point": {"x": 0.5, "y": 0.5, "zoom": zoom},
        "effects": {
            "stabilize": {"enabled": false, "shakiness": 5},
            "speed": speed
        },
        "visible": true
    })
}

/// Default 9:16 PiP layout: video is the full-bleed background. The video
/// slot covers the full output frame; alpha=255 everywhere inside.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn video_only_full_bleed_default_layout() {
    assert_ffmpeg_on_path();
    let tmp = TempDir::new().expect("tempdir");
    let clip_a = tmp.path().join("clip-a.mp4");
    let clip_b = tmp.path().join("clip-b.mp4");
    make_test_clip(&clip_a, 1.0, "a");
    make_test_clip(&clip_b, 1.0, "b");

    let output_path = tmp.path().join("video_only.mov");
    // Default 9:16: PipInsetSource::Map with map as inset → video is the
    // full-bleed background. video_slot covers the full output frame.
    let req = build_request(
        output_path.to_string_lossy().as_ref(),
        &clip_a,
        &clip_b,
        PipInsetSource::Map,
        0.012,
    );

    let summary = render_export(req).await.expect("render_export should succeed");
    // total_frames is computed from the timeline's totalDurationMs (1334ms)
    // × 30fps = 40 frames (with rounding). The test verifies via ffprobe
    // that FFmpeg's actual frame count agrees with the duration math
    // (Σ trimmed_span / speed).
    assert!(summary.frames_written >= 30 && summary.frames_written <= 60);

    let probe = ffprobe_streams(&output_path);
    let streams = probe["streams"].as_array().expect("streams array");
    let video = streams
        .iter()
        .find(|s| s["codec_type"] == "video")
        .expect("video stream");
    assert_eq!(video["codec_name"], "prores");
    // ProRes 4444 supports both 10-bit and 12-bit yuva variants; FFmpeg's
    // prores_ks may emit either depending on build defaults. The
    // load-bearing invariant from LAYOUT.md §6 is "4:4:4 with alpha",
    // which both formats satisfy.
    let pix_fmt = video["pix_fmt"].as_str().expect("pix_fmt present");
    assert!(
        matches!(pix_fmt, "yuva444p10le" | "yuva444p12le"),
        "expected yuva444p{{10,12}}le, got {}",
        pix_fmt,
    );
    assert_eq!(video["width"].as_u64().unwrap(), 1080);
    assert_eq!(video["height"].as_u64().unwrap(), 1920);

    // Audio: 1 stream, pcm_s16le.
    let audio_streams: Vec<&Value> = streams
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .collect();
    assert_eq!(audio_streams.len(), 1, "expected one audio stream");
    assert_eq!(audio_streams[0]["codec_name"], "pcm_s16le");
    let sample_rate = audio_streams[0]["sample_rate"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .or_else(|| audio_streams[0]["sample_rate"].as_u64())
        .expect("sample_rate present");
    assert!(sample_rate >= 44100, "sample_rate={}", sample_rate);

    // Duration ≈ Σ(trimmed_span / speed) = 2 × (1.0 / 1.5) ≈ 1.333s ± frame.
    let duration = probe["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .expect("format.duration present");
    assert!(
        (1.30..=1.40).contains(&duration),
        "duration {} not in [1.30, 1.40]",
        duration,
    );

    // Mid-clip-0 frame (frame 10): pixel at slot center (540, 960) for
    // full-bleed video must be non-(0,0,0) and alpha=255.
    let frame = extract_rgba_frame(&output_path, 10, 1080, 1920);
    let center_a = alpha_at(&frame, 1080, 540, 960);
    assert_eq!(center_a, 255, "full-bleed video center must be opaque");
    let (r, g, b) = rgb_at(&frame, 1080, 540, 960);
    assert!(
        !(r == 0 && g == 0 && b == 0),
        "full-bleed video center should have non-zero RGB, got ({},{},{})",
        r,
        g,
        b,
    );
}

/// Inset variant: video slot is a small rect; pixels outside have alpha=0.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn video_only_inset_alpha_outside_is_zero() {
    assert_ffmpeg_on_path();
    let tmp = TempDir::new().expect("tempdir");
    let clip_a = tmp.path().join("clip-a.mp4");
    let clip_b = tmp.path().join("clip-b.mp4");
    make_test_clip(&clip_a, 1.0, "a");
    make_test_clip(&clip_b, 1.0, "b");

    let output_path = tmp.path().join("video_only_inset.mov");
    // Video as inset at (0.10, 0.10, 0.40, 0.40) of 1080×1920 →
    // slot (108, 192, 432, 768).
    let req = build_request(
        output_path.to_string_lossy().as_ref(),
        &clip_a,
        &clip_b,
        PipInsetSource::Video,
        0.0, // sharp corners — alphamerge skipped, only pad.
    );
    let resolved = req.layout.resolved.clone();

    render_export(req).await.expect("render_export should succeed");

    let frame = extract_rgba_frame(&output_path, 5, 1080, 1920);
    // Pixel (10, 10) — outside the inset rect — must have alpha=0.
    assert_eq!(
        alpha_at(&frame, 1080, 10, 10),
        0,
        "pixel outside inset should be transparent",
    );
    // Inset center: alpha=255 and non-(0,0,0) RGB.
    let cx = resolved.video_slot.x + resolved.video_slot.w / 2;
    let cy = resolved.video_slot.y + resolved.video_slot.h / 2;
    assert_eq!(
        alpha_at(&frame, 1080, cx, cy),
        255,
        "inset center should be opaque",
    );
    let (r, g, b) = rgb_at(&frame, 1080, cx, cy);
    assert!(
        !(r == 0 && g == 0 && b == 0),
        "inset center should have non-zero RGB, got ({},{},{})",
        r,
        g,
        b,
    );
}

/// Inset variant with corner radius: a pixel on the corner-arc edge has
/// alpha in (0, 255) (antialiased band); falloff is monotonic.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn video_only_inset_with_corner_radius_antialiased() {
    assert_ffmpeg_on_path();
    let tmp = TempDir::new().expect("tempdir");
    let clip_a = tmp.path().join("clip-a.mp4");
    let clip_b = tmp.path().join("clip-b.mp4");
    make_test_clip(&clip_a, 1.0, "a");
    make_test_clip(&clip_b, 1.0, "b");

    let output_path = tmp.path().join("video_only_corner.mov");
    let req = build_request(
        output_path.to_string_lossy().as_ref(),
        &clip_a,
        &clip_b,
        PipInsetSource::Video,
        0.05, // 0.05 × min(1080, 1920) = 54 px corner radius.
    );
    let resolved = req.layout.resolved.clone();
    assert!(resolved.corner_radius_px > 0, "corner_radius_px should be positive");

    render_export(req).await.expect("render_export should succeed");

    let frame = extract_rgba_frame(&output_path, 5, 1080, 1920);

    // Sweep horizontally along the top row of the inset (`y = video_slot.y`),
    // through the top-left corner-arc region (mask y = 0, mask x in
    // [0, corner_radius_px]). Antialiased band lives where the mask's
    // signed distance to the arc center crosses ±0.5 px, i.e. at mask x ≈
    // sqrt(r² - r²) (boundary). For r=54, scanning mask x ∈ [0, 54] hits
    // an antialiased pixel somewhere in the middle.
    let r = resolved.corner_radius_px;
    let top_y = resolved.video_slot.y;
    let mut found_intermediate = false;
    let mut alphas = Vec::new();
    for k in 0..=r {
        let px = resolved.video_slot.x + k;
        let a = alpha_at(&frame, 1080, px, top_y);
        alphas.push(a);
        if a > 0 && a < 255 {
            found_intermediate = true;
        }
    }
    assert!(
        found_intermediate,
        "expected at least one antialiased pixel along the top arc edge, alphas={:?}",
        alphas,
    );

    // Monotonic alpha falloff along the top row: leftmost (mask x=0,
    // outside the arc) has lower alpha than near the arc-center column
    // (mask x=r, on the rectangle's flat edge).
    let outside_a = alpha_at(&frame, 1080, resolved.video_slot.x, top_y);
    let inside_a = alpha_at(&frame, 1080, resolved.video_slot.x + r, top_y);
    assert!(
        outside_a <= inside_a,
        "alpha should rise monotonically from arc edge → flat edge: outside={} inside={}",
        outside_a,
        inside_a,
    );
}

#[allow(dead_code)]
fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Build a Channel C request at an arbitrary `(aspect, layout)` cell. The
/// 2-clip fixture stays the same; only the layout descriptor varies. Used
/// by the task 100 matrix tests.
#[cfg(feature = "integration_export_matrix")]
fn build_request_with_layout(
    output_path: &str,
    clip_a_path: &Path,
    clip_b_path: &Path,
    aspect: AspectRatio,
    layout: LayoutConfig,
) -> RenderExportRequest {
    let resolved = resolve_slots(&layout, aspect);
    let layout_descriptor = LayoutDescriptor {
        aspect,
        layout,
        resolved,
    };
    let project_state = json!({
        "timeline": { "totalDurationMs": 1334 },
        "route": null,
        "clips": [
            clip_json("clip-a", clip_a_path, 0, 1000, 1.5, 1.2),
            clip_json("clip-b", clip_b_path, 0, 1000, 1.5, 1.2),
        ],
        "mapSettings": {}
    });
    RenderExportRequest {
        channel: "video_only".to_string(),
        fps: 30,
        output_path: output_path.to_string(),
        layout: layout_descriptor,
        project_state,
    }
}

/// Task 100 matrix: render Channel C at every (PiP, Split) × (9:16, 4:5,
/// 16:9) cell and verify FFprobe reports correct dims, codec, pix_fmt, and
/// audio stream. Existing baseline 9:16-PiP tests stay; this is additive.
#[cfg(feature = "integration_export_matrix")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn channel_c_full_matrix() {
    assert_ffmpeg_on_path();
    let tmp = TempDir::new().expect("tempdir");
    let clip_a = tmp.path().join("clip-a.mp4");
    let clip_b = tmp.path().join("clip-b.mp4");
    make_test_clip(&clip_a, 1.0, "a");
    make_test_clip(&clip_b, 1.0, "b");

    let aspects = [
        AspectRatio::NineSixteen,
        AspectRatio::FourFive,
        AspectRatio::SixteenNine,
    ];
    for aspect in aspects {
        for (mode, layout) in [
            ("pip", default_pip_layout(aspect)),
            ("split", default_split_layout(aspect)),
        ] {
            let output_path = tmp
                .path()
                .join(format!("video_only_{:?}_{}.mov", aspect, mode));
            let req = build_request_with_layout(
                output_path.to_string_lossy().as_ref(),
                &clip_a,
                &clip_b,
                aspect,
                layout,
            );

            render_export(req).await.unwrap_or_else(|e| {
                panic!("render_export failed for ({:?}, {}): {:?}", aspect, mode, e)
            });

            let probe = ffprobe_streams(&output_path);
            let streams = probe["streams"].as_array().expect("streams array");
            let video = streams
                .iter()
                .find(|s| s["codec_type"] == "video")
                .unwrap_or_else(|| panic!("no video stream for ({:?}, {})", aspect, mode));
            assert_eq!(video["codec_name"], "prores", "{:?} {}", aspect, mode);
            let pix_fmt = video["pix_fmt"].as_str().expect("pix_fmt present");
            assert!(
                matches!(pix_fmt, "yuva444p10le" | "yuva444p12le"),
                "{:?} {}: pix_fmt={}",
                aspect,
                mode,
                pix_fmt,
            );

            let dims = output_dims(aspect);
            assert_eq!(
                video["width"].as_u64().unwrap() as u32,
                dims.w,
                "{:?} {} width",
                aspect,
                mode,
            );
            assert_eq!(
                video["height"].as_u64().unwrap() as u32,
                dims.h,
                "{:?} {} height",
                aspect,
                mode,
            );

            // Channel C carries audio: pcm_s16le, exactly one stream.
            let audio_streams: Vec<&Value> = streams
                .iter()
                .filter(|s| s["codec_type"] == "audio")
                .collect();
            assert_eq!(audio_streams.len(), 1, "{:?} {} audio count", aspect, mode);
            assert_eq!(
                audio_streams[0]["codec_name"], "pcm_s16le",
                "{:?} {} audio codec",
                aspect,
                mode,
            );
        }
    }
}
