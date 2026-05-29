# PIPELINE_DECISIONS

Decision record for the picture-perfect map export sprint. Companion to `PIPELINE_RESEARCH.md`.

Each entry records:
- **The proposal** (1-2 sentence summary of what the research recommended)
- **Verification** (what the subagent confirmed against spec, codebase, and empirical testing)
- **Decision** (ACCEPT / REJECT / DEFER / MODIFIED)
- **Reasoning** (your notes on why)

---

## Cluster A — Color Science

### A1. Add `d=error_diffusion` and `f=spline36` to delivery finishing filters
*Split into two sub-decisions:*

**A1-dither** — Add `d=error_diffusion` to the three branches in `delivery_finishing_filter()` (`src-tauri/src/export/delivery.rs:147-163`).
- **Status: DEFERRED pending empirical verification.**
- Verification (subagent, 2026-05-22) confirmed the math direction is correct (dither breaks up flat regions) but the research doc's specific "166 → 198 unique greens" headline numbers do NOT reproduce on a controlled test input. The doc didn't disclose what input it actually tested on.
- Matthew has been running the tool and **cannot reproduce banding in actual exports**. This contradicts the doc's framing of "highest-impact fix."
- **Next action**: empirical test on a real export with a large flat-ish map region. If visible banding present → ACCEPT. If not → REJECT (no point fixing a non-problem; the doc's claim was inflated).

**A1-kernel** — Add `f=spline36` to the same three branches.
- **Status: ACCEPT.**
- This is about chroma downsampling quality (4:4:4 → 4:2:0), not dither. Default `bilinear` blurs sharp color edges; `spline36` preserves them. Free win for any frame with sharp color edges (route lines, waypoints, text on map).
- Independent of A1-dither — no reason to gate.

### A2. Keep `tin=iec61966-2-1` for map canvas ingest (the sRGB-EOTF / BT.709-EOTF residual)
*Status: pending walkthrough*

### A3. Working-space primaries: BT.2020-linear vs sRGB-linear
*Status: pending walkthrough*

### A4. Per-target conformance (the §2 table)
*Status: pending walkthrough*

### A5. Concrete diffs to `util/color.rs` and `delivery.rs`
*Status: pending walkthrough*

---

## Cluster B — Map Rendering Quality

### B1. Invert the pixelRatio strategy (always supersample)
*Status: pending walkthrough*

### B2. MapLibre constructor defaults (`antialias: true`, `preserveDrawingBuffer: true`)
*Status: pending walkthrough*

### B3. OpenFreeMap POI sprites are 1× — hide or fork
*Status: pending walkthrough*

### B4. Symbol-placement determinism additions
*Status: pending walkthrough*

---

## Cluster C — Plumbing / Correctness

### C1. Migrate working-space pix_fmt from `gbrpf32le` to `gbrapf32le` (alpha-preserving)
*Status: pending walkthrough*

### C2. Overlay default-format trap → CI assertion
*Status: pending walkthrough*

### C3. HDR HLG: ship with `hdr-opt=1:repeat-headers=1`
*Status: pending walkthrough*

---
