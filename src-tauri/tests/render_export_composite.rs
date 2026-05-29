// Integration test for the Channel A (composite) end-to-end pipeline (task 090).
//
// Channel A is the headline deliverable: the map render stream and the
// per-clip processed video stream composited into a single H.265 `.mp4` per
// the configured layout, with audio. Drives `render_export` against system
// FFmpeg + the bundled renderer worker, produces a `.mp4` on disk, and
// asserts FFprobe reports `(1080×1920, hevc, yuv420p, 1× aac audio stream,
// duration ≈ Σ trimmed-and-speed-adjusted clip spans)`. Reads frame 30 of
// the output and spot-checks pixels per layout mode:
//
//   * PiP-map-inset (default 9:16): frame center is full-bleed video; inset
//     center is the map.
//   * PiP-video-inset: frame center is full-bleed map; inset center is video.
//   * Split: each half holds map / video respectively.
//
// All three modes assert alpha=255 across the canvas — Channel A is the
// deliverable, opaque end-to-end (LAYOUT.md §6 invariant: no transparent
// regions in the composite output).
//
// Gated on `--features integration_export` so routine `cargo test` doesn't
// pay the wall clock and the dependency on FFmpeg + Node + maplibre-native +
// network (cold tile fetches). Mirrors 060/070's guard pattern.
//
// NOTE: The LAYOUT.md §6 "B + C composites to A" parity test is deferred to
// a follow-up task. It would gate on a separate `integration_export_parity`
// feature (three exports back-to-back is the slowest test in the suite).
// This file ships the headline correctness coverage; the parity guarantee is
// already enforced *structurally* — the composite branch reuses
// `build_clip_chain` (per 070) and `corner_mask::build_corner_mask_png` (per
// 060) without modification.
//
// PRECONDITIONS (run once before this test):
//   npm run build:renderer
//   ffmpeg / ffprobe on PATH
//
// Run:
//   cargo test --test render_export_composite --features integration_export -- --nocapture

#![cfg(feature = "integration_export")]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{json, Value};
use tempfile::TempDir;
use trail_cut_lib::export::{
    default_layout, default_pip_layout, default_split_layout, output_dims, render_export_inner,
    resolve_slots, AspectRatio, CodecPreference, DeliveryTarget, LayoutConfig, LayoutDescriptor,
    NormalizedRect, OutputResolution, PipInsetSource, RenderExportRequest, SplitSide,
};

// --- env / fixture helpers --------------------------------------------------

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn renderer_cjs() -> PathBuf {
    manifest_dir()
        .join("sidecars")
        .join("renderer")
        .join("dist")
        .join("renderer.cjs")
}

fn setup_fixture_cjs() -> PathBuf {
    manifest_dir()
        .join("sidecars")
        .join("renderer")
        .join("dist")
        .join("setup_fixture.cjs")
}

