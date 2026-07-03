// WS4 — Delivery transforms.
//
// `F_delivery_{target}` takes working-space pixels (linear-light, BT.2020
// primaries, `gbrpf32le`) to a final output file with explicit color
// tagging. This is the workstream that kills the QuickTime per-frame color
// warnings — every output is now consistently tagged.
//
// Each target has three pieces:
//   - a **finishing filter** spliced after `[vout_w]` in the composite
//     filter_complex. Does the working-space → target color conversion AND
//     the target's aspect/resolution scale+pad (so social exports of a 9:16
//     project work, and so do 16:9 4K exports of a 9:16 project).
//   - an **encoder argv** spliced after `-map [vout] -map [aout]`. Codec,
//     `-pix_fmt`, `-color_*` flags (global), `-x264-params`/`-x265-params`
//     (encoder-specific VUI duplicates per the WS6 regression flag — libx264
//     and libx265 silently drop `-color_primaries`/`-color_trc` without the
//     encoder-specific params), `-c:a` / `-b:a` audio settings, and
//     `-movflags +faststart`.
//   - a target-selected **encoder probe**. SDR HEVC and HDR HEVC targets
//     use SOFTWARE libx265 with hardware fallback only when libx265 is
//     absent — the decoration-crispness probe (2026-07-03) measured hardware
//     encoders crushing high-chroma decoration edges at any reasonable
//     bitrate (see `encoder::hevc_candidates`); H.264 targets always use
//     libx264 (the brief specifies it explicitly); ProRes Master always uses
//     prores_ks.
//
// Public surface for WS5 (export UI):
//   - `DeliveryTarget` enum — every catalog entry.
//   - `DeliveryTarget::label()` / `::short_label()` — human-readable strings
//     for the picker. The picker filters by channel (composite accepts all
//     five; map_only / video_only accept only ProresMaster).
//   - `DeliveryTarget::aspect()` / `::output_dims()` — target's pixel canvas
//     (None for ProresMaster — it inherits the project layout).
//   - `DeliveryTarget::container_extension()` — `"mp4"` or `"mov"`.
//   - `DeliveryTarget::all()` — full catalog, in display order.

use serde::{Deserialize, Serialize};

use crate::export::encoder::{
    select_encoder, EncoderChoice, EncoderClass, EncoderError, EncoderKind,
};
use crate::util::color::WORKING_SPACE_PIX_FMT;
use crate::util::color_space::{delivery_zscale_chain, ColorSpace};

/// Delivery target — color regime + codec + container only. Aspect and
/// resolution are NOT encoded here: the outer export grid owns aspect (one
/// of 9:16 / 4:5 / 16:9) and the inner Quality picker owns resolution
/// (720p / 1080p / 1440p / 2160p). The actual output canvas is computed
/// from those two via `layout::output_dims(aspect, resolution)` at
/// validation time and flows through as `ValidatedRequest::output_dims`.
///
/// History (Issue 2 refactor): the pre-refactor enum bundled aspect +
/// resolution + container + color regime + encoder family into five hard-
/// coded variants (`social_sdr_vertical` = 1080×1920 / H.264 / BT.709,
/// etc.), which meant the inner modal silently overrode the outer grid's
/// aspect AND the Quality picker's resolution. Splitting along the right
/// axes drops the conflation and opens up combos that the old catalog
/// couldn't express (HDR at 1080p, SDR 4:5 at any resolution, etc.).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryTarget {
    /// SDR BT.709 limited, 8-bit 4:2:0 yuv420p, libx264 in mp4. The
    /// "universal compatibility" option — plays on Windows' default player
    /// without the Microsoft Store HEVC extension, plus all older devices.
    SdrH264,
    /// SDR BT.709 limited, 8-bit 4:2:0 yuv420p, HEVC (videotoolbox or
    /// libx265) in mp4. The default for composite — roughly half the file
    /// size of H.264 at equivalent quality and native on iPhone / modern
    /// Android / macOS / Chrome / Edge. Friction case: Windows default
    /// player needs Microsoft's $0.99 HEVC extension.
    SdrH265,
    /// HDR via HLG BT.2020 limited, 10-bit 4:2:0 yuv420p10le, HEVC main10
    /// in mp4. HLG is the YouTube HDR convention; H.265 is mandatory at
    /// 10-bit (H.264 high10 is rarely shipped).
    HdrHlg,
    /// HDR via PQ / HDR10 (SMPTE ST 2084) BT.2020 limited, 10-bit 4:2:0
    /// yuv420p10le, HEVC main10 in mp4. The streaming / HDR10 convention;
    /// the same encoder shape as HLG, differing only in the color regime —
    /// added as one registry/table entry to prove the matrix is extensible.
    HdrPq,
    /// ProRes 4444 with alpha, BT.709 limited, yuva444p10le in mov. The
    /// only legal target for `map_only` / `video_only` (lossless
    /// compositing intermediates) and the archival master for composite.
    Prores,
}

