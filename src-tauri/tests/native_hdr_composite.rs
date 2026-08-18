// Gate c of the Phase 5 renderer strangle: HDR (and SDR) composite delivery
// fed END-TO-END by NATIVE map frames.
//
// Drives the REAL `render_export_inner` composite path — clip probing,
// corner mask, `build_composite_filtergraph`'s delivery-aware argv (CANON §1
// ingest anchor + PQ composite transport), FFmpegSink, orchestrator,
// renderer worker — with the worker's NATIVE backend (maplibre-gl-native
// in-process) selected via env. For each of {SdrH265, HdrHlg, HdrPq} it
// asserts the container/stream shape AND decodes a mid-export frame to pin
// the map's white anchor:
//
//   - map white (the POV dot's flat white core at the map-slot center —
//     camera-follows-marker holds it there) must land at BT.2408 graphics
//     white: signal ≈ 0.75 HLG / 0.58 PQ (the ×2.03 SDR-origin ingest
//     anchor, CANON §1.12), and ≈ 1.0 (Y'≈235) for SDR delivery.
//
// The ingest contract is engine-invariant by measurement (native readback =
// 8-bit sRGB RGBA, byte-identical to GL JS gl.readPixels —
// .spike/native-gl/MECHANICAL_VERDICT.md §2); this test proves it holds
// through the full production argv, not just at the readback boundary.
//
// Loud-failure preconditions (never skip): renderer bundles
// (`npm run build:renderer`), the patched mbgl-native binding
// (`npm run build:native-binding`), ffmpeg-full (zscale) + ffprobe on PATH,
// network for tile fetches (cached after first run).
//
// Env note: TRAILCUT_RENDERER_BACKEND is set process-wide HERE ONLY — this
// test binary is native-only, so nothing races. The spawned worker child
// inherits it (OrchestratorConfig::default() pins no backend).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Once;

use serde_json::{json, Value};
use tempfile::TempDir;
use trail_cut_lib::export::{
    default_layout, resolve_slots, AspectRatio, CodecPreference, DeliveryTarget,
    LayoutDescriptor, OutputResolution, RenderExportRequest,
};

static PIN_NATIVE_BACKEND: Once = Once::new();

fn pin_native_backend() {
    PIN_NATIVE_BACKEND.call_once(|| {
        std::env::set_var("TRAILCUT_RENDERER_BACKEND", "native");
    });
}

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn assert_preconditions() {
    let renderer = manifest_dir().join("sidecars/renderer/dist/renderer.cjs");
    let fixture = manifest_dir().join("sidecars/renderer/dist/setup_fixture.cjs");
    if !renderer.exists() || !fixture.exists() {
        panic!(
            "Renderer bundle artifacts missing. Run `npm run build:renderer` first.\n\
             Expected: {}\nExpected: {}",
            renderer.display(),
            fixture.display(),
        );
    }
    let binding = OrchestratorBindingDir::resolve();
    if !binding.0.exists() {
        panic!(
            "Patched maplibre-gl-native binding missing at {}.\n\
             Run `npm run build:renderer` (or `npm run build:native-binding`) first — \
             this native-backend gate refuses to run without it.",
            binding.0.display(),
        );
    }
    for tool in ["ffmpeg", "ffprobe"] {
        let ok = Command::new(tool)
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ok {
            panic!("{tool} not on PATH — install ffmpeg-full (`brew install ffmpeg-full`)");
        }
    }
}

/// Mirror of the orchestrator's dev-layout binding resolution (env override
/// respected) so the precondition check points at the same location the
/// worker will actually require() from.
struct OrchestratorBindingDir(PathBuf);
impl OrchestratorBindingDir {
    fn resolve() -> Self {
        if let Ok(p) = std::env::var("TRAILCUT_MBGL_NATIVE_DIR") {
            if !p.trim().is_empty() {
                return Self(PathBuf::from(p));
            }
        }
        let triple = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            "aarch64-apple-darwin"
        } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
            "x86_64-apple-darwin"
        } else {
            "unsupported-host"
        };
        Self(
            manifest_dir()
                .join("binaries")
                .join(format!("mbgl-native-{triple}")),
        )
    }
}

/// Synthetic 1280x720 SDR test clip (lavfi testsrc + sine audio), TAGGED
/// bt709/tv like real camera footage. The tags are load-bearing AND must be
/// in the x264 BITSTREAM VUI (`-x264-params colorprim=…`), not only the
/// container: decoded frame props come from the VUI, and the post-Phase-4
/// clip ingest (`ingest_zscale_chain` with `explicit_source_tags=false`)
/// lets zimg infer source colorimetry from those props — an untagged decode
/// yields zimg's "no path between colorspaces" (code 3074). Real iPhone
/// footage always carries VUI colorimetry, so this keeps the fixture
/// faithful (same recipe as color_fixtures' make_synthetic_bt709_clip).
fn make_test_clip(output: &Path, duration_s: f64) {
    let status = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            &format!("testsrc=size=1280x720:rate=30:duration={duration_s}"),
            "-f",
            "lavfi",
            "-i",
            &format!("sine=frequency=440:sample_rate=48000:duration={duration_s}"),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-colorspace",
            "bt709",
            "-color_range",
            "tv",
            "-x264-params",
            "colorprim=bt709:transfer=bt709:colormatrix=bt709",
            "-c:a",
            "aac",
            "-shortest",
        ])
        .arg(output)
        .status()
        .expect("spawn ffmpeg fixture builder");
    assert!(status.success(), "ffmpeg test-clip synth failed");
}