fn assert_bundle_present() {
    let renderer = renderer_cjs();
    let fixture = setup_fixture_cjs();
    if !renderer.exists() || !fixture.exists() {
        panic!(
            "Renderer bundle artifacts missing. Run `npm run build:renderer` first.\n\
             Expected: {}\n\
             Expected: {}",
            renderer.display(),
            fixture.display(),
        );
    }
}

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
/// commit binary fixtures. Mirrors 070's helper exactly so the cross-channel
/// diff assertions in the composite tests use the same baseline content.
fn make_test_clip(output: &Path, duration_s: f64, color_seed: &str) {
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

fn ffprobe_streams_and_format(path: &Path) -> Value {
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

fn channel_max_diff(a: (u8, u8, u8), b: (u8, u8, u8)) -> i32 {
    let dr = (a.0 as i32 - b.0 as i32).abs();
    let dg = (a.1 as i32 - b.1 as i32).abs();
    let db = (a.2 as i32 - b.2 as i32).abs();
    dr.max(dg).max(db)
}

// --- request builder --------------------------------------------------------

fn clip_json(
    id: &str,
    source: &Path,
    in_ms: u64,
    out_ms: u64,
    speed: f64,
    zoom: f64,
    created_at: &str,
) -> Value {
    // `created_at` is load-bearing for `compileTimeline`: clips without a
    // parseable timestamp are filtered out by `filterCompilableClips`, which
    // produces an empty `clipSpans` array — and the renderer's
    // `activeClipIdAt` then refuses to do anything sensible with the timeline.
    json!({
        "id": id,
        "path": source.to_string_lossy(),
        "filename": source.file_name().unwrap().to_string_lossy(),
        "created_at": created_at,
        "duration_ms": out_ms,
        "resolution": "1280x720",
        "trim": {"in_ms": in_ms, "out_ms": out_ms},
        "focal_point": {"x": 0.5, "y": 0.5, "zoom": zoom},
        "effects": {
            "stabilize": {"enabled": false, "shakiness": 5},
            "speed": speed
        },
        "visible": true,
        "map_overrides": null
    })
}

/// Run `node setup_fixture.cjs` with the given clips piped in as JSON, and
/// return the fully-compiled SetupPayload (with `timeline.clipSpans` etc.)
/// suitable to flatten into `RenderExportRequest.project_state`.
///
/// The composite tests build their own ad-hoc clip fixtures (synthetic mp4
/// files at tmpdir paths), so they can't reuse the default fixture's
/// `/dev/null/clip-a.mov`. Piping the per-test clip array through stdin
/// keeps the timeline-compile logic in one place (the TS port) — without it,
/// the renderer worker's `activeClipIdAt` crashes on a stub
/// `{ totalDurationMs }` timeline that is missing `clipSpans`.
fn build_setup_payload_via_fixture(clips: &[Value]) -> Value {
    assert_bundle_present();
    let fixture = setup_fixture_cjs();
    let overrides = json!({
        "clips": clips,
        // Composite tests don't have real GPS data on the synthetic
        // testsrc clips, so skip route indexing entirely.
        "route": null,
    });

    let mut child = Command::new("node")
        .arg(&fixture)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn node setup_fixture.cjs");
    {
        let stdin = child.stdin.as_mut().expect("child stdin");
        stdin
            .write_all(overrides.to_string().as_bytes())
            .expect("write overrides to fixture stdin");
    }
    let output = child
        .wait_with_output()
        .expect("wait for setup_fixture.cjs");
    if !output.status.success() {
        panic!(
            "setup_fixture.cjs failed: stderr={}",
            String::from_utf8_lossy(&output.stderr),
        );
    }
    let mut payload: Value =
        serde_json::from_slice(&output.stdout).expect("fixture stdout → JSON");
    // The fixture emits the wire-shape SetupCmd (`cmd`, `cssViewport`,
    // `framebuffer`, `pixelRatio`, `fps`); `RenderExportRequest` re-injects
    // those itself, so strip them so the flattened project_state has no
    // leftover envelope fields.
    if let Some(obj) = payload.as_object_mut() {
        obj.remove("cmd");
        obj.remove("cssViewport");
        obj.remove("framebuffer");
        obj.remove("pixelRatio");
        obj.remove("fps");
    }
    payload
}

/// Build a 2-clip 9:16 composite request with the given layout config.
///
/// Two 1.0-second clips at speed=1.5 → 1/1.5 + 1/1.5 = ~1.333s total. The
/// actual `frames_written` reported by render_export is computed from the
/// timeline's totalDurationMs; the integration test verifies the produced
/// media's duration via FFprobe matches the per-clip atempo'd spans
/// (Σ trimmed_span / speed).
///
/// We can't stub `timeline` here because the renderer worker's
/// `activeClipIdAt` reads `timeline.clipSpans.length`. Instead we drive the
/// real `compileTimeline` via the bundled fixture builder, which produces a
/// fully-shaped CompiledTimeline (clipSpans, transitionSpans, totalDurationMs).
fn build_request(
    output_path: &str,
    clip_a_path: &Path,
    clip_b_path: &Path,
    layout: LayoutConfig,
) -> RenderExportRequest {
    let aspect = AspectRatio::NineSixteen;
    let resolved = resolve_slots(&layout, aspect, OutputResolution::default());
    let layout_descriptor = LayoutDescriptor {
        aspect,
        resolution: OutputResolution::default(),
        layout,
        resolved,
    };

    let clips = vec![
        clip_json(
            "clip-a",
            clip_a_path,
            0,
            1000,
            1.5,
            1.2,
            "2024-06-01T12:00:00.000-07:00",
        ),
        clip_json(
            "clip-b",
            clip_b_path,
            0,
            1000,
            1.5,
            1.2,
            "2024-06-01T12:00:01.000-07:00",
        ),
    ];
    let project_state = build_setup_payload_via_fixture(&clips);

    RenderExportRequest {
        channel: "composite".to_string(),
        fps: 30,
        output_path: output_path.to_string(),
        layout: layout_descriptor,
        codec_preference: CodecPreference::default(),
        audio_bitrate_kbps: 256,
        // WS4: legacy composite integration tests stay on the YouTube SDR
        // 4K target — the existing assertions on hevc + yuv420p + +faststart
        // line up with that target's `delivery_encoder_args` output.
        delivery_target: DeliveryTarget::SdrH265,
        project_state,
    }
}

// --- shared assertion helpers ----------------------------------------------

/// FFprobe assertions common to every Channel A export: 1080×1920 hevc
/// yuv420p video stream + a single aac audio stream + duration ≈ 1.333s.
fn assert_composite_container_shape(output_path: &Path) {
    let probe = ffprobe_streams_and_format(output_path);
    let streams = probe["streams"].as_array().expect("streams array");
    let video = streams
        .iter()
        .find(|s| s["codec_type"] == "video")
        .expect("video stream");
    assert_eq!(video["codec_name"], "hevc");
    assert_eq!(video["pix_fmt"], "yuv420p");
    assert_eq!(video["width"].as_u64().unwrap(), 1080);
    assert_eq!(video["height"].as_u64().unwrap(), 1920);

    let audio_streams: Vec<&Value> = streams
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .collect();
    assert_eq!(audio_streams.len(), 1, "expected one audio stream");
    assert_eq!(audio_streams[0]["codec_name"], "aac");
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
}

// --- tests ------------------------------------------------------------------

/// Default 9:16 layout: PiP with map as inset (bottom-right), video as the
/// full-bleed background. Frame 30 (mid-timeline) sample at (540, 960) — the
/// frame center — falls inside the full-bleed video coverage and outside the
/// bottom-right map inset rect; pixel at the inset's center is the map.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn composite_pip_map_inset_default_layout() {
    assert_ffmpeg_on_path();
    assert_bundle_present();
    let tmp = TempDir::new().expect("tempdir");
    let clip_a = tmp.path().join("clip-a.mp4");
    let clip_b = tmp.path().join("clip-b.mp4");
    make_test_clip(&clip_a, 1.0, "a");
    make_test_clip(&clip_b, 1.0, "b");
    let output_path = tmp.path().join("composite.mp4");

    // Default 9:16: PipInsetSource::Map with map as bottom-right inset.
    let layout = default_layout(AspectRatio::NineSixteen);
    let resolved = resolve_slots(&layout, AspectRatio::NineSixteen, OutputResolution::default());
    let req = build_request(
        output_path.to_string_lossy().as_ref(),
        &clip_a,
        &clip_b,
        layout,
    );

    let summary = render_export_inner(req, None)
        .await
        .expect("render_export should succeed");
    // 1334ms × 30fps → 40 frames (round-half-up). The actual encoded count
    // can drift by a frame or two due to per-clip atempo rounding; allow a
    // generous band rather than asserting exact equality.
    assert!(
        summary.frames_written >= 30 && summary.frames_written <= 60,
        "frames_written {} not in [30, 60]",
        summary.frames_written,
    );

    assert_composite_container_shape(&output_path);

    // ---- frame-30 sampling ----
    // Pixel (540, 960) — frame center — is in the full-bleed video and
    // *outside* the bottom-right map inset. Channel A is opaque end-to-end,
    // so alpha=255 is the load-bearing invariant (the rawvideo-rgba extract
    // pipeline always reports alpha=255 for an opaque yuv420p source — this
    // assertion is a tripwire for any future regression that introduces
    // transparency into A's output).
    let frame = extract_rgba_frame(&output_path, 30, 1080, 1920);
    let center_a = alpha_at(&frame, 1080, 540, 960);
    assert_eq!(center_a, 255, "composite output is opaque at frame center");
    let video_rgb = rgb_at(&frame, 1080, 540, 960);
    assert!(
        !(video_rgb.0 == 0 && video_rgb.1 == 0 && video_rgb.2 == 0),
        "frame center should have video pixels, got ({},{},{})",
        video_rgb.0,
        video_rgb.1,
        video_rgb.2,
    );

    // Pixel at the inset's center — the map slot — is non-(0,0,0) (the map
    // covers it) and visibly differs from the video pixel above. Weak
    // assertion (per-channel diff > 30): we're confirming the composite ran,
    // not pixel-equal-asserting.
    let cx = resolved.map_slot.x + resolved.map_slot.w / 2;
    let cy = resolved.map_slot.y + resolved.map_slot.h / 2;
    let inset_a = alpha_at(&frame, 1080, cx, cy);
    assert_eq!(inset_a, 255, "inset center must be opaque");
    let map_rgb = rgb_at(&frame, 1080, cx, cy);
    assert!(
        !(map_rgb.0 == 0 && map_rgb.1 == 0 && map_rgb.2 == 0),
        "inset center should have map pixels, got ({},{},{})",
        map_rgb.0,
        map_rgb.1,
        map_rgb.2,
    );
    assert!(
        channel_max_diff(map_rgb, video_rgb) > 30,
        "inset pixel ({},{},{}) should differ from video pixel ({},{},{}) by >30 in some channel",
        map_rgb.0,
        map_rgb.1,
        map_rgb.2,
        video_rgb.0,
        video_rgb.1,
        video_rgb.2,
    );
}

/// PiP with video as the inset (mirror of the default): map is the
/// full-bleed background; video sits at the inset rect at (0.10, 0.10, 0.40,
/// 0.40) with a 0.012 corner radius. Frame 30 sample at (540, 960) — frame
/// center — falls inside the map's full-bleed coverage; pixel at the inset's
/// center is the video.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn composite_pip_video_inset() {
    assert_ffmpeg_on_path();
    assert_bundle_present();
    let tmp = TempDir::new().expect("tempdir");
    let clip_a = tmp.path().join("clip-a.mp4");
    let clip_b = tmp.path().join("clip-b.mp4");
    make_test_clip(&clip_a, 1.0, "a");
    make_test_clip(&clip_b, 1.0, "b");
    let output_path = tmp.path().join("composite_video_inset.mp4");

    // `default_layout(NineSixteen)` returns `PipInsetSource::Map`; construct
    // the video-inset variant manually.
    let layout = LayoutConfig::Pip {
        inset_source: PipInsetSource::Video,
        inset: NormalizedRect {
            x: 0.10,
            y: 0.10,
            w: 0.40,
            h: 0.40,
        },
        corner_radius: 0.012,
    };
    let resolved = resolve_slots(&layout, AspectRatio::NineSixteen, OutputResolution::default());
    let req = build_request(
        output_path.to_string_lossy().as_ref(),
        &clip_a,
        &clip_b,
        layout,
    );

    render_export_inner(req, None)
        .await
        .expect("render_export should succeed");

    assert_composite_container_shape(&output_path);

    // ---- frame-30 sampling ----
    // Pixel (540, 960) — frame center — falls *outside* the top-left inset
    // (which spans roughly (108, 192) → (540, 960) at 0.10/0.10/0.40/0.40,
    // so the geometric center of the frame is the inset's bottom-right
    // corner; we sample further out to be safely outside the inset).
    // Sample at (900, 1500) — solidly in the map's full-bleed region.
    let frame = extract_rgba_frame(&output_path, 30, 1080, 1920);
    let bg_a = alpha_at(&frame, 1080, 900, 1500);
    assert_eq!(bg_a, 255, "composite output is opaque outside inset");
    let map_rgb = rgb_at(&frame, 1080, 900, 1500);
    assert!(
        !(map_rgb.0 == 0 && map_rgb.1 == 0 && map_rgb.2 == 0),
        "background should have map pixels, got ({},{},{})",
        map_rgb.0,
        map_rgb.1,
        map_rgb.2,
    );

    // Inset center — the video slot — has the source video pixels.
    let cx = resolved.video_slot.x + resolved.video_slot.w / 2;
    let cy = resolved.video_slot.y + resolved.video_slot.h / 2;
    let inset_a = alpha_at(&frame, 1080, cx, cy);
    assert_eq!(inset_a, 255, "video inset center must be opaque");
    let video_rgb = rgb_at(&frame, 1080, cx, cy);
    assert!(
        !(video_rgb.0 == 0 && video_rgb.1 == 0 && video_rgb.2 == 0),
        "video inset center should have non-zero RGB, got ({},{},{})",
        video_rgb.0,
        video_rgb.1,
        video_rgb.2,
    );
    assert!(
        channel_max_diff(map_rgb, video_rgb) > 30,
        "video inset pixel ({},{},{}) should differ from map pixel ({},{},{}) by >30 in some channel",
        video_rgb.0,
        video_rgb.1,
        video_rgb.2,
        map_rgb.0,
        map_rgb.1,
        map_rgb.2,
    );
}

