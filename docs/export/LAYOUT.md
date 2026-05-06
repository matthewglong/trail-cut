# TrailCut Export — Layout System Design

**Status**: Design decisions captured; implementation pending.
**Companion to**: [`docs/export/PLAN.md`](./PLAN.md) — renderer architecture, channels, IPC contract.
**Date**: 2026-05-05

## Scope

This document settles the open questions in PLAN.md's "Open: layout system" section: layout primitives, aspect ratios, layout × aspect matrix, per-clip overrides, map slot viewport invariant, video-side effects pipeline, audio, and (added during design) channel output formats and the masked-export decision for Channels B and C.

It does NOT cover: layout configurator UI design (drag affordances, exact snap targets), filtergraph code itself, per-clip layout overrides (deferred to v2 with animated transitions), or schema migration details.

## 1. Layout modes

For v1, two named layout modes — **PiP** and **Split**. The user picks one per aspect; each is configured independently.

### PiP (Picture-in-Picture)

- One source fills the output frame as background.
- The other source is an inset rectangle on top.
- **Swap axis**: user chooses which source is the inset (map or video). Both directions are valid use cases.
- Inset rect is freely positioned, freely sized, any aspect.
- v1 supports a `corner_radius` on the inset for the polished social-media look.
- UI provides snap targets (golden ratio, common aspects, edges/corners). Snap behavior is a UI concern; the data model just stores the resolved rect.

### Split

- Frame is divided into two non-overlapping regions by a single divider.
- **Swap axis**: user chooses which side has the video (vs. map). Surfaced as a swap icon on the divider in UI.
- Divider position is freely chosen along its axis, no constraint.
- **Divider orientation is dictated by output aspect**:
  - 16:9 → vertical divider (left/right).
  - 9:16 and 4:5 → horizontal divider (top/bottom).
- Inverse-orientation splits (vertical divider in 9:16, horizontal in 16:9) are not supported in v1.

### What lives in a layout config

- Mode (PiP or Split).
- Swap state (which source is inset, or which side has video).
- Mode-specific geometry:
  - PiP: inset rect (`x`, `y`, `w`, `h`) and `corner_radius`.
  - Split: divider position (0..1).

### What does NOT live in a layout config

- Source video processing (trim, speed, focal-point crop) — clip-level, not layout-level.
- Map content settings (style, bearing, zoom) — already in `Project.map_settings` and `Clip.map_overrides`.
- Output frame dimensions — those come from the chosen aspect, not the layout.

## 2. Output aspects

Three aspects for v1, with fixed pixel dimensions:

| Aspect | Dimensions | Primary platforms |
|---|---|---|
| 9:16 | 1080×1920 | Stories, Reels, TikTok, YouTube Shorts |
| 4:5 | 1080×1350 | Instagram feed |
| 16:9 | 1920×1080 | YouTube horizontal, landscape |

Output dimensions are **fixed by the chosen aspect**, not derived from the layout's slot dimensions. The layout decides how the output frame is internally divided; it does not decide the frame's overall size.

## 3. Layout × aspect matrix

Both layout modes work at all three aspects:

| | PiP | Split |
|---|---|---|
| 9:16 | ✓ free inset | ✓ horizontal divider (top/bottom) |
| 4:5 | ✓ free inset | ✓ horizontal divider (top/bottom) |
| 16:9 | ✓ free inset | ✓ vertical divider (left/right) |

## 4. Configuration scope and per-clip overrides

### v1: project-level, per-aspect

The project model holds one layout configuration per aspect. When the user picks an export aspect, that aspect's configured layout loads. Each aspect's layout is configured independently — switching aspects in the editor switches to that aspect's stored layout.

```
project.layouts: {
  aspect_9_16: LayoutConfig | null
  aspect_4_5:  LayoutConfig | null
  aspect_16_9: LayoutConfig | null
}
```

(Names illustrative; concrete schema follows existing `project.json` patterns.)

### Per-clip map content already works

`Project.map_settings` + `Clip.map_overrides` already exists ([`src-tauri/src/models.rs`](../../src-tauri/src/models.rs)). A clip can override map style, zoom, bearing, etc. — that determines what the map slot's contents *look like* at that clip, independent of where the slot sits in the frame. Unaffected by the layout system.

### v2+ per-clip layout-geometry overrides

The data shape leaves space for per-clip layout overrides as a sparse `Option`-mirrored field on `Clip`, mirroring the existing `MapSettings`/`MapOverrides` pattern. Adding per-clip layout later is a one-field migration, not an architectural change.

Per-clip layout-geometry is intentionally NOT shipped in v1 because changing layout geometry between clips without an animated transition is visually jarring. Per-clip layout overrides naturally ship together with animated layout transitions — they are the same v2+ feature.

## 5. Map slot viewport invariant

The map renderer's viewport equals the **map slot's pixel dimensions** in the configured layout, not the output frame's dimensions.