fn clip_json(id: &str, source: &Path, created_at: &str) -> Value {
    json!({
        "id": id,
        "path": source.to_string_lossy(),
        "filename": source.file_name().unwrap().to_string_lossy(),
        "created_at": created_at,
        "duration_ms": 1000,
        "resolution": "1280x720",
        "trim": {"in_ms": 0, "out_ms": 1000},
        "focal_point": {"x": 0.5, "y": 0.5, "zoom": 1.2},
        "effects": {"stabilize": {"enabled": false, "shakiness": 5}, "speed": 1.5},
        "visible": true,
        "map_overrides": null
    })
}

/// Compile the project state via the bundled fixture builder. Clips are
/// overridden with real (synthesized) files; the DEFAULT route is kept — its
/// trackpoint wall-clocks (12:00:00→12:00:02) bracket the clips' created_at,
/// so the POV marker is live and the follow-cam pins its white dot to the
/// map-slot center (the white-anchor probe target).
fn build_project_state(clips: &[Value]) -> Value {
    let fixture = manifest_dir().join("sidecars/renderer/dist/setup_fixture.cjs");
    let overrides = json!({ "clips": clips });
    let mut child = Command::new("node")
        .arg(&fixture)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn node setup_fixture.cjs");
    child
        .stdin
        .as_mut()
        .expect("child stdin")
        .write_all(overrides.to_string().as_bytes())
        .expect("write overrides");
    let output = child.wait_with_output().expect("wait for setup_fixture.cjs");
    assert!(
        output.status.success(),
        "setup_fixture.cjs failed: {}",
        String::from_utf8_lossy(&output.stderr),
    );
    let mut payload: Value =
        serde_json::from_slice(&output.stdout).expect("fixture stdout → JSON");
    if let Some(obj) = payload.as_object_mut() {
        obj.remove("cmd");
        obj.remove("cssViewport");
        obj.remove("framebuffer");
        obj.remove("readback");
        obj.remove("pixelRatio");
        obj.remove("fps");
    }
    payload
}

fn build_request(
    output_path: &str,
    target: DeliveryTarget,
    project_state: Value,
) -> RenderExportRequest {
    let aspect = AspectRatio::NineSixteen;
    let layout = default_layout(aspect);
    let resolved = resolve_slots(&layout, aspect, OutputResolution::default());
    RenderExportRequest {
        channel: "composite".to_string(),
        fps: 30,
        output_path: output_path.to_string(),
        layout: LayoutDescriptor {
            aspect,
            resolution: OutputResolution::default(),
            magnification: 1.0,
            layout,
            resolved,
        },
        codec_preference: CodecPreference::default(),
        audio_bitrate_kbps: 256,
        delivery_target: target,
        project_state,
    }
}

fn ffprobe_video_stream(path: &Path) -> Value {
    let out = Command::new("ffprobe")
        .args(["-v", "error", "-show_streams", "-of", "json"])
        .arg(path)
        .output()
        .expect("spawn ffprobe");
    assert!(
        out.status.success(),
        "ffprobe failed: {}",
        String::from_utf8_lossy(&out.stderr),
    );
    let probe: Value = serde_json::from_slice(&out.stdout).expect("ffprobe json");
    probe["streams"]
        .as_array()
        .expect("streams")
        .iter()
        .find(|s| s["codec_type"] == "video")
        .expect("video stream")
        .clone()
}

/// Extract frame `idx` as raw Y'CbCr and return the luma plane. 10-bit for
/// HDR outputs (yuv444p10le), 8-bit for SDR (yuv444p) — no color conversion,
/// coded values as-is (limited range).
fn extract_luma_plane(path: &Path, idx: u32, w: u32, h: u32, ten_bit: bool) -> Vec<u16> {
    let pix_fmt = if ten_bit { "yuv444p10le" } else { "yuv444p" };
    let out = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(path)
        .args([
            "-vf",
            &format!("select=eq(n\\,{idx})"),
            "-vsync",
            "0",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            pix_fmt,
            "-",
        ])
        .output()
        .expect("spawn ffmpeg extract");
    assert!(
        out.status.success(),
        "frame extract failed: {}",
        String::from_utf8_lossy(&out.stderr),
    );
    let px = (w as usize) * (h as usize);
    let bytes_per = if ten_bit { 2 } else { 1 };
    assert!(
        out.stdout.len() >= px * bytes_per,
        "short read: {} < {}",
        out.stdout.len(),
        px * bytes_per,
    );
    if ten_bit {
        out.stdout[..px * 2]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect()
    } else {
        out.stdout[..px].iter().map(|&b| b as u16).collect()
    }
}

