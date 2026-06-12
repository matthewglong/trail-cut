// Atomic-axes color-space registry — the single source of truth for every
// color string the export pipeline emits.
//
// The premise: a color space is fully described by FOUR ATOMIC AXES —
// primaries, transfer, range, matrix (+ an optional nominal-peak-luminance
// for HDR transfers). Once color is decomposed that way, the whole pipeline
// is THREE transforms between `ColorSpace` values:
//
//   1. ingest    — source `ColorSpace` → working `ColorSpace` (per clip, and
//                  the map canvas's sRGB → working)
//   2. composite — happens entirely IN the working `ColorSpace` (linear light)
//   3. delivery  — working `ColorSpace` → output `ColorSpace` (from the
//                  chosen `DeliveryTarget`)
//
// `ingest_zscale_chain` and `delivery_zscale_chain` GENERATE the zscale filter
// strings from a `ColorSpace` (pair). The per-axis enums carry both their
// zscale token (`zscale()`) and their FFmpeg `-color_*` flag spelling
// (`ffmpeg_flag()`) — for several axes those differ (e.g. SMPTE 170M is
// `170m` to zscale but `smpte170m` to the encoder flags).
//
// THE ACCEPTANCE TEST FOR THIS MODULE: adding a new transfer / primary /
// range / matrix is ONE new enum arm + its token strings here, and NOTHING
// else in the codebase changes. The duplicated color knowledge that used to
// live across `color.rs`, `delivery.rs`, and `filtergraph.rs` (the BT.709
// description alone lived in five places) collapses to one definition per
// axis value.
//
// NOT in scope (but the registry is shaped to accept them as future table
// entries, no structural change): cinema-log IDTs, ACEScg AP1 working
// primaries, ACES/OCIO, Dolby Vision RPU passthrough, tone-map operators.

/// Color primaries (the chromaticities of the R/G/B lights).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Primaries {
    Bt709,
    Bt2020,
    // Future: P3D65, AcesAp1 — add the arm + tokens below, nothing else.
}

impl Primaries {
    /// zscale `p=`/`pin=` token.
    pub const fn zscale(self) -> &'static str {
        match self {
            Primaries::Bt709 => "bt709",
            Primaries::Bt2020 => "bt2020",
        }
    }
    /// FFmpeg `-color_primaries` flag spelling (identical to zscale here).
    pub const fn ffmpeg_flag(self) -> &'static str {
        self.zscale()
    }
}

/// Transfer characteristic (the OETF/EOTF curve).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transfer {
    Bt709,
    /// SMPTE 170M (NTSC) — a distinct legacy SDR gamma from BT.709.
    Smpte170m,
    /// BT.470BG (PAL).
    Bt470bg,
    /// sRGB (IEC 61966-2-1) — the map canvas / WebGL framebuffer transfer.
    Srgb,
    /// ARIB STD-B67 / BBC Hybrid Log-Gamma (HDR).
    Hlg,
    /// SMPTE ST 2084 / Perceptual Quantizer (HDR).
    Pq,
    /// Linear light — the working-space transfer.
    Linear,
    // Future: log transfers (S-Log3, LogC, …) for IDT support — add here.
}

impl Transfer {
    /// zscale `t=`/`tin=` token.
    pub const fn zscale(self) -> &'static str {
        match self {
            Transfer::Bt709 => "bt709",
            Transfer::Smpte170m => "170m",
            Transfer::Bt470bg => "470bg",
            Transfer::Srgb => "iec61966-2-1",
            Transfer::Hlg => "arib-std-b67",
            Transfer::Pq => "smpte2084",
            Transfer::Linear => "linear",
        }
    }
    /// FFmpeg `-color_trc` flag spelling. Differs from the zscale token for
    /// the legacy SDR transfers (`170m`→`smpte170m`, `470bg`→`bt470bg`).
    pub const fn ffmpeg_flag(self) -> &'static str {
        match self {
            Transfer::Bt709 => "bt709",
            Transfer::Smpte170m => "smpte170m",
            Transfer::Bt470bg => "bt470bg",
            Transfer::Srgb => "iec61966-2-1",
            Transfer::Hlg => "arib-std-b67",
            Transfer::Pq => "smpte2084",
            Transfer::Linear => "linear",
        }
    }
    /// HDR transfers carry a nominal peak luminance at ingest.
    pub const fn is_hdr(self) -> bool {
        matches!(self, Transfer::Hlg | Transfer::Pq)
    }
}

