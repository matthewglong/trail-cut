// Probe and select the best FFmpeg video encoder per class on this machine.
//
// See docs/export/tasks/040-encoder-probing.md. The module is consumed by the
// channel sinks (lands in 060/090) when constructing their FFmpeg `-c:v` flag.
//
// Three encoder classes are probed:
//   - Hevc        — Channel A's deliverable (H.265 in .mp4)
//   - H264        — software-fallback class for "Compatibility Mode"
//   - ProResAlpha — Channels B and C (prores_ks profile 4444)
//
// The probe runs once per (ffmpeg_version, platform) pair, caches the result
// at `{global_config_dir()}/encoder.json`, and hits the cache on subsequent
// `select_encoder` calls. Cache invalidates automatically when either key
// component diverges from the saved value.
//
// `EncoderChoice::codec_args` carries the per-class flags downstream sinks
// pass as-is. Encoder selection here produces `-c:v` flags only — channel
// filtergraph logic lives in the channel sinks (060/070/090).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::util::fs::global_config_dir;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum EncoderClass {
    /// Channel A's deliverable — H.265 in `.mp4` (LAYOUT.md §6).
    Hevc,
    /// Software fallback for hypothetical "Compatibility Mode" (HEVC fully
    /// unavailable). Not currently used by any channel; kept so future toggles
    /// don't require re-architecting the probe.
    H264,
    /// Channels B and C — `prores_ks` profile 4444 with alpha. Single-candidate
    /// class; "selection" is just confirmation that the encoder works.
    ProResAlpha,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum EncoderKind {
    Hardware,
    Software,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncoderChoice {
    pub class: EncoderClass,
    pub name: String,
    pub kind: EncoderKind,
    /// Additional `-c:v` family flags (CRF/quality, profile, pix_fmt, etc.)
    /// downstream sinks pass after `-c:v <name>`. ProRes carries its own
    /// `-c:v prores_ks` inside this list (see docs §"Class-specific args").
    pub codec_args: Vec<String>,
    pub probe_wall_clock_ms: u32,
}

/// Bump whenever the candidate POLICY changes (order, args, new classes) —
/// the cache is otherwise keyed only on (ffmpeg_version, platform), so a
/// policy change would never reach machines with a warm cache. History:
/// 1 (implicit) = hardware-first HEVC; 2 = libx265-first HEVC
/// (decoration-crispness fix, 2026-07-03).
const ENCODER_POLICY_VERSION: u32 = 2;

fn default_policy_version() -> u32 {
    // Pre-versioning caches deserialize as policy 1 and self-invalidate.
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncoderProbe {
    pub ffmpeg_version: String,
    pub platform: String,
    #[serde(default = "default_policy_version")]
    pub policy_version: u32,
    pub probed_at_unix_ms: u64,
    pub choices: HashMap<EncoderClass, EncoderChoice>,
}

#[derive(Debug, Error)]
pub enum EncoderError {
    #[error("ffmpeg not available: {0}")]
    FfmpegMissing(String),
    #[error("no working encoder for class {0:?}")]
    NoEncoderForClass(EncoderClass),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("config dir: {0}")]
    Config(String),
    #[error("could not parse `ffmpeg -encoders` output")]
    EncoderListParse,
}

impl From<EncoderError> for String {
    fn from(e: EncoderError) -> Self {
        e.to_string()
    }
}

// ---------- ffmpeg path resolution ----------
//
// Today the codebase calls `ffmpeg` from PATH. Task 130 swaps in the bundled
// `binaries/ffmpeg-<target-triple>` by setting this once at startup; the
// encoder module itself is unaffected by the swap.

static FFMPEG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Resolve the FFmpeg binary path. Uses the value pinned by
/// `set_ffmpeg_path` (task 130 sidecar bundling), or `"ffmpeg"` for the
/// dev-mode PATH lookup.
pub fn ffmpeg_path() -> PathBuf {
    FFMPEG_PATH
        .get_or_init(|| PathBuf::from("ffmpeg"))
        .clone()
}

/// Pin the ffmpeg binary path. First write wins (mirrors `OnceLock::set`).
/// Production callers leave the default; task 130 will call this with the
/// bundled binary path before any export starts.
#[doc(hidden)]
pub fn set_ffmpeg_path(path: PathBuf) {
    let _ = FFMPEG_PATH.set(path);
}

// ---------- cache path resolution (with test override) ----------

static CACHE_PATH_OVERRIDE: Mutex<Option<PathBuf>> = Mutex::new(None);

fn cache_path() -> Result<PathBuf, EncoderError> {
    if let Some(p) = CACHE_PATH_OVERRIDE.lock().unwrap().as_ref() {
        return Ok(p.clone());
    }
    Ok(global_config_dir()
        .map_err(EncoderError::Config)?
        .join("encoder.json"))
}

/// Test-only: redirect the encoder cache file. Pass `None` to revert to the
/// production default at `{global_config_dir()}/encoder.json`.
#[doc(hidden)]
pub fn set_cache_path_for_test(path: Option<PathBuf>) {
    *CACHE_PATH_OVERRIDE.lock().unwrap() = path;
}

// ---------- public API ----------

/// Run the full probe and overwrite the cache. Used by the Tauri command and
/// the integration test. Channel sinks should prefer `select_encoder`, which
/// hits the cache first.
pub fn probe_all() -> Result<EncoderProbe, EncoderError> {
    let ffmpeg_version = ffmpeg_version_line()?;
    let platform = platform_string();
    let in_build = list_encoders()?;

    let mut choices: HashMap<EncoderClass, EncoderChoice> = HashMap::new();
    for &class in &[
        EncoderClass::Hevc,
        EncoderClass::H264,
        EncoderClass::ProResAlpha,
    ] {
        let mut chosen: Option<EncoderChoice> = None;
        for cand in candidates_for(class) {
            if !in_build.contains(cand.name) {
                continue;
            }
            let start = Instant::now();
            match test_encode(&cand) {
                Ok(()) => {
                    let elapsed_u128 = start.elapsed().as_millis();
                    let elapsed = elapsed_u128.min(u32::MAX as u128) as u32;
                    chosen = Some(EncoderChoice {
                        class,
                        name: cand.name.to_string(),
                        kind: cand.kind,
                        codec_args: cand.downstream_codec_args(),
                        probe_wall_clock_ms: elapsed,
                    });
                    break;
                }
                Err(stderr_tail) => {
                    eprintln!(
                        "encoder probe: {} rejected for class {:?}:\n{}",
                        cand.name, class, stderr_tail
                    );
                }
            }
        }
        match chosen {
            Some(c) => {
                choices.insert(class, c);
            }
            None => return Err(EncoderError::NoEncoderForClass(class)),
        }
    }

    let probe = EncoderProbe {
        ffmpeg_version,
        platform,
        policy_version: ENCODER_POLICY_VERSION,
        probed_at_unix_ms: now_ms(),
        choices,
    };
    write_cache(&probe)?;
    Ok(probe)
}

/// Return the chosen encoder for `class`, hitting the on-disk cache first.
/// Falls back to a fresh `probe_all()` (lazy first-time probe) when the cache
/// is missing, malformed, or stamped with a different `ffmpeg_version` or
/// `platform`.
pub fn select_encoder(class: EncoderClass) -> Result<EncoderChoice, EncoderError> {
    let ffmpeg_version = ffmpeg_version_line()?;
    let platform = platform_string();

    if let Some(probe) = read_cache_if_fresh(&ffmpeg_version, &platform) {
        if let Some(choice) = probe.choices.get(&class) {
            return Ok(choice.clone());
        }
    }

    let probe = probe_all()?;
    probe
        .choices
        .get(&class)
        .cloned()
        .ok_or(EncoderError::NoEncoderForClass(class))
}

// ---------- internals ----------

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn platform_string() -> String {
    format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS)
}