impl DeliveryTarget {
    /// Full catalog in display order. The picker iterates this and filters
    /// by channel compatibility (`is_allowed_for_channel`).
    pub const fn all() -> &'static [DeliveryTarget] {
        &[
            DeliveryTarget::SdrH265,
            DeliveryTarget::SdrH264,
            DeliveryTarget::HdrHlg,
            DeliveryTarget::HdrPq,
            DeliveryTarget::Prores,
        ]
    }

    /// Human-readable display label for the picker dropdown.
    pub const fn label(self) -> &'static str {
        match self {
            DeliveryTarget::SdrH265 => "SDR · H.265 (modern, smaller files)",
            DeliveryTarget::SdrH264 => "SDR · H.264 (universal compatibility)",
            DeliveryTarget::HdrHlg => "HDR · HLG (10-bit BT.2020)",
            DeliveryTarget::HdrPq => "HDR · PQ / HDR10 (10-bit BT.2020)",
            DeliveryTarget::Prores => "ProRes 4444 (master / intermediate)",
        }
    }

    /// Short label for tight UI affordances (badges, status lines).
    pub const fn short_label(self) -> &'static str {
        match self {
            DeliveryTarget::SdrH265 => "SDR H.265",
            DeliveryTarget::SdrH264 => "SDR H.264",
            DeliveryTarget::HdrHlg => "HDR HLG",
            DeliveryTarget::HdrPq => "HDR PQ",
            DeliveryTarget::Prores => "ProRes",
        }
    }

    /// The output [`ColorSpace`] this target delivers to — the single point
    /// where a target's color regime is declared. The finishing filter and
    /// the encoder color flags both derive from it.
    pub fn output_color_space(self) -> ColorSpace {
        match self {
            DeliveryTarget::SdrH264 | DeliveryTarget::SdrH265 | DeliveryTarget::Prores => {
                ColorSpace::SDR_BT709
            }
            DeliveryTarget::HdrHlg => ColorSpace::HDR_HLG_BT2020,
            DeliveryTarget::HdrPq => ColorSpace::HDR_PQ_BT2020,
        }
    }

    /// Final-encode pixel format for this target.
    fn finishing_pix_fmt(self) -> &'static str {
        match self {
            DeliveryTarget::SdrH264 | DeliveryTarget::SdrH265 => "yuv420p",
            DeliveryTarget::HdrHlg | DeliveryTarget::HdrPq => "yuv420p10le",
            DeliveryTarget::Prores => "yuva444p10le",
        }
    }

    /// Container extension (no leading dot). `"mov"` for ProRes (PCM audio
    /// + alpha-bearing pixel format require the QuickTime container);
    /// `"mp4"` for everything else.
    pub const fn container_extension(self) -> &'static str {
        match self {
            DeliveryTarget::Prores => "mov",
            _ => "mp4",
        }
    }

    /// `true` iff this target is a legal selection for the given export
    /// channel. Composite accepts all four; map_only and video_only accept
    /// only `Prores` (B and C are lossless compositing intermediates).
    pub fn is_allowed_for_channel(self, channel: &str) -> bool {
        match channel {
            "composite" => true,
            "map_only" | "video_only" => matches!(self, DeliveryTarget::Prores),
            _ => false,
        }
    }
}

/// Build the finishing filter chain that takes `[vout_w]` (working-space
/// `gbrpf32le`) to `[vout]` (target's color regime + pixel format).
/// Returns the chain WITHOUT the leading `[vout_w]` label so the caller
/// can splice it as `[vout_w]{chain}[vout]`.
///
/// The chain is now color-only: the composite is rendered AT the project's
/// validated `(aspect, resolution)` canvas from the start (see
/// `ValidatedRequest::output_dims` → `filtergraph::build_filter_complex`),
/// so there is no scale+pad step here. Pre-Issue-2 the chain also forced
/// the canvas to the target's hard-coded dims — that was the silent-aspect-
/// override bug; removing the scale+pad makes the outer grid the single
/// source of truth for aspect and the Quality picker for resolution.
pub fn delivery_finishing_filter(target: DeliveryTarget) -> String {
    // Color-only: working space → the target's output color space, then the
    // target's final pixel format. Both pieces come from the registry — the
    // per-target match arms of hardcoded zscale strings are gone (a new target
    // is an `output_color_space` + `finishing_pix_fmt` entry, nothing more).
    //
    // Phase 4 (fix D — HQ chroma subsample): a fused `format=yuv420p[10le]`
    // is where FFmpeg silently box-filter-decimates chroma to 4:2:0. For
    // 4:2:0 targets the hop is split: land full-chroma 4:4:4 at the target
    // depth, lanczos-resample the chroma (`scale=` with no w=/h= does NOT
    // resize — it only re-samples per the flags), then the final 4:2:0
    // format. Gated on `finishing_pix_fmt()` (the pixel format, not the
    // target enum) so a future 4:2:0 target gets HQ subsample automatically;
    // ProRes (yuva444p10le) and any 4:4:4 target keep the fused form.
    let chain = delivery_zscale_chain(&ColorSpace::WORKING, &target.output_color_space());
    let pix = target.finishing_pix_fmt();
    match pix {
        // HDR 10-bit 4:2:0 — split via 4:4:4-10 then lanczos chroma.
        "yuv420p10le" => format!(
            "{chain},format=yuv444p10le,\
             scale=flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp,\
             format=yuv420p10le"
        ),
        // SDR 8-bit 4:2:0 — 8-bit analogue.
        "yuv420p" => format!(
            "{chain},format=yuv444p,\
             scale=flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp,\
             format=yuv420p"
        ),
        // Non-4:2:0 targets (ProRes yuva444p10le): no decimation, leave fused.
        _ => format!("{chain},format={pix}"),
    }
}

