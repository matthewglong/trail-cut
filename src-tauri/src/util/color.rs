// Source-color classification — the single decision point every downstream
// ingest formula (WS1 proxy, WS2 thumbnail, WS3 export working-space) branches
// on.
//
// WS0 (this module) is intentionally narrow: a typed enum, a plain metadata
// struct, and one pure `classify()` function. No I/O, no ffprobe coupling, no
// log-format heuristics. ffprobe lives in `crate::export::ffprobe`; the import
// pipeline (`commands::media`) is responsible for shuttling probed metadata
// into `ColorMetadata` and calling `classify()`.
//
// Phase 2 (log formats) extends the enum with `DLog`, `CLog`, `CLog2`,
// `CLog3`, `GpLog`, `VLog`, `SLog2`, `SLog3` variants; those are defined here
// already so the on-disk wire format and the serde rename map stay stable as
// new variants come online. `classify()` never returns a log variant in Phase
// 1 — log detection requires a user override (see ARCHITECTURE.md §"Phase 2
// additions": "Auto-detect HDR, manually declare log").
//
// WS10 adds the log-development side of that wire: when `effective_color_class()`
// returns a log variant, `ingest_filter_for()` produces an `lut3d`-led filter
// chain that applies the bundled vendor LUT (DJI / GoPro / Canon) and then
// lands in the working space. The bundled LUTs themselves live under
// `src-tauri/resources/luts/` — see that directory's README for licensing
// notes and which slots ship real LUTs vs placeholders. When a slot ships
// only a placeholder, the chain falls back to the SDR-Rec.709 ingest so
// existing behaviour (flat/gray but watchable) is preserved.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::OnceLock;

use crate::util::color_space::{
    ingest_zscale_chain, working_pix_fmt, ColorSpace, Transfer,
};

// ---------------------------------------------------------------------------
// Working-space contract (WS3 — working-space architecture in export).
//
// Every clip and the map both land in this regime before any concat or
// overlay happens. The boundary is documented in
// `docs/color-pipeline/ARCHITECTURE.md` §"Working space definition":
//
//     | Color model | Linear-light RGB                         |
//     | Primaries   | BT.2020                                  |
//     | Transfer    | Linear                                   |
//     | Range       | Full                                     |
//     | Pixel fmt   | gbrpf32le (planar GBR float, no alpha)   |
//     | Bit depth   | 32-bit float                             |
//
// Downstream WS4 (delivery transforms) takes the working space and applies
// `[working] zscale=t=bt709:m=bt709:p=bt709:r=limited, format=yuv420p` style
// finishing chains per target. The constants and helpers below are the
// single seam that WS3 and WS4 agree on.
// ---------------------------------------------------------------------------

// These three constants are kept as the names the rest of the backend reaches
// for, but they are now DERIVED from the atomic-axes registry
// (`ColorSpace::WORKING`) rather than free-standing literals — the registry is
// the single source of truth. Adding/changing the working space is a registry
// edit; these aliases follow automatically.

/// FFmpeg `format=…` pixel format used everywhere inside the working space.
/// Planar GBR, 32-bit float per channel, little-endian. No alpha — composite
/// transparency lives elsewhere (final delivery transforms, mask compositing
/// via a parallel chain). Chosen so HDR sources (HLG, PQ) sit comfortably
/// without crushing range and SDR sources sit without distortion.
pub const WORKING_SPACE_PIX_FMT: &str = working_pix_fmt(&ColorSpace::WORKING);

/// zscale `p=…` (primaries) argument for the working space. BT.2020 wide
/// gamut so HDR delivery comes for free from any project.
pub const WORKING_SPACE_PRIMARIES: &str = ColorSpace::WORKING.primaries.zscale();

/// zscale `m=…` (matrix coefficients) argument for the working space.
/// `bt2020nc` — non-constant luminance. Mate to `WORKING_SPACE_PRIMARIES`.
pub const WORKING_SPACE_MATRIX: &str = ColorSpace::WORKING.matrix.zscale();

/// FFmpeg filter chain that brings a clip with the given source color class
/// into the working space (linear-light, BT.2020 primaries, `gbrpf32le`).
/// Per the ingest-formula table in ARCHITECTURE.md §"Ingest formulas (Phase
/// 1)".
///
/// The returned chain is a comma-joined filter expression ready to splice
/// after the per-clip `crop`/`scale` chain, before whatever per-clip label
/// the caller emits. It does NOT include leading/trailing commas — callers
/// concatenate with `,{ingest_filter_for(class, source_trc)}`.
///
/// HDR variants use `tin=…` (input transfer) explicitly because some HDR
/// sources arrive with stripped or wrong transfer tags; setting `tin` makes
/// the inverse-EOTF deterministic. `npl` is the nominal peak luminance —
/// 400 nits for HLG (typical broadcast reference), 1000 nits for PQ
/// (canonical reference white).
///
/// `source_trc` is the original `color_transfer` string from ffprobe (e.g.
/// `"bt709"`, `"smpte170m"`, `"bt470bg"`). It is consulted **only** on the
/// SDR branch — the `classify()` function collapses `bt709`, `smpte170m`
/// (NTSC) and `bt470bg` (PAL) all into `SdrBt709`, but those three transfer
/// curves are spec'd differently. SMPTE 170M and BT.470BG carry slightly
/// different (older) gammas; zscale recognises them as distinct `tin=` values
/// (`170m`, `470bg`). Using `tin=bt709` on a `smpte170m` source applies the
/// wrong inverse EOTF and introduces a small but real color error in working
/// space. iPhone (the primary target) tags itself as `bt709` and is
/// unaffected; real-world impact is on older DJI / GoPro / Sony / camcorder
/// footage with legacy SDR tags. For HDR / DV / log variants the
/// `source_trc` argument is ignored — those have unambiguous expected
/// transfers handled in their own arms.
///
/// Phase 2 log variants (WS10) route through `lut3d` with a bundled
/// vendor LUT (DJI / GoPro / Canon) before the SDR-linearise + retag tail.
/// When a slot ships only a placeholder (`bundled_lut_path` returns
/// `None`), the variant falls back to the SDR-Rec.709 chain so the
/// pipeline still produces watchable output. Sony S-Log2/S-Log3 and
/// Panasonic V-Log have no bundled LUT today and always take the
/// fallback path — those are a separate workstream when those users
/// request it.
pub fn ingest_filter_for(class: SourceColorClass, source_trc: Option<&str>) -> String {
    ingest_filter_into(class, source_trc, &ColorSpace::WORKING)
}

