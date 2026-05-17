// Output resolution and codec preference types (Phase 1 of the export-controls
// plan). These are scaffolding only — Phase 1 establishes the wire-protocol
// shape with sensible defaults; later phases consume the fields.
//
// `OutputResolution` rides on `LayoutDescriptor` (in `layout.rs`); Phase 4
// makes `output_dims` / `resolve_slots` resolution-aware. `CodecPreference`
// rides on `RenderExportRequest` (in `mod.rs`); Phase 3 wires it into the
// encoder selection in the composite branch.
//
// Both enums are `#[serde(default)]`-friendly and back-compat: old wire data
// missing these fields deserializes cleanly to the documented defaults.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum OutputResolution {
    #[serde(rename = "720p")]
    P720,
    #[serde(rename = "1080p")]
    P1080,
    #[serde(rename = "1440p")]
    P1440,
    #[serde(rename = "2160p")]
    P2160,
}

impl Default for OutputResolution {
    fn default() -> Self {
        Self::P1080
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CodecPreference {
    Auto,
    H264,
    Hevc,
}

impl Default for CodecPreference {
    fn default() -> Self {
        Self::Auto
    }
}
