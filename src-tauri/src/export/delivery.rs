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
//     prefer hardware (videotoolbox on macOS) with software fallback; H.264
//     targets always use libx264 (the brief specifies it explicitly);
//     ProRes Master always uses prores_ks.
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
            DeliveryTarget::Prores,
        ]
    }

    /// Human-readable display label for the picker dropdown.
    pub const fn label(self) -> &'static str {
        match self {
            DeliveryTarget::SdrH265 => "SDR · H.265 (modern, smaller files)",
            DeliveryTarget::SdrH264 => "SDR · H.264 (universal compatibility)",
            DeliveryTarget::HdrHlg => "HDR · HLG (10-bit BT.2020)",
            DeliveryTarget::Prores => "ProRes 4444 (master / intermediate)",
        }
    }

    /// Short label for tight UI affordances (badges, status lines).
    pub const fn short_label(self) -> &'static str {
        match self {
            DeliveryTarget::SdrH265 => "SDR H.265",
            DeliveryTarget::SdrH264 => "SDR H.264",
            DeliveryTarget::HdrHlg => "HDR HLG",
            DeliveryTarget::Prores => "ProRes",
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
    match target {
        DeliveryTarget::HdrHlg => {
            // HLG BT.2020 limited, 10-bit 4:2:0.
            "zscale=t=arib-std-b67:m=bt2020nc:p=bt2020:r=limited,format=yuv420p10le"
                .to_string()
        }
        DeliveryTarget::Prores => {
            // BT.709 limited, but preserve alpha + bit depth (yuva444p10le).
            // Channel A composite gets the full working-space → BT.709
            // conversion here; B and C round-trip through working space
            // earlier (per WS3) and don't reach this path.
            "zscale=t=bt709:m=bt709:p=bt709:r=limited,format=yuva444p10le".to_string()
        }
        // SDR family (H.264 and H.265 share color/pixel format —
        // codec/container differences happen at encoder time, not in the
        // finishing filter).
        DeliveryTarget::SdrH264 | DeliveryTarget::SdrH265 => {
            "zscale=t=bt709:m=bt709:p=bt709:r=limited,format=yuv420p".to_string()
        }
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
    match target {
        DeliveryTarget::SdrH264 => {
            // H.264 via libx264 (always available — software encoder).
            push(&mut out, ["-c:v", "libx264"]);
            push(&mut out, ["-preset", "medium", "-crf", "18"]);
            push(&mut out, ["-pix_fmt", "yuv420p"]);
            push_color_flags_bt709(&mut out);
            // libx264 drops `-color_primaries`/`-color_trc` from the VUI
            // unless we duplicate them in `-x264-params`. WS6 regression.
            push(
                &mut out,
                [
                    "-x264-params",
                    "colorprim=bt709:transfer=bt709:colormatrix=bt709",
                ],
            );
            push_aac_audio(&mut out);
            push(&mut out, ["-movflags", "+faststart"]);
        }
        DeliveryTarget::SdrH265 => {
            // HEVC SDR. videotoolbox preferred; libx265 fallback.
            out.push("-c:v".into());
            out.push(encoder.name.clone());
            if encoder.name == "hevc_videotoolbox" {
                push(&mut out, ["-tag:v", "hvc1", "-q:v", "50"]);
            } else {
                // libx265 (or other software) — explicit pix_fmt + preset/crf.
                push(&mut out, ["-tag:v", "hvc1", "-preset", "medium", "-crf", "18"]);
            }
            push(&mut out, ["-pix_fmt", "yuv420p"]);
            push_color_flags_bt709(&mut out);
            if encoder.name != "hevc_videotoolbox" {
                // libx265 / x265 software path — VUI duplicate.
                push(
                    &mut out,
                    [
                        "-x265-params",
                        "colorprim=bt709:transfer=bt709:colormatrix=bt709",
                    ],
                );
            }
            push_aac_audio(&mut out);
            push(&mut out, ["-movflags", "+faststart"]);
        }
        DeliveryTarget::HdrHlg => {
            // HEVC 10-bit HDR (HLG BT.2020).
            out.push("-c:v".into());
            out.push(encoder.name.clone());
            if encoder.name == "hevc_videotoolbox" {
                push(
                    &mut out,
                    ["-tag:v", "hvc1", "-q:v", "50", "-profile:v", "main10"],
                );
            } else {
                // libx265 main10 fallback.
                push(
                    &mut out,
                    [
                        "-tag:v",
                        "hvc1",
                        "-profile:v",
                        "main10",
                        "-preset",
                        "medium",
                        "-crf",
                        "18",
                    ],
                );
            }
            push(&mut out, ["-pix_fmt", "yuv420p10le"]);
            push_color_flags_hlg_bt2020(&mut out);
            if encoder.name != "hevc_videotoolbox" {
                // libx265 — VUI duplicate for HDR.
                push(
                    &mut out,
                    [
                        "-x265-params",
                        "colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc",
                    ],
                );
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
            push_color_flags_bt709(&mut out);
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
        DeliveryTarget::SdrH265 | DeliveryTarget::HdrHlg => EncoderClass::Hevc,
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

fn push_color_flags_bt709(out: &mut Vec<String>) {
    push(
        out,
        [
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-colorspace",
            "bt709",
            "-color_range",
            "tv",
        ],
    );
}

fn push_color_flags_hlg_bt2020(out: &mut Vec<String>) {
    push(
        out,
        [
            "-color_primaries",
            "bt2020",
            "-color_trc",
            "arib-std-b67",
            "-colorspace",
            "bt2020nc",
            "-color_range",
            "tv",
        ],
    );
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
            (DeliveryTarget::Prores, "\"prores\""),
        ] {
            let json = serde_json::to_string(&variant).unwrap();
            assert_eq!(json, expected, "wire format for {:?}", variant);
            let round: DeliveryTarget = serde_json::from_str(&json).unwrap();
            assert_eq!(round, variant);
        }
    }

    #[test]
    fn catalog_lists_all_four_in_display_order() {
        let all: Vec<DeliveryTarget> = DeliveryTarget::all().to_vec();
        assert_eq!(all.len(), 4);
        // SDR H.265 first — default for composite (most users), modern
        // efficiency + native playback on Apple/Chrome/Edge.
        assert_eq!(all[0], DeliveryTarget::SdrH265);
        // ProRes last — archival/intermediate, not the typical pick.
        assert_eq!(all[3], DeliveryTarget::Prores);
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
        assert_eq!(DeliveryTarget::Prores.container_extension(), "mov");
    }

    // ---- finishing filter tests ----
    //
    // Issue 2 refactor: finishing filter is now color-only. The composite
    // is rendered AT the project's validated `(aspect, resolution)` canvas
    // from the start, so there is no scale+pad here — these tests assert
    // that no `scale=` / `pad=` slips back in (which was the pre-refactor
    // aspect-override bug).

    #[test]
    fn finishing_filter_sdr_targets_use_bt709_yuv420p_and_emit_no_scale_pad() {
        for t in [DeliveryTarget::SdrH264, DeliveryTarget::SdrH265] {
            let f = delivery_finishing_filter(t);
            assert!(
                f.contains("zscale=t=bt709:m=bt709:p=bt709:r=limited"),
                "{:?}: {}",
                t,
                f,
            );
            assert!(f.contains("format=yuv420p"), "{:?}: {}", t, f);
            // No standalone scale or pad — `scale=` is a substring of
            // `zscale=`, so match `,scale=` to exclude the zscale prefix.
            assert!(
                !f.contains(",scale=") && !f.starts_with("scale="),
                "{:?} must not include a standalone scale filter: {}",
                t,
                f,
            );
            assert!(!f.contains("pad="), "{:?} must not pad: {}", t, f);
        }
    }

    #[test]
    fn finishing_filter_hdr_uses_hlg_bt2020_yuv420p10le_and_emits_no_scale_pad() {
        let f = delivery_finishing_filter(DeliveryTarget::HdrHlg);
        assert!(
            f.contains("zscale=t=arib-std-b67:m=bt2020nc:p=bt2020:r=limited"),
            "{}",
            f,
        );
        assert!(f.contains("format=yuv420p10le"), "{}", f);
        assert!(
            !f.contains(",scale=") && !f.starts_with("scale="),
            "HDR must not include a standalone scale filter: {}",
            f,
        );
        assert!(!f.contains("pad="), "HDR must not pad: {}", f);
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
        // splice needed.
        let args = delivery_encoder_args(DeliveryTarget::SdrH265, &videotoolbox_hevc());
        let joined = args.join(" ");
        assert!(joined.contains("-c:v hevc_videotoolbox"), "{}", joined);
        assert!(joined.contains("-tag:v hvc1"), "{}", joined);
        assert!(joined.contains("-q:v 50"), "{}", joined);
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
        assert!(joined.contains("-preset medium"), "{}", joined);
        assert!(joined.contains("-crf 18"), "{}", joined);
        assert!(
            joined.contains("-x265-params colorprim=bt709:transfer=bt709:colormatrix=bt709"),
            "libx265 SDR must duplicate VUI in -x265-params (WS6): {}",
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
        assert!(
            joined.contains(
                "-x265-params colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc"
            ),
            "libx265 HDR must duplicate VUI in -x265-params (WS6): {}",
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
