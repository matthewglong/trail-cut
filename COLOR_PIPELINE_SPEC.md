# Color Pipeline Spec

**Purpose.** Define the data model, node taxonomy, and dispatcher contract that the TrailCut export pipeline uses to convert clip and map streams from their source color spaces, through a project-scoped working space, to a delivery target — without hardcoding the conversion paths.

**Relationship to existing docs.**
- `UNIVERSAL_WORKING_SPACE_REPORT.md` (UWSR) — the architectural framing: per-project working space, dispatch on (input class × delivery target × metadata confidence). This spec is the executable shape of UWSR's §7 dispatch table.
- `PIPELINE_RESEARCH.md` (PR) — the file:line ffmpeg diffs. Under this spec, PR's diffs become *outputs* of the dispatcher for the Consumer-SDR and Consumer-HDR project modes, not hand-authored chains.
- `PIPELINE_DECISIONS.md` — the existing ACCEPT/REJECT/DEFER ledger. This spec does not duplicate it; it provides the architecture that the decisions parameterize.

**Status.** Living document. Sections marked **LOCKED** are settled and implementable. Sections marked **TBD-grill-N** are pending design — see the open grills list at the bottom.

---

## 1. Color-axis model **[LOCKED]**

A color space is a 4-tuple of independent enums:

```rust
struct ColorSpace {
    primaries:  Primaries,   // Rec709 | Rec2020 | Ap1 | SGamut3Cine | ...
    transfer:   Transfer,    // Linear | Bt709Gamma | SrgbEotf | HlgOetf | PqOetf | SLog3 | ...
    range:      Range,       // Full | Limitedtm
    matrix:     Matrix,      // RGB | Bt709 | Bt2020NC | Bt601 | ...
}
```

The four axes are **independent dimensions**. A transform between two color spaces is a path through this 4-D coordinate space, decomposed into atomic single-axis steps plus a small set of non-axis-changing operators.

This is rejected: a `ColorSpace` modeled as an opaque named identity (`Bt709GammaLimited`, `LinearRec2020Full`). That model forces combinatorial registry growth — every new input format requires authoring edges from it to every existing space. The per-axis model lets a new input format add one or two enum variants (e.g., `Transfer::SLog3`, `Primaries::SGamut3Cine`) and automatically compose with every existing chain.

**Why "matrix" is an axis.** The matrix coefficients (`Bt709`, `Bt2020NC`, `Bt601`) describe how to convert RGB ↔ YCbCr. Inside linear-RGB-float land the matrix value is a label only; it has no effect. The axis exists so the dispatcher can track the boundary crossing and emit the correct flags at YCbCr ↔ RGB conversion points.

---

## 2. Node taxonomy **[LOCKED]**

v1 ships **seven** node kinds. The taxonomy is closed: every v1 transform is one of these.

### 2.1 Axis-change nodes (5)

| Node | Changes axis | Constraint |
|---|---|---|
| `TransferDecode { from, to: Linear }` | transfer | head of the linear-light region |
| `TransferEncode { from: Linear, to }` | transfer | tail of the linear-light region |
| `PrimariesMatrix { from, to }` | primaries | requires `transfer == Linear` |
| `MatrixSwap { from, to }` | matrix | only meaningful at RGB↔YCbCr boundary |
| `RangeConvert { from, to }` | range | travels with the RGB↔YCbCr boundary |

### 2.2 LinearLightOperator nodes (2)

Both consume linear-RGB-float at the working space's coordinate and produce linear-RGB-float at the same coordinate. No axis change. The renderer-validator allows them to appear anywhere between `TransferDecode` and `TransferEncode`.

| Node | Arity | Trigger |
|---|---|---|
| `Compositor` | 2 → 1 | always — `out = srcAlpha · map + (1 − srcAlpha) · video` |
| `ToneMap` (BT.2446 Method A) | 1 → 1 | clip transfer ∈ {HlgOetf, PqOetf} AND delivery target is SDR |