/// Working-space-parameterized form of [`ingest_filter_for`]. The pipeline's
/// working space is a project-level value (see `Project::working_color_space`,
/// schema v9); today it always resolves to [`ColorSpace::WORKING`], but every
/// generator threads it explicitly so a future non-default working space is a
/// model change, not a filtergraph rewrite.
///
/// All per-class color knowledge now flows through the registry generator
/// [`ingest_zscale_chain`] — the only per-class logic left here is (a) which
/// source [`ColorSpace`] a class maps to and (b) the `lut3d` development
/// prefix for log variants. The legacy hardcoded zscale strings are gone.
pub fn ingest_filter_into(
    class: SourceColorClass,
    source_trc: Option<&str>,
    working: &ColorSpace,
) -> String {
    // SDR (and `Unknown`) ingest, honoring the legacy-transfer disambiguation
    // (smpte170m → tin=170m, bt470bg → tin=470bg) via `source_color_space_for`.
    let sdr_chain =
        || ingest_zscale_chain(&source_color_space_for(SourceColorClass::SdrBt709, source_trc), working, false);

    // `lut3d` development tail: every vendor LUT converts log → BT.709 SDR
    // (full-range internally), so after the LUT the chain is the plain SDR
    // ingest (`tin=bt709` — legacy hints don't apply to the LUT's output).
    // Centralised so the LUT-vs-SDR fallback only diverges at the single
    // `bundled_lut_path` point.
    let lut_chain = |bundled: BundledLut| match bundled_lut_path(bundled) {
        Some(path) => format!(
            "lut3d='{lut}',{tail}",
            lut = escape_lut3d_filename(&path.to_string_lossy()),
            tail = ingest_zscale_chain(&ColorSpace::SDR_BT709, working, false),
        ),
        // No usable LUT (file missing or placeholder) — fall back to SDR so
        // the pipeline still produces a frame. Matches the Phase 1 behaviour
        // the WS10 brief asks us to preserve as a graceful-degradation floor.
        None => sdr_chain(),
    };

    match class {
        // Dolby Vision collapses to its HLG base layer in Phase 1 (the RPU is
        // discarded — nothing here reads it), so it shares the HLG source space.
        SourceColorClass::HlgBt2020 | SourceColorClass::DolbyVision => {
            ingest_zscale_chain(&ColorSpace::HDR_HLG_BT2020, working, false)
        }
        SourceColorClass::PqBt2020 => {
            ingest_zscale_chain(&ColorSpace::HDR_PQ_BT2020, working, false)
        }
        SourceColorClass::SdrBt709 | SourceColorClass::Unknown => sdr_chain(),
        // ---- Phase 2 log variants ----
        SourceColorClass::DLog => lut_chain(BundledLut::DjiDLog),
        SourceColorClass::GpLog => lut_chain(BundledLut::GoProProtune),
        SourceColorClass::CLog => lut_chain(BundledLut::CanonCLog),
        SourceColorClass::CLog2 => lut_chain(BundledLut::CanonCLog2),
        SourceColorClass::CLog3 => lut_chain(BundledLut::CanonCLog3),
        // Sony S-Log2 / S-Log3 and Panasonic V-Log: no bundled LUT in scope
        // for WS10. Fall back to the SDR chain — the WS9 UI surfaces this as
        // "no LUT bundled, footage will look flat".
        SourceColorClass::VLog | SourceColorClass::SLog2 | SourceColorClass::SLog3 => sdr_chain(),
    }
}

/// Map a coarse [`SourceColorClass`] (+ the original ffprobe `color_transfer`
/// hint) onto the atomic-axes [`ColorSpace`] the export pipeline ingests from.
///
/// This is the seam between the legacy coarse-label world (`SourceColorClass`,
/// still used for the UI, log-LUT routing, and camera-preset hints) and the
/// atomic-axes pipeline. HDR classes map to their canonical source spaces; the
/// SDR family (and log variants, which develop to BT.709 SDR) disambiguate the
/// legacy transfer via `source_trc` so SMPTE 170M / BT.470BG sources get the
/// correct inverse EOTF.
pub fn source_color_space_for(class: SourceColorClass, source_trc: Option<&str>) -> ColorSpace {
    match class {
        SourceColorClass::HlgBt2020 | SourceColorClass::DolbyVision => ColorSpace::HDR_HLG_BT2020,
        SourceColorClass::PqBt2020 => ColorSpace::HDR_PQ_BT2020,
        // SDR family + log variants (treated as BT.709 SDR after development /
        // fallback). The three legacy SDR transfers carry distinct gammas.
        _ => {
            let transfer = match source_trc {
                Some("smpte170m") => Transfer::Smpte170m,
                Some("bt470bg") => Transfer::Bt470bg,
                _ => Transfer::Bt709,
            };
            ColorSpace {
                transfer,
                ..ColorSpace::SDR_BT709
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Bundled LUT slots (WS10).
//
// Each variant maps to a single `.cube` file under `src-tauri/resources/luts/`.
// The LUT bytes are embedded at compile time via `include_bytes!` — same
// pattern as `SRGB_ICC_BYTES` in `commands::ffmpeg` — so the binary is
// self-contained and runtime LUT resolution never has to hit a Tauri
// resource-path lookup.
//
// Licensing reality: most vendor LUTs (DJI / GoPro / Canon) have EULAs that
// don't unambiguously permit redistribution as part of a third-party app
// binary. The slots are therefore initially populated with **placeholder
// files** — a single-comment-line `.cube` that the runtime validator
// rejects, causing `ingest_filter_for()` to fall back to the SDR-Rec.709
// chain (matches Phase 1 behaviour). See
// `src-tauri/resources/luts/README.md` for the per-vendor licensing
// posture and how users building from source can drop in a properly-
// licensed LUT.
// ---------------------------------------------------------------------------

/// Catalog of bundled `.cube` LUT slots, one per `SourceColorClass` log
/// variant that ships a vendor LUT today. Variants intentionally don't cover
/// V-Log / S-Log* — those are out of WS10 scope and stay on the SDR
/// fallback in `ingest_filter_for`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BundledLut {
    DjiDLog,
    GoProProtune,
    CanonCLog,
    CanonCLog2,
    CanonCLog3,
}

impl BundledLut {
    /// On-disk filename (under `src-tauri/resources/luts/`). Also the
    /// temp-file basename, so `$TMPDIR/trailcut-luts/{filename}` is
    /// the materialised path.
    fn filename(self) -> &'static str {
        match self {
            BundledLut::DjiDLog => "DJI_DLog_to_Rec709.cube",
            BundledLut::GoProProtune => "GoPro_Protune_to_Rec709.cube",
            BundledLut::CanonCLog => "Canon_CLog_to_Rec709.cube",
            BundledLut::CanonCLog2 => "Canon_CLog2_to_Rec709.cube",
            BundledLut::CanonCLog3 => "Canon_CLog3_to_Rec709.cube",
        }
    }

    /// Compile-time-embedded bytes for this slot. `include_bytes!` requires
    /// the file to exist at build time; placeholder files are tracked in
    /// `src-tauri/resources/luts/` so the build never breaks. The runtime
    /// `is_real_cube_lut` check is what distinguishes a real LUT from a
    /// placeholder.
    fn embedded_bytes(self) -> &'static [u8] {
        match self {
            BundledLut::DjiDLog => include_bytes!("../../resources/luts/DJI_DLog_to_Rec709.cube"),
            BundledLut::GoProProtune => {
                include_bytes!("../../resources/luts/GoPro_Protune_to_Rec709.cube")
            }
            BundledLut::CanonCLog => {
                include_bytes!("../../resources/luts/Canon_CLog_to_Rec709.cube")
            }
            BundledLut::CanonCLog2 => {
                include_bytes!("../../resources/luts/Canon_CLog2_to_Rec709.cube")
            }
            BundledLut::CanonCLog3 => {
                include_bytes!("../../resources/luts/Canon_CLog3_to_Rec709.cube")
            }
        }
    }
}

/// Heuristic: does this byte slice look like a real Adobe Cube LUT, or
/// is it the placeholder comment we ship by default? `lut3d` requires a
/// `LUT_3D_SIZE` header line; a placeholder is a `#`-prefixed comment
/// with no header. We also require a minimum byte length to defend
/// against truncated files. Cheap (linear scan over a few KB max),
/// runs once per slot on first use thanks to the `OnceLock` cache.
fn is_real_cube_lut(bytes: &[u8]) -> bool {
    // 32-byte floor — even the smallest legitimate 2³ LUT header
    // (`LUT_3D_SIZE 2\n` + 8 RGB rows) is comfortably bigger than this.
    // Our placeholder files are ~70 bytes of comment with no header line,
    // so the header check is what actually disqualifies them; the length
    // gate just rules out empty / zero-byte files outright.
    if bytes.len() < 32 {
        return false;
    }
    // Adobe Cube spec: `LUT_3D_SIZE N` must appear as a non-comment
    // line in the header. Scan line-by-line so a `# LUT_3D_SIZE` in a
    // comment doesn't trip the check.
    let text = match std::str::from_utf8(bytes) {
        Ok(t) => t,
        Err(_) => return false,
    };
    text.lines().any(|line| {
        let trimmed = line.trim_start();
        !trimmed.starts_with('#') && trimmed.starts_with("LUT_3D_SIZE")
    })
}

/// Materialise the bundled `.cube` to `$TMPDIR/trailcut-luts/{filename}`
/// on first use, return the resulting path so `lut3d='{path}'` can find
/// it. Caches per slot (each `OnceLock` is independent), so repeated
/// `ingest_filter_for` calls during a single export are free.
///
/// Returns `None` when the embedded bytes don't look like a real LUT
/// (placeholder file shipped by default) or the temp-file write fails.
/// Callers (the per-class arms of `ingest_filter_for`) treat `None` as
/// "use the SDR fallback chain instead."
fn bundled_lut_path(lut: BundledLut) -> Option<&'static PathBuf> {
    // One `OnceLock` per slot. Holds `Option<PathBuf>` so the
    // placeholder / write-failure cases cache as `None` and we don't
    // retry the temp write on every call.
    static DJI_DLOG: OnceLock<Option<PathBuf>> = OnceLock::new();
    static GOPRO: OnceLock<Option<PathBuf>> = OnceLock::new();
    static CANON_CLOG: OnceLock<Option<PathBuf>> = OnceLock::new();
    static CANON_CLOG2: OnceLock<Option<PathBuf>> = OnceLock::new();
    static CANON_CLOG3: OnceLock<Option<PathBuf>> = OnceLock::new();
    let slot = match lut {
        BundledLut::DjiDLog => &DJI_DLOG,
        BundledLut::GoProProtune => &GOPRO,
        BundledLut::CanonCLog => &CANON_CLOG,
        BundledLut::CanonCLog2 => &CANON_CLOG2,
        BundledLut::CanonCLog3 => &CANON_CLOG3,
    };
    slot.get_or_init(|| {
        let bytes = lut.embedded_bytes();
        if !is_real_cube_lut(bytes) {
            // Placeholder file. Don't touch the filesystem — the
            // caller's fallback handles "no LUT for this slot".
            return None;
        }
        let mut dir = std::env::temp_dir();
        dir.push("trailcut-luts");
        if let Err(e) = std::fs::create_dir_all(&dir) {
            eprintln!(
                "lut3d: failed to create temp LUT dir {}: {}",
                dir.display(),
                e
            );
            return None;
        }
        let path = dir.join(lut.filename());
        // Re-write on every fresh process boot so a partial / truncated
        // write from a prior crash gets replaced. LUT contents are
        // deterministic (compile-time const).
        match std::fs::write(&path, bytes) {
            Ok(()) => Some(path),
            Err(e) => {
                eprintln!(
                    "lut3d: failed to materialise {} at {}: {}",
                    lut.filename(),
                    path.display(),
                    e
                );
                None
            }
        }
    })
    .as_ref()
}