/// Encoder argv for the given target. Spliced into the FFmpeg invocation
/// after `-map [vout] -map [aout]` and before the output path.
///
/// **Regression guard (WS6):** every SDR / HDR formula emits both the
/// global `-color_*` flags AND the encoder-specific
/// `-x264-params`/`-x265-params`. libx264 and libx265 silently drop
/// `-color_primaries`/`-color_trc` from the H.264/H.265 VUI unless the
/// duplicate is in the encoder params; without this the output `colr`
/// atom would be missing or wrong. videotoolbox honors the global flags
/// directly.
///
/// `encoder.name` decides between the hardware (videotoolbox) and software
/// (libx265 / libx264) branches for the HEVC targets — the software
/// branches add the `-x265-params` splice. The H.264 target always uses
/// libx264 (no hardware fallback — the brief mandates `-c:v libx264`),
/// so the `-x264-params` splice is unconditional.
pub fn delivery_encoder_args(target: DeliveryTarget, encoder: &EncoderChoice) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    // The target's color regime — color flags + the VUI duplicate string both
    // derive from this one ColorSpace, so a new target carries its own color
    // tags automatically with no per-target flag code.
    let out_cs = target.output_color_space();
    match target {
        DeliveryTarget::SdrH264 => {
            // H.264 via libx264 (always available — software encoder).
            push(&mut out, ["-c:v", "libx264"]);
            push(&mut out, ["-preset", "medium", "-crf", "18"]);
            push(&mut out, ["-pix_fmt", "yuv420p"]);
            push_color_flags_from_cs(&mut out, &out_cs);
            // libx264 drops `-color_primaries`/`-color_trc` from the VUI
            // unless we duplicate them in `-x264-params`. WS6 regression.
            push_vui_params(&mut out, "-x264-params", &out_cs);
            push_aac_audio(&mut out);
            push(&mut out, ["-movflags", "+faststart"]);
        }
        DeliveryTarget::SdrH265 => {
            // HEVC SDR. libx265 (software) is the quality path — the
            // decoration-crispness probe (2026-07-03) measured
            // hevc_videotoolbox crushing high-chroma decoration edges
            // (Cr Sobel retention 0.55 at the old `-q:v 50`; still below
            // libx265 crf18 even at `-q:v 80` with 5× the bits). The
            // videotoolbox branch is FALLBACK-ONLY (ffmpeg builds without
            // libx265) at a non-starving quality.
            out.push("-c:v".into());
            out.push(encoder.name.clone());
            if encoder.name == "hevc_videotoolbox" {
                push(&mut out, ["-tag:v", "hvc1", "-q:v", "65"]);
            } else {
                // libx265 — preset/crf measured on the crispness probe:
                // `fast`/17 + the chroma QP offsets in X265_DELIVERY_TUNING
                // hold decoration chroma edges at ≥0.88 Sobel retention vs
                // the lossless pre-encode tap (vs 0.55 for the old VT path).
                push(&mut out, ["-tag:v", "hvc1", "-preset", "fast", "-crf", "17"]);
            }
            push(&mut out, ["-pix_fmt", "yuv420p"]);
            push_color_flags_from_cs(&mut out, &out_cs);
            if encoder.name != "hevc_videotoolbox" {
                // libx265 / x265 software path — VUI duplicate + delivery tuning.
                push_x265_delivery_params(&mut out, &out_cs);
            }
            push_aac_audio(&mut out);
            push(&mut out, ["-movflags", "+faststart"]);
        }
        // HDR 10-bit (HLG and PQ share the entire encoder shape — main10 HEVC,
        // yuv420p10le — and differ ONLY in the color regime, which flows from
        // `out_cs`. This is the extensibility payoff: PQ delivery is "free"
        // here, just another `output_color_space` entry.)
        DeliveryTarget::HdrHlg | DeliveryTarget::HdrPq => {
            // Same libx265-first rationale as SdrH265 — the HDR targets
            // measured WORSE through videotoolbox (HdrPq Cr Sobel retention
            // 0.54 at the old `-q:v 50`; PQ's steep curve concentrates
            // decoration chroma detail exactly where hardware quantization
            // crushes it). videotoolbox branch is FALLBACK-ONLY.
            out.push("-c:v".into());
            out.push(encoder.name.clone());
            if encoder.name == "hevc_videotoolbox" {
                push(
                    &mut out,
                    ["-tag:v", "hvc1", "-q:v", "65", "-profile:v", "main10"],
                );
            } else {
                // libx265 main10 — same measured preset/crf/tuning as SDR.
                push(
                    &mut out,
                    [
                        "-tag:v",
                        "hvc1",
                        "-profile:v",
                        "main10",
                        "-preset",
                        "fast",
                        "-crf",
                        "17",
                    ],
                );
            }
            push(&mut out, ["-pix_fmt", "yuv420p10le"]);
            push_color_flags_from_cs(&mut out, &out_cs);
            if encoder.name != "hevc_videotoolbox" {
                // libx265 — VUI duplicate for HDR + delivery tuning.
                push_x265_delivery_params(&mut out, &out_cs);
            }
            push_aac_audio(&mut out);
            push(&mut out, ["-movflags", "+faststart"]);
        }
        DeliveryTarget::Prores => {
            // ProRes 4444 with alpha + PCM audio. The encoder's codec_args
            // already include `-c:v prores_ks -profile:v 4444 -pix_fmt
            // yuva444p10le -vendor apl0` (per Candidate::downstream_codec_args
            // for EncoderClass::ProResAlpha) — splat them as-is.
            for a in &encoder.codec_args {
                out.push(a.clone());
            }
            push_color_flags_from_cs(&mut out, &out_cs);
            push(&mut out, ["-c:a", "pcm_s16le"]);
            // ProRes lives in .mov; the QuickTime muxer accepts (and ignores
            // unknown bits of) `-movflags +faststart` but DOES honor the
            // moov-atom-at-front directive. Without this, ProRes masters
            // written to remote/slow drives are unplayable until the full
            // transfer completes — the moov atom would otherwise land at the
            // end of the file. Channels B and C already emit this for their
            // ProRes intermediates (see `filtergraph.rs`); Channel A's
            // composite ProRes master must match.
            push(&mut out, ["-movflags", "+faststart"]);
        }
    }
    out
}