fn ffmpeg_version_line() -> Result<String, EncoderError> {
    let out = Command::new(ffmpeg_path())
        .arg("-hide_banner")
        .arg("-version")
        .output()
        .map_err(|e| EncoderError::FfmpegMissing(format!("spawn failed: {}", e)))?;
    if !out.status.success() {
        return Err(EncoderError::FfmpegMissing(format!(
            "`ffmpeg -version` exited non-zero (code {:?})",
            out.status.code()
        )));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let first = stdout.lines().next().unwrap_or("").trim().to_string();
    if first.is_empty() {
        return Err(EncoderError::FfmpegMissing(
            "`ffmpeg -version` produced empty output".to_string(),
        ));
    }
    Ok(first)
}

fn list_encoders() -> Result<HashSet<String>, EncoderError> {
    let out = Command::new(ffmpeg_path())
        .arg("-hide_banner")
        .arg("-encoders")
        .output()
        .map_err(|e| EncoderError::FfmpegMissing(format!("spawn failed: {}", e)))?;
    if !out.status.success() {
        return Err(EncoderError::EncoderListParse);
    }
    Ok(parse_encoder_list(&String::from_utf8_lossy(&out.stdout)))
}

/// Parse the table FFmpeg emits below the `------` separator. Each table row
/// has flag glyphs followed by the encoder name, e.g.:
///   ` V....D libx264              libx264 H.264 / AVC ...`
fn parse_encoder_list(stdout: &str) -> HashSet<String> {
    let mut set = HashSet::new();
    let mut after_separator = false;
    for line in stdout.lines() {
        if !after_separator {
            if line.contains("------") {
                after_separator = true;
            }
            continue;
        }
        let trimmed = line.trim_start();
        let mut it = trimmed.split_whitespace();
        if let Some(_flags) = it.next() {
            if let Some(name) = it.next() {
                set.insert(name.to_string());
            }
        }
    }
    set
}

#[derive(Clone)]
struct Candidate {
    name: &'static str,
    kind: EncoderKind,
    /// Args passed after `-c:v <name>` during the 1-frame test encode. These
    /// are also folded into `downstream_codec_args` (with a `-c:v <name>`
    /// prepended for ProRes per the spec's class-specific args table).
    test_extra_args: &'static [&'static str],
    /// Whether the test input needs an alpha-channel `lavfi` source — true
    /// for ProRes 4444 with `yuva444p10le`.
    needs_alpha_input: bool,
    class: EncoderClass,
}

