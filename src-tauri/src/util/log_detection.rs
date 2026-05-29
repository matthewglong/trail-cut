// WS8 — Log Format Detection
//
// Camera make/model knowledge base used to *suggest* (never auto-apply) a
// likely log encoding for an imported clip. Log formats (D-Log, C-Log,
// GP-Log, V-Log, S-Log2/3) tag themselves as plain `bt709` in ffprobe color
// metadata; they cannot be auto-detected from color tags. Detection here
// relies on the QuickTime / encoder-derived camera identification surfaced on
// `ColorMetadata` plus a 10-bit pixel-format gate.
//
// The output is consumed by WS9's source-format UI: a clip whose
// `suggested_log_class` is `Some(...)` shows a "Looks like D-Log — apply?"
// affordance, and the *user* (not the pipeline) decides whether to write the
// suggestion through to `user_color_class_override`. Suggestions are never
// auto-applied — false positives on log are destructive (applying a D-Log →
// 709 LUT to a plain Rec.709 clip crushes shadows and oversaturates badly,
// see `docs/color-pipeline/background/design-decisions.md` §"Decision 5").
//
// Knowledge-base scope is intentionally conservative:
//   - DJI drones + 10-bit                  → D-Log
//   - GoPro HERO 10+ + 10-bit              → GP-Log (Protune flat)
//   - Canon cinema bodies (C70/C300/C500)  → C-Log2
//   - Canon R5 / R6 / R3                   → C-Log3
//   - Sony FX-series / A7S / A7R          → S-Log3
//   - Panasonic GH5/GH6/S1H/S5             → V-Log
// Everything else returns `None`. False negatives (e.g. iPhone, which has no
// log option at all) are the correct behaviour — no suggestion means the UI
// surfaces nothing, which is better than a misleading hint.

use crate::util::color::SourceColorClass;

/// Structured input for the log-format classifier. Mirrors the subset of
/// `ColorMetadata` we actually consult, plus a derived `bit_depth` (cheaper
/// to compute once and pass than to re-derive at every branch). Public so
/// `crate::util::color::suggest_log_format` can build it; callers outside
/// this module should reach for `suggest_log_format(&ColorMetadata)` rather
/// than constructing this struct by hand.
#[derive(Debug, Clone)]
pub struct DetectionInput<'a> {
    pub camera_make: Option<&'a str>,
    pub camera_model: Option<&'a str>,
    /// Derived from `pix_fmt` via `bit_depth_from_pix_fmt`. 10 for any
    /// `*10le` / `*10be` planar format, 12 for `*12le` / `*12be`, 8
    /// otherwise (the conservative default when we can't tell).
    pub bit_depth: u8,
    /// Carried so the HDR-overrides-log gate stays local. `bt709` /
    /// `Some("")` / `None` are the "no HDR transfer" sentinels — anything
    /// else (`arib-std-b67`, `smpte2084`, …) suppresses the suggestion
    /// because HDR-tagged footage is never log.
    pub color_trc: Option<&'a str>,
}

/// Derive the per-channel bit depth from an ffprobe `pix_fmt` string.
/// Handles the planar YUV / RGB families this codebase actually sees:
///   - `yuv420p`, `yuv422p`, `yuv444p`, `nv12`, `rgb24` → 8
///   - `yuv420p10le`, `yuv420p10be`, `yuv422p10le`, `p010le` → 10
///   - `yuv420p12le`, `yuv422p12le`, `yuv444p12le` → 12
/// Falls back to 8 (the safe SDR baseline) for anything we don't recognise
/// — a "we don't know, so assume not-10-bit" stance that keeps the
/// suggestion gate conservative.
pub fn bit_depth_from_pix_fmt(pix_fmt: Option<&str>) -> u8 {
    let Some(p) = pix_fmt else {
        return 8;
    };
    let p = p.to_ascii_lowercase();
    // `p010le` is Apple's QuickTime 10-bit container fourcc; covered by the
    // explicit substring match below.
    if p.contains("12le") || p.contains("12be") {
        return 12;
    }
    if p.contains("10le") || p.contains("10be") || p == "p010le" || p == "p010be" {
        return 10;
    }
    8
}