/// Select the right `EncoderChoice` for the given delivery target. Used by
/// `render_export`'s composite branch.
///
/// Target → class mapping:
///   - SdrH264         → H264 (always libx264)
///   - SdrH265 / HdrHlg → Hevc (videotoolbox preferred, libx265 fallback)
///   - Prores          → ProResAlpha
pub fn select_encoder_for_target(
    target: DeliveryTarget,
) -> Result<EncoderChoice, EncoderError> {
    let class = match target {
        DeliveryTarget::SdrH264 => EncoderClass::H264,
        DeliveryTarget::SdrH265 | DeliveryTarget::HdrHlg | DeliveryTarget::HdrPq => {
            EncoderClass::Hevc
        }
        DeliveryTarget::Prores => EncoderClass::ProResAlpha,
    };
    select_encoder(class)
}

// ---------- internals ----------

fn push<const N: usize>(out: &mut Vec<String>, parts: [&str; N]) {
    for p in parts {
        out.push(p.to_string());
    }
}

/// Emit the global `-color_primaries / -color_trc / -colorspace / -color_range`
/// flags from a [`ColorSpace`]. The single definition that replaces the former
/// per-regime `push_color_flags_bt709` / `push_color_flags_hlg_bt2020` (and the
/// duplicate in `filtergraph::push_prores_color_flags`). `pub(crate)` so the
/// filtergraph builders share it.
pub(crate) fn push_color_flags_from_cs(out: &mut Vec<String>, cs: &ColorSpace) {
    out.push("-color_primaries".into());
    out.push(cs.primaries.ffmpeg_flag().into());
    out.push("-color_trc".into());
    out.push(cs.transfer.ffmpeg_flag().into());
    out.push("-colorspace".into());
    out.push(cs.matrix.ffmpeg_flag().into());
    out.push("-color_range".into());
    out.push(cs.range.ffmpeg_flag().into());
}

/// x265 delivery tuning appended to `-x265-params` (decoration-crispness
/// fix, 2026-07-03). Map decorations are high-chroma edges with near-zero
/// luma contrast; shifting the chroma QP down 2 steps spends ~5% more bits
/// exactly where that failure mode lives (measured ≈ +1 dB Cb/Cr PSNR and
/// +0.02 Cb/Cr Sobel retention on the probe, at unchanged luma quality).
const X265_DELIVERY_TUNING: &str = "cbqpoffs=-2:crqpoffs=-2";