/// Escape special characters in a path so it can be embedded inside a
/// `lut3d='...'` filter argument. FFmpeg's filtergraph parser treats `\`
/// and `'` as escape / quote characters even inside single-quoted strings,
/// and `:` is the filter-option separator. macOS paths shouldn't normally
/// contain any of those, but `$TMPDIR` on some setups (e.g. per-user
/// sandboxed dirs) can include unusual characters — better to escape
/// defensively than ship a filter chain that fails to parse.
fn escape_lut3d_filename(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for ch in path.chars() {
        match ch {
            '\\' | '\'' | ':' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

/// Map a log `SourceColorClass` to the `BundledLut` slot we ship for it,
/// or `None` if no slot exists (V-Log / S-Log* — out of WS10 scope) or
/// the class isn't a log variant at all.
fn bundled_lut_for_class(class: SourceColorClass) -> Option<BundledLut> {
    match class {
        SourceColorClass::DLog => Some(BundledLut::DjiDLog),
        SourceColorClass::GpLog => Some(BundledLut::GoProProtune),
        SourceColorClass::CLog => Some(BundledLut::CanonCLog),
        SourceColorClass::CLog2 => Some(BundledLut::CanonCLog2),
        SourceColorClass::CLog3 => Some(BundledLut::CanonCLog3),
        SourceColorClass::VLog | SourceColorClass::SLog2 | SourceColorClass::SLog3 => None,
        _ => None,
    }
}

/// Public surface for WS1 (proxy) / WS2 (thumbnail): if `class` is a log
/// variant with a real bundled LUT, return the single `lut3d='...'`
/// filter that develops log → BT.709 SDR. Callers splice this into the
/// front of their per-class filtergraph (after `scale`, before the
/// `format=yuv420p` tail) so the proxy / thumbnail comes out tone-mapped
/// rather than flat.
///
/// Returns `None` when:
///   - `class` is not a log variant (SDR / HDR — no LUT development needed).
///   - `class` is a log variant with no bundled LUT (V-Log / S-Log*).
///   - `class` is a log variant whose slot ships only a placeholder
///     (DJI / GoPro / Canon today — see `resources/luts/README.md`).
///
/// In every `None` case the caller's existing SDR / HDR branch is the
/// correct fallback — same shape as Phase 1 behaviour for log variants.
pub fn log_development_lut_prefix(class: SourceColorClass) -> Option<String> {
    let slot = bundled_lut_for_class(class)?;
    let path = bundled_lut_path(slot)?;
    Some(format!(
        "lut3d='{}'",
        escape_lut3d_filename(&path.to_string_lossy())
    ))
}

/// FFmpeg filter chain that brings the map canvas (raw RGBA8 from the
/// renderer worker's `gl.readPixels()` — full-range sRGB by WebGL
/// convention) into the working space.
///
/// Per ARCHITECTURE.md §"Map ingest formula": same logical operation as
/// `F_ingest_sdr`, but starting from sRGB full-range RGB rather than
/// BT.709 limited Y'CbCr. `tin=iec61966-2-1` is the canonical zscale
/// transfer name for sRGB; `rin=full` forces full-range interpretation so
/// the map's whites stay white rather than getting clipped through a
/// limited-range assumption.
///
/// Both ends of the first zscale (input AND output) declare full
/// primaries / transfer / matrix / range — load-bearing in a way the
/// per-clip `ingest_filter_for()` chains aren't. The asymmetry is real:
/// video stream inputs propagate container color tags into the
/// filtergraph and zimg infers any unspecified zscale option from those;
/// the map canvas arrives as bare `rawvideo` RGBA with no embedded color
/// metadata, so any zscale option left at its `input` default (-1)
/// resolves to "unknown" and zimg fails planning with code 3074
/// ("no path between colorspaces"). Setting only the source tags is not
/// enough — unspecified output tags also fall back to `input` and inherit
/// the same "unknown" sink, which is just as fatal.
///
/// The matrix tag for RGB-identity is `gbr` (zscale enum value 0), NOT
/// `bt709` — declaring `bt709` would tell zimg the source needs a
/// YCbCr→RGB matrix inversion it can't apply to already-RGB data.
/// Confirmed against `ffmpeg -h filter=zscale`: the matrix enum lists
/// `gbr` as the identity coefficient. sRGB shares BT.709 primaries
/// (same chromaticities), so `pin=bt709` is the canonical pairing with
/// `tin=iec61966-2-1`.
pub fn map_ingest_filter() -> String {
    map_ingest_filter_into(&ColorSpace::WORKING)
}

/// Working-space-parameterized form of [`map_ingest_filter`]. The map canvas
/// is just a known source [`ColorSpace`] ([`ColorSpace::SRGB`]: BT.709
/// primaries, sRGB transfer, full range, RGB-identity matrix), so it flows
/// through the SAME generator as clip ingest — with `explicit_source_tags`
/// set, because the bare `rawvideo` RGBA input carries no stream tags for zimg
/// to infer from (the load-bearing asymmetry documented above).
pub fn map_ingest_filter_into(working: &ColorSpace) -> String {
    ingest_zscale_chain(&ColorSpace::SRGB, working, true)
}

/// Coarse classification of a source clip's color regime. Drives ingest
/// formula selection at every stage of the pipeline (proxy, thumbnail,
/// export). All Phase 1 ingest paths branch on this enum.
///
/// Serialized snake_case so the on-wire format matches the TypeScript union
/// in `src/types.ts` (`'sdr_bt709' | 'hlg_bt2020' | …`) and is stable across
/// schema versions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceColorClass {
    /// Standard dynamic range, Rec.709 primaries + transfer + matrix. The
    /// out-of-the-box iPhone capture; also the safe assumption when color
    /// metadata is missing entirely (see `classify`'s fallback to SDR).
    SdrBt709,
    /// High dynamic range via the ARIB STD-B67 / BBC Hybrid Log-Gamma
    /// transfer on BT.2020 primaries. iPhone HDR mode.
    HlgBt2020,
    /// High dynamic range via the SMPTE ST 2084 / Perceptual Quantizer
    /// transfer on BT.2020 primaries. Treated as `npl=1000` at ingest time.
    PqBt2020,
    /// Dolby Vision. Phase 1 collapses every Dolby Vision profile down to
    /// "treat the HLG base layer; discard the enhancement layer / RPU." Full
    /// DV handling is out of scope for this phase.
    DolbyVision,
    /// No usable color metadata. Downstream consumers MUST treat this as
    /// SDR Rec.709 (the safest default — gets you a watchable proxy /
    /// thumbnail / export even when the source is mis-tagged).
    Unknown,
    // ---- Phase 2 variants ----
    // Log formats are SDR-range files that encode a wider dynamic range via a
    // log curve. They cannot be auto-detected (they tag themselves as plain
    // bt709 in ffprobe output, see ARCHITECTURE.md §"Phase 2 additions"); the
    // populating path is a user override on the clip, not `classify()`.
    DLog,
    CLog,
    CLog2,
    CLog3,
    GpLog,
    VLog,
    SLog2,
    SLog3,
}

/// Probed color signals a clip carries on disk. Values come from `ffprobe`:
/// `pix_fmt`, `color_primaries`, `color_transfer`, `color_space`,
/// `color_range` are stream-level fields; `has_dolby_vision` is derived from
/// the stream's `side_data_list` carrying a Dolby Vision configuration
/// record; `camera_make` and `camera_model` come from the QuickTime container
/// tags (`com.apple.quicktime.make` / `.model`) with a fallback to the
/// encoder string for non-Apple devices.
///
/// All fields are `Option` because real-world files routinely lack any
/// individual field — `classify()` is responsible for picking a sensible
/// default when fields are missing rather than erroring.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ColorMetadata {
    pub pix_fmt: Option<String>,
    pub color_primaries: Option<String>,
    /// ffprobe spells this `color_transfer` (we adopt the canonical
    /// "trc" / transfer-characteristics shorthand here so consumers match
    /// the BT.709 / BT.2020 spec naming).
    pub color_trc: Option<String>,
    pub color_space: Option<String>,
    pub color_range: Option<String>,
    pub has_dolby_vision: bool,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
}

/// Suggest a likely log encoding for the given metadata. Pure forwarder
/// onto the camera-make/model knowledge base in
/// `crate::util::log_detection` — the front door consumers reach for so they
/// don't have to know about the `DetectionInput` shape or the bit-depth
/// derivation. Returns `None` when no suggestion is warranted (the
/// overwhelmingly common case: iPhone, GoPro 8-bit, unknown cameras, anything
/// already tagged HDR).
///
/// **Suggestions are never auto-applied.** The pipeline reads
/// `effective_color_class()` (= override > auto-detected); this hint exists
/// purely to populate a UI affordance (WS9). False positives on log are
/// destructive — a D-Log → 709 LUT applied to a plain Rec.709 clip crushes
/// shadows and oversaturates badly. The "auto-detect HDR, manually declare
/// log" decision (see `docs/color-pipeline/background/design-decisions.md`
/// §"Decision 5") makes user confirmation mandatory.
///
/// The import path consults this together with `classify()`:
///   - `classify(meta)`           → `source_color_class` (auto-applied)
///   - `suggest_log_format(meta)` → `suggested_log_class` (UI-only hint)
///
/// Only suggest log when the auto-detected class is SDR or Unknown — never
/// over a detected HDR class. The `color_trc` HDR gate inside the knowledge
/// base enforces this, but call sites should also skip the call entirely
/// when `classify()` returns an HDR or DV class.
pub fn suggest_log_format(meta: &ColorMetadata) -> Option<SourceColorClass> {
    use crate::util::log_detection::{bit_depth_from_pix_fmt, suggest_log_format as inner, DetectionInput};

    inner(DetectionInput {
        camera_make: meta.camera_make.as_deref(),
        camera_model: meta.camera_model.as_deref(),
        bit_depth: bit_depth_from_pix_fmt(meta.pix_fmt.as_deref()),
        color_trc: meta.color_trc.as_deref(),
    })
}

/// Classify a source's color regime from its probed metadata. Pure: no I/O,
/// no allocation beyond what serde imposes via the input borrow.
///
/// Decision tree (matches the table in `docs/color-pipeline/ARCHITECTURE.md`
/// §"Ingest formulas (Phase 1)"):
///
/// 1. Dolby Vision side data wins outright — DV files often *also* tag as
///    HLG on the base layer; we want them on the DV path.
/// 2. `color_trc=arib-std-b67`        → `HlgBt2020`
/// 3. `color_trc=smpte2084`           → `PqBt2020`
/// 4. `color_trc=bt709|smpte170m|bt470bg` → `SdrBt709`
/// 5. Anything else, including missing → `Unknown`
///
/// `Unknown` is the explicit signal that we should treat the source as SDR
/// Rec.709 at ingest. The two cases are distinct: `SdrBt709` came from
/// positive metadata; `Unknown` came from absent/garbage metadata. Callers
/// that want to surface "this file is mis-tagged" to the user can branch on
/// the difference (Phase 2's user-override UI does this).
///
/// Phase 1 never returns a log variant. See `SourceColorClass`'s doc.
pub fn classify(meta: &ColorMetadata) -> SourceColorClass {
    if meta.has_dolby_vision {
        return SourceColorClass::DolbyVision;
    }
    match meta.color_trc.as_deref() {
        Some("arib-std-b67") => SourceColorClass::HlgBt2020,
        Some("smpte2084") => SourceColorClass::PqBt2020,
        Some("bt709") | Some("smpte170m") | Some("bt470bg") => SourceColorClass::SdrBt709,
        _ => SourceColorClass::Unknown,
    }
}

/// A detected source [`ColorSpace`] plus per-axis flags marking which axes were
/// INFERRED (the file tag was absent) versus read directly from the stream.
/// The UI badges inferred axes so the user knows which to sanity-check; the
/// per-clip override (see `Clip::color_space_override`) lets them correct any
/// axis without affecting the others.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InferredColorSpace {
    pub cs: ColorSpace,
    pub inferred_primaries: bool,
    pub inferred_transfer: bool,
    pub inferred_range: bool,
    pub inferred_matrix: bool,
}