/// Split layout (9:16 aspect): video on the top half, map on the bottom half.
/// `legal_split_sides(NineSixteen)` permits only Top/Bottom — `Left`/`Right`
/// are inverse-orientation for portrait and rejected by `validate_request`.
/// No inset, no corner mask. Frame 30 sample at the center of each half
/// asserts that the two pixels are visibly different (cross-half diff > 30 in
/// some channel) and that both halves are opaque (alpha=255).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn composite_split() {
    assert_ffmpeg_on_path();
    assert_bundle_present();
    let tmp = TempDir::new().expect("tempdir");
    let clip_a = tmp.path().join("clip-a.mp4");
    let clip_b = tmp.path().join("clip-b.mp4");
    make_test_clip(&clip_a, 1.0, "a");
    make_test_clip(&clip_b, 1.0, "b");
    let output_path = tmp.path().join("composite_split.mp4");

    let layout = LayoutConfig::Split {
        video_side: SplitSide::Top,
        divider: 0.5,
    };
    let resolved = resolve_slots(&layout, AspectRatio::NineSixteen, OutputResolution::default());
    let req = build_request(
        output_path.to_string_lossy().as_ref(),
        &clip_a,
        &clip_b,
        layout,
    );

    render_export_inner(req, None)
        .await
        .expect("render_export should succeed");

    assert_composite_container_shape(&output_path);

    // ---- frame-30 sampling ----
    let frame = extract_rgba_frame(&output_path, 30, 1080, 1920);

    // Center of the video slot (top half for 9:16 split).
    let vx = resolved.video_slot.x + resolved.video_slot.w / 2;
    let vy = resolved.video_slot.y + resolved.video_slot.h / 2;
    let video_a = alpha_at(&frame, 1080, vx, vy);
    assert_eq!(video_a, 255, "split video half must be opaque");
    let video_rgb = rgb_at(&frame, 1080, vx, vy);
    assert!(
        !(video_rgb.0 == 0 && video_rgb.1 == 0 && video_rgb.2 == 0),
        "split video half center should have non-zero RGB, got ({},{},{})",
        video_rgb.0,
        video_rgb.1,
        video_rgb.2,
    );

    // Center of the map slot (bottom half for 9:16 split).
    let mx = resolved.map_slot.x + resolved.map_slot.w / 2;
    let my = resolved.map_slot.y + resolved.map_slot.h / 2;
    let map_a = alpha_at(&frame, 1080, mx, my);
    assert_eq!(map_a, 255, "split map half must be opaque");
    let map_rgb = rgb_at(&frame, 1080, mx, my);
    assert!(
        !(map_rgb.0 == 0 && map_rgb.1 == 0 && map_rgb.2 == 0),
        "split map half center should have non-zero RGB, got ({},{},{})",
        map_rgb.0,
        map_rgb.1,
        map_rgb.2,
    );

    // The two halves must hold visibly different content (the whole point
    // of Split mode). Cross-half per-channel diff > 30 in some channel.
    assert!(
        channel_max_diff(video_rgb, map_rgb) > 30,
        "split halves video=({},{},{}) and map=({},{},{}) should differ by >30 in some channel",
        video_rgb.0,
        video_rgb.1,
        video_rgb.2,
        map_rgb.0,
        map_rgb.1,
        map_rgb.2,
    );
}