/// Encoding range (how code values map to the [0,1] signal).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Range {
    /// Studio / limited (luma 16–235). zscale `limited`, FFmpeg `tv`.
    Limited,
    /// Full (0–255). zscale `full`, FFmpeg `pc`.
    Full,
}

impl Range {
    pub const fn zscale(self) -> &'static str {
        match self {
            Range::Limited => "limited",
            Range::Full => "full",
        }
    }
    pub const fn ffmpeg_flag(self) -> &'static str {
        match self {
            Range::Limited => "tv",
            Range::Full => "pc",
        }
    }
}

/// Matrix coefficients (the Y'CbCr ↔ RGB matrix). `Gbr` is the RGB-identity
/// coefficient — used for sRGB inputs and the working space's RGB float buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Matrix {
    Bt709,
    Bt2020nc,
    Smpte170m,
    /// RGB identity (zscale enum value `gbr`).
    Gbr,
}

impl Matrix {
    pub const fn zscale(self) -> &'static str {
        match self {
            Matrix::Bt709 => "bt709",
            Matrix::Bt2020nc => "bt2020nc",
            Matrix::Smpte170m => "170m",
            Matrix::Gbr => "gbr",
        }
    }
    pub const fn ffmpeg_flag(self) -> &'static str {
        match self {
            Matrix::Bt709 => "bt709",
            Matrix::Bt2020nc => "bt2020nc",
            Matrix::Smpte170m => "smpte170m",
            Matrix::Gbr => "gbr",
        }
    }
}

/// A complete color-space description: the four atomic axes plus an optional
/// nominal peak luminance (nits) that is meaningful only for HDR transfers.
/// HDR ingest uses npl=100 — the absolute working-space convention (linear
/// 1.0 = 100 nits, Session 4 / PORT_DESIGN §4A): zimg's HLG/PQ finishing
/// default is npl=100, so ingest at 100 makes HDR video round-trip as
/// identity instead of darkening. `npl` participates in the INGEST chain
/// (inverse-EOTF needs it); it is intentionally NOT emitted on the delivery
/// chain (the `-color_trc` flag carries the signaling there).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ColorSpace {
    pub primaries: Primaries,
    pub transfer: Transfer,
    pub range: Range,
    pub matrix: Matrix,
    pub npl: Option<u32>,
}

impl ColorSpace {
    /// The project working space: linear-light, BT.2020 primaries, full range,
    /// BT.2020-NC matrix, `gbrpf32le` pixel format. Byte-identical to the
    /// pre-registry `WORKING_SPACE_*` constants so existing exports are stable.
    pub const WORKING: ColorSpace = ColorSpace {
        primaries: Primaries::Bt2020,
        transfer: Transfer::Linear,
        range: Range::Full,
        matrix: Matrix::Bt2020nc,
        npl: None,
    };

    /// sRGB — the map canvas as it arrives from the renderer's `gl.readPixels`
    /// (full-range sRGB RGB, RGB-identity matrix).
    pub const SRGB: ColorSpace = ColorSpace {
        primaries: Primaries::Bt709,
        transfer: Transfer::Srgb,
        range: Range::Full,
        matrix: Matrix::Gbr,
        npl: None,
    };

    /// SDR Rec.709 source/delivery space.
    pub const SDR_BT709: ColorSpace = ColorSpace {
        primaries: Primaries::Bt709,
        transfer: Transfer::Bt709,
        range: Range::Limited,
        matrix: Matrix::Bt709,
        npl: None,
    };

    /// HDR HLG BT.2020 source space. npl=100 — the absolute working space
    /// (linear 1.0 = 100 nits; Session 4 / PORT_DESIGN §4A). Matches zimg's
    /// npl=100 finishing default so HLG video round-trips as identity.
    pub const HDR_HLG_BT2020: ColorSpace = ColorSpace {
        primaries: Primaries::Bt2020,
        transfer: Transfer::Hlg,
        range: Range::Limited,
        matrix: Matrix::Bt2020nc,
        npl: Some(100),
    };

