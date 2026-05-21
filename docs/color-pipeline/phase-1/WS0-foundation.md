# WS0 — Foundation: Probe, Classify, Model

**Phase:** 1
**Blocks:** WS1, WS2, WS3
**Blocked by:** none
**Estimated scope:** medium — touches Rust models, TS types, ffprobe, and ExifTool integration

## Goal

Establish the data substrate every subsequent color workstream depends on:
1. Probe source color metadata via ffprobe at import time.
2. Persist that metadata on the Clip model (Rust and TS).
3. Define a single `SourceColorClass` classifier that all downstream formulas branch on.

After this lands, every clip in the project has a known color class. WS1/WS2/WS3 read that class and pick the right ingest formula.

## Context

Before reading further, read:
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — working space and ingest formula concepts.
- [`../background/investigation-findings.md`](../background/investigation-findings.md) — current state of ffprobe and the Clip model.

Current state: ffprobe captures only `width/height/has_audio/container_duration_s`. The Clip model has zero color fields. The pipeline is structurally blind to source color at decision time.

## Files to modify

| File | Change |
|---|---|
| `src-tauri/src/export/ffprobe.rs` | Extend `ProbedClip` struct + `parse_ffprobe_json`. Add color fields to the ffprobe argv. |
| `src-tauri/src/models.rs` | Extend `ClipMetadata` with color fields. |
| `src/types.ts` | Mirror Rust changes in TS `ClipMetadata` type. |
| `src-tauri/src/util/color.rs` | **NEW FILE.** Define `SourceColorClass` enum and pure `classify()` function. |
| `src-tauri/src/lib.rs` | Register the new `util/color` module. |
| `src-tauri/src/commands.rs` (or wherever `scan_directory`/`import_media` live) | Call ffprobe at import to populate color metadata. |

## Implementation

### 1. New `SourceColorClass` enum

Create `src-tauri/src/util/color.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceColorClass {
    SdrBt709,
    HlgBt2020,
    PqBt2020,
    DolbyVision,
    Unknown,
    // Phase 2 variants — define now, populate later:
    DLog,
    CLog,
    CLog2,
    CLog3,
    GpLog,
    VLog,
    SLog2,
    SLog3,
}

#[derive(Debug, Clone)]
pub struct ColorMetadata {
    pub pix_fmt: Option<String>,
    pub color_primaries: Option<String>,
    pub color_trc: Option<String>,
    pub color_space: Option<String>,
    pub color_range: Option<String>,
    pub has_dolby_vision: bool,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
}

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
```

Note: Phase 2 log variants are defined now but `classify()` never returns them in Phase 1. They become populated via user override in Phase 2.

### 2. Extend `ProbedClip` and ffprobe call

In `src-tauri/src/export/ffprobe.rs`:

- Add fields to `ProbedClip`: `pix_fmt`, `color_primaries`, `color_trc`, `color_space`, `color_range`, `has_dolby_vision`, `camera_make`, `camera_model`.
- Update the ffprobe argv to request these. The exact call should include:
  ```
  ffprobe -v error
    -select_streams v:0
    -show_entries stream=pix_fmt,color_primaries,color_transfer,color_space,color_range,width,height
    -show_entries stream_side_data=side_data_type,dv_profile,dv_level,rpu_present_flag
    -show_entries format=duration
    -show_entries format_tags=com.apple.quicktime.make,com.apple.quicktime.model,encoder
    -of json
    <path>
  ```
- Update `parse_ffprobe_json` to extract the new fields. Note the JSON key for transfer is `color_transfer` (not `color_trc`); rename appropriately.
- Detect Dolby Vision by looking for `DOVI configuration record` in `side_data_list`.
- Camera make/model: prefer `com.apple.quicktime.make`/`.model`; fall back to checking encoder string for "DJI", "GoPro" markers.

### 3. Extend `ClipMetadata` (Rust)

In `src-tauri/src/models.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipMetadata {
    // ... existing fields ...

    // Color metadata, populated at import via ffprobe:
    pub pix_fmt: Option<String>,
    pub color_primaries: Option<String>,
    pub color_trc: Option<String>,
    pub color_space: Option<String>,
    pub color_range: Option<String>,
    pub has_dolby_vision: bool,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,

    // Auto-detected class:
    pub source_color_class: SourceColorClass,

    // Phase 2 — user override (None in Phase 1):
    pub user_color_class_override: Option<SourceColorClass>,
}

impl ClipMetadata {
    pub fn effective_color_class(&self) -> SourceColorClass {
        self.user_color_class_override.unwrap_or(self.source_color_class)
    }
}
```

### 4. Mirror in TypeScript

In `src/types.ts`, add matching fields to `ClipMetadata`. Define `SourceColorClass` as a string union:

```ts
export type SourceColorClass =
  | 'sdr_bt709'
  | 'hlg_bt2020'
  | 'pq_bt2020'
  | 'dolby_vision'
  | 'unknown'
  | 'd_log' | 'c_log' | 'c_log2' | 'c_log3'
  | 'gp_log' | 'v_log' | 's_log2' | 's_log3';
```

### 5. Populate at import

Wherever `import_media`/`scan_directory` builds `ClipMetadata`, call the new ffprobe path and `classify()` to populate the color fields. Existing ExifTool calls stay scope-limited to timestamps/GPS — do not add color extraction to ExifTool.

## Acceptance criteria

- [ ] `cargo build` and `cargo test` pass in `src-tauri/`.
- [ ] TypeScript builds cleanly (`npm run build` from project root).
- [ ] ffprobe is called at import for every video file and the new fields are populated on `ClipMetadata`.
- [ ] Given an iPhone HLG sample, `classify()` returns `HlgBt2020`.
- [ ] Given an iPhone SDR sample, `classify()` returns `SdrBt709`.
- [ ] Given a Dolby Vision sample (synthetic OK), `classify()` returns `DolbyVision`.
- [ ] Given a file with no color metadata, `classify()` returns `Unknown` and `effective_color_class()` returns `Unknown` (which downstream treats as SDR).
- [ ] Existing tests in `src-tauri/src/export/ffprobe.rs` still pass; new tests cover the color-extraction paths.
- [ ] Saving and reloading a project preserves the color fields (JSON round-trip works).

## Out of scope

- Log format detection from camera make/model (Phase 2, WS8).
- User-facing UI for color class override (Phase 2, WS9).
- Applying any color transforms (Phase 1 WS1–WS5).
- Changing ExifTool's tag list.

## References

- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — working space and formula concepts.
- [`../background/investigation-findings.md`](../background/investigation-findings.md) — current state.
- [`../background/design-decisions.md`](../background/design-decisions.md) — Decision 1 (working space) and Decision 5 (auto-detect HDR, manual log).