`resolveIntent(cameraAt(t), viewport)` is called with the slot viewport. Region-style cameras resolve their concrete framing against the slot's aspect, so map framing adapts to slot shape.

### v1 consequences

- One map viewport per export run. The renderer worker is configured once at boot with slot dimensions and renders all frames at that viewport.
- Different export aspects → different layouts → different slot dimensions → different viewports. But each export action is one viewport.
- The orchestrator's frame-pipeline ordering is unaffected — there are no mid-stream viewport changes in v1.
- v2 per-clip layouts will introduce mid-stream viewport changes; the worker boot/recycle protocol already supports this since `map.render` accepts viewport per call.

### Live preview drift (known v1 limitation)

The editor's `MapView` pane currently renders the map at the editor's pane size, not the export's slot. Region-style cameras resolve to different concrete framings at different viewports, so what the user sees in preview will not exactly match what they get at export.

This is a UI-side issue, not an export-correctness issue. Long-term resolution: the editor preview should render the actual export frame (full layout composited at the chosen aspect) for WYSIWYG. For v1, this drift is documented as a known limitation; export correctness is unaffected.

## 6. Channels and output formats

Three export channels (per PLAN.md), each at the full chosen-aspect output dimensions. **Channels B and C are masked positional exports**: full-frame ProRes 4444 with alpha, with content positioned at its layout slot rect and alpha=0 elsewhere.

| Channel | Content | Output dim | Slot positioning | Codec / Container |
|---|---|---|---|---|
| **A. Composite** | Map + video composited per layout | Full chosen-aspect dim | Slots at layout positions, opaque background | H.265 in `.mp4`, CRF ~17 |
| **B. Map only** | Map slot only | Full chosen-aspect dim | Map slot at its layout position; alpha=0 elsewhere | ProRes 4444 in `.mov` with alpha |
| **C. Video only** | Video slot only | Full chosen-aspect dim | Video slot at its layout position; alpha=0 elsewhere | ProRes 4444 in `.mov` with alpha |

### Why masked B and C

A user can stack B.mov and C.mov in any NLE (Resolve, Premiere, FCP, Avid) and reconstruct A's composite with **no positioning work** — both files have identical dimensions and their content already lines up with the layout. This is the "compositing intermediate" the user actually wants when re-cutting in another editor.

### Format choice rationale

- **Channel A is a deliverable**: typically uploaded directly to social media. H.265 in `.mp4` at CRF ~17 is visually lossless to the eye, ~400 MB/min at 1080p, plays everywhere. Hardware-accelerated encoding per the encoder-probing logic in PLAN.md.
- **Channels B and C are compositing intermediates**: ProRes 4444 in `.mov` with alpha is the industry-standard intermediate codec — visually lossless, ~700 Mbps (~5 GB/min at 1080p), universal NLE support on both Mac and Windows. FFmpeg encodes via `prores_ks -profile:v 4444 -pix_fmt yuva444p10le`.

### PiP-specific positioning

In PiP, the "background" source's slot dim equals the full output frame dim; the "inset" source's slot is the inset rect. So:

- B in PiP-with-map-as-inset: the map renders at inset-rect dims, positioned at the inset rect within an alpha canvas. Alpha=0 outside the inset rect.
- C in PiP-with-video-as-background: the video renders at full output frame dims (its slot is the whole frame). Alpha=1 everywhere.
- Logic inverts when the swap selects the other source as inset.

### Corner radius

- v1's PiP inset supports a `corner_radius` on the inset rect.
- Implemented as an antialiased alpha mask on the inset's rectangle. ProRes 4444's alpha channel handles antialiased edges correctly.
- For Channel A: corner radius cuts the inset's pixels — the rounded-rect interior shows the inset; outside the rounded rect, the background source shows through.
- For Channels B and C: the corner radius applies to the slot's alpha mask. The inset's rounded corners produce alpha falloff at the corner curves.

## 7. Video-side effects pipeline

