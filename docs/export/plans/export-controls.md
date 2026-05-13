# Export Controls — Implementation Plan

## Goal

Backend implementation for export quality controls. UI is **out of scope** (built in a separate session). The deliverable is plumbing: types on the wire protocol, parameters threaded through the pipeline, and tests. No new UI components, no styling, no UX copy.

## Scope

Four new user-facing knobs on the export pipeline:

1. **Resolution** — `720p | 1080p | 1440p | 2160p`. Default `1080p`.
2. **Frame rate** — explicit (`24 | 30 | 60`) or `Auto` (= max source fps, clamped to {24, 30, 60}). Resolved to a concrete `u32` in TS before reaching Rust.
3. **Codec preference** — `Auto | H.264 | HEVC`. Default `Auto`.
4. **Audio bitrate** — `128 | 192 | 256 | 320` kbps. Default `256`.

### Encoder-internal (not exposed)

- **CRF**: HEVC = 19, H.264 = 20. Same across all resolutions. CRF is a perceptual target — higher resolution naturally produces bigger files, which is correct.
- **libx264/libx265 preset**: `medium`.
- **VideoToolbox**: default behavior, no `-q:v` override (current pipeline).

### Out of scope

- UI work (separate session)
- Color/HDR/log handling
- Direct platform upload
- Custom resolutions / aspects
- Burn-ins / captions / watermarks
- Persistence into `project.json` (each export carries its own settings; the future UI can decide whether app state remembers last-used values)

## Architecture decisions

- **Resolution is the only orthogonal-to-quality knob.** Smaller files = pick a lower resolution. We do NOT expose CRF.
- **Same CRF across all resolutions** because CRF is perceptual. Bigger canvases just produce bigger files; that's the right behavior.
- **Rust never sees `Auto` fps.** TS resolves it in `compileExportRequest` and the wire format always carries a concrete `u32`.
- **Every new field is `serde(default = ...)`.** Old wire data (and existing tests) keep working without modification.
- **Codec preference does NOT silently fall back.** If the user picks HEVC and the system has no HEVC encoder, the export errors out cleanly — falling back to H.264 silently is worse than failing.

## Phases

Phases 1–5 below. Phase 1 is foundation; 2/3/4 are file-disjoint and can run in any order after 1; Phase 5 wraps up tests + smoke.

---

### Phase 1 — Protocol & type scaffolding

**Goal:** establish the new types and add fields to the wire protocol with sensible defaults. **No behavior change** — defaults preserve current output. After Phase 1, existing exports run unchanged.

**Rust changes:**

- New file `src-tauri/src/export/resolution.rs`:

  ```rust
  use serde::{Deserialize, Serialize};

  #[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
  pub enum OutputResolution {
      #[serde(rename = "720p")]  P720,
      #[serde(rename = "1080p")] P1080,
      #[serde(rename = "1440p")] P1440,
      #[serde(rename = "2160p")] P2160,
  }
  impl Default for OutputResolution {
      fn default() -> Self { Self::P1080 }
  }

  #[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
  #[serde(rename_all = "snake_case")]
  pub enum CodecPreference {
      Auto,
      H264,
      Hevc,
  }
  impl Default for CodecPreference {
      fn default() -> Self { Self::Auto }
  }
  ```

- Wire up in `src-tauri/src/export/mod.rs`:
  ```rust
  pub mod resolution;
  pub use resolution::{CodecPreference, OutputResolution};
  ```

- Add fields to `RenderExportRequest` (`src-tauri/src/export/mod.rs`):
  ```rust
  pub struct RenderExportRequest {
      // ...existing fields...
      #[serde(default)]
      pub codec_preference: CodecPreference,
      #[serde(default = "default_audio_bitrate_kbps")]
      pub audio_bitrate_kbps: u32,
  }
  fn default_audio_bitrate_kbps() -> u32 { 256 }
  ```

- Add `resolution` field to `LayoutDescriptor` (`src-tauri/src/export/layout.rs`):
  ```rust
  pub struct LayoutDescriptor {
      pub aspect: AspectRatio,
      #[serde(default)]
      pub resolution: OutputResolution,  // NEW — unused until Phase 4
      pub layout: LayoutConfig,
      pub resolved: SlotResolution,
  }
  ```

