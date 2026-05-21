# WS10 — Log LUT Bundling and Ingest

**Phase:** 2
**Blocks:** WS9 (UI needs the formulas to dispatch when user accepts a log declaration)
**Blocked by:** Phase 1 complete (plugs into the working-space architecture from WS3)
**Estimated scope:** medium — LUT licensing, bundle, ingest formula additions

## Goal

Bundle official log-to-Rec.709 LUTs from DJI, GoPro, and Canon. Add `F_ingest_{log_class}` formulas to the pipeline. These formulas slot into the working-space architecture from WS3 — when a clip's `effective_color_class()` returns a log variant, the correct LUT-based ingest chain runs.

## Context

Read first:
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — Phase 2 section + working space.
- [`WS3-working-space-export.md`](../phase-1/WS3-working-space-export.md) — the architecture this plugs into.

A log format is an SDR-range file encoded with a log curve that preserves a wider dynamic range than plain Rec.709. Each manufacturer has their own log curve and gamut, so a single generic "log-to-Rec.709" LUT doesn't work — you need the specific LUT for each format.

## Files to modify / create

| Path | Change |
|---|---|
| `src-tauri/luts/` | **NEW DIR.** Bundled LUT files. |
| `src-tauri/luts/README.md` | LUT provenance and licensing. |
| `src-tauri/luts/DJI_DLog_to_Rec709.cube` | DJI's official LUT. |
| `src-tauri/luts/GoPro_Protune_to_Rec709.cube` | GoPro's Protune LUT. |
| `src-tauri/luts/Canon_CLog_to_Rec709.cube` | Canon's C-Log LUT (per variant). |
| `src-tauri/luts/Canon_CLog2_to_Rec709.cube` | |
| `src-tauri/luts/Canon_CLog3_to_Rec709.cube` | |
| `src-tauri/src/util/color.rs` | Extend `ingest_filter_for()` with log branches. |
| `src-tauri/tauri.conf.json` | Ensure LUTs are bundled in the app resources. |

## Implementation

### 1. Acquire LUTs

Download official LUTs from each manufacturer's support site:
- **DJI**: D-Log to Rec.709 LUT from DJI's download center.
- **GoPro**: Protune Flat to Rec.709 LUT from GoPro's developer/support site.
- **Canon**: C-Log, C-Log2, C-Log3 LUTs from Canon's professional download center.

For Sony S-Log and Panasonic V-Log: defer to a follow-up workstream (users can add custom LUTs later). Initial scope is DJI + GoPro + Canon.

**Licensing**: each manufacturer's LUTs come with EULA terms. Verify redistribution is permitted, or alternatively:
- Bundle LUTs and require user to accept manufacturer EULA on first use.
- Prompt user to download the LUT themselves and point TrailCut at the file (less convenient but legally cleaner).

Document the licensing approach in `src-tauri/luts/README.md`.

### 2. LUT loading

The `lut3d` FFmpeg filter consumes `.cube` files (Adobe Cube format) — the de facto standard. All manufacturer LUTs ship as `.cube`.

Verify each LUT is in `.cube` format (convert from `.3dl` or `.dat` using `ffmpeg` or a conversion tool if needed).

### 3. Extend `ingest_filter_for()`

In `src-tauri/src/util/color.rs`, add log branches:

```rust
pub fn ingest_filter_for(class: SourceColorClass) -> String {
    match class {
        // ... existing Phase 1 branches ...

        SourceColorClass::DLog => format!(
            "lut3d='{}',zscale=tin=bt709:t=linear,format=gbrpf32le,zscale=p=bt2020:m=bt2020nc",
            lut_path("DJI_DLog_to_Rec709.cube")
        ),
        SourceColorClass::GpLog => format!(
            "lut3d='{}',zscale=tin=bt709:t=linear,format=gbrpf32le,zscale=p=bt2020:m=bt2020nc",
            lut_path("GoPro_Protune_to_Rec709.cube")
        ),
        SourceColorClass::CLog => format!(
            "lut3d='{}',zscale=tin=bt709:t=linear,format=gbrpf32le,zscale=p=bt2020:m=bt2020nc",
            lut_path("Canon_CLog_to_Rec709.cube")
        ),
        SourceColorClass::CLog2 => format!(
            "lut3d='{}',zscale=tin=bt709:t=linear,format=gbrpf32le,zscale=p=bt2020:m=bt2020nc",
            lut_path("Canon_CLog2_to_Rec709.cube")
        ),
        SourceColorClass::CLog3 => format!(
            "lut3d='{}',zscale=tin=bt709:t=linear,format=gbrpf32le,zscale=p=bt2020:m=bt2020nc",
            lut_path("Canon_CLog3_to_Rec709.cube")
        ),
        SourceColorClass::VLog | SourceColorClass::SLog2 | SourceColorClass::SLog3 => {
            // No bundled LUT yet — fall back to plain SDR ingest.
            // User will see flat footage; document this in WS9's UI.
            format!("zscale=tin=bt709:t=linear,format=gbrpf32le,zscale=p=bt2020:m=bt2020nc")
        }

        // ... rest unchanged ...
    }
}

fn lut_path(filename: &str) -> String {
    // Resolve via Tauri's app resources directory.
    // Pattern: tauri::api::path::resource_dir() / "luts" / filename
    // Return absolute path as a string for FFmpeg.
    // (Implementation depends on existing resource resolution patterns in the codebase.)
    todo!()
}
```

### 4. Tauri bundle config

Update `src-tauri/tauri.conf.json` to include the `luts/` directory in the bundled app resources, so the LUTs are available at runtime.

### 5. Trigger proxy regeneration

When a user changes `user_color_class_override` on a clip (via WS9 UI), the proxy must be regenerated because the ingest formula changed. Find the existing proxy invalidation logic (likely triggered on clip metadata changes) and ensure it fires on `user_color_class_override` changes.

### 6. Resolution / DPR for LUT precision

LUT files come in different grid sizes (17³, 33³, 65³). Use the largest available for color accuracy. FFmpeg's `lut3d` handles any size; no special config needed.

## Acceptance criteria

- [ ] LUT files are bundled in the app and accessible at runtime.
- [ ] `ingest_filter_for(DLog)` returns a filter chain that applies the DJI LUT.
- [ ] A clip with `user_color_class_override = DLog` produces a tone-mapped proxy that looks correct (not flat).
- [ ] Same clip exports through the composite pipeline with correct color in all delivery targets.
- [ ] LUT licensing is documented and EULA-compliant.
- [ ] Sony/Panasonic log variants fall back to plain SDR ingest without crashing (documented limitation).
- [ ] Proxy regeneration fires when user changes the override.
- [ ] Unit tests verify the ingest chain for each log class.

## Out of scope

- Custom user LUT import — defer indefinitely.
- Sony/Panasonic LUTs — separate workstream when those users request it.
- LUT preview UI (showing before/after of LUT application) — deferred.
- Per-clip exposure/grading on top of the LUT — separate future workstream.

## References

- [`WS3-working-space-export.md`](../phase-1/WS3-working-space-export.md) — the ingest architecture this extends.
- [`WS9-source-format-ui.md`](WS9-source-format-ui.md) — the UI that dispatches these formulas.
- [FFmpeg lut3d filter docs](https://ffmpeg.org/ffmpeg-filters.html#lut3d-1).
- DJI / GoPro / Canon LUT download centers (links per manufacturer).