Per-clip edits (trim, speed, focal-point crop) translate to FFmpeg filters at export time. The same per-clip chain produces the video stream that feeds **both** Channel A's video slot and Channel C's video slot — both target the same dimensions (the layout's video slot dims), so the per-clip processed video is identical between A and C.

### Per-clip video chain

```
[input_v] →
  trim=start=in_s:end=out_s →
  setpts=(PTS-STARTPTS)/speed →
  crop=crop_w:crop_h:crop_x:crop_y →     # focal-point crop to target aspect
  scale=target_w:target_h →              # target = video slot dims
  [out_v]
```

### Per-clip audio chain

```
[input_a] →
  atrim=start=in_s:end=out_s →
  atempo=speed                           # chained for speeds outside [0.5, 2.0]
  [out_a]
```

`atempo` accepts factors in [0.5, 2.0] per instance; out-of-range speeds chain instances (e.g., `atempo=2.0,atempo=2.0` for 4×; `atempo=0.5,atempo=0.5` for 0.25×).

### Where the math lives

Filtergraph generation (Rust, at export time) computes:

- `target_w, target_h` from the layout's video slot dims at the chosen aspect.
- `in_s, out_s` from `clip.trim` (ms → seconds).
- `speed` from `clip.effects.speed`.
- Focal-point crop:
  - source dims = `src_w × src_h`
  - aspect-fit crop = largest target-aspect rectangle inside source.
  - punch-in: divide aspect-fit dims by `clip.focal_point.zoom`.
  - center: align crop center with `(focal_point.x × src_w, focal_point.y × src_h)`, clamped to source bounds.

### `focal_point.zoom` semantics

- `zoom = 1.0`: aspect-fit (largest target-aspect rectangle inside source).
- `zoom > 1.0`: punch-in (tighter crop, less of source visible).
- `zoom < 1.0`: disallowed (no source pixels exist outside source bounds).

### Source: originals, not proxies

Exports use the original source video files, not the editor's 720p H.264 proxies. Proxies exist only for editor preview; export uses the highest-fidelity source available.

### Hidden clips (`visible: false`)

Hidden clips are excluded entirely from export:

- No video, no audio in the concatenated output streams.
- No time on the project-time axis (the compiled timeline already skips them).
- Map's `cameraAt(t)` evaluator already skips them (per existing compiled-timeline behavior).

### Per-channel composition

After per-clip processing and concatenation:

- **Channel A**: overlay the concatenated video stream onto the map render stream at the video slot's rect (with corner-radius alpha mask if PiP). Encode as H.265.
- **Channel B**: overlay the map render stream onto a transparent canvas at the map slot's rect (with corner-radius alpha mask if PiP and map-is-inset). Encode as ProRes 4444 with alpha.
- **Channel C**: overlay the concatenated video stream onto a transparent canvas at the video slot's rect (with corner-radius alpha mask if PiP and video-is-inset). Encode as ProRes 4444 with alpha.

## 8. Audio

### Rule

- Per-clip source audio, passthrough.
- `atempo` matched to `effects.speed`, chained for extreme speeds.
- Clips concatenated in timeline order.
- No music track in v1.

### Per-channel

| Channel | Audio |
|---|---|
| A | Source-audio passthrough (with `atempo`) |
| B | Silent — map only, no source audio path |
| C | Source-audio passthrough (identical chain to A) |

Hidden clips contribute no audio (they contribute no time at all).

## 9. Open implementation questions

These are intentionally not settled here; they are next-task material:

- Concrete TypeScript and Rust types for `LayoutConfig` (PiP and Split discriminated variants), and the wire format for the `LayoutDescriptor` referenced in PLAN.md's IPC contract.
- Project-schema migration to add per-aspect layout storage. The existing `ExportConfig.layout: ExportLayout` field in `models.rs` is a placeholder from earlier design and will need restructuring; this is a v3→v4 schema bump.
- Layout configurator UI design: snap targets (which aspects, which positions, how golden-ratio is surfaced), drag affordances, default starting layouts per aspect, and the swap toggle UI.
- Live preview's framing strategy: stay mismatched to export (current), or redesign for WYSIWYG composite preview.
- Encoder-probing extensions: PLAN.md's probe focuses on H.264. ProRes 4444 is software-only via `prores_ks` — confirm performance and memory behavior on a representative export, and whether it warrants its own probe entry.

## 10. Decisions index

Quick reference for locked decisions from this design pass:

- **Layout modes**: PiP and Split.
- **Output aspects**: 9:16, 16:9, 4:5.
- **PiP**: free position, free size, any aspect; `corner_radius` supported in v1; swap (which source is inset) supported.
- **Split**: free divider position; orientation locked by aspect (16:9 → vertical, 9:16/4:5 → horizontal); swap (which side has video) supported.
- **Configuration scope**: project-level, per-aspect. Per-clip layout-geometry overrides deferred to v2 (paired with animated transitions). Per-clip map *content* overrides already work via existing `MapOverrides`.
- **Map viewport invariant**: render viewport = map slot's pixel dims in the configured layout. Live preview drift is a known v1 limitation.
- **Channel A**: H.265 in `.mp4`, CRF ~17 (visually lossless deliverable).
- **Channels B and C**: ProRes 4444 in `.mov` with alpha; full output dim canvas with content positioned at slot rect, alpha=0 elsewhere (masked positional export for compositing).
- **Per-clip video chain**: trim → setpts (speed) → focal-crop (to slot aspect) → scale (to slot dims).
- **Per-clip audio chain**: atrim → atempo (chained for extreme speeds).
- **Source for export**: originals, not proxies.
- **`focal_point.zoom`**: ≥ 1.0 only; 1.0 = aspect-fit, > 1.0 = punch-in.
- **Hidden clips**: excluded entirely from export.
- **Audio**: source-passthrough, `atempo` for speed; A and C have audio, B is silent; no music in v1.