- **DO NOT** change `output_dims` or `resolve_slots` signatures in this phase. They stay 1-ary (`output_dims(aspect)`, `resolve_slots(layout, aspect)`). Phase 4 makes them resolution-aware. The new `LayoutDescriptor.resolution` field round-trips through serde but isn't consumed yet.

**TS changes:**

- New types in `src/lib/layout.ts`:
  ```ts
  export type OutputResolution = "720p" | "1080p" | "1440p" | "2160p";
  ```

- New types in `src/lib/exportRequest.ts`:
  ```ts
  export type CodecPreference = "auto" | "h264" | "hevc";
  export type FrameRateChoice =
    | { kind: "auto" }
    | { kind: "explicit"; fps: 24 | 30 | 60 };
  ```

- Extend `ExportInputs` (in `exportRequest.ts`) with **optional** fields (so existing callers don't break):
  ```ts
  resolution?: OutputResolution;          // default "1080p"
  codecPreference?: CodecPreference;       // default "auto"
  audioBitrateKbps?: number;               // default 256
  frameRate?: FrameRateChoice;             // default { kind: "explicit", fps: 30 }
  ```

- The compiled request shape must surface these in the wire JSON using **snake_case keys** to match Rust serde. Field naming:
  - `resolution` (on the layout descriptor)
  - `codec_preference`
  - `audio_bitrate_kbps`
  - `fps` (already exists; resolved from FrameRateChoice in Phase 2)

- Add `warnings: string[]` to the compiled request (defaults to `[]`). Phase 2 populates it for fps issues; Phase 3 may also push to it. Nothing reads it yet.

**Tests:**

- Rust: deserialize a `RenderExportRequest` JSON missing all new fields → defaults populate cleanly. Use existing test patterns in `mod.rs`.
- TS: `compileExportRequest` with no new fields produces the same compiled output as today plus the new defaults (snapshot or shape assertion).
- Existing tests must continue to pass without modification — this is a back-compat smoke test.

**Acceptance:**
- `cargo test` passes.
- `npm test` passes.
- No call site change required outside this phase's files.

---

### Phase 2 — Frame rate `Auto` resolution

**Goal:** resolve `frameRate: { kind: "auto" }` to a concrete fps based on visible clips' source frame rates. Remove the hardcoded `fps: 30` from `ExportModal.tsx`.

**TS changes:**

- In `src/lib/exportRequest.ts`, add a pure helper:
  ```ts
  export function resolveFrameRate(
    choice: FrameRateChoice,
    visibleClips: Clip[],
  ): { fps: number; warnings: string[] } {
    if (choice.kind === "explicit") {
      const maxSource = maxSourceFps(visibleClips);
      const warnings: string[] = [];
      if (maxSource != null && choice.fps > maxSource) {
        warnings.push(
          `Output fps ${choice.fps} exceeds max source fps ${maxSource}; frames will be duplicated.`,
        );
      }
      return { fps: choice.fps, warnings };
    }
    // Auto
    const maxSource = maxSourceFps(visibleClips) ?? 30;
    const snapped = maxSource >= 60 ? 60 : maxSource >= 30 ? 30 : 24;
    return { fps: snapped, warnings: [] };
  }

  function maxSourceFps(clips: Clip[]): number | null {
    const vals = clips.filter(c => c.visible).map(c => c.frame_rate).filter((f): f is number => typeof f === "number");
    if (vals.length === 0) return null;
    return Math.max(...vals);
  }
  ```

- Plumb through `compileExportRequest`: read `inputs.frameRate` (default `{ kind: "explicit", fps: 30 }`), call `resolveFrameRate`, store the result's `fps` on the compiled request, append warnings to the request's `warnings` array.

- Replace the literal `fps: 30` in `src/components/ExportModal/ExportModal.tsx:230` with the value coming out of `compileExportRequest`. The ExportModal callsite should not hardcode fps anywhere.

**Tests** (`src/lib/__tests__/exportRequest.test.ts`):

- Empty visible-clip list + `auto` → fps 30, no warnings.
- All clips report `frame_rate: 30` + `auto` → fps 30.
- Mixed `frame_rate: 30 | 60` + `auto` → fps 60.
- All clips at 24 + `auto` → fps 24.
- Clips with `frame_rate: undefined` + `auto` → fps 30 (the source-fps fallback).
- Explicit `{ fps: 60 }` with all 30-fps sources → fps 60, warning emitted.
- Explicit `{ fps: 30 }` with no visible clips → fps 30, no warning.

**Acceptance:**
- Existing 30-fps exports unchanged.
- A project with 60-fps clips and `frameRate: { kind: "auto" }` compiles to `fps: 60`.

---

### Phase 3 — Codec preference + audio bitrate

**Goal:** honor `codec_preference` in encoder selection; make AAC bitrate parameterizable.

**Codec preference** (`src-tauri/src/export/encoder.rs` + composite branch of `src-tauri/src/export/mod.rs`):

- Read `req.codec_preference` in the composite branch (currently `mod.rs:578` calls `select_channel_encoder(EncoderClass::Hevc)`).
- Map preference to candidate filter before probing:
  - `Auto` → current behavior (probe Hevc first; this is what `EncoderClass::Hevc` already does — it has a fallback ladder internally).
  - `H264` → call `select_channel_encoder(EncoderClass::H264)` instead.
  - `Hevc` → call `select_channel_encoder(EncoderClass::Hevc)` but on probe failure return a clear `RenderExportError` with `stage: "validation"` and message `"HEVC encoder not available on this system; choose H.264 or Auto."` **Do not silently fall back.**
- Audit `select_encoder` internals — if it currently has a silent H.264 fallback when Hevc fails, the `Hevc` preference path needs to bypass that fallback. Adding a `strict: bool` parameter or a separate `select_encoder_strict` function is fine; pick whichever is less invasive.
- Other channels (`ProResAlpha` for `map_only` / `video_only`) ignore the preference. ProRes is a Channel B/C internal format, not a user-facing codec.

**Audio bitrate** (`src-tauri/src/export/filtergraph.rs`):

- `aac_args()` (around line 1158) is currently a const helper used in tests. Replace it with a function:
  ```rust
  fn aac_args(kbps: u32) -> Vec<String> {
      vec!["-c:a".into(), "aac".into(), "-b:a".into(), format!("{}k", kbps)]
  }
  ```
- Plumb `audio_bitrate_kbps: u32` as a parameter through `build_composite_filtergraph` and any helpers that currently use the const.
- Update the composite branch in `mod.rs` to pass `req.audio_bitrate_kbps`.

**Tests:**

- Encoder probe filter test: with codec preference `H264`, the probe never tries Hevc candidates. With `Hevc` and no Hevc candidate available, returns a `RenderExportError` (no silent H.264).
- Filtergraph argv test: building with `audio_bitrate_kbps: 192` produces argv containing `["-b:a", "192k"]`.
- Existing composite filtergraph tests should be updated to pass `256` explicitly (or via a default helper) — they currently rely on the const.

**Acceptance:**
- Default exports unchanged (codec=Auto, audio=256k).
- Explicit codec preference respected; explicit Hevc on a non-Hevc system errors cleanly.
- Explicit audio bitrate respected in argv.

---

### Phase 4 — Resolution / output dimensions

**Goal:** make output canvas size variable per `OutputResolution`. The pipeline is mostly already prepared for this — the only deep changes are `output_dims`, `resolve_slots`, the parity check, and the parity fixture.

**Why this is shallower than initially feared:**
- The map renderer's `Viewport` is already wired to `map_slot.w / map_slot.h` from the resolved layout (`mod.rs:276-278`, `mod.rs:607` similar). Once `output_dims` produces larger dims, the map slot scales automatically.
- The corner mask rasterizer (`corner_mask.rs:41-45`) already takes `slot_w, slot_h, radius_px` as parameters. No code change needed.
- `build_composite_filtergraph` already accepts `output: OutputDimensions` and uses it in `pad=...`. No signature change needed beyond what flows through `resolve_slots`.

**Step 4a — `output_dims` becomes 2-ary** (`src-tauri/src/export/layout.rs:31`):

```rust
pub fn output_dims(aspect: AspectRatio, resolution: OutputResolution) -> OutputDimensions {
    let short = match resolution {
        OutputResolution::P720  => 720,
        OutputResolution::P1080 => 1080,
        OutputResolution::P1440 => 1440,
        OutputResolution::P2160 => 2160,
    };
    match aspect {
        AspectRatio::NineSixteen => OutputDimensions { w: short, h: short * 16 / 9 },
        AspectRatio::FourFive    => OutputDimensions { w: short, h: short * 5 / 4 },
        AspectRatio::SixteenNine => OutputDimensions { w: short * 16 / 9, h: short },
    }
}
```

Verify even dimensions for `yuv420p`:
- 720 → 1280 (16:9, 9:16); 900 (4:5)
- 1080 → 1920; 1350
- 1440 → 2560; 1800
- 2160 → 3840; 2700

All even ✓.

**Step 4b — `resolve_slots` becomes 3-ary** (`src-tauri/src/export/layout.rs:196`):

```rust
pub fn resolve_slots(
    layout: &LayoutConfig,
    aspect: AspectRatio,
    resolution: OutputResolution,
) -> SlotResolution {
    let output = output_dims(aspect, resolution);
    // ... rest unchanged
}
```

Update all callers. Notable: `clamp_layout` (line 298) and the parity check in `validate_request` (`mod.rs:128`). Both must thread `resolution` through.

**Step 4c — parity check reads `LayoutDescriptor.resolution`:**

In `mod.rs:128`:
```rust
let recomputed = resolve_slots(&req.layout.layout, req.layout.aspect, req.layout.resolution);
```

**Step 4d — mirror in TS** (`src/lib/layout.ts`):

- Mirror the 2-ary `outputDims(aspect, resolution)`.
- Mirror the 3-ary `resolveSlots(layout, aspect, resolution)`.
- Mirror `clampLayout` similarly.
- Update `src/lib/exportRequest.ts` to pass `resolution` through to the descriptor when building the request.

**Step 4e — update parity fixture** (`src-tauri/tests/fixtures/layout_parity.json`):

- Expand to cover all 12 combinations: 3 aspects × 4 resolutions.
- Both sides must compute identical `SlotResolution` for each combo.

**Tests:**

- New unit tests in `layout.rs`:
  - `output_dims(NineSixteen, P720)` → `{ w: 720, h: 1280 }`
  - `output_dims(FourFive, P2160)` → `{ w: 2160, h: 2700 }`
  - `output_dims(SixteenNine, P1440)` → `{ w: 2560, h: 1440 }`
- Mirror in `layout.test.ts`.
- Parity test runs all 12 cases through the fixture.

**Acceptance:**
- Defaults unchanged: P1080 produces today's exact dimensions.
- Building a `LayoutDescriptor` with `resolution: P2160` and aspect 9:16 produces a resolved `output: { w: 2160, h: 3840 }`.
- All call sites of `output_dims` and `resolve_slots` updated, no broken builds.

---

### Phase 5 — Tests + integration

**Goal:** integration coverage for the new surface area.

- Add a fixture/test for `RenderExportRequest` JSON missing all Phase 1–3 new fields → deserializes with defaults. (Confirms back-compat with any wire data captured before this change.)
- Add a TS integration test in `useExportQueue.test.ts` or a new file covering: compiling a job with `{ resolution: "2160p", frameRate: { kind: "auto" }, codecPreference: "h264", audioBitrateKbps: 192 }` and asserting the compiled wire payload contains all four.
- Update any existing test that asserts specific output dimensions to cover the new resolution param.
- Optional manual smoke test (document in the plan, but don't gate the PR on it): export one 2-second clip at each of `(720p, 1080p, 2160p)` × `(9:16, 16:9)` × `(h264, hevc)`. ffprobe each output to confirm dims and codec. Inspect visually for blurry map / corners at 2160p.

**Acceptance:**
- All tests pass.
- The default-path export (no new fields set) is byte-identical to pre-change exports given identical inputs.

---

## Verification

After **each phase**:
```
cd /Users/personal/Documents/trail-cut
cargo test --manifest-path src-tauri/Cargo.toml
npm test
```

Phase 4 additionally needs the parity test to pass:
```
cargo test --manifest-path src-tauri/Cargo.toml layout_parity
```

## Sequencing

| Phase | Depends on | Parallelizable with |
|---|---|---|
| 1 | — | (none — foundation) |
| 2 | 1 | 3, 4 |
| 3 | 1 | 2, 4 |
| 4 | 1 | 2, 3 |
| 5 | 1, 2, 3, 4 | — |

Phases 2/3/4 modify disjoint files (verified):
- Phase 2: `src/lib/exportRequest.ts`, `src/components/ExportModal/ExportModal.tsx`
- Phase 3: `src-tauri/src/export/encoder.rs`, `src-tauri/src/export/filtergraph.rs`, composite branch of `mod.rs`
- Phase 4: `src-tauri/src/export/layout.rs`, `src/lib/layout.ts`, validate_request in `mod.rs`, parity fixture
