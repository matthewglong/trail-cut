# Bundled log-to-Rec.709 LUTs (WS10)

This directory holds the official vendor LUTs that `F_ingest_{log_class}`
applies via FFmpeg's `lut3d` filter, per the Phase 2 ingest architecture
in `docs/color-pipeline/ARCHITECTURE.md` and the workstream brief in
`docs/color-pipeline/phase-2/WS10-log-luts.md`.

## How the pipeline finds them

The LUT bytes are embedded at compile time via `include_bytes!` in
`src-tauri/src/util/color.rs` (mirrors the `sRGB.icc` pattern in
`src-tauri/src/commands/ffmpeg.rs`). On first use, the bytes are
materialised to `$TMPDIR/trailcut-luts/{filename}` and the path is
handed to FFmpeg's `lut3d='{path}'` filter.

Each LUT file in this directory must be:
- A valid Adobe Cube format (`.cube`) file.
- Non-empty (>= 32 bytes — anything smaller is treated as a placeholder).
- Contain a `LUT_3D_SIZE` header line (the `lut3d` filter requires this;
  files without it are rejected as placeholders).

When a LUT file is missing OR fails those checks, `ingest_filter_for()`
falls back to the SDR-Rec.709 placeholder chain — same behaviour as
Phase 1. This is the documented graceful degradation path: shipping the
binary without a LUT yields flat/gray log footage rather than a hard
failure, and a user can drop their own properly-licensed LUT into this
directory before building from source.

## Licensing — why most slots are placeholders

Every major manufacturer's log-to-Rec.709 LUT is governed by an EULA
that does not unambiguously permit redistribution as part of a
third-party application binary:

| File | Vendor source | Redistribution status |
|---|---|---|
| `DJI_DLog_to_Rec709.cube` | DJI's "DJI Color Files" pack (D-Cinelike / D-Log packs on dji.com/support) | EULA grey — personal use permitted, third-party-app redistribution not explicitly granted |
| `GoPro_Protune_to_Rec709.cube` | GoPro's "ProTune to Rec.709" LUT (formerly Cineform Studio, now via gopro.com/support) | EULA grey — historically distributed freely but redistribution clause is ambiguous |
| `Canon_CLog_to_Rec709.cube` | Canon Professional Network LUT pack ("Canon Log to BT.709 Look") | Redistribution NOT permitted — Canon requires direct download via a Canon ID account |
| `Canon_CLog2_to_Rec709.cube` | As above (C-Log2 variant) | NOT permitted |
| `Canon_CLog3_to_Rec709.cube` | As above (C-Log3 variant) | NOT permitted |

Per the WS10 brief's "license restrictions on LUTs" guidance — "ship the
ones you can ship cleanly and leave clear TODOs for the others — don't
ship anything legally questionable" — this initial commit ships
**placeholder files only**. The ingest pipeline is wired up and tested
against the LUT-bearing filter shape; the actual LUT bytes are left to
either:

1. **The user**, who can download the LUT directly from the vendor and
   drop the `.cube` file into this directory before building from source
   (their own use of a vendor LUT in a locally-built binary is covered
   by every vendor's standard EULA).
2. **A future shipping commit**, once written permission is obtained
   from each vendor's licensing team (DJI / GoPro). Canon will likely
   never grant redistribution and is expected to remain user-supplied
   indefinitely.

Sony S-Log2/S-Log3 and Panasonic V-Log are explicitly out of scope per
the WS10 brief — defer to a follow-up workstream when those users
request it. Their `ingest_filter_for()` branches fall back to the SDR
placeholder chain unconditionally (no LUT lookup attempted).

## Adding a LUT (for users building from source)

1. Download the official LUT from the vendor's site (must be `.cube`
   format — convert from `.3dl` or `.dat` via FFmpeg or DaVinci Resolve
   if needed).
2. Rename to match the filename in the table above (case-sensitive).
3. Place in this directory.
4. Rebuild — the `include_bytes!` call picks up the new content at
   compile time; no source changes needed.

The largest grid size available is preferred for accuracy (65³ > 33³ >
17³). FFmpeg's `lut3d` filter handles any size; no config needed.

## Provenance log

Track here when a real LUT replaces a placeholder. Format:
`YYYY-MM-DD  filename  source_url_or_pack  license_grant_ref  grid_size`

(no entries yet — all slots are placeholders)