Inverse tone-mapping (SDR → HDR) is intentionally absent: per UWSR §7, the correct behavior is colorimetric lift, which is *identity in linear-RGB-float* — the SDR clip's linear values pass through unchanged and the OETF at the tail re-encodes to HLG/PQ. No operator needed; the SDR clip sits at its native brightness on the HDR canvas.

Gamut compression (e.g., ACES RGC) is a registered slot with no v1 occupant: every v1 input is a subset of every v1 working space, so no out-of-gamut values arise. When Cinema project mode ships with S-Gamut3.Cine / Wide Gamut 4 / REDWideGamutRGB inputs, a `GamutCompress` LinearLightOperator joins the taxonomy. Its addition does not change the dispatcher contract.

---

## 3. Ordering invariants **[LOCKED]**

The renderer-validator enforces four invariants. They are physical/mathematical truths, not heuristics. Combinations determine *which* rules fire, never *what* the rules are.

1. **`PrimariesMatrix` requires `transfer == Linear`.** An RGB-primaries 3×3 matrix is a linear operation on tristimulus values. Applying it to gamma-encoded values produces math that does not correspond to physical light mixing. Any primaries change is sandwiched by `TransferDecode` (before) and `TransferEncode` (after) when either end is non-linear.

2. **`MatrixSwap` only fires at an RGB↔YCbCr boundary.** Matrix coefficients describe RGB → YCbCr conversion. Inside linear-RGB-float, the matrix label has no effect.