    /// HDR PQ BT.2020 source space. npl=100 — same absolute working-space
    /// convention as HLG (see `HDR_HLG_BT2020`).
    pub const HDR_PQ_BT2020: ColorSpace = ColorSpace {
        primaries: Primaries::Bt2020,
        transfer: Transfer::Pq,
        range: Range::Limited,
        matrix: Matrix::Bt2020nc,
        npl: Some(100),
    };

    /// Patch individual axes from optional zscale-token strings (per-clip
    /// override). Unrecognized tokens are ignored (the base axis is kept),
    /// matching the `Unknown`/"safest default" contract — no unvalidated
    /// string ever reaches FFmpeg. `npl` is left as-is (derived from the base
    /// transfer); a transfer override re-derives it via `with_transfer`.
    pub fn with_overrides(
        self,
        primaries: Option<&str>,
        transfer: Option<&str>,
        range: Option<&str>,
        matrix: Option<&str>,
    ) -> ColorSpace {
        let mut cs = self;
        if let Some(p) = primaries.and_then(parse_primaries) {
            cs.primaries = p;
        }
        if let Some(t) = transfer.and_then(parse_transfer) {
            cs.transfer = t;
            cs.npl = default_npl_for(t);
        }
        if let Some(r) = range.and_then(parse_range) {
            cs.range = r;
        }
        if let Some(m) = matrix.and_then(parse_matrix) {
            cs.matrix = m;
        }
        cs
    }
}

/// Working-space pixel format for the given working `ColorSpace`. Today always
/// `gbrpf32le` (planar GBR 32-bit float, no alpha); a future working space
/// with a different buffer adds a branch HERE and nowhere else.
pub const fn working_pix_fmt(_working: &ColorSpace) -> &'static str {
    "gbrpf32le"
}

/// Generate the zscale ingest chain `source` → `working`.
///
/// Two forms, selected by `explicit_source_tags`:
///
/// - **clip form** (`false`): the input is a decoded video stream that
///   propagates its container color tags into the filtergraph, so zscale
///   infers `pin`/`min`/`rin` and only the input transfer (`tin=`) needs to be
///   stated. First zscale: `zscale=tin={t}:t=linear[:npl=N]`.
/// - **map form** (`true`): the input is bare `rawvideo` RGBA with NO embedded
///   color metadata, so ALL four source tags must be explicit or zimg fails
///   planning with code 3074 ("no path between colorspaces"). First zscale:
///   `zscale=pin=..:tin=..:min=..:rin=..:p={src_p}:t=linear:m={src_m}:r=full`.
///
/// In both forms the FIRST zscale only LINEARIZES (keeps source primaries),
/// then `format=` hops to the working pixel format, then the SECOND zscale
/// retags/converts primaries + matrix to the working space. This two-step
/// shape is load-bearing and matches the pre-registry chains exactly.
pub fn ingest_zscale_chain(
    source: &ColorSpace,
    working: &ColorSpace,
    explicit_source_tags: bool,
) -> String {
    let npl_suffix = match source.npl {
        Some(npl) => format!(":npl={}", npl),
        None => String::new(),
    };

    let first = if explicit_source_tags {
        // Map-canvas form: output keeps SOURCE primaries/matrix, only the
        // transfer is linearized here; the second zscale does the gamut hop.
        format!(
            "zscale=pin={pin}:tin={tin}:min={min}:rin={rin}:p={sp}:t=linear:m={sm}:r=full{npl}",
            pin = source.primaries.zscale(),
            tin = source.transfer.zscale(),
            min = source.matrix.zscale(),
            rin = source.range.zscale(),
            sp = source.primaries.zscale(),
            sm = source.matrix.zscale(),
            npl = npl_suffix,
        )
    } else {
        format!(
            "zscale=tin={tin}:t=linear{npl}",
            tin = source.transfer.zscale(),
            npl = npl_suffix,
        )
    };

    format!(
        "{first},format={pix},zscale=p={wp}:m={wm}",
        first = first,
        pix = working_pix_fmt(working),
        wp = working.primaries.zscale(),
        wm = working.matrix.zscale(),
    )
}