impl Candidate {
    fn downstream_codec_args(&self) -> Vec<String> {
        match self.class {
            EncoderClass::ProResAlpha => {
                let mut v = vec!["-c:v".to_string(), self.name.to_string()];
                v.extend(self.test_extra_args.iter().map(|s| s.to_string()));
                v
            }
            _ => self.test_extra_args.iter().map(|s| s.to_string()).collect(),
        }
    }
}

fn candidates_for(class: EncoderClass) -> Vec<Candidate> {
    match class {
        EncoderClass::Hevc => hevc_candidates(),
        EncoderClass::H264 => h264_candidates(),
        EncoderClass::ProResAlpha => vec![Candidate {
            name: "prores_ks",
            kind: EncoderKind::Software,
            test_extra_args: &[
                "-profile:v",
                "4444",
                "-pix_fmt",
                "yuva444p10le",
                "-vendor",
                "apl0",
            ],
            needs_alpha_input: true,
            class,
        }],
    }
}

// HEVC candidate order: SOFTWARE FIRST (libx265), hardware fallback.
//
// This is a measured quality decision, not a performance one (decoration-
// crispness probe, 2026-07-03, docs/ship-review/PROGRESS.md): map decorations
// are high-chroma edges with near-zero luma contrast, and hardware encoders
// crush exactly that. hevc_videotoolbox at the shipped `-q:v 50` retained only
// 0.55 of the pre-encode Cr-plane edge energy on a real 4K composite (Y 39.7 /
// U 45.8 / V 46.6 dB vs the lossless tap) — visibly mushy marks and trail.
// libx265 crf18 medium at a comparable bitrate class retains 0.85+ (Y 46.4 /
// U 54.7 / V 54.1 dB). Crucially this is NOT bit starvation alone: VT at
// `-q:v 80` with 5× the bitrate still measured below libx265 crf18 on chroma
// edges. The hardware candidates remain as fallbacks so machines whose ffmpeg
// lacks libx265 still export (at documented lower decoration fidelity).
#[cfg(target_os = "macos")]
fn hevc_candidates() -> Vec<Candidate> {
    vec![
        Candidate {
            name: "libx265",
            kind: EncoderKind::Software,
            test_extra_args: &["-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-crf", "17"],
            needs_alpha_input: false,
            class: EncoderClass::Hevc,
        },
        Candidate {
            name: "hevc_videotoolbox",
            kind: EncoderKind::Hardware,
            test_extra_args: &["-tag:v", "hvc1", "-q:v", "65"],
            needs_alpha_input: false,
            class: EncoderClass::Hevc,
        },
    ]
}