/// Emit the encoder-specific VUI duplicate (`-x264-params` / `-x265-params
/// colorprim=…:transfer=…:colormatrix=…`) from a [`ColorSpace`]. libx264 and
/// libx265 silently drop the VUI color tags without this duplicate (WS6
/// regression guard). The `colorprim`/`transfer`/`colormatrix` syntax is
/// identical for both encoders, so one builder serves both.
fn push_vui_params(out: &mut Vec<String>, flag: &str, cs: &ColorSpace) {
    out.push(flag.into());
    out.push(format!(
        "colorprim={}:transfer={}:colormatrix={}",
        cs.primaries.ffmpeg_flag(),
        cs.transfer.ffmpeg_flag(),
        cs.matrix.ffmpeg_flag(),
    ));
}

/// x265 delivery params: the WS6 VUI duplicate PLUS the chroma-QP delivery
/// tuning, folded into ONE `-x265-params` value — ffmpeg does not merge
/// repeated `-x265-params` flags (last one wins), so the tuning must ride
/// the same string as the VUI colors.
fn push_x265_delivery_params(out: &mut Vec<String>, cs: &ColorSpace) {
    out.push("-x265-params".into());
    out.push(format!(
        "colorprim={}:transfer={}:colormatrix={}:{}",
        cs.primaries.ffmpeg_flag(),
        cs.transfer.ffmpeg_flag(),
        cs.matrix.ffmpeg_flag(),
        X265_DELIVERY_TUNING,
    ));
}

fn push_aac_audio(out: &mut Vec<String>) {
    push(out, ["-c:a", "aac", "-b:a", "192k"]);
}

// Silence `unused_imports` for items only used in tests or by other modules.
#[allow(dead_code)]
fn _working_space_ref() -> &'static str {
    // Reference WORKING_SPACE_PIX_FMT so the dep graph captures the WS3
    // contract — finishing filters consume working-space pixels.
    WORKING_SPACE_PIX_FMT
}