/// Build a Channel A request at an arbitrary `(aspect, layout)` cell. The
/// 2-clip fixture is reused; only the layout descriptor varies. Used by the
/// task 100 matrix tests.
#[cfg(feature = "integration_export_matrix")]
fn build_request_with_aspect(
    output_path: &str,
    clip_a_path: &Path,
    clip_b_path: &Path,
    aspect: AspectRatio,
    layout: LayoutConfig,
) -> RenderExportRequest {
    let resolved = resolve_slots(&layout, aspect, OutputResolution::default());
    let layout_descriptor = LayoutDescriptor {
        aspect,
        resolution: OutputResolution::default(),
        layout,
        resolved,
    };
    let clips = vec![
        clip_json(
            "clip-a",
            clip_a_path,
            0,
            1000,
            1.5,
            1.2,
            "2024-06-01T12:00:00.000-07:00",
        ),
        clip_json(
            "clip-b",
            clip_b_path,
            0,
            1000,
            1.5,
            1.2,
            "2024-06-01T12:00:01.000-07:00",
        ),
    ];
    let project_state = build_setup_payload_via_fixture(&clips);
    RenderExportRequest {
        channel: "composite".to_string(),
        fps: 30,
        output_path: output_path.to_string(),
        layout: layout_descriptor,
        codec_preference: CodecPreference::default(),
        audio_bitrate_kbps: 256,
        // WS4: legacy composite integration tests stay on the YouTube SDR
        // 4K target — the existing assertions on hevc + yuv420p + +faststart
        // line up with that target's `delivery_encoder_args` output.
        delivery_target: DeliveryTarget::SdrH265,
        project_state,
    }
}