#[cfg(target_os = "windows")]
fn hevc_candidates() -> Vec<Candidate> {
    vec![
        Candidate {
            name: "libx265",
            kind: EncoderKind::Software,
            test_extra_args: &["-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-crf", "17"],
            needs_alpha_input: false,
            class: EncoderClass::Hevc,
        },
        Candidate {
            name: "hevc_nvenc",
            kind: EncoderKind::Hardware,
            test_extra_args: &["-tag:v", "hvc1", "-rc", "vbr", "-cq", "23"],
            needs_alpha_input: false,
            class: EncoderClass::Hevc,
        },
        Candidate {
            name: "hevc_qsv",
            kind: EncoderKind::Hardware,
            test_extra_args: &["-tag:v", "hvc1", "-q", "23"],
            needs_alpha_input: false,
            class: EncoderClass::Hevc,
        },
        Candidate {
            name: "hevc_amf",
            kind: EncoderKind::Hardware,
            test_extra_args: &["-tag:v", "hvc1", "-quality", "balanced"],
            needs_alpha_input: false,
            class: EncoderClass::Hevc,
        },
    ]
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn hevc_candidates() -> Vec<Candidate> {
    vec![Candidate {
        name: "libx265",
        kind: EncoderKind::Software,
        test_extra_args: &["-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-crf", "17"],
        needs_alpha_input: false,
        class: EncoderClass::Hevc,
    }]
}

#[cfg(target_os = "macos")]
fn h264_candidates() -> Vec<Candidate> {
    vec![
        Candidate {
            name: "h264_videotoolbox",
            kind: EncoderKind::Hardware,
            test_extra_args: &["-q:v", "60"],
            needs_alpha_input: false,
            class: EncoderClass::H264,
        },
        Candidate {
            name: "libx264",
            kind: EncoderKind::Software,
            test_extra_args: &["-pix_fmt", "yuv420p", "-crf", "18"],
            needs_alpha_input: false,
            class: EncoderClass::H264,
        },
    ]
}

#[cfg(target_os = "windows")]
fn h264_candidates() -> Vec<Candidate> {
    vec![
        Candidate {
            name: "h264_nvenc",
            kind: EncoderKind::Hardware,
            test_extra_args: &["-rc", "vbr", "-cq", "21"],
            needs_alpha_input: false,
            class: EncoderClass::H264,
        },
        Candidate {
            name: "h264_qsv",
            kind: EncoderKind::Hardware,
            test_extra_args: &["-q", "21"],
            needs_alpha_input: false,
            class: EncoderClass::H264,
        },
        Candidate {
            name: "h264_amf",
            kind: EncoderKind::Hardware,
            test_extra_args: &["-quality", "balanced"],
            needs_alpha_input: false,
            class: EncoderClass::H264,
        },
        Candidate {
            name: "libx264",
            kind: EncoderKind::Software,
            test_extra_args: &["-pix_fmt", "yuv420p", "-crf", "18"],
            needs_alpha_input: false,
            class: EncoderClass::H264,
        },
    ]
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn h264_candidates() -> Vec<Candidate> {
    vec![Candidate {
        name: "libx264",
        kind: EncoderKind::Software,
        test_extra_args: &["-pix_fmt", "yuv420p", "-crf", "18"],
        needs_alpha_input: false,
        class: EncoderClass::H264,
    }]
}

/// Run a 1-frame `lavfi` color source through the encoder and discard the
/// output. Catches the "in the build but the GPU/driver doesn't accept it"
/// failure mode (PLAN.md §"Hardware-accelerated encoding"). 320×240 is small
/// enough that even slow software encoders finish in ms; large enough that
/// hardware encoders accept it (some reject sub-256 dimensions).
fn test_encode(cand: &Candidate) -> Result<(), String> {
    let input = if cand.needs_alpha_input {
        "color=c=black@0.5:s=320x240:r=30:d=0.04"
    } else {
        "color=c=black:s=320x240:r=30:d=0.04"
    };
    let mut cmd = Command::new(ffmpeg_path());
    cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg(input)
        .arg("-frames:v")
        .arg("1")
        .arg("-c:v")
        .arg(cand.name);
    for a in cand.test_extra_args {
        cmd.arg(a);
    }
    cmd.arg("-f").arg("null").arg("-");

    let out = cmd.output().map_err(|e| format!("spawn failed: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail_start = stderr.len().saturating_sub(4096);
        return Err(stderr[tail_start..].to_string());
    }
    Ok(())
}

// ---------- cache I/O ----------

fn read_cache_if_fresh(version: &str, platform: &str) -> Option<EncoderProbe> {
    let path = cache_path().ok()?;
    let bytes = std::fs::read(&path).ok()?;
    let probe: EncoderProbe = serde_json::from_slice(&bytes).ok()?;
    if probe.ffmpeg_version == version
        && probe.platform == platform
        && probe.policy_version == ENCODER_POLICY_VERSION
    {
        Some(probe)
    } else {
        None
    }
}

fn write_cache(probe: &EncoderProbe) -> Result<(), EncoderError> {
    let path = cache_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(probe)?;
    std::fs::write(&path, bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_world_encoder_list_lines() {
        let sample = "\
Encoders:
 V..... = Video
 ------
 V....D libx264              libx264 H.264 / AVC ...
 V....D h264_videotoolbox    VideoToolbox H.264 Encoder
 VFS... prores_ks            Apple ProRes (iCodec Pro)
";
        let set = parse_encoder_list(sample);
        assert!(set.contains("libx264"));
        assert!(set.contains("h264_videotoolbox"));
        assert!(set.contains("prores_ks"));
        assert!(!set.contains("Encoders:"));
    }

    #[test]
    fn hevc_chain_prefers_libx265_hardware_is_fallback_only() {
        // Decoration-crispness decision (2026-07-03): software x265 first —
        // hardware encoders measurably crush high-chroma decoration edges
        // (see the candidate-order comment above hevc_candidates()).
        let c = candidates_for(EncoderClass::Hevc);
        assert_eq!(c[0].name, "libx265");
        assert_eq!(c[0].kind, EncoderKind::Software);
        if cfg!(target_os = "macos") {
            assert_eq!(c.last().unwrap().name, "hevc_videotoolbox");
            assert_eq!(c.last().unwrap().kind, EncoderKind::Hardware);
        }
    }

    #[test]
    fn prores_codec_args_include_c_v_prefix() {
        // Spec puts -c:v prores_ks inside codec_args; consumers splat as-is.
        let cand = &candidates_for(EncoderClass::ProResAlpha)[0];
        let args = cand.downstream_codec_args();
        assert_eq!(args[0], "-c:v");
        assert_eq!(args[1], "prores_ks");
        assert!(args.iter().any(|s| s == "yuva444p10le"));
        assert!(args.iter().any(|s| s == "apl0"));
    }

    #[test]
    fn hevc_codec_args_omit_c_v_prefix() {
        // HEVC/H264 codec_args are post-`-c:v` flags; consumers prepend `-c:v <name>`.
        if cfg!(target_os = "macos") {
            let cand = &candidates_for(EncoderClass::Hevc)[0];
            let args = cand.downstream_codec_args();
            assert_ne!(args.first().map(|s| s.as_str()), Some("-c:v"));
            assert!(args.iter().any(|s| s == "hvc1"));
        }
    }
}