/// Suggest a likely log encoding for the given metadata. Returns `None`
/// when:
///   - the source tags itself as HDR (HLG or PQ) — HDR is never log;
///   - the camera doesn't appear in the knowledge base;
///   - the camera's log mode requires 10-bit and the clip isn't 10-bit;
///   - the make/model strings are empty.
///
/// The returned `SourceColorClass` is *not* written through to
/// `source_color_class` or `user_color_class_override` automatically.
/// It rides as a separate `suggested_log_class` hint that WS9's source-format
/// UI surfaces to the user.
pub fn suggest_log_format(input: DetectionInput) -> Option<SourceColorClass> {
    // HDR gate: log formats tag themselves as bt709 (or unspecified). Anything
    // else is real HDR and must never get a log suggestion on top of it.
    // `Some("")` is included because some sources emit an empty-string value
    // rather than omitting the key; treat it as equivalent to absent.
    let trc_ok = matches!(input.color_trc, Some("bt709") | None | Some(""));
    if !trc_ok {
        return None;
    }

    let make = input.camera_make.unwrap_or("").to_ascii_lowercase();
    let model = input.camera_model.unwrap_or("").to_ascii_lowercase();

    // DJI drones — D-Log requires 10-bit recording on Mavic 3+, Air 2S,
    // Inspire, etc. Older 8-bit DJI captures (Mavic 2 in standard mode) are
    // not log and must not get a suggestion. The DJI fallback in
    // `export::ffprobe::detect_camera_from_encoder` lands "DJI" in
    // `camera_make` even when the QuickTime tags are absent.
    if make.contains("dji") {
        if input.bit_depth >= 10 {
            return Some(SourceColorClass::DLog);
        }
        return None;
    }

    // GoPro HERO 10+ with 10-bit can be GP-Log (the "Protune flat" picture
    // profile). 8-bit GoPro footage is plain Rec.709 — no suggestion.
    if make.contains("gopro") {
        if input.bit_depth >= 10 {
            return Some(SourceColorClass::GpLog);
        }
        return None;
    }

    // Canon — split between cinema bodies (C70/C300/C500 → typically C-Log2)
    // and mirrorless bodies (R5/R6/R3 → C-Log3). The 5D Mk IV's C-Log was an
    // optional firmware upgrade and we have no signal to distinguish on/off,
    // so it intentionally returns None (no suggestion is better than a
    // wrong-half-the-time guess).
    if make.contains("canon") {
        if model.contains("c70") || model.contains("c300") || model.contains("c500") {
            return Some(SourceColorClass::CLog2);
        }
        if model.contains("r5") || model.contains("r6") || model.contains("r3") {
            return Some(SourceColorClass::CLog3);
        }
        return None;
    }

    // Sony — S-Log on the FX cinema line (FX3/FX6/FX9) and the A7S/A7R
    // hybrid bodies. S-Log2 is older and rarer on modern bodies; suggest
    // S-Log3 as the more common default. User can override to S-Log2 from
    // the UI if needed.
    //
    // Sony tags the body using its internal Alpha codename in the
    // QuickTime container — `ILCE-7SM3` is the A7S III, `ILCE-7RM5` is the
    // A7R V, `ILME-FX3` is the FX3, `PXW-FX9` is the FX9. We match both
    // the marketing-name substrings ("a7s", "a7r") and the internal-code
    // substrings ("ilce-7s", "ilce-7r") because real-world clips carry
    // the latter and a knowledge base that only matches the former would
    // silently miss most Sony footage.
    if make.contains("sony") {
        if model.contains("fx3")
            || model.contains("fx6")
            || model.contains("fx9")
            || model.contains("a7s")
            || model.contains("a7r")
            || model.contains("ilce-7s")
            || model.contains("ilce-7r")
        {
            return Some(SourceColorClass::SLog3);
        }
        return None;
    }

    // Panasonic — V-Log on the GH-series cine-hybrid (GH5, GH6) and the
    // S-series full-frame (S1H, S5). V-Log on the GH4 was a paid upgrade
    // and is too rare to suggest by default.
    if make.contains("panasonic") {
        if model.contains("gh5")
            || model.contains("gh6")
            || model.contains("s1h")
            || model.contains("s5")
        {
            return Some(SourceColorClass::VLog);
        }
        return None;
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(
        make: Option<&'a str>,
        model: Option<&'a str>,
        bit_depth: u8,
        trc: Option<&'a str>,
    ) -> DetectionInput<'a> {
        DetectionInput {
            camera_make: make,
            camera_model: model,
            bit_depth,
            color_trc: trc,
        }
    }

    // ---- bit_depth_from_pix_fmt -------------------------------------------------

    #[test]
    fn bit_depth_8_for_yuv420p() {
        assert_eq!(bit_depth_from_pix_fmt(Some("yuv420p")), 8);
        assert_eq!(bit_depth_from_pix_fmt(Some("nv12")), 8);
        assert_eq!(bit_depth_from_pix_fmt(Some("rgb24")), 8);
    }

    #[test]
    fn bit_depth_10_for_yuv420p10le_and_p010le() {
        assert_eq!(bit_depth_from_pix_fmt(Some("yuv420p10le")), 10);
        assert_eq!(bit_depth_from_pix_fmt(Some("yuv422p10le")), 10);
        assert_eq!(bit_depth_from_pix_fmt(Some("YUV420P10LE")), 10);
        assert_eq!(bit_depth_from_pix_fmt(Some("p010le")), 10);
    }

    #[test]
    fn bit_depth_12_for_yuv444p12le() {
        assert_eq!(bit_depth_from_pix_fmt(Some("yuv420p12le")), 12);
        assert_eq!(bit_depth_from_pix_fmt(Some("yuv444p12le")), 12);
    }

    #[test]
    fn bit_depth_falls_back_to_8_when_absent_or_unknown() {
        assert_eq!(bit_depth_from_pix_fmt(None), 8);
        assert_eq!(bit_depth_from_pix_fmt(Some("some-future-fmt")), 8);
    }

    // ---- DJI --------------------------------------------------------------------

    #[test]
    fn dji_mavic_3_10bit_bt709_suggests_d_log() {
        // The canonical "real-world signal" case: a DJI Mavic 3 clip,
        // 10-bit, tagged bt709. This is the strongest D-Log indicator we
        // have and the brief's headline acceptance check.
        let out = suggest_log_format(input(
            Some("DJI"),
            Some("Mavic 3"),
            10,
            Some("bt709"),
        ));
        assert_eq!(out, Some(SourceColorClass::DLog));
    }

    #[test]
    fn dji_mavic_3_8bit_does_not_suggest_log() {
        // D-Log on DJI bodies requires 10-bit recording. An 8-bit Mavic clip
        // is plain Rec.709 — suggesting D-Log would be a false positive.
        let out = suggest_log_format(input(Some("DJI"), Some("Mavic 3"), 8, Some("bt709")));
        assert_eq!(out, None);
    }

    #[test]
    fn dji_from_encoder_fallback_string_still_matches() {
        // ffprobe's `detect_camera_from_encoder` puts the literal "DJI"
        // (uppercase) in `camera_make` when QuickTime tags are absent. The
        // lowercase match must still hit.
        let out = suggest_log_format(input(Some("DJI"), Some("DJI Avatar Encoder"), 10, None));
        assert_eq!(out, Some(SourceColorClass::DLog));
    }

    // ---- GoPro ------------------------------------------------------------------

    #[test]
    fn gopro_10bit_suggests_gp_log() {
        let out = suggest_log_format(input(
            Some("GoPro"),
            Some("HERO11 Black"),
            10,
            Some("bt709"),
        ));
        assert_eq!(out, Some(SourceColorClass::GpLog));
    }

    #[test]
    fn gopro_8bit_does_not_suggest_log() {
        let out = suggest_log_format(input(Some("GoPro"), Some("HERO9 Black"), 8, Some("bt709")));
        assert_eq!(out, None);
    }

    // ---- Canon ------------------------------------------------------------------

    #[test]
    fn canon_c70_suggests_c_log2() {
        let out = suggest_log_format(input(Some("Canon"), Some("EOS C70"), 10, Some("bt709")));
        assert_eq!(out, Some(SourceColorClass::CLog2));
    }

    #[test]
    fn canon_c300_suggests_c_log2() {
        let out = suggest_log_format(input(Some("Canon"), Some("C300 Mark III"), 10, None));
        assert_eq!(out, Some(SourceColorClass::CLog2));
    }

    #[test]
    fn canon_r5_suggests_c_log3() {
        let out = suggest_log_format(input(Some("Canon"), Some("EOS R5"), 10, Some("bt709")));
        assert_eq!(out, Some(SourceColorClass::CLog3));
    }

    #[test]
    fn canon_r6_and_r3_suggest_c_log3() {
        assert_eq!(
            suggest_log_format(input(Some("Canon"), Some("EOS R6"), 10, None)),
            Some(SourceColorClass::CLog3),
        );
        assert_eq!(
            suggest_log_format(input(Some("Canon"), Some("EOS R3"), 10, None)),
            Some(SourceColorClass::CLog3),
        );
    }

    #[test]
    fn canon_5d_mk_iv_is_not_suggested() {
        // C-Log on the 5D Mk IV was an optional paid firmware. No signal in
        // the container tells us whether it's on; refuse to guess.
        let out = suggest_log_format(input(Some("Canon"), Some("EOS 5D Mark IV"), 8, None));
        assert_eq!(out, None);
    }

    // ---- Sony -------------------------------------------------------------------

    #[test]
    fn sony_fx3_suggests_s_log3() {
        let out = suggest_log_format(input(Some("Sony"), Some("ILME-FX3"), 10, Some("bt709")));
        assert_eq!(out, Some(SourceColorClass::SLog3));
    }

    #[test]
    fn sony_fx6_and_fx9_suggest_s_log3() {
        assert_eq!(
            suggest_log_format(input(Some("Sony"), Some("ILME-FX6"), 10, None)),
            Some(SourceColorClass::SLog3),
        );
        assert_eq!(
            suggest_log_format(input(Some("Sony"), Some("PXW-FX9"), 10, None)),
            Some(SourceColorClass::SLog3),
        );
    }

    #[test]
    fn sony_a7s_iii_suggests_s_log3() {
        let out = suggest_log_format(input(Some("Sony"), Some("ILCE-7SM3"), 10, None));
        assert_eq!(out, Some(SourceColorClass::SLog3));
    }

    #[test]
    fn sony_zv1_is_not_suggested() {
        // Vlog camera but no S-Log option — we don't have it in the KB.
        let out = suggest_log_format(input(Some("Sony"), Some("ZV-1"), 8, None));
        assert_eq!(out, None);
    }

    // ---- Panasonic --------------------------------------------------------------

    #[test]
    fn panasonic_gh5_suggests_v_log() {
        let out = suggest_log_format(input(
            Some("Panasonic"),
            Some("DC-GH5"),
            10,
            Some("bt709"),
        ));
        assert_eq!(out, Some(SourceColorClass::VLog));
    }

    #[test]
    fn panasonic_s1h_and_s5_suggest_v_log() {
        assert_eq!(
            suggest_log_format(input(Some("Panasonic"), Some("DC-S1H"), 10, None)),
            Some(SourceColorClass::VLog),
        );
        assert_eq!(
            suggest_log_format(input(Some("Panasonic"), Some("DC-S5"), 10, None)),
            Some(SourceColorClass::VLog),
        );
    }

    // ---- iPhone / unknown / HDR -------------------------------------------------

    #[test]
    fn iphone_never_suggests_log() {
        // iPhones have no log option in any current iOS camera mode. SDR and
        // HLG iPhone clips must both return None.
        assert_eq!(
            suggest_log_format(input(
                Some("Apple"),
                Some("iPhone 15 Pro"),
                8,
                Some("bt709"),
            )),
            None,
        );
        assert_eq!(
            suggest_log_format(input(
                Some("Apple"),
                Some("iPhone 15 Pro"),
                10,
                Some("arib-std-b67"),
            )),
            None,
        );
    }

    #[test]
    fn hdr_transfer_suppresses_log_suggestion() {
        // A DJI Mavic clip that's actually tagged HLG (rare but possible —
        // user enabled HDR mode) must not get a log suggestion on top of
        // its real HDR transfer.
        assert_eq!(
            suggest_log_format(input(
                Some("DJI"),
                Some("Mavic 3 Pro"),
                10,
                Some("arib-std-b67"),
            )),
            None,
        );
        assert_eq!(
            suggest_log_format(input(
                Some("Canon"),
                Some("EOS R5"),
                10,
                Some("smpte2084"),
            )),
            None,
        );
    }

    #[test]
    fn missing_metadata_returns_none() {
        // A clip with no camera identification at all (the import path's
        // graceful-degradation case). Suggesting anything here is a guess
        // with no signal — the brief's "false positives are worse than no
        // detection" rule applies.
        assert_eq!(
            suggest_log_format(input(None, None, 10, Some("bt709"))),
            None,
        );
    }

    #[test]
    fn empty_string_transfer_treated_as_unspecified() {
        // Some sources emit `color_transfer = ""` (empty string) rather than
        // omitting the field. Treat it as absent for the HDR gate so a
        // genuinely log-suspect clip still gets a suggestion.
        let out = suggest_log_format(input(Some("DJI"), Some("Mavic 3"), 10, Some("")));
        assert_eq!(out, Some(SourceColorClass::DLog));
    }

    // ---- Integration: through ColorMetadata --------------------------------------

    #[test]
    fn suggest_via_color_metadata_dji_mavic() {
        // The public surface lives on `util::color::suggest_log_format`,
        // which delegates here. This test guards that the
        // ColorMetadata → DetectionInput projection preserves the signals
        // the classifier needs.
        use crate::util::color::ColorMetadata;
        let meta = ColorMetadata {
            pix_fmt: Some("yuv420p10le".to_string()),
            color_primaries: Some("bt709".to_string()),
            color_trc: Some("bt709".to_string()),
            color_space: Some("bt709".to_string()),
            color_range: Some("tv".to_string()),
            has_dolby_vision: false,
            camera_make: Some("DJI".to_string()),
            camera_model: Some("Mavic 3".to_string()),
        };
        let out = crate::util::color::suggest_log_format(&meta);
        assert_eq!(out, Some(SourceColorClass::DLog));
    }
}