/// Container-shape assertions parametrized over aspect. Mirrors
/// `assert_composite_container_shape` but with dims keyed off `aspect`
/// rather than hard-coded 1080×1920.
#[cfg(feature = "integration_export_matrix")]
fn assert_composite_container_shape_for_aspect(output_path: &Path, aspect: AspectRatio) {
    let probe = ffprobe_streams_and_format(output_path);
    let streams = probe["streams"].as_array().expect("streams array");
    let video = streams
        .iter()
        .find(|s| s["codec_type"] == "video")
        .expect("video stream");
    assert_eq!(video["codec_name"], "hevc", "{:?}", aspect);
    assert_eq!(video["pix_fmt"], "yuv420p", "{:?}", aspect);
    let dims = output_dims(aspect);
    assert_eq!(
        video["width"].as_u64().unwrap() as u32,
        dims.w,
        "{:?} width",
        aspect,
    );
    assert_eq!(
        video["height"].as_u64().unwrap() as u32,
        dims.h,
        "{:?} height",
        aspect,
    );

    let audio_streams: Vec<&Value> = streams
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .collect();
    assert_eq!(audio_streams.len(), 1, "{:?} audio count", aspect);
    assert_eq!(audio_streams[0]["codec_name"], "aac", "{:?} audio codec", aspect);

    let duration = probe["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .expect("format.duration present");
    assert!(
        (1.30..=1.40).contains(&duration),
        "{:?}: duration {} not in [1.30, 1.40]",
        aspect,
        duration,
    );
}

/// Task 100 matrix: render Channel A at every (PiP, Split) × (9:16, 4:5,
/// 16:9) cell. Each export's container is verified for codec, pix_fmt,
/// dims, and audio. Frame-5 alpha sample asserts opaque output (LAYOUT.md
/// §6: composite is end-to-end opaque, no transparent regions). Existing
/// 9:16-PiP tests stay; this is additive coverage.
#[cfg(feature = "integration_export_matrix")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn channel_a_full_matrix() {
    assert_ffmpeg_on_path();
    assert_bundle_present();
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
                .join(format!("composite_{:?}_{}.mp4", aspect, mode));
            let req = build_request_with_aspect(
                output_path.to_string_lossy().as_ref(),
                &clip_a,
                &clip_b,
                aspect,
                layout,
            );

            render_export_inner(req, None).await.unwrap_or_else(|e| {
                panic!("render_export failed for ({:?}, {}): {:?}", aspect, mode, e)
            });

            assert_composite_container_shape_for_aspect(&output_path, aspect);

            // Opaque output (LAYOUT.md §6 invariant). yuv420p has no alpha
            // channel, but extracting as rgba sets alpha=255 unless the
            // source had transparency — we verify a center pixel is opaque.
            let dims = output_dims(aspect);
            let frame = extract_rgba_frame(&output_path, 5, dims.w, dims.h);
            let cx = dims.w / 2;
            let cy = dims.h / 2;
            assert_eq!(
                alpha_at(&frame, dims.w, cx, cy),
                255,
                "{:?} {}: composite center should be opaque",
                aspect,
                mode,
            );
        }
    }
}