/// Resolve probed metadata into a concrete [`ColorSpace`], inferring ONLY the
/// axes whose stream tag is absent — present tags are never overridden (the
/// Premiere antipattern). Inference rules, applied only on absence:
///
/// - **transfer**: the primary signal; HLG/PQ/legacy-SDR recognized directly,
///   otherwise default BT.709.
/// - **primaries**: from the transfer when absent (HLG/PQ ⇒ BT.2020, else
///   BT.709).
/// - **range**: limited (`tv`) by default — H.264/HEVC convention; full is
///   normally declared explicitly.
/// - **matrix**: from the primaries when absent (BT.2020 ⇒ bt2020nc, else
///   bt709).
///
/// HDR `npl` follows the transfer (HLG 400, PQ 1000) per the ingest convention.
pub fn inferred_color_space(meta: &ColorMetadata) -> InferredColorSpace {
    let (transfer, inferred_transfer) = match meta.color_trc.as_deref() {
        Some("arib-std-b67") => (Transfer::Hlg, false),
        Some("smpte2084") => (Transfer::Pq, false),
        Some("smpte170m") => (Transfer::Smpte170m, false),
        Some("bt470bg") => (Transfer::Bt470bg, false),
        Some("bt709") => (Transfer::Bt709, false),
        _ => (Transfer::Bt709, true),
    };

    let (primaries, inferred_primaries) = match meta.color_primaries.as_deref() {
        Some("bt2020") => (crate::util::color_space::Primaries::Bt2020, false),
        Some("bt709") | Some("smpte170m") | Some("bt470bg") => {
            (crate::util::color_space::Primaries::Bt709, false)
        }
        _ => {
            let p = if transfer.is_hdr() {
                crate::util::color_space::Primaries::Bt2020
            } else {
                crate::util::color_space::Primaries::Bt709
            };
            (p, true)
        }
    };

    let (range, inferred_range) = match meta.color_range.as_deref() {
        Some("tv") | Some("limited") => (crate::util::color_space::Range::Limited, false),
        Some("pc") | Some("full") => (crate::util::color_space::Range::Full, false),
        _ => (crate::util::color_space::Range::Limited, true),
    };

    let (matrix, inferred_matrix) = match meta.color_space.as_deref() {
        Some("bt2020nc") => (crate::util::color_space::Matrix::Bt2020nc, false),
        Some("bt709") => (crate::util::color_space::Matrix::Bt709, false),
        Some("smpte170m") => (crate::util::color_space::Matrix::Smpte170m, false),
        Some("gbr") => (crate::util::color_space::Matrix::Gbr, false),
        _ => {
            let m = match primaries {
                crate::util::color_space::Primaries::Bt2020 => {
                    crate::util::color_space::Matrix::Bt2020nc
                }
                crate::util::color_space::Primaries::Bt709 => {
                    crate::util::color_space::Matrix::Bt709
                }
            };
            (m, true)
        }
    };

    InferredColorSpace {
        cs: ColorSpace {
            primaries,
            transfer,
            range,
            matrix,
            npl: crate::util::color_space::default_npl_for(transfer),
        },
        inferred_primaries,
        inferred_transfer,
        inferred_range,
        inferred_matrix,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta_with_trc(trc: &str) -> ColorMetadata {
        ColorMetadata {
            color_trc: Some(trc.to_string()),
            ..ColorMetadata::default()
        }
    }

    #[test]
    fn iphone_hlg_classifies_as_hlg_bt2020() {
        // iPhone HLG mode tags itself with `arib-std-b67` transfer on
        // BT.2020 primaries (see iphone source color table in
        // background/investigation-findings.md).
        let meta = ColorMetadata {
            pix_fmt: Some("yuv420p10le".into()),
            color_primaries: Some("bt2020".into()),
            color_trc: Some("arib-std-b67".into()),
            color_space: Some("bt2020nc".into()),
            color_range: Some("tv".into()),
            has_dolby_vision: false,
            camera_make: Some("Apple".into()),
            camera_model: Some("iPhone 15 Pro".into()),
        };
        assert_eq!(classify(&meta), SourceColorClass::HlgBt2020);
    }

    #[test]
    fn iphone_sdr_classifies_as_sdr_bt709() {
        let meta = ColorMetadata {
            pix_fmt: Some("yuv420p".into()),
            color_primaries: Some("bt709".into()),
            color_trc: Some("bt709".into()),
            color_space: Some("bt709".into()),
            color_range: Some("tv".into()),
            has_dolby_vision: false,
            camera_make: Some("Apple".into()),
            camera_model: Some("iPhone 12".into()),
        };
        assert_eq!(classify(&meta), SourceColorClass::SdrBt709);
    }

    #[test]
    fn pq_source_classifies_as_pq_bt2020() {
        let meta = meta_with_trc("smpte2084");
        assert_eq!(classify(&meta), SourceColorClass::PqBt2020);
    }

    #[test]
    fn dolby_vision_wins_over_hlg_base_layer_tag() {
        // DV Profile 8.4 uses an HLG base layer — the file tags itself as
        // HLG *and* carries a DV side-data block. Classification must pick
        // DolbyVision so the DV-specific ingest path runs.
        let meta = ColorMetadata {
            color_trc: Some("arib-std-b67".into()),
            color_primaries: Some("bt2020".into()),
            color_space: Some("bt2020nc".into()),
            has_dolby_vision: true,
            ..ColorMetadata::default()
        };
        assert_eq!(classify(&meta), SourceColorClass::DolbyVision);
    }

    #[test]
    fn dolby_vision_wins_with_no_color_tags() {
        // Some DV files tag the base layer as "unspecified". The DV signal
        // is still authoritative.
        let meta = ColorMetadata {
            has_dolby_vision: true,
            ..ColorMetadata::default()
        };
        assert_eq!(classify(&meta), SourceColorClass::DolbyVision);
    }

    #[test]
    fn legacy_smpte170m_classifies_as_sdr_bt709() {
        // Older SDR captures tag transfer as `smpte170m` (NTSC) — treated
        // as SDR Rec.709 at ingest. Same for `bt470bg` (PAL).
        assert_eq!(classify(&meta_with_trc("smpte170m")), SourceColorClass::SdrBt709);
        assert_eq!(classify(&meta_with_trc("bt470bg")), SourceColorClass::SdrBt709);
    }

    #[test]
    fn missing_metadata_classifies_as_unknown() {
        // A file with zero color metadata. Downstream contract: treat
        // Unknown as SDR. Returning Unknown rather than SdrBt709 here keeps
        // the "we guessed" signal available for a Phase 2 UI surface.
        let meta = ColorMetadata::default();
        assert_eq!(classify(&meta), SourceColorClass::Unknown);
    }

    #[test]
    fn unrecognized_trc_classifies_as_unknown() {
        // A non-standard / future transfer string we don't model yet.
        // Same fallback as missing — Unknown, treated as SDR downstream.
        let meta = meta_with_trc("some-future-transfer");
        assert_eq!(classify(&meta), SourceColorClass::Unknown);
    }

    // -----------------------------------------------------------------
    // WS3 — working-space helpers
    // -----------------------------------------------------------------

    #[test]
    fn working_space_constants_are_stable() {
        // WS4 (delivery transforms) and WS3 (working-space ingest) share
        // these three strings. A typo here breaks the working-space
        // boundary contract — both sides MUST agree on `gbrpf32le` /
        // BT.2020 primaries / BT.2020-NC matrix.
        assert_eq!(WORKING_SPACE_PIX_FMT, "gbrpf32le");
        assert_eq!(WORKING_SPACE_PRIMARIES, "bt2020");
        assert_eq!(WORKING_SPACE_MATRIX, "bt2020nc");
    }

    #[test]
    fn ingest_filter_for_sdr_is_bt709_inverse_eotf() {
        // SDR Rec.709 ingest (no source TRC hint, or `bt709` explicitly):
        // inverse BT.709 EOTF, primaries pass through, working-space pixel
        // format, primaries/matrix retag.
        let f = ingest_filter_for(SourceColorClass::SdrBt709, None);
        assert!(f.contains("zscale=tin=bt709:t=linear"), "got: {}", f);
        assert!(f.contains("format=gbrpf32le"), "got: {}", f);
        assert!(f.contains("zscale=p=bt2020:m=bt2020nc"), "got: {}", f);
        // No HDR-only npl on SDR.
        assert!(!f.contains("npl="), "SDR ingest must not pass npl: {}", f);

        // Same behaviour when an explicit `bt709` source TRC is threaded
        // through — regression guard for Fix #6.
        let f_bt709 = ingest_filter_for(SourceColorClass::SdrBt709, Some("bt709"));
        assert_eq!(
            f_bt709, f,
            "bt709 source_trc must match None (no hint) — pre-fix default",
        );
    }

    #[test]
    fn ingest_filter_for_unknown_falls_back_to_sdr() {
        // `Unknown` is the explicit "treat as SDR" signal — same chain as
        // SdrBt709, but with the source classification preserved upstream
        // for any UI surface that wants to flag mis-tagged clips.
        assert_eq!(
            ingest_filter_for(SourceColorClass::Unknown, None),
            ingest_filter_for(SourceColorClass::SdrBt709, None),
        );
    }

    #[test]
    fn ingest_filter_for_hlg_uses_arib_std_b67_with_npl_400() {
        let f = ingest_filter_for(SourceColorClass::HlgBt2020, None);
        assert!(f.contains("zscale=tin=arib-std-b67:t=linear:npl=400"), "got: {}", f);
        assert!(f.contains("format=gbrpf32le"), "got: {}", f);
        assert!(f.contains("zscale=p=bt2020:m=bt2020nc"), "got: {}", f);
    }

    #[test]
    fn ingest_filter_for_pq_uses_smpte2084_with_npl_1000() {
        let f = ingest_filter_for(SourceColorClass::PqBt2020, None);
        assert!(f.contains("zscale=tin=smpte2084:t=linear:npl=1000"), "got: {}", f);
        assert!(f.contains("format=gbrpf32le"), "got: {}", f);
        assert!(f.contains("zscale=p=bt2020:m=bt2020nc"), "got: {}", f);
    }

    // ---- Fix #6: legacy SDR transfer routing ----

    #[test]
    fn ingest_filter_for_sdr_with_smpte170m_uses_170m_tin() {
        // SMPTE 170M (NTSC) is an older SDR transfer that classify()
        // collapses into SdrBt709, but zscale recognises it as a distinct
        // input transfer (`tin=170m`). Using `tin=bt709` on a 170M source
        // applies the wrong inverse EOTF and introduces a small color
        // error in working space. Fix #6 threads the original source TRC
        // through so the SDR branch picks the correct tin= value.
        let f = ingest_filter_for(SourceColorClass::SdrBt709, Some("smpte170m"));
        assert!(
            f.contains("zscale=tin=170m:t=linear"),
            "smpte170m source must select tin=170m: {}",
            f,
        );
        assert!(
            !f.contains("zscale=tin=bt709"),
            "smpte170m source must NOT use tin=bt709 (Fix #6): {}",
            f,
        );
        // Tail untouched — working-space landing pads are stable.
        assert!(f.contains("format=gbrpf32le"), "got: {}", f);
        assert!(f.contains("zscale=p=bt2020:m=bt2020nc"), "got: {}", f);
    }

    #[test]
    fn ingest_filter_for_sdr_with_bt470bg_uses_470bg_tin() {
        // BT.470BG (PAL) gets the same treatment as SMPTE 170M.
        let f = ingest_filter_for(SourceColorClass::SdrBt709, Some("bt470bg"));
        assert!(
            f.contains("zscale=tin=470bg:t=linear"),
            "bt470bg source must select tin=470bg: {}",
            f,
        );
        assert!(
            !f.contains("zscale=tin=bt709"),
            "bt470bg source must NOT use tin=bt709 (Fix #6): {}",
            f,
        );
    }

    #[test]
    fn ingest_filter_for_sdr_with_unrecognised_trc_defaults_to_bt709() {
        // Unknown / future / garbage source TRCs route to tin=bt709 — the
        // safest default and the pre-fix behaviour for non-recognised
        // transfers on the SDR branch. Matches Unknown's contract:
        // "downstream consumers MUST treat this as SDR Rec.709".
        let f = ingest_filter_for(SourceColorClass::SdrBt709, Some("some-future-trc"));
        assert!(f.contains("zscale=tin=bt709:t=linear"), "got: {}", f);
    }

    #[test]
    fn ingest_filter_for_hdr_classes_ignore_source_trc_hint() {
        // The source_trc argument is consulted only on the SDR branch.
        // HDR / DV variants have unambiguous expected transfers — the
        // argument must be ignored. Regression guard: a future caller
        // passing the source's HLG/PQ trc string must not accidentally
        // change the HDR chain.
        for trc_hint in [None, Some("bt709"), Some("smpte170m"), Some("bt470bg"), Some("arib-std-b67"), Some("smpte2084")] {
            assert_eq!(
                ingest_filter_for(SourceColorClass::HlgBt2020, trc_hint),
                ingest_filter_for(SourceColorClass::HlgBt2020, None),
                "HLG ingest must ignore source_trc hint {:?}",
                trc_hint,
            );
            assert_eq!(
                ingest_filter_for(SourceColorClass::PqBt2020, trc_hint),
                ingest_filter_for(SourceColorClass::PqBt2020, None),
                "PQ ingest must ignore source_trc hint {:?}",
                trc_hint,
            );
            assert_eq!(
                ingest_filter_for(SourceColorClass::DolbyVision, trc_hint),
                ingest_filter_for(SourceColorClass::DolbyVision, None),
                "DV ingest must ignore source_trc hint {:?}",
                trc_hint,
            );
        }
    }

    #[test]
    fn ingest_filter_for_unknown_class_with_legacy_trc_routes_to_legacy_tin() {
        // The Unknown class collapses onto the SDR chain, so a legacy
        // source TRC threaded through still picks the right `tin=` value.
        // This is the "mis-tagged or untagged file with a legacy transfer
        // hint" case — extremely rare but the contract should hold
        // uniformly across the SDR family.
        let f = ingest_filter_for(SourceColorClass::Unknown, Some("smpte170m"));
        assert!(f.contains("zscale=tin=170m:t=linear"), "got: {}", f);
    }

    #[test]
    fn ingest_filter_for_dolby_vision_treats_as_hlg_base_layer() {
        // Phase 1 contract: DV collapses to its HLG base layer. WS3 must
        // emit the HLG chain — discarding the RPU happens implicitly
        // because nothing in this pipeline knows how to read it.
        let dv = ingest_filter_for(SourceColorClass::DolbyVision, None);
        let hlg = ingest_filter_for(SourceColorClass::HlgBt2020, None);
        assert_eq!(dv, hlg, "DV ingest must equal HLG ingest in Phase 1");
    }

    #[test]
    fn ingest_filter_for_unbundled_log_variants_fall_back_to_sdr_chain() {
        // Sony S-Log2/S-Log3 and Panasonic V-Log are explicitly out of
        // scope for WS10 (per the brief's "Sony S-Log and Panasonic
        // V-Log: defer to a follow-up workstream"). Those branches
        // unconditionally route to the SDR-Rec.709 chain — no LUT
        // lookup attempted — so the pipeline still produces watchable
        // (flat/gray) output for a user override on a Sony/Panasonic
        // clip.
        let sdr = ingest_filter_for(SourceColorClass::SdrBt709, None);
        for class in [
            SourceColorClass::VLog,
            SourceColorClass::SLog2,
            SourceColorClass::SLog3,
        ] {
            assert_eq!(
                ingest_filter_for(class, None),
                sdr,
                "no-bundled-LUT variant {:?} must use SDR fallback",
                class,
            );
        }
    }

    #[test]
    fn ingest_filter_for_placeholder_log_variants_fall_back_to_sdr_chain() {
        // DJI / GoPro / Canon slots ship placeholder `.cube` files by
        // default (see `src-tauri/resources/luts/README.md` — vendor
        // EULAs don't unambiguously permit redistribution). When the
        // bundled bytes don't pass `is_real_cube_lut`,
        // `ingest_filter_for` falls back to the SDR-Rec.709 chain so
        // the pipeline still produces frames. This test will start
        // failing for the affected variants the moment a real LUT
        // replaces a placeholder — at that point swap the assertion
        // for the LUT-bearing one (see
        // `ingest_filter_for_log_variant_with_real_lut_uses_lut3d`).
        let sdr = ingest_filter_for(SourceColorClass::SdrBt709, None);
        for class in [
            SourceColorClass::DLog,
            SourceColorClass::GpLog,
            SourceColorClass::CLog,
            SourceColorClass::CLog2,
            SourceColorClass::CLog3,
        ] {
            let lut = match class {
                SourceColorClass::DLog => BundledLut::DjiDLog,
                SourceColorClass::GpLog => BundledLut::GoProProtune,
                SourceColorClass::CLog => BundledLut::CanonCLog,
                SourceColorClass::CLog2 => BundledLut::CanonCLog2,
                SourceColorClass::CLog3 => BundledLut::CanonCLog3,
                _ => unreachable!(),
            };
            if is_real_cube_lut(lut.embedded_bytes()) {
                // A real LUT has replaced this slot's placeholder —
                // see the LUT-bearing test below. Skip the fallback
                // assertion for this variant rather than fail.
                continue;
            }
            assert_eq!(
                ingest_filter_for(class, None),
                sdr,
                "{:?} with placeholder LUT must take the SDR fallback",
                class,
            );
        }
    }

    #[test]
    fn ingest_filter_for_log_variant_with_real_lut_uses_lut3d() {
        // Cross-cutting check: for every bundled-LUT slot that has been
        // populated with a real `.cube` file, `ingest_filter_for` must
        // emit a chain that starts with `lut3d='<path>'` and ends in
        // the working-space tail. If no slot has a real LUT (the
        // default shipping state — all placeholders), this test is a
        // no-op rather than a failure: the
        // `…placeholder…_fall_back_to_sdr_chain` test above covers
        // that side.
        let slots = [
            (SourceColorClass::DLog, BundledLut::DjiDLog),
            (SourceColorClass::GpLog, BundledLut::GoProProtune),
            (SourceColorClass::CLog, BundledLut::CanonCLog),
            (SourceColorClass::CLog2, BundledLut::CanonCLog2),
            (SourceColorClass::CLog3, BundledLut::CanonCLog3),
        ];
        for (class, lut) in slots {
            if !is_real_cube_lut(lut.embedded_bytes()) {
                continue;
            }
            let f = ingest_filter_for(class, None);
            assert!(
                f.starts_with("lut3d='"),
                "{:?} ingest must start with lut3d filter: {}",
                class,
                f,
            );
            assert!(
                f.contains(lut.filename()),
                "{:?} ingest must reference {}: {}",
                class,
                lut.filename(),
                f,
            );
            // Tail: linearise from BT.709 SDR (the LUT's output
            // colourspace), hop to working-space pixel format, retag.
            assert!(
                f.contains("zscale=tin=bt709:t=linear"),
                "{:?} ingest must linearise BT.709 after LUT: {}",
                class,
                f,
            );
            assert!(
                f.contains("format=gbrpf32le"),
                "{:?} ingest must end in working-space pix fmt: {}",
                class,
                f,
            );
            assert!(
                f.contains("zscale=p=bt2020:m=bt2020nc"),
                "{:?} ingest must retag to BT.2020 primaries/matrix: {}",
                class,
                f,
            );
        }
    }

    #[test]
    fn is_real_cube_lut_rejects_placeholders_and_accepts_lut_3d_size_header() {
        // Placeholder shipped by default — pure comment, no header.
        let placeholder = b"# Placeholder. See README.md.\n";
        assert!(!is_real_cube_lut(placeholder));
        // Truncated / empty.
        assert!(!is_real_cube_lut(b""));
        assert!(!is_real_cube_lut(b"LUT_3D_SIZE 2\n")); // < 32 bytes
        // A real minimal Cube LUT (2³ = 8 entries, identity-ish). The
        // `lut3d` parser accepts comment lines + header + RGB rows.
        let real = b"# Title\nLUT_3D_SIZE 2\n\
            0.0 0.0 0.0\n1.0 0.0 0.0\n0.0 1.0 0.0\n1.0 1.0 0.0\n\
            0.0 0.0 1.0\n1.0 0.0 1.0\n0.0 1.0 1.0\n1.0 1.0 1.0\n";
        assert!(is_real_cube_lut(real));
        // Header inside a comment line MUST NOT count — defends
        // against the placeholder evolving into a longer doc-only file
        // that happens to mention the spec.
        let doc_only = b"# This file would have LUT_3D_SIZE here normally.\n# But it's just docs.\n# More padding to clear the 32-byte length floor entirely.\n";
        assert!(!is_real_cube_lut(doc_only));
    }

    #[test]
    fn escape_lut3d_filename_handles_quote_colon_and_backslash() {
        // Path with no special chars passes through verbatim.
        assert_eq!(
            escape_lut3d_filename("/tmp/trailcut-luts/DJI_DLog_to_Rec709.cube"),
            "/tmp/trailcut-luts/DJI_DLog_to_Rec709.cube",
        );
        // The three FFmpeg filtergraph metacharacters get backslash-escaped.
        assert_eq!(escape_lut3d_filename("a'b"), "a\\'b");
        assert_eq!(escape_lut3d_filename("a:b"), "a\\:b");
        assert_eq!(escape_lut3d_filename("a\\b"), "a\\\\b");
    }

    #[test]
    fn bundled_luts_resolve_to_a_path_when_real_or_none_when_placeholder() {
        // For each slot: either the bundled bytes are a real LUT and we
        // materialise to a path, or they're a placeholder and we get
        // `None`. The OnceLock means the temp write only happens on the
        // first call across the whole test run.
        for lut in [
            BundledLut::DjiDLog,
            BundledLut::GoProProtune,
            BundledLut::CanonCLog,
            BundledLut::CanonCLog2,
            BundledLut::CanonCLog3,
        ] {
            let bytes = lut.embedded_bytes();
            let real = is_real_cube_lut(bytes);
            let resolved = bundled_lut_path(lut);
            if real {
                let path = resolved.unwrap_or_else(|| {
                    panic!(
                        "real LUT for {:?} ({}) must materialise to a temp path",
                        lut,
                        lut.filename(),
                    )
                });
                let on_disk = std::fs::read(path).expect("materialised LUT readable");
                assert_eq!(on_disk, bytes, "materialised bytes must round-trip");
                assert!(
                    path.file_name().and_then(|n| n.to_str()) == Some(lut.filename()),
                    "materialised filename must match slot filename"
                );
            } else {
                assert!(
                    resolved.is_none(),
                    "placeholder LUT for {:?} must resolve to None",
                    lut,
                );
            }
        }
    }

    #[test]
    fn map_ingest_filter_is_srgb_full_range_into_working_space() {
        // Map canvas: full-range sRGB RGBA8 from `gl.readPixels()`.
        // `iec61966-2-1` is zscale's canonical name for sRGB; `rin=full`
        // is load-bearing (WebGL framebuffers are full-range — without
        // this flag zscale assumes limited-range and the map's whites
        // clip).
        let f = map_ingest_filter();
        assert!(f.contains("tin=iec61966-2-1"), "got: {}", f);
        assert!(f.contains("t=linear"), "got: {}", f);
        assert!(f.contains("rin=full"), "got: {}", f);
        assert!(f.contains("format=gbrpf32le"), "got: {}", f);
        assert!(f.contains("zscale=p=bt2020:m=bt2020nc"), "got: {}", f);
    }

    #[test]
    fn map_ingest_declares_all_four_source_color_tags() {
        // Regression guard: the map canvas input is bare `rawvideo` RGBA
        // with no stream-side color metadata, so zimg has nothing to
        // infer from. All four source tags (primaries / transfer /
        // matrix / range) must be set explicitly on the first zscale —
        // missing any one re-introduces the planning failure that
        // surfaced as `code 3074: no path between colorspaces`. The
        // per-clip `ingest_filter_for()` chains intentionally omit these
        // because their inputs *do* carry stream tags; this asymmetry
        // is exactly the trap the test exists to catch.
        let f = map_ingest_filter();
        assert!(f.contains("pin="), "missing source primaries (pin=): {}", f);
        assert!(f.contains("tin="), "missing source transfer (tin=): {}", f);
        assert!(f.contains("min="), "missing source matrix (min=): {}", f);
        assert!(f.contains("rin="), "missing source range (rin=): {}", f);
    }

    #[test]
    fn ingest_filters_end_in_working_space_pixel_format_and_primaries() {
        // Cross-cutting assertion: every ingest chain (clip + map) must
        // (a) include the working-space pixel format and (b) finish by
        // tagging BT.2020 primaries + matrix. WS4's delivery transform
        // assumes both — losing either silently turns the working space
        // into yuv-space-with-a-different-name. WS10: log variants are
        // included too — both the LUT-bearing branch and the SDR
        // fallback for unbundled / placeholder slots must land in the
        // working space.
        let mut chains: Vec<String> = vec![map_ingest_filter()];
        for class in [
            SourceColorClass::SdrBt709,
            SourceColorClass::HlgBt2020,
            SourceColorClass::PqBt2020,
            SourceColorClass::DolbyVision,
            SourceColorClass::Unknown,
            SourceColorClass::DLog,
            SourceColorClass::GpLog,
            SourceColorClass::CLog,
            SourceColorClass::CLog2,
            SourceColorClass::CLog3,
            SourceColorClass::VLog,
            SourceColorClass::SLog2,
            SourceColorClass::SLog3,
        ] {
            chains.push(ingest_filter_for(class, None));
        }
        for f in chains {
            assert!(f.contains("format=gbrpf32le"), "missing pix fmt: {}", f);
            assert!(f.contains("p=bt2020"), "missing bt2020 primaries: {}", f);
            assert!(f.contains("m=bt2020nc"), "missing bt2020nc matrix: {}", f);
        }
    }

    // -----------------------------------------------------------------
    // WS8 — log-format suggestion façade
    // -----------------------------------------------------------------

    #[test]
    fn suggest_log_format_returns_d_log_for_dji_mavic_10bit_bt709() {
        // Acceptance: DJI Mavic 3 + 10-bit + bt709 → `Some(DLog)`. This is
        // the strongest log indicator the knowledge base can produce and the
        // headline check in the WS8 brief.
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
        assert_eq!(suggest_log_format(&meta), Some(SourceColorClass::DLog));
    }

    #[test]
    fn suggest_log_format_returns_none_for_iphone() {
        // Acceptance: iPhones have no log option, so detection must stay
        // silent on every iPhone capture regardless of bit depth / transfer.
        let meta = ColorMetadata {
            pix_fmt: Some("yuv420p".to_string()),
            color_primaries: Some("bt709".to_string()),
            color_trc: Some("bt709".to_string()),
            color_space: Some("bt709".to_string()),
            color_range: Some("tv".to_string()),
            has_dolby_vision: false,
            camera_make: Some("Apple".to_string()),
            camera_model: Some("iPhone 15 Pro".to_string()),
        };
        assert_eq!(suggest_log_format(&meta), None);
    }

    #[test]
    fn suggest_log_format_returns_none_for_hlg_or_pq_transfer() {
        // Acceptance: HDR overrides log. Even a knowledge-base-matched
        // camera (DJI, Canon R5) must not pick up a log suggestion when its
        // transfer is HLG or PQ.
        for trc in ["arib-std-b67", "smpte2084"] {
            let meta = ColorMetadata {
                pix_fmt: Some("yuv420p10le".to_string()),
                color_trc: Some(trc.to_string()),
                camera_make: Some("DJI".to_string()),
                camera_model: Some("Mavic 3".to_string()),
                ..ColorMetadata::default()
            };
            assert_eq!(suggest_log_format(&meta), None, "transfer {trc}");
        }
    }

    #[test]
    fn suggest_log_format_sensible_defaults_for_sony_fx_panasonic_gh_canon_r5() {
        // Acceptance: spot-check that the per-vendor defaults match the
        // brief's "sensible defaults" call-out.
        let sony_fx3 = ColorMetadata {
            pix_fmt: Some("yuv420p10le".to_string()),
            color_trc: Some("bt709".to_string()),
            camera_make: Some("Sony".to_string()),
            camera_model: Some("ILME-FX3".to_string()),
            ..ColorMetadata::default()
        };
        assert_eq!(suggest_log_format(&sony_fx3), Some(SourceColorClass::SLog3));

        let panasonic_gh6 = ColorMetadata {
            pix_fmt: Some("yuv420p10le".to_string()),
            color_trc: Some("bt709".to_string()),
            camera_make: Some("Panasonic".to_string()),
            camera_model: Some("DC-GH6".to_string()),
            ..ColorMetadata::default()
        };
        assert_eq!(suggest_log_format(&panasonic_gh6), Some(SourceColorClass::VLog));

        let canon_r5 = ColorMetadata {
            pix_fmt: Some("yuv420p10le".to_string()),
            color_trc: Some("bt709".to_string()),
            camera_make: Some("Canon".to_string()),
            camera_model: Some("EOS R5".to_string()),
            ..ColorMetadata::default()
        };
        assert_eq!(suggest_log_format(&canon_r5), Some(SourceColorClass::CLog3));

        let canon_r6 = ColorMetadata {
            pix_fmt: Some("yuv420p10le".to_string()),
            color_trc: Some("bt709".to_string()),
            camera_make: Some("Canon".to_string()),
            camera_model: Some("EOS R6".to_string()),
            ..ColorMetadata::default()
        };
        assert_eq!(suggest_log_format(&canon_r6), Some(SourceColorClass::CLog3));
    }

    #[test]
    fn source_color_class_serializes_as_snake_case() {
        // The TS union in `src/types.ts` is `'sdr_bt709' | 'hlg_bt2020' |
        // 'pq_bt2020' | 'dolby_vision' | 'unknown' | 'd_log' | …`. The Rust
        // enum's snake_case rename must produce identical strings so the
        // JSON round-trip between TS and Rust is wire-stable.
        for (variant, expected) in [
            (SourceColorClass::SdrBt709, "\"sdr_bt709\""),
            (SourceColorClass::HlgBt2020, "\"hlg_bt2020\""),
            (SourceColorClass::PqBt2020, "\"pq_bt2020\""),
            (SourceColorClass::DolbyVision, "\"dolby_vision\""),
            (SourceColorClass::Unknown, "\"unknown\""),
            (SourceColorClass::DLog, "\"d_log\""),
            (SourceColorClass::CLog, "\"c_log\""),
            (SourceColorClass::CLog2, "\"c_log2\""),
            (SourceColorClass::CLog3, "\"c_log3\""),
            (SourceColorClass::GpLog, "\"gp_log\""),
            (SourceColorClass::VLog, "\"v_log\""),
            (SourceColorClass::SLog2, "\"s_log2\""),
            (SourceColorClass::SLog3, "\"s_log3\""),
        ] {
            let json = serde_json::to_string(&variant).unwrap();
            assert_eq!(json, expected, "wire format for {:?}", variant);
            let round_tripped: SourceColorClass = serde_json::from_str(&json).unwrap();
            assert_eq!(round_tripped, variant, "round trip for {:?}", variant);
        }
    }
}
