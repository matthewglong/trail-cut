# WS8 — Log Format Detection

**Phase:** 2
**Blocks:** WS9
**Blocked by:** Phase 1 complete (needs `SourceColorClass` and `effective_color_class()` from WS0)
**Estimated scope:** medium — knowledge base, classifier extension, no code-path changes (suggestions only)

## Goal

Detect likely log formats (D-Log, C-Log, GP-Log, V-Log, S-Log2, S-Log3) from camera make/model metadata. Surface as **suggestions** in the UI, not auto-applied transforms. False positives are destructive; user confirmation is mandatory.

## Context

Read first:
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — Phase 2 section.
- [`../background/design-decisions.md`](../background/design-decisions.md) — Decision 5 (auto-detect HDR, manual log) and Decision 6 (group-level declaration).

**Critical constraint:** log formats tag themselves as plain `bt709` in ffprobe color metadata. They cannot be auto-detected from color tags. Detection relies on camera make/model strings + heuristics. Even high-confidence detection is offered as a *suggestion* — the user must confirm before any LUT is applied.

## Files to modify

| File | Change |
|---|---|
| `src-tauri/src/util/color.rs` | Extend `classify()` to return `(SourceColorClass, Option<SourceColorClass>)` — the detected class and an optional suggested log format. |
| `src-tauri/src/util/log_detection.rs` | **NEW FILE.** Camera make/model knowledge base. |
| `src-tauri/src/models.rs` | Add `suggested_log_class: Option<SourceColorClass>` to `ClipMetadata`. |
| `src/types.ts` | Mirror the suggestion field. |

## Implementation

### 1. Knowledge base

Create `src-tauri/src/util/log_detection.rs`:

```rust
use crate::util::color::SourceColorClass;

#[derive(Debug, Clone)]
pub struct DetectionInput<'a> {
    pub camera_make: Option<&'a str>,
    pub camera_model: Option<&'a str>,
    pub encoder: Option<&'a str>,
    pub pix_fmt: Option<&'a str>,
    pub bit_depth: u8,
    pub color_trc: Option<&'a str>,
}

pub fn suggest_log_format(input: DetectionInput) -> Option<SourceColorClass> {
    // Only suggest log when color_trc is bt709 (or unspecified). HDR-tagged
    // footage is never log.
    let trc_ok = matches!(input.color_trc, Some("bt709") | None | Some(""));
    if !trc_ok {
        return None;
    }

    let make = input.camera_make.unwrap_or("").to_lowercase();
    let model = input.camera_model.unwrap_or("").to_lowercase();
    let encoder = input.encoder.unwrap_or("").to_lowercase();

    // DJI drones
    if make.contains("dji") || encoder.contains("dji") {
        // D-Log requires 10-bit recording on Mavic 3+, Air 2S, etc.
        if input.bit_depth >= 10 {
            return Some(SourceColorClass::DLog);
        }
    }

    // GoPro HERO 10+ with 10-bit can be GP-Log (Protune flat)
    if make.contains("gopro") || encoder.contains("gopro") {
        if input.bit_depth >= 10 {
            return Some(SourceColorClass::GpLog);
        }
    }

    // Canon cinema and high-end stills (5D Mk IV, R5, R5C, C-series)
    // Note: C-Log is opt-in on most Canon bodies; we can only suggest, not confirm.
    if make.contains("canon") {
        if model.contains("c70") || model.contains("c300") || model.contains("c500") {
            return Some(SourceColorClass::CLog2); // Cinema bodies usually CLog2/3
        }
        if model.contains("r5") || model.contains("r6") || model.contains("r3") {
            return Some(SourceColorClass::CLog3);
        }
        // 5D Mk IV — C-Log was an optional firmware upgrade; can't be sure.
        // Return None and let user override if needed.
    }

    // Sony — S-Log on FX-series and A7S-series
    if make.contains("sony") {
        if model.contains("fx3") || model.contains("fx6") || model.contains("fx9") {
            return Some(SourceColorClass::SLog3);
        }
        if model.contains("a7s") || model.contains("a7r") {
            // S-Log is opt-in; suggest S-Log3 (more common on modern bodies)
            return Some(SourceColorClass::SLog3);
        }
    }

    // Panasonic — V-Log on GH-series, S-series
    if make.contains("panasonic") {
        if model.contains("gh5") || model.contains("gh6") || model.contains("s1h") || model.contains("s5") {
            return Some(SourceColorClass::VLog);
        }
    }

    None
}
```

### 2. Extend `classify()` to return suggestion

```rust
pub fn classify_with_suggestion(meta: &ColorMetadata) -> (SourceColorClass, Option<SourceColorClass>) {
    let class = classify(meta);
    let suggestion = if matches!(class, SourceColorClass::SdrBt709 | SourceColorClass::Unknown) {
        log_detection::suggest_log_format(DetectionInput {
            camera_make: meta.camera_make.as_deref(),
            camera_model: meta.camera_model.as_deref(),
            encoder: meta.encoder.as_deref(),
            pix_fmt: meta.pix_fmt.as_deref(),
            bit_depth: bit_depth_from_pix_fmt(meta.pix_fmt.as_deref()),
            color_trc: meta.color_trc.as_deref(),
        })
    } else {
        None
    };
    (class, suggestion)
}
```

Note: only suggest log when auto-detected class is SDR or Unknown. Never suggest log over a detected HDR class.

### 3. Update `ClipMetadata`

Add `suggested_log_class: Option<SourceColorClass>` to `ClipMetadata` (Rust + TS). Populate during import via `classify_with_suggestion()`.

### 4. `effective_color_class()` precedence

Update to:
```rust
pub fn effective_color_class(&self) -> SourceColorClass {
    // User override wins. Otherwise use auto-detected class.
    // Suggestion is NOT auto-applied — it surfaces in UI only.
    self.user_color_class_override.unwrap_or(self.source_color_class)
}
```

The suggestion is consumed by WS9's UI, not by the pipeline directly.

## Acceptance criteria

- [ ] `cargo build` and tests pass.
- [ ] `suggest_log_format` returns `Some(DLog)` for DJI Mavic 3 with 10-bit bt709 input.
- [ ] `suggest_log_format` returns `None` for iPhone (no log option exists on iPhone).
- [ ] `suggest_log_format` returns `None` when `color_trc` is HLG or PQ (HDR overrides log).
- [ ] `suggest_log_format` returns sensible defaults for Sony FX, Panasonic GH/S, Canon R5/R6.
- [ ] `ClipMetadata.suggested_log_class` is populated for clips matching the knowledge base.
- [ ] `effective_color_class()` does NOT auto-apply the suggestion — only `user_color_class_override` or auto-detected `source_color_class`.
- [ ] Unit tests cover each knowledge-base branch.

## Out of scope

- Auto-applying suggestions to the pipeline (would cause false positives).
- The UI that surfaces suggestions to the user — WS9.
- The LUT-based ingest formulas — WS10.
- ML-based detection from footage analysis (out of scope for this app entirely).

## References

- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — Phase 2 section.
- [`../background/design-decisions.md`](../background/design-decisions.md) — Decision 5 + 6.
- DJI/GoPro/Canon/Sony/Panasonic documentation for log format support per camera.