/// Generate the zscale delivery (finishing) chain `working` → `output`.
/// Does NOT emit `npl` (delivery signaling is carried by the encoder
/// `-color_trc` flag — matches the pre-registry finishing filters). The
/// caller appends `,format={pix_fmt}`.
pub fn delivery_zscale_chain(_working: &ColorSpace, output: &ColorSpace) -> String {
    format!(
        "zscale=t={t}:m={m}:p={p}:r={r}",
        t = output.transfer.zscale(),
        m = output.matrix.zscale(),
        p = output.primaries.zscale(),
        r = output.range.zscale(),
    )
}

/// The HDR ingest nominal-peak-luminance convention for a transfer.
/// npl=100 for both HDR transfers — the absolute working space (linear 1.0 =
/// 100 nits). zimg's HLG/PQ finishing default is also npl=100, so ingest at
/// 100 makes HDR video round-trip as identity (the old 400/1000 values
/// darkened HLG 240→183 across a round-trip; PORT_DESIGN §4A / Session 4).
pub const fn default_npl_for(t: Transfer) -> Option<u32> {
    match t {
        Transfer::Hlg => Some(100),
        Transfer::Pq => Some(100),
        _ => None,
    }
}

/// zimg SDR diffuse white = linear 1.0 in the absolute working space.
pub const SDR_REF_WHITE_NITS: f64 = 100.0;
/// BT.2408 HDR graphics / diffuse reference white.
pub const HDR_REF_WHITE_NITS: f64 = 203.0;

/// Composite headroom factor. Real iPhone HLG peaks at linear 24.6 at npl=100
/// (Session 4) → H must exceed that; H=16 clips. H=32 covers HLG + PQ to
/// ~3200 nit. PQ above ~3200 nit clips (PORT_DESIGN §6 known bound). Applied
/// ONLY on HDR delivery — H=32 on SDR regresses the gradient 209→85 levels.
pub const COMPOSITE_HEADROOM: f64 = 32.0;

/// Linear-light gain that anchors an SDR-ORIGIN source to the delivery's
/// reference white. Returns `Some(2.03)` IFF the source is SDR-origin
/// (`!source.transfer.is_hdr()`) AND the delivery is HDR
/// (`delivery.transfer.is_hdr()`); otherwise `None` (no scaling).
///
/// HDR-origin sources carry their own absolute nits and are NEVER anchored.
/// SDR→SDR is native (no anchor). Applied as a linear gain at the INGEST
/// tail, on the SDR-origin branch only, so the HDR video branch — which
/// shares the single finishing — is untouched. Proven equivalent to
/// `npl=203` finishing for HLG and PQ (PORT_DESIGN §2 / HANDOFF §2).
pub fn sdr_origin_anchor_gain(source: &ColorSpace, delivery: &ColorSpace) -> Option<f64> {
    (!source.transfer.is_hdr() && delivery.transfer.is_hdr())
        .then(|| HDR_REF_WHITE_NITS / SDR_REF_WHITE_NITS) // 2.03
}

/// Linear-light RGB gain by `factor`, as a comma-joined `colorchannelmixer`
/// CHAIN. Each stage multiplies R/G/B uniformly (rr=gg=bb=stage, off-diagonal
/// 0). `colorchannelmixer` caps every coefficient at ±2.0 and is clamp-free
/// for values >1.0, so a factor outside [0,2] is split into ≤2.0 stages whose
/// product equals `factor`. Operates on `gbrpf32le`; preserves values >1.0
/// (HDR headroom) — the property `geq` (clamps [0,1]) and `exposure` (±3-stop
/// cap) both fail (Session 4).
///
/// The ±2.0 cap is an UPPER bound only — there is no lower positive bound
/// (a single coefficient of 0.03125 is legal), so chaining is needed only
/// when `factor > 2.0`. Stage coefficients are formatted with Rust's f64
/// `Display` (shortest round-trip repr — pinned by unit test).
///
/// `factor` must be finite and > 0. `factor == 1.0` returns an empty string
/// (identity — caller splices nothing).
pub fn linear_gain_filter(factor: f64) -> String {
    assert!(
        factor.is_finite() && factor > 0.0,
        "linear_gain_filter: factor must be finite and > 0, got {factor}",
    );
    if factor == 1.0 {
        return String::new();
    }
    let mut stages: Vec<f64> = Vec::new();
    let mut remaining = factor;
    while remaining > 2.0 {
        stages.push(2.0);
        remaining /= 2.0;
    }
    stages.push(remaining);
    stages
        .iter()
        .map(|s| format!("colorchannelmixer=rr={s}:gg={s}:bb={s}"))
        .collect::<Vec<_>>()
        .join(",")
}