3. **`RangeConvert` and chroma subsampling travel with the RGB↔YCbCr boundary.** Limited-vs-full range is a property of the encoded YCbCr representation; the range stretch lives in the same `zscale` invocation as the matrix conversion (zscale's `r=` parameter sits next to `m=`).

4. **`TransferDecode` is the head of the linear-light region; `TransferEncode` is its tail.** All `PrimariesMatrix`, `LinearLightOperator`, and gamut math happens strictly between them.

**Violation handling.** A chain that violates any of these is a bug in the dispatcher or coalescer, not a runtime condition. Loud test failure (per the project's loud-test-failures convention), no fallback path.

---

## 4. Working space as coordinate **[LOCKED]**

There is no universal working space. The working space is a *coordinate* in the 4-axis model, resolved per project mode:

```rust
fn working_space(mode: ProjectColorMode) -> ColorSpace {
    match mode {
        ConsumerSdr => ColorSpace { primaries: Rec709,  transfer: Linear, range: Full, matrix: Rgb },
        ConsumerHdr => ColorSpace { primaries: Rec2020, transfer: Linear, range: Full, matrix: Rgb },
        // v2+:
        Cinema      => ColorSpace { primaries: Ap1,     transfer: Linear, range: Full, matrix: Rgb },
        Salvage     => ColorSpace { primaries: Rec709,  transfer: Linear, range: Full, matrix: Rgb },
    }
}
```

The working space is the **rendezvous coordinate**:
- Every ingest chain (clip, map, future second-video) ends here.
- Every output chain begins here.
- All `LinearLightOperator` nodes (`Compositor`, `ToneMap`) run here.

Each project has exactly one working space. Cross-mode dispatch (mixed input/output) happens at the project-mode resolver, not by introducing a second working space mid-chain.

The `ProjectColorMode` enum's v1 variants and the policy that resolves a project to one — auto-detect vs explicit, mixed-input policy — are TBD-grill-3.

---

## 5. Performance contract **[LOCKED]**

The per-axis model is a compile-time abstraction. The renderer **coalesces** consecutive axis-change nodes into single `zscale=...` invocations.

**Contract.** For every `(ProjectColorMode, DeliveryTarget, input-clip ColorSpace)` triple, the emitted ffmpeg filter string must be at-least-as-compact as a hand-authored Model-A equivalent. That is: the dispatcher's chain must coalesce into the same number of `zscale` / `format` / `setparams` invocations a human author would write, with byte-identical flags.

**Enforcement.** Snapshot tests in `src-tauri/tests/` covering at minimum the v1 cells:
- Rec.709 SDR clip × {SdrH264, SdrH265, Prores}
- iPhone HLG clip × {SdrH264, SdrH265, HdrHlg, Prores}
- sRGB map ingest (every mode)

The snapshot reference for each cell is a hand-authored filter string derived from PR §3. A divergent emit fails the test loudly with a diff against the reference.

**Compile-time cost.** Negligible — chain construction is microseconds of Rust for chains of <20 nodes. Invisible against any actual render.

---

## 6. `ClipColor`, project color settings, and the cascade **[LOCKED]**

### 6.1 Persistence model — η

Only what the user authored is persisted. `stream_tags` and `inferred` are recomputed from the source file on every `resolve()` call. The file is the source of truth for what it claims; the user's setting is the source of truth for what they assert.

**Persisted on `Project` (project.json):**
- `color_setting: PartialColorSpace` — project-wide assertion that beats file tags for every clip in this project. Default: all-None.
- `chroma_siting_setting: Option<ChromaSiting>` — project-wide chroma-siting assertion. Default: None.

**Persisted on `Clip` (project.json):**
- `color.setting: PartialColorSpace` — per-clip assertion that beats project-setting and file tags for this specific clip. Default: all-None.
- `color.chroma_siting_setting: Option<ChromaSiting>` — per-clip chroma-siting assertion. Default: None.

**Recomputed on demand by `resolve()`:**
- `stream_tags: PartialColorSpace` — read fresh from ffprobe. Per-field `None` represents an absent VUI tag.
- `inferred: ColorSpace` — pure function of `stream_tags` + clip shape hints (resolution, codec). Always a complete 4-tuple; serves as the floor.

```rust
struct PartialColorSpace {
    primaries: Option<Primaries>,
    transfer:  Option<Transfer>,
    range:     Option<Range>,
    matrix:    Option<Matrix>,
}

struct ClipColor {
    setting: PartialColorSpace,
    chroma_siting_setting: Option<ChromaSiting>,
}

impl Default for ClipColor {
    fn default() -> Self {
        Self {
            setting: PartialColorSpace::default(), // all None
            chroma_siting_setting: None,
        }
    }
}
```

### 6.2 Cascade

Four layers per axis, strongest first:

1. **Clip setting** — `clip.color.setting[axis]`, per-clip exception
2. **Project setting** — `project.color_setting[axis]`, project-wide assertion
3. **Stream tag** — `stream_tags[axis]`, what ffprobe read from the file's VUI
4. **Inferred floor** — `inferred[axis]`, baked-in heuristic (always present)

The dispatcher reads `.effective` only. The introspection layers (`stream_tags`, `inferred`, `project_setting`, `clip_setting`) exist for future advanced UI; they are computed at resolve time and not stored.

```rust
fn resolve(project: &Project, clip: &Clip) -> ResolvedClipColor {
    let stream_tags = ffprobe_color_tags(&clip.source_path);
    let inferred    = fill_with_inference(&stream_tags, clip_shape(clip));

    let pick = |axis_clip, axis_project, axis_tag, axis_floor| {
        axis_clip.or(axis_project).or(axis_tag).unwrap_or(axis_floor)
    };

    let effective = ColorSpace {
        primaries: pick(clip.color.setting.primaries, project.color_setting.primaries,
                        stream_tags.primaries, inferred.primaries),
        transfer:  pick(clip.color.setting.transfer,  project.color_setting.transfer,
                        stream_tags.transfer,  inferred.transfer),
        range:     pick(clip.color.setting.range,     project.color_setting.range,
                        stream_tags.range,     inferred.range),
        matrix:    pick(clip.color.setting.matrix,    project.color_setting.matrix,
                        stream_tags.matrix,    inferred.matrix),
    };

    let chroma_siting_effective = clip.color.chroma_siting_setting
        .or(project.chroma_siting_setting)
        .or(stream_tags.chroma_siting)
        .unwrap_or(infer_chroma_siting(clip));

    ResolvedClipColor {
        stream_tags,
        inferred,
        project_setting: project.color_setting,
        clip_setting:    clip.color.setting,
        effective,
        chroma_siting_effective,
    }
}
```

### 6.3 Per-axis source badge

Falls out of the type structure with no additional state. The future advanced UI uses this to render which layer fed each axis:

```rust
enum AxisSource { ClipSetting, ProjectSetting, FromFile, Inferred }

fn source_of(axis: Axis, resolved: &ResolvedClipColor) -> AxisSource {
    if      resolved.clip_setting[axis].is_some()    { AxisSource::ClipSetting    }
    else if resolved.project_setting[axis].is_some() { AxisSource::ProjectSetting }
    else if resolved.stream_tags[axis].is_some()     { AxisSource::FromFile       }
    else                                             { AxisSource::Inferred       }
}
```

### 6.4 Naming

User-facing terms are "Clip color settings" and "Project color settings" — not "overrides." The cascade's precedence (settings beat file tags) is internal; the user is configuring their project, not overriding it. Internal field names match: `setting` per clip, `color_setting` per project.

### 6.5 Inference floor

`fill_with_inference(stream_tags, clip_shape)` is a pure function. v1 rules, applied per axis when the corresponding `stream_tags` field is `None`:

- `primaries`: `Rec.709` for HD/UHD (≥720 lines), `Rec.601` for SD (<720 lines)
- `transfer`:  `Bt709Gamma` (SDR consumer default)
- `range`:     `Limited` (standard for H.264/HEVC delivery)
- `matrix`:    matches `primaries` choice — `Bt709` for HD/UHD, `Bt601` for SD

Not user-editable in v1. If these prove wrong for a camera class, the fix is improving the rule, not exposing a knob.

### 6.6 Schema migration

`CURRENT_SCHEMA_VERSION` bumps v8 → v9. The `migrate_v8_to_v9` function in `commands/project.rs` sets:
- `project.color_setting = PartialColorSpace::default()` (all-None)
- `project.chroma_siting_setting = None`
- Every clip: `clip.color = ClipColor::default()`

Structural only — no inference runs and no ffprobe is called during migration. The first `resolve()` at export time populates `stream_tags` and `inferred` fresh.

### 6.7 v1 UI surface

Zero. Both project and clip settings default to all-None on every new project and every imported clip. No panel, no badge, no advanced disclosure surfaces them. The data model is built; the UI is a future-additive delivery that does not require touching the data model.

## 7. `ProjectColorMode` v1 surface **[TBD-grill-3]**

Open: which variants ship in v1 vs stub `unimplemented!()`; auto-detect from first imported clip vs explicit on project create; mixed-project policy (auto-promote / tone-down / refuse).

## 8. Transform node shape **[TBD-grill-4]**

Open: what each node carries beyond `(input_space, output_space)` — ffmpeg fragment, typed kind, validator hooks, cost metadata.

## 9. Registry & dispatcher algorithm **[TBD-grill-5]**

Open: lookup table vs graph traversal; how `LinearLightOperator` nodes are inserted into chains; how the dispatcher decides *which* working space to rendezvous at when inputs and outputs disagree.

## 10. Renderer contract & coalescer **[TBD-grill-6]**

Open: chain → ffmpeg filter string emission rules; coalescing algorithm; encoder argv attachment.

## 11. Map ingest as peer chain **[TBD-grill-7]**

Open: does the map run through the same dispatcher with a fixed `ClipColor`-equivalent (sRGB / Full / RGB), or a dedicated path? The shared-data contract (`src/lib/mapVisuals/`) is the constraint.

## 12. Alpha in the spec **[TBD-grill-8]**

Open: where the alpha-bearing-format requirement lives — per node, per working space, both. `gbrapf32le` migration plan (PR §3.4) drops in here.

## 13. Inferred-metadata UI contract **[TBD-grill-9]**

Open: clip-settings surface for stream-tag absence; per-clip override round-trip into `ClipColor`; "inferred" badge.

## 14. Failure modes **[TBD-grill-10]**

Open: no-path-found behavior, contradictory metadata, user-override conflicts with stream tags, unsupported input transfer.