// Silence unused-import for EncoderKind under non-test builds (used by test
// fixtures in mod.rs). Re-export for downstream tests.
#[allow(dead_code)]
fn _encoder_kind_ref() -> EncoderKind {
    EncoderKind::Software
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stub_encoder(class: EncoderClass, name: &str, codec_args: Vec<&str>) -> EncoderChoice {
        EncoderChoice {
            class,
            name: name.to_string(),
            kind: EncoderKind::Software,
            codec_args: codec_args.into_iter().map(|s| s.to_string()).collect(),
            probe_wall_clock_ms: 0,
        }
    }

    fn stub_hw(class: EncoderClass, name: &str) -> EncoderChoice {
        EncoderChoice {
            class,
            name: name.to_string(),
            kind: EncoderKind::Hardware,
            codec_args: vec![],
            probe_wall_clock_ms: 0,
        }
    }

    fn libx264() -> EncoderChoice {
        // libx264 is the only legal encoder for the SDR-vertical / square
        // targets; codec_args are irrelevant to the SDR-vertical branch
        // (which builds its argv from scratch).
        stub_encoder(EncoderClass::H264, "libx264", vec![])
    }

    fn libx265() -> EncoderChoice {
        stub_encoder(EncoderClass::Hevc, "libx265", vec![])
    }

    fn videotoolbox_hevc() -> EncoderChoice {
        stub_hw(EncoderClass::Hevc, "hevc_videotoolbox")
    }

    fn prores() -> EncoderChoice {
        stub_encoder(
            EncoderClass::ProResAlpha,
            "prores_ks",
            vec![
                "-c:v",
                "prores_ks",
                "-profile:v",
                "4444",
                "-pix_fmt",
                "yuva444p10le",
                "-vendor",
                "apl0",
            ],
        )
    }

    #[test]
    fn all_targets_round_trip_through_serde() {
        // Wire format must be snake_case so the TS mirror matches.
        for (variant, expected) in [
            (DeliveryTarget::SdrH264, "\"sdr_h264\""),
            (DeliveryTarget::SdrH265, "\"sdr_h265\""),
            (DeliveryTarget::HdrHlg, "\"hdr_hlg\""),
            (DeliveryTarget::HdrPq, "\"hdr_pq\""),
            (DeliveryTarget::Prores, "\"prores\""),
        ] {
            let json = serde_json::to_string(&variant).unwrap();
            assert_eq!(json, expected, "wire format for {:?}", variant);
            let round: DeliveryTarget = serde_json::from_str(&json).unwrap();
            assert_eq!(round, variant);
        }
    }

    #[test]
    fn catalog_lists_all_targets_in_display_order() {
        let all: Vec<DeliveryTarget> = DeliveryTarget::all().to_vec();
        assert_eq!(all.len(), 5);
        // SDR H.265 first — default for composite (most users), modern
        // efficiency + native playback on Apple/Chrome/Edge.
        assert_eq!(all[0], DeliveryTarget::SdrH265);
        // ProRes last — archival/intermediate, not the typical pick.
        assert_eq!(all[4], DeliveryTarget::Prores);
    }

    #[test]
    fn hdr_pq_target_generates_pq_bt2020_finishing_and_encoder_flags() {
        // Extensibility proof: PQ delivery was added as registry table entries
        // (one DeliveryTarget arm + output_color_space) with NO new filter or
        // flag code, and produces a correct PQ / BT.2020 chain end-to-end.
        //
        // Phase 4 re-baseline (fix D): the pre-Phase-4 pin was the fused
        // `…,format=yuv420p10le`, where FFmpeg silently box-filter-decimates
        // chroma. The finishing now splits the hop: 4:4:4-10 landing →
        // lanczos chroma resample → 4:2:0-10. Justified by the decoded-frame
        // tracer (hdr_reference_white_tracer_pq) and the verbose dry-run
        // test in color_fixtures.rs.
        let f = delivery_finishing_filter(DeliveryTarget::HdrPq);
        assert_eq!(
            f,
            "zscale=t=smpte2084:m=bt2020nc:p=bt2020:r=limited,format=yuv444p10le,\
             scale=flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp,\
             format=yuv420p10le",
        );
        let args = delivery_encoder_args(DeliveryTarget::HdrPq, &libx265());
        let joined = args.join(" ");
        assert!(joined.contains("-profile:v main10"), "{}", joined);
        assert!(joined.contains("-pix_fmt yuv420p10le"), "{}", joined);
        assert!(joined.contains("-color_primaries bt2020"), "{}", joined);
        assert!(joined.contains("-color_trc smpte2084"), "{}", joined);
        assert!(joined.contains("-colorspace bt2020nc"), "{}", joined);
        assert!(
            joined.contains("-x265-params colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc"),
            "{}",
            joined,
        );
    }

    #[test]
    fn channel_compatibility_matches_brief() {
        // Composite accepts all four.
        for t in DeliveryTarget::all() {
            assert!(t.is_allowed_for_channel("composite"));
        }
        // map_only / video_only accept only Prores.
        for ch in ["map_only", "video_only"] {
            assert!(DeliveryTarget::Prores.is_allowed_for_channel(ch));
            for t in DeliveryTarget::all() {
                if *t != DeliveryTarget::Prores {
                    assert!(
                        !t.is_allowed_for_channel(ch),
                        "{:?} must NOT be allowed for {}",
                        t,
                        ch,
                    );
                }
            }
        }
        // Unknown channel rejects everything.
        for t in DeliveryTarget::all() {
            assert!(!t.is_allowed_for_channel("thumbnail"));
        }
    }

    #[test]
    fn container_extension_mp4_for_codec_targets_mov_for_prores() {
        assert_eq!(DeliveryTarget::SdrH264.container_extension(), "mp4");
        assert_eq!(DeliveryTarget::SdrH265.container_extension(), "mp4");
        assert_eq!(DeliveryTarget::HdrHlg.container_extension(), "mp4");
        assert_eq!(DeliveryTarget::HdrPq.container_extension(), "mp4");
        assert_eq!(DeliveryTarget::Prores.container_extension(), "mov");
    }

    // ---- finishing filter tests ----
    //
    // Issue 2 refactor: finishing filter is now color-only. The composite
    // is rendered AT the project's validated `(aspect, resolution)` canvas
    // from the start, so there is no scale+pad here — these tests assert
    // that no `scale=` / `pad=` slips back in (which was the pre-refactor
    // aspect-override bug).

    // Phase 4 re-baseline (fix D): the 4:2:0 targets now contain a
    // FLAGS-ONLY `scale=` step (the HQ lanczos chroma resample). A `scale=`
    // with no `w=`/`h=` does not resize — the Issue-2 aspect-override hazard
    // these tests guard against is a DIMENSIONED scale/pad, so the
    // assertions below forbid `scale=w=`/`pad=` while allowing the
    // flags-only chroma step, and pin the split shape.

    #[test]
    fn finishing_filter_sdr_targets_use_bt709_yuv420p_with_hq_chroma_split() {
        for t in [DeliveryTarget::SdrH264, DeliveryTarget::SdrH265] {
            let f = delivery_finishing_filter(t);
            assert!(
                f.contains("zscale=t=bt709:m=bt709:p=bt709:r=limited"),
                "{:?}: {}",
                t,
                f,
            );
            // Fix D split shape: 4:4:4 landing → lanczos chroma → 4:2:0.
            assert!(
                f.contains(
                    "format=yuv444p,\
                     scale=flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp,\
                     format=yuv420p"
                ),
                "{:?} must use the HQ chroma subsample split: {}",
                t,
                f,
            );
            // No DIMENSIONED scale and no pad (the aspect-override hazard).
            assert!(
                !f.contains("scale=w=") && !f.contains(":w=") && !f.contains("pad="),
                "{:?} must not resize or pad: {}",
                t,
                f,
            );
        }
    }

    #[test]
    fn finishing_filter_hdr_uses_hlg_bt2020_yuv420p10le_with_hq_chroma_split() {
        let f = delivery_finishing_filter(DeliveryTarget::HdrHlg);
        assert!(
            f.contains("zscale=t=arib-std-b67:m=bt2020nc:p=bt2020:r=limited"),
            "{}",
            f,
        );
        // Fix D split shape at 10-bit.
        assert!(
            f.contains(
                "format=yuv444p10le,\
                 scale=flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp,\
                 format=yuv420p10le"
            ),
            "HDR must use the HQ chroma subsample split: {}",
            f,
        );
        assert!(
            !f.contains("scale=w=") && !f.contains(":w=") && !f.contains("pad="),
            "HDR must not resize or pad: {}",
            f,
        );
    }

    #[test]
    fn finishing_filter_prores_preserves_alpha_no_scale_pad() {
        let f = delivery_finishing_filter(DeliveryTarget::Prores);
        assert!(f.contains("zscale=t=bt709:m=bt709:p=bt709:r=limited"), "{}", f);
        assert!(f.contains("format=yuva444p10le"), "{}", f);
        assert!(
            !f.contains(",scale=") && !f.starts_with("scale="),
            "ProRes must not include a standalone scale filter: {}",
            f,
        );
        assert!(!f.contains("pad="), "ProRes must not pad: {}", f);
    }

    // ---- encoder argv tests ----

    #[test]
    fn sdr_h264_argv_sets_x264_color_params() {
        let args = delivery_encoder_args(DeliveryTarget::SdrH264, &libx264());
        let joined = args.join(" ");
        // libx264 selected; preset + crf; pix_fmt; color flags; x264-params
        // duplicate (WS6 regression); audio; faststart.
        assert!(joined.contains("-c:v libx264"), "{}", joined);
        assert!(joined.contains("-preset medium"), "{}", joined);
        assert!(joined.contains("-crf 18"), "{}", joined);
        assert!(joined.contains("-pix_fmt yuv420p"), "{}", joined);
        assert!(joined.contains("-color_primaries bt709"), "{}", joined);
        assert!(joined.contains("-color_trc bt709"), "{}", joined);
        assert!(joined.contains("-colorspace bt709"), "{}", joined);
        assert!(joined.contains("-color_range tv"), "{}", joined);
        assert!(
            joined.contains("-x264-params colorprim=bt709:transfer=bt709:colormatrix=bt709"),
            "x264-params duplicate missing (WS6 regression): {}",
            joined,
        );
        assert!(joined.contains("-c:a aac"), "{}", joined);
        assert!(joined.contains("-b:a 192k"), "{}", joined);
        assert!(joined.contains("-movflags +faststart"), "{}", joined);
    }

    #[test]
    fn sdr_h265_with_videotoolbox_skips_x265_params() {
        // VideoToolbox honors the global -color_* flags — no -x265-params
        // splice needed. This branch is FALLBACK-ONLY (libx265 absent);
        // q:v 65 so the fallback at least doesn't starve (old 50 measured
        // ~13 Mbps at 4K — decoration mush).
        let args = delivery_encoder_args(DeliveryTarget::SdrH265, &videotoolbox_hevc());
        let joined = args.join(" ");
        assert!(joined.contains("-c:v hevc_videotoolbox"), "{}", joined);
        assert!(joined.contains("-tag:v hvc1"), "{}", joined);
        assert!(joined.contains("-q:v 65"), "{}", joined);
        assert!(joined.contains("-color_primaries bt709"), "{}", joined);
        assert!(joined.contains("-color_trc bt709"), "{}", joined);
        assert!(
            !joined.contains("-x265-params"),
            "videotoolbox must not splice -x265-params: {}",
            joined,
        );
    }

    #[test]
    fn sdr_h265_with_libx265_adds_x265_params_color_duplicate() {
        let args = delivery_encoder_args(DeliveryTarget::SdrH265, &libx265());
        let joined = args.join(" ");
        assert!(joined.contains("-c:v libx265"), "{}", joined);
        assert!(joined.contains("-tag:v hvc1"), "{}", joined);
        // Decoration-crispness settings (2026-07-03 probe): fast/17 + the
        // chroma QP offsets, measured ≥0.88 Cr Sobel retention vs the
        // lossless pre-encode tap.
        assert!(joined.contains("-preset fast"), "{}", joined);
        assert!(joined.contains("-crf 17"), "{}", joined);
        assert!(
            joined.contains(
                "-x265-params colorprim=bt709:transfer=bt709:colormatrix=bt709:\
                 cbqpoffs=-2:crqpoffs=-2"
            ),
            "libx265 SDR must carry the VUI duplicate (WS6) AND the chroma-QP \
             delivery tuning in ONE -x265-params value: {}",
            joined,
        );
    }

    #[test]
    fn hdr_hlg_with_videotoolbox_uses_main10_and_bt2020_flags() {
        let args = delivery_encoder_args(DeliveryTarget::HdrHlg, &videotoolbox_hevc());
        let joined = args.join(" ");
        assert!(joined.contains("-c:v hevc_videotoolbox"), "{}", joined);
        assert!(joined.contains("-profile:v main10"), "{}", joined);
        assert!(joined.contains("-pix_fmt yuv420p10le"), "{}", joined);
        assert!(joined.contains("-color_primaries bt2020"), "{}", joined);
        assert!(joined.contains("-color_trc arib-std-b67"), "{}", joined);
        assert!(joined.contains("-colorspace bt2020nc"), "{}", joined);
        assert!(joined.contains("-color_range tv"), "{}", joined);
        assert!(
            !joined.contains("-x265-params"),
            "videotoolbox path must not splice x265-params: {}",
            joined,
        );
    }

    #[test]
    fn hdr_hlg_with_libx265_adds_main10_and_x265_params_hlg_bt2020() {
        let args = delivery_encoder_args(DeliveryTarget::HdrHlg, &libx265());
        let joined = args.join(" ");
        assert!(joined.contains("-c:v libx265"), "{}", joined);
        assert!(joined.contains("-profile:v main10"), "{}", joined);
        assert!(joined.contains("-pix_fmt yuv420p10le"), "{}", joined);
        assert!(joined.contains("-preset fast"), "{}", joined);
        assert!(joined.contains("-crf 17"), "{}", joined);
        assert!(
            joined.contains(
                "-x265-params colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:\
                 cbqpoffs=-2:crqpoffs=-2"
            ),
            "libx265 HDR must carry the VUI duplicate (WS6) AND the chroma-QP \
             delivery tuning in ONE -x265-params value: {}",
            joined,
        );
    }

    #[test]
    fn prores_argv_emits_prores_ks_with_bt709_tags_and_pcm_audio() {
        let args = delivery_encoder_args(DeliveryTarget::Prores, &prores());
        let joined = args.join(" ");
        assert!(joined.contains("-c:v prores_ks"), "{}", joined);
        assert!(joined.contains("-profile:v 4444"), "{}", joined);
        assert!(joined.contains("-pix_fmt yuva444p10le"), "{}", joined);
        assert!(joined.contains("-vendor apl0"), "{}", joined);
        assert!(joined.contains("-color_primaries bt709"), "{}", joined);
        assert!(joined.contains("-color_trc bt709"), "{}", joined);
        assert!(joined.contains("-colorspace bt709"), "{}", joined);
        assert!(joined.contains("-color_range tv"), "{}", joined);
        assert!(joined.contains("-c:a pcm_s16le"), "{}", joined);
        // Fix #5: ProRes Master must emit `-movflags +faststart` like every
        // other delivery target. The QuickTime muxer honors it (moves the
        // moov atom to the front) and silently ignores the mp4-specific
        // bits — load-bearing for ProRes files written to remote / slow
        // drives, which otherwise can't be played back until the full
        // transfer completes.
        assert!(joined.contains("-movflags +faststart"), "{}", joined);
        // ProRes has no AAC and no x264/x265 params.
        assert!(!joined.contains("-c:a aac"), "{}", joined);
        assert!(!joined.contains("-x264-params"), "{}", joined);
        assert!(!joined.contains("-x265-params"), "{}", joined);
    }

    #[test]
    fn every_codec_target_emits_global_color_flags_and_vui_duplicate() {
        // Cross-cutting assertion: every SDR / HDR codec target carries BOTH
        // the global -color_* flags AND (for software encoders) the
        // encoder-params VUI duplicate. ProRes is the lone exception (no
        // encoder-params analogue; the prores_ks encoder honors global
        // flags directly).
        let cases: Vec<(DeliveryTarget, EncoderChoice, bool /* expects vui dup */)> = vec![
            (DeliveryTarget::SdrH264, libx264(), true),
            (DeliveryTarget::SdrH265, libx265(), true),
            (DeliveryTarget::SdrH265, videotoolbox_hevc(), false),
            (DeliveryTarget::HdrHlg, libx265(), true),
            (DeliveryTarget::HdrHlg, videotoolbox_hevc(), false),
            (DeliveryTarget::HdrPq, libx265(), true),
            (DeliveryTarget::HdrPq, videotoolbox_hevc(), false),
        ];
        for (target, enc, expect_dup) in cases {
            let args = delivery_encoder_args(target, &enc);
            let joined = args.join(" ");
            assert!(
                joined.contains("-color_primaries"),
                "{:?}/{}: missing -color_primaries: {}",
                target,
                enc.name,
                joined,
            );
            assert!(
                joined.contains("-color_trc"),
                "{:?}/{}: missing -color_trc: {}",
                target,
                enc.name,
                joined,
            );
            assert!(
                joined.contains("-colorspace"),
                "{:?}/{}: missing -colorspace: {}",
                target,
                enc.name,
                joined,
            );
            assert!(
                joined.contains("-color_range tv"),
                "{:?}/{}: missing -color_range tv: {}",
                target,
                enc.name,
                joined,
            );
            let has_dup =
                joined.contains("-x264-params") || joined.contains("-x265-params");
            assert_eq!(
                has_dup, expect_dup,
                "{:?}/{}: VUI duplicate expectation mismatch (expected {}); joined: {}",
                target, enc.name, expect_dup, joined,
            );
        }
    }
}
