# WS3 — Working-Space Architecture in Export

**Phase:** 1
**Blocks:** WS4
**Blocked by:** WS0 (needs `effective_color_class()` on `ClipMetadata`)
**Estimated scope:** large — touches `clip_chain.rs` and `filtergraph.rs`, restructures filter graphs

## Goal

Introduce the linear-light, wide-gamut working space inside the export filter graph. Every clip and the map both land in working space before any concat or overlay happens. **This is the workstream that kills the PIP saturation bug** — both sides of the overlay are now in identical working space.

## Context

Read first:
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — working space definition (linear-light, BT.2020 primaries, `gbrpf32le`).
- [`../background/investigation-findings.md`](../background/investigation-findings.md) — root cause of the PIP saturation bug (overlay normalizes nothing).

Current state:
- `src-tauri/src/export/clip_chain.rs:90` ends each per-clip subgraph with `,format=yuva444p10le` — pixel format only, no color normalization.
- `src-tauri/src/export/filtergraph.rs:424–429` ingests map as `-f rawvideo -pix_fmt rgba` with no color tagging.
- Composite filter graphs at `filtergraph.rs:563–569 (PipMapInset)`, `:585–590 (PipVideoInset)`, `:599–614 (Split)` overlay without normalization.

## Files to modify

| File | Change |
|---|---|
| `src-tauri/src/export/clip_chain.rs` | Replace the trailing `format=yuva444p10le` with per-class ingest chain into working space. |
| `src-tauri/src/export/filtergraph.rs` | Add `F_map_to_working` to map ingest. Restructure composite graphs to overlay/stack in working space. |
| `src-tauri/src/util/color.rs` | Add `working_space_format()` and `ingest_filter_for(class)` helpers. |

## Implementation

### 1. Define working-space constants

In `src-tauri/src/util/color.rs`, add:

```rust
pub const WORKING_SPACE_PIX_FMT: &str = "gbrpf32le";
pub const WORKING_SPACE_PRIMARIES: &str = "bt2020";
pub const WORKING_SPACE_MATRIX: &str = "bt2020nc";

/// Returns the FFmpeg filter chain to bring a clip with the given color class
/// into working space (linear-light, BT.2020 primaries, gbrpf32le).
pub fn ingest_filter_for(class: SourceColorClass) -> String {
    match class {
        SourceColorClass::HlgBt2020 => format!(
            "zscale=tin=arib-std-b67:t=linear:npl=400,format=gbrpf32le,zscale=p=bt2020:m=bt2020nc"
        ),
        SourceColorClass::PqBt2020 => format!(
            "zscale=tin=smpte2084:t=linear:npl=1000,format=gbrpf32le,zscale=p=bt2020:m=bt2020nc"
        ),
        SourceColorClass::DolbyVision => format!(
            // Treat as HLG base layer; RPU discarded.
            "zscale=tin=arib-std-b67:t=linear:npl=400,format=gbrpf32le,zscale=p=bt2020:m=bt2020nc"
        ),
        SourceColorClass::SdrBt709 | SourceColorClass::Unknown => format!(
            "zscale=tin=bt709:t=linear,format=gbrpf32le,zscale=p=bt2020:m=bt2020nc"
        ),
        // Phase 2 log variants — placeholder; WS10 will implement.
        _ => format!(
            "zscale=tin=bt709:t=linear,format=gbrpf32le,zscale=p=bt2020:m=bt2020nc"
        ),
    }
}

/// Returns the FFmpeg filter chain to bring the map canvas (sRGB full-range RGBA)
/// into working space.
pub fn map_ingest_filter() -> String {
    String::from("zscale=tin=iec61966-2-1:t=linear:rin=full,format=gbrpf32le,zscale=p=bt2020:m=bt2020nc")
}
```

### 2. Update `clip_chain.rs`

Find the line that currently appends `,format=yuva444p10le` to each clip's subgraph (~line 90). Replace with:

```rust
let ingest = color::ingest_filter_for(clip.metadata.effective_color_class());
// Append per-clip subgraph:
write!(graph, "{},format=gbrpf32le[v{i}_w];", ingest)?;
```

The concat filter that follows now operates on `[v0_w][v1_w]…` streams in working space:

```
[v0_w][v1_w]...concat=n=N:v=1:a=0,fps={fps}[vc]
```

`[vc]` is now in working space.

### 3. Update `filtergraph.rs` map ingest

Map input stays `-f rawvideo -pix_fmt rgba -s WxH -r FPS -i pipe:0`, but immediately apply `map_ingest_filter()` to bring it into working space:

```
[map_raw] {map_ingest_filter()} [map];
```

Where `[map]` (now in working space) is what downstream composite filters consume.

### 4. Restructure composite filter graphs

All three modes overlay in working space, then convert to a delivery format at the end. **The final-format conversion moves to WS4 (delivery transforms)** — for this workstream, end with a placeholder `format=yuv444p10le` so the existing encoder still receives something it can handle.

#### PipMapInset
```
[vc][map]overlay={map_x}:{map_y}[vout_w];
[vout_w]format=yuv444p10le[vout]
```

#### PipVideoInset
```
[map][vc]overlay={video_x}:{video_y}[vout_w];
[vout_w]format=yuv444p10le[vout]
```

#### Split
The synthetic black base is no longer needed (working space handles normalization). But keep it for layout simplicity:
```
color=c=black:s={W}x{H}:r={fps},format=gbrpf32le[bg];
[bg][map]overlay={map_x}:{map_y}[bg_with_map];
[bg_with_map][vc]overlay={video_x}:{video_y}[vout_w];
[vout_w]format=yuv444p10le[vout]
```

Remove `format=auto` from the overlay calls — both inputs are now `gbrpf32le`, no negotiation needed.

### 5. Channel B (map_only) and Channel C (video_only)

Apply the same ingest into working space. For map_only: `[map_raw] {map_ingest_filter()} [map]; [map]format=yuv444p10le[vout]`. For video_only: per-clip ingest → concat → `format=yuv444p10le[vout]`.

The final delivery format conversion is WS4's job.

## Acceptance criteria

- [ ] `cargo build` passes.
- [ ] All three composite modes (PipMapInset, PipVideoInset, Split) produce output without errors.
- [ ] **PIP composite of map + iPhone SDR clip looks identical in color to Split composite of the same project.** This is the regression test for the bug.
- [ ] No washout, no oversaturation, no color drift visible in PIP output.
- [ ] Existing filtergraph tests pass (may need updates to expected filter strings — that's OK, update them).
- [ ] New unit tests on the filter-graph builder verifying that per-clip subgraph contains `ingest_filter_for(...)` output and that map ingest contains `map_ingest_filter()` output.
- [ ] Internal precision is `gbrpf32le` through the filter graph (verify by inspecting the assembled filter string).

## Out of scope

- Final delivery format and explicit output color tags — those are WS4.
- Per-export delivery target selection in the UI — WS5.
- HDR delivery — WS4 (different delivery formula).
- Log format ingest formulas — Phase 2 (WS10).

## References

- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — working space definition.
- [`../background/investigation-findings.md`](../background/investigation-findings.md) — PIP saturation root cause.
- [Canva: A journey through colour space with FFmpeg](https://www.canva.dev/blog/engineering/a-journey-through-colour-space-with-ffmpeg/) — overlay/compositing color drift.