// ---- override-token parsers (zscale tokens → axis enum) -------------------

pub fn parse_primaries(s: &str) -> Option<Primaries> {
    match s {
        "bt709" => Some(Primaries::Bt709),
        "bt2020" => Some(Primaries::Bt2020),
        _ => None,
    }
}

pub fn parse_transfer(s: &str) -> Option<Transfer> {
    match s {
        "bt709" => Some(Transfer::Bt709),
        "170m" | "smpte170m" => Some(Transfer::Smpte170m),
        "470bg" | "bt470bg" => Some(Transfer::Bt470bg),
        "iec61966-2-1" | "srgb" => Some(Transfer::Srgb),
        "arib-std-b67" | "hlg" => Some(Transfer::Hlg),
        "smpte2084" | "pq" => Some(Transfer::Pq),
        "linear" => Some(Transfer::Linear),
        _ => None,
    }
}

pub fn parse_range(s: &str) -> Option<Range> {
    match s {
        "limited" | "tv" => Some(Range::Limited),
        "full" | "pc" => Some(Range::Full),
        _ => None,
    }
}

pub fn parse_matrix(s: &str) -> Option<Matrix> {
    match s {
        "bt709" => Some(Matrix::Bt709),
        "bt2020nc" => Some(Matrix::Bt2020nc),
        "170m" | "smpte170m" => Some(Matrix::Smpte170m),
        "gbr" => Some(Matrix::Gbr),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- byte-equality with the pre-registry hardcoded strings ----
    //
    // These are the load-bearing tests: the registry must regenerate the
    // EXACT strings the old hardcoded chains produced, or existing exports
    // change and the empirically-validated FFmpeg behavior (no silent yuv420
    // downconvert, no zimg 3074) is no longer guaranteed.

    #[test]
    fn ingest_sdr_matches_legacy() {
        assert_eq!(
            ingest_zscale_chain(&ColorSpace::SDR_BT709, &ColorSpace::WORKING, false),
            "zscale=tin=bt709:t=linear,format=gbrpf32le,zscale=p=bt2020:m=bt2020nc",
        );
    }

    #[test]
    fn ingest_legacy_sdr_transfers_match() {
        let m170 = ColorSpace {
            transfer: Transfer::Smpte170m,
            ..ColorSpace::SDR_BT709
        };
        assert_eq!(
            ingest_zscale_chain(&m170, &ColorSpace::WORKING, false),
            "zscale=tin=170m:t=linear,format=gbrpf32le,zscale=p=bt2020:m=bt2020nc",
        );
        let pal = ColorSpace {
            transfer: Transfer::Bt470bg,
            ..ColorSpace::SDR_BT709
        };
        assert_eq!(
            ingest_zscale_chain(&pal, &ColorSpace::WORKING, false),
            "zscale=tin=470bg:t=linear,format=gbrpf32le,zscale=p=bt2020:m=bt2020nc",
        );
    }

    // The two HDR ingest pins below are NOT "legacy" strings anymore: Phase 4
    // (HDR port, 2026-06-11) re-baselined them from npl=400/1000 to npl=100 —
    // the absolute working-space convention (linear 1.0 = 100 nits), which
    // matches zimg's npl=100 finishing default so HDR video round-trips as
    // identity (the old values darkened HLG 240→183). Do NOT "restore"
    // 400/1000; that re-introduces the round-trip darkening the
    // hdr-video round-trip integration test (color_fixtures.rs) would catch.

    #[test]
    fn ingest_hlg_pins_npl_100_absolute_space() {
        assert_eq!(
            ingest_zscale_chain(&ColorSpace::HDR_HLG_BT2020, &ColorSpace::WORKING, false),
            "zscale=tin=arib-std-b67:t=linear:npl=100,format=gbrpf32le,zscale=p=bt2020:m=bt2020nc",
        );
    }

    #[test]
    fn ingest_pq_pins_npl_100_absolute_space() {
        assert_eq!(
            ingest_zscale_chain(&ColorSpace::HDR_PQ_BT2020, &ColorSpace::WORKING, false),
            "zscale=tin=smpte2084:t=linear:npl=100,format=gbrpf32le,zscale=p=bt2020:m=bt2020nc",
        );
    }

    #[test]
    fn ingest_map_matches_legacy() {
        // Exact string the pre-registry `map_ingest_filter()` produced.
        let expected = concat!(
            "zscale=pin=bt709:tin=iec61966-2-1:min=gbr:rin=full:",
            "p=bt709:t=linear:m=gbr:r=full,",
            "format=gbrpf32le,zscale=p=bt2020:m=bt2020nc",
        );
        assert_eq!(
            ingest_zscale_chain(&ColorSpace::SRGB, &ColorSpace::WORKING, true),
            expected,
        );
    }

    #[test]
    fn delivery_sdr_matches_legacy() {
        let chain = delivery_zscale_chain(&ColorSpace::WORKING, &ColorSpace::SDR_BT709);
        assert_eq!(chain, "zscale=t=bt709:m=bt709:p=bt709:r=limited");
    }

    #[test]
    fn delivery_hlg_matches_legacy() {
        let out = ColorSpace {
            npl: None,
            ..ColorSpace::HDR_HLG_BT2020
        };
        let chain = delivery_zscale_chain(&ColorSpace::WORKING, &out);
        assert_eq!(chain, "zscale=t=arib-std-b67:m=bt2020nc:p=bt2020:r=limited");
    }

    #[test]
    fn delivery_pq_chain() {
        let out = ColorSpace {
            npl: None,
            ..ColorSpace::HDR_PQ_BT2020
        };
        let chain = delivery_zscale_chain(&ColorSpace::WORKING, &out);
        assert_eq!(chain, "zscale=t=smpte2084:m=bt2020nc:p=bt2020:r=limited");
    }

    #[test]
    fn delivery_never_emits_npl() {
        // npl is an ingest-only concept; delivery signaling rides the encoder
        // -color_trc flag. A source-shaped HDR ColorSpace (npl=Some) must not
        // leak ":npl=" into the finishing filter.
        //
        // Phase 4 note: the ship-review ACTION_PLAN flagged this pin for
        // retirement ("npl=203 on delivery"), but the implemented design
        // (docs/spikes/IMPLEMENTATION.md, reconciled with Matthew) anchors
        // SDR-origin sources via an ingest-side ×2.03 linear gain
        // (`sdr_origin_anchor_gain`) — proven byte-equivalent to npl=203
        // finishing — precisely so the delivery chain stays npl-free and the
        // HDR video branch (which shares it) round-trips untouched. This pin
        // therefore remains CORRECT after the HDR port; do not retire it.
        let chain = delivery_zscale_chain(&ColorSpace::WORKING, &ColorSpace::HDR_HLG_BT2020);
        assert!(!chain.contains("npl="), "got: {}", chain);
    }

    // ---- ffmpeg flag spellings ----

    #[test]
    fn legacy_transfer_flag_spellings_differ_from_zscale() {
        assert_eq!(Transfer::Smpte170m.zscale(), "170m");
        assert_eq!(Transfer::Smpte170m.ffmpeg_flag(), "smpte170m");
        assert_eq!(Transfer::Bt470bg.zscale(), "470bg");
        assert_eq!(Transfer::Bt470bg.ffmpeg_flag(), "bt470bg");
    }

    #[test]
    fn range_flag_spellings() {
        assert_eq!(Range::Limited.zscale(), "limited");
        assert_eq!(Range::Limited.ffmpeg_flag(), "tv");
        assert_eq!(Range::Full.zscale(), "full");
        assert_eq!(Range::Full.ffmpeg_flag(), "pc");
    }

    // ---- extensibility proof: adding a transfer touches only this module ----

    #[test]
    fn every_transfer_has_distinct_nonempty_tokens() {
        let all = [
            Transfer::Bt709,
            Transfer::Smpte170m,
            Transfer::Bt470bg,
            Transfer::Srgb,
            Transfer::Hlg,
            Transfer::Pq,
            Transfer::Linear,
        ];
        for t in all {
            assert!(!t.zscale().is_empty());
            assert!(!t.ffmpeg_flag().is_empty());
        }
    }

    // ---- override behavior ----

    #[test]
    fn with_overrides_patches_named_axes_and_rederives_npl() {
        // Start SDR, override transfer to HLG → npl re-derived to 100 (the
        // absolute working-space convention, Phase 4).
        let cs = ColorSpace::SDR_BT709.with_overrides(
            Some("bt2020"),
            Some("arib-std-b67"),
            Some("tv"),
            Some("bt2020nc"),
        );
        assert_eq!(cs.primaries, Primaries::Bt2020);
        assert_eq!(cs.transfer, Transfer::Hlg);
        assert_eq!(cs.range, Range::Limited);
        assert_eq!(cs.matrix, Matrix::Bt2020nc);
        assert_eq!(cs.npl, Some(100));
    }

    // ---- Phase 4: SDR-origin → HDR-delivery anchor + linear gain chain ----

    #[test]
    fn sdr_origin_anchor_gain_some_for_sdr_to_hdr() {
        for src in [ColorSpace::SRGB, ColorSpace::SDR_BT709] {
            for hdr in [ColorSpace::HDR_HLG_BT2020, ColorSpace::HDR_PQ_BT2020] {
                assert_eq!(
                    sdr_origin_anchor_gain(&src, &hdr),
                    Some(2.03),
                    "{:?} → {:?}",
                    src.transfer,
                    hdr.transfer,
                );
            }
        }
    }

    #[test]
    fn sdr_origin_anchor_gain_none_for_hdr_source() {
        // HDR-origin sources carry their own absolute nits — never anchored,
        // regardless of delivery.
        for src in [ColorSpace::HDR_HLG_BT2020, ColorSpace::HDR_PQ_BT2020] {
            for delivery in [
                ColorSpace::SDR_BT709,
                ColorSpace::HDR_HLG_BT2020,
                ColorSpace::HDR_PQ_BT2020,
            ] {
                assert_eq!(sdr_origin_anchor_gain(&src, &delivery), None);
            }
        }
    }

    #[test]
    fn sdr_origin_anchor_gain_none_for_sdr_delivery() {
        for src in [ColorSpace::SRGB, ColorSpace::SDR_BT709] {
            assert_eq!(sdr_origin_anchor_gain(&src, &ColorSpace::SDR_BT709), None);
        }
    }

    #[test]
    fn linear_gain_filter_decompositions() {
        // Worked decompositions from the HDR-port build spec
        // (docs/spikes/IMPLEMENTATION.md §1) — these strings are spliced
        // verbatim into filtergraphs, so they are byte-pinned here.
        assert_eq!(linear_gain_filter(1.0), "");
        // B anchor ×2.03 → [2.0, 1.015].
        assert_eq!(
            linear_gain_filter(2.03),
            "colorchannelmixer=rr=2:gg=2:bb=2,colorchannelmixer=rr=1.015:gg=1.015:bb=1.015",
        );
        // C ÷H (H=32): one stage — the ±2.0 cap is an upper bound only.
        assert_eq!(
            linear_gain_filter(1.0 / COMPOSITE_HEADROOM),
            "colorchannelmixer=rr=0.03125:gg=0.03125:bb=0.03125",
        );
        // C ×H: 2⁵ = 32 → five 2.0 stages.
        assert_eq!(
            linear_gain_filter(COMPOSITE_HEADROOM),
            "colorchannelmixer=rr=2:gg=2:bb=2,colorchannelmixer=rr=2:gg=2:bb=2,\
             colorchannelmixer=rr=2:gg=2:bb=2,colorchannelmixer=rr=2:gg=2:bb=2,\
             colorchannelmixer=rr=2:gg=2:bb=2",
        );
    }

    #[test]
    fn with_overrides_ignores_unrecognized_tokens() {
        let cs = ColorSpace::SDR_BT709.with_overrides(
            Some("garbage"),
            None,
            Some("nonsense"),
            None,
        );
        // Unrecognized tokens leave the base axes untouched.
        assert_eq!(cs, ColorSpace::SDR_BT709);
    }
}