/// Normalized signal level of the brightest luma inside a window around the
/// map-slot center (the POV dot's flat white core — window max dodges the
/// dot's AA edge and chroma bleed while staying inside the core).
fn white_anchor_signal(
    luma: &[u16],
    frame_w: u32,
    cx: u32,
    cy: u32,
    window: u32,
    ten_bit: bool,
) -> f64 {
    let mut max_y: u16 = 0;
    for y in (cy - window)..=(cy + window) {
        for x in (cx - window)..=(cx + window) {
            let v = luma[(y * frame_w + x) as usize];
            if v > max_y {
                max_y = v;
            }
        }
    }
    if ten_bit {
        (max_y as f64 - 64.0) / 876.0
    } else {
        (max_y as f64 - 16.0) / 219.0
    }
}

struct TargetExpectation {
    target: DeliveryTarget,
    /// Expected coded pix_fmt of the deliverable.
    pix_fmt: &'static str,
    /// Expected color_transfer tag (None = don't assert; SDR tagging is not
    /// this gate's concern).
    transfer: Option<&'static str>,
    ten_bit: bool,
    /// BT.2408 graphics-white signal the map's white core must land at.
    white_signal: f64,
    /// Tolerance: ±0.03 matches the Phase-3/4 tracer bar (±0.02) plus
    /// encode/4:2:0 slack on a small (but flat) white region.
    tol: f64,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn native_map_frames_through_all_delivery_targets() {
    pin_native_backend();
    assert_preconditions();

    let tmp = TempDir::new().expect("tempdir");
    let clip_a = tmp.path().join("clip-a.mp4");
    let clip_b = tmp.path().join("clip-b.mp4");
    make_test_clip(&clip_a, 1.0);
    make_test_clip(&clip_b, 1.0);
    let clips = vec![
        clip_json("clip-a", &clip_a, "2024-06-01T12:00:00.000-07:00"),
        clip_json("clip-b", &clip_b, "2024-06-01T12:00:01.000-07:00"),
    ];

    let cases = [
        TargetExpectation {
            target: DeliveryTarget::SdrH265,
            pix_fmt: "yuv420p",
            transfer: None,
            ten_bit: false,
            white_signal: 1.0,
            tol: 0.03,
        },
        TargetExpectation {
            target: DeliveryTarget::HdrHlg,
            pix_fmt: "yuv420p10le",
            transfer: Some("arib-std-b67"),
            ten_bit: true,
            white_signal: 0.75,
            tol: 0.03,
        },
        TargetExpectation {
            target: DeliveryTarget::HdrPq,
            pix_fmt: "yuv420p10le",
            transfer: Some("smpte2084"),
            ten_bit: true,
            white_signal: 0.58,
            tol: 0.03,
        },
    ];

    for case in cases {
        let output_path = tmp.path().join(format!("native_{:?}.mp4", case.target));
        let project_state = build_project_state(&clips);
        let req = build_request(
            output_path.to_string_lossy().as_ref(),
            case.target,
            project_state,
        );
        let map_slot = req.layout.resolved.map_slot;

        let summary = trail_cut_lib::export::render_export_inner(req, None)
            .await
            .unwrap_or_else(|e| panic!("render_export failed for {:?}: {:?}", case.target, e));
        assert!(
            summary.frames_written >= 30,
            "{:?}: expected ≥30 frames, wrote {}",
            case.target,
            summary.frames_written,
        );

        // ---- stream shape ----
        let video = ffprobe_video_stream(&output_path);
        assert_eq!(video["codec_name"], "hevc", "{:?} codec", case.target);
        assert_eq!(video["pix_fmt"], case.pix_fmt, "{:?} pix_fmt", case.target);
        if let Some(t) = case.transfer {
            assert_eq!(video["color_transfer"], t, "{:?} transfer tag", case.target);
            assert_eq!(
                video["color_primaries"], "bt2020",
                "{:?} primaries tag",
                case.target,
            );
        }
        let w = video["width"].as_u64().unwrap() as u32;
        let h = video["height"].as_u64().unwrap() as u32;
        assert_eq!((w, h), (1080, 1920), "{:?} dims", case.target);

        // ---- decoded white anchor at the map-slot center ----
        // Frame 20 (t≈667 ms): marker between trackpoints 0 and 1, dot live.
        let luma = extract_luma_plane(&output_path, 20, w, h, case.ten_bit);
        let cx = map_slot.x + map_slot.w / 2;
        let cy = map_slot.y + map_slot.h / 2;
        let signal = white_anchor_signal(&luma, w, cx, cy, 6, case.ten_bit);
        assert!(
            (signal - case.white_signal).abs() <= case.tol,
            "{:?}: map white anchor measured {:.4}, expected {:.2} ±{:.2} \
             (map-slot center ({cx},{cy}) — the POV dot's white core; a miss here means \
             the delivery-aware ingest anchor did not survive the native-fed composite)",
            case.target,
            signal,
            case.white_signal,
            case.tol,
        );
        eprintln!(
            "[native-hdr-gate] {:?}: white anchor {:.4} (expected {:.2}) — OK",
            case.target, signal, case.white_signal,
        );
    }
}
