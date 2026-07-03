// Decoration-crispness probe — argv emitter.
//
// NOT a gate: `#[ignore]`d, run explicitly by the crispness diagnosis harness
// (scratchpad crisp-probe). Emits the PRODUCTION composite ffmpeg argv —
// verbatim `build_composite_filtergraph` output with the machine's real
// `select_encoder_for_target` choice — plus the software-encoder variant for
// HEVC targets, as JSON. The harness then runs the argv against captured
// renderer frames, swapping only encoder args per measurement variant, so
// every filter string in the measurement is the production string.
//
// Inputs via env:
//   PROBE_CONFIG — JSON: { project_json, map_slot, video_slot, output,
//                          corner_radius_px, fps, total_frames,
//                          source_dims, has_audio, out_dir }
//   PROBE_OUT    — path to write the argv-plan JSON.
//
// Run: cargo test --test decoration_probe -- --ignored --nocapture

use std::path::PathBuf;

use serde::Deserialize;
use serde_json::json;
use trail_cut_lib::export::corner_mask::build_corner_mask_png;
use trail_cut_lib::export::filtergraph::{
    build_composite_filtergraph, CompositeMode, VisibleClipInput,
};
use trail_cut_lib::export::{
    select_encoder_for_target, DeliveryTarget, EncoderChoice, EncoderClass, EncoderKind,
    OutputDimensions, PixelDims, PixelRect,
};
use trail_cut_lib::Clip;

#[derive(Deserialize)]
struct RectCfg {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

#[derive(Deserialize)]
struct DimsCfg {
    w: u32,
    h: u32,
}

fn default_mode() -> String {
    "pip_map_inset".to_string()
}

#[derive(Deserialize)]
struct ProbeConfig {
    project_json: String,
    map_slot: RectCfg,
    video_slot: RectCfg,
    output: DimsCfg,
    corner_radius_px: u32,
    fps: u32,
    total_frames: u32,
    source_dims: DimsCfg,
    has_audio: bool,
    out_dir: String,
    /// "pip_map_inset" | "pip_video_inset" | "split"
    #[serde(default = "default_mode")]
    composite_mode: String,
}

fn rect(r: &RectCfg) -> PixelRect {
    PixelRect {
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
    }
}

#[test]
#[ignore = "diagnosis harness — run explicitly with PROBE_CONFIG/PROBE_OUT set"]
fn emit_production_composite_argv() {
    let cfg_path = std::env::var("PROBE_CONFIG").expect("PROBE_CONFIG env var");
    let out_path = std::env::var("PROBE_OUT").expect("PROBE_OUT env var");
    let cfg: ProbeConfig =
        serde_json::from_str(&std::fs::read_to_string(&cfg_path).expect("read PROBE_CONFIG"))
            .expect("parse PROBE_CONFIG");

    // The clip exactly as the app persists it — deserialized through the
    // production `Clip` model.
    let project: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&cfg.project_json).expect("read project"))
            .expect("parse project");
    let clips: Vec<Clip> = serde_json::from_value(project["clips"].clone()).expect("parse clips");
    let visible: Vec<VisibleClipInput> = clips
        .into_iter()
        .filter(|c| c.visible)
        .map(|clip| VisibleClipInput {
            source_path: PathBuf::from(&clip.path),
            clip,
            source_dims: PixelDims {
                w: cfg.source_dims.w,
                h: cfg.source_dims.h,
            },
            has_audio: cfg.has_audio,
        })
        .collect();
    assert!(!visible.is_empty(), "no visible clips in project");

    // Corner mask — same builder production uses (PipMapInset masks the map
    // slot). Written to the harness dir so the argv can reference it.
    let mask_path = if cfg.corner_radius_px > 0 {
        let png = build_corner_mask_png(cfg.map_slot.w, cfg.map_slot.h, cfg.corner_radius_px)
            .expect("corner mask");
        let p = PathBuf::from(&cfg.out_dir).join("corner-mask.png");
        std::fs::write(&p, png).expect("write mask");
        Some(p)
    } else {
        None
    };

    let composite_mode = match cfg.composite_mode.as_str() {
        "pip_map_inset" => CompositeMode::PipMapInset,
        "pip_video_inset" => CompositeMode::PipVideoInset,
        "split" => CompositeMode::Split,
        other => panic!("unknown composite_mode {other:?}"),
    };

    let targets = [
        DeliveryTarget::SdrH264,
        DeliveryTarget::SdrH265,
        DeliveryTarget::HdrHlg,
        DeliveryTarget::HdrPq,
        DeliveryTarget::Prores,
    ];

    let mut plans = Vec::new();
    for target in targets {
        let real = select_encoder_for_target(target).expect("select_encoder_for_target");
        let mut encoder_variants = vec![("prod".to_string(), real.clone())];
        // Software-encoder variant for HEVC targets when the machine picked
        // hardware — emits the exact software branch of delivery_encoder_args.
        if matches!(
            target,
            DeliveryTarget::SdrH265 | DeliveryTarget::HdrHlg | DeliveryTarget::HdrPq
        ) && real.name != "libx265"
        {
            encoder_variants.push((
                "sw".to_string(),
                EncoderChoice {
                    class: EncoderClass::Hevc,
                    name: "libx265".to_string(),
                    kind: EncoderKind::Software,
                    codec_args: vec![],
                    probe_wall_clock_ms: 0,
                },
            ));
        }
        for (variant, encoder) in encoder_variants {
            let ext = target.container_extension();
            let tname = format!("{:?}", target).to_lowercase();
            let out_file =
                PathBuf::from(&cfg.out_dir).join(format!("{tname}-{variant}.{ext}"));
            let plan = build_composite_filtergraph(
                &visible,
                rect(&cfg.map_slot),
                rect(&cfg.video_slot),
                OutputDimensions {
                    w: cfg.output.w,
                    h: cfg.output.h,
                },
                composite_mode,
                mask_path.as_deref(),
                cfg.fps,
                cfg.total_frames,
                &encoder,
                192,
                target,
                &out_file,
            )
            .expect("build_composite_filtergraph");
            plans.push(json!({
                "target": tname,
                "variant": variant,
                "encoder": encoder.name,
                "output": out_file.to_string_lossy(),
                "frame_bytes": plan.frame_bytes_per_input,
                "argv": plan.argv,
            }));
        }
    }

    std::fs::write(
        &out_path,
        serde_json::to_string_pretty(&json!({ "plans": plans })).unwrap(),
    )
    .expect("write PROBE_OUT");
    eprintln!("[decoration_probe] wrote {} plans to {}", plans.len(), out_path);
}
