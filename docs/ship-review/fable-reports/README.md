# Fable handoff reports — 2026-07-07

Deep-dive reports produced in the final Fable session before the model
transition, in priority order. Each is a decision-grade analysis of an area
where deep reasoning was the bottleneck; execution can be carried by later
sessions/models working from these documents.

Provenance: five parallel Fable agents, each briefed with the CANON/PROGRESS
state and the standing project rules (no leveling down, HDR co-equal, loud
test failures, no human time estimates). `docs/ship-review/PROGRESS.md` and
`docs/CANON.md` remain the authorities — these reports feed decisions; any
decision Matthew makes from them gets recorded back into PROGRESS/CANON.

## The reports and their recommendations

| # | Report | Recommendation (details + evidence inside) |
|---|--------|--------------------------------------------|
| 1 | [01-pq-temporal-crawl.md](01-pq-temporal-crawl.md) | **Re-eyeball HLG/PQ first** — the libx265 fix (`1345ded`) removed the encoder mush that sat on top of the crawl; it may now read as acceptable grain. Land the §B temporal gate **with the red-team correction: measure coherent σ (σ of the spatial mean), not per-pixel σ**. ⚠️ **The report's dither fallback was REFUTED by adversarial verification** (appended in-file): libx265 crf17 zeroes ≤3-code temporal dither while the coherent crawl survives — the report validated dither pre-encode only, where it ships dead. If the eyeball fails, the surviving levers are the **higher-bit map wire** or **acceptance**. Diagnosis + all citations confirmed; higher SSAA is a no-op on this defect. |
| 2 | [02-hdr-to-sdr-tonemap.md](02-hdr-to-sdr-tonemap.md) | Splice at **per-clip ingest** (HDR-origin + SDR-delivery gated, like the ×2.03 anchor) — **architecture CONFIRMED by adversarial verification** (map byte-untouched, clean gbrpf32le float negotiation, no silent scaler, invariants preserved); operator **mobius** (zscale has no tonemap op; libplacebo fails on macOS — probed). ⚠️ **Two blockers before implementing** (verification appended in-file): (1) the `!is_hdr()` gate also catches **ProRes** — HLG/PQ→ProRes archival masters would get tone-mapped; ProRes must be excluded (the "disjoint cells" enumeration missed it); (2) **`peak=6` reintroduces a hard clip** — HLG max is linear 10.0 at npl=100, so 600–1000 nits plateaus at 255, violating the report's own gate; peak must be content-driven (HLG=10, PQ=MaxCLL). Also: §B numbers are full-range vs production limited-range; mixed SDR+HDR timelines seam ~15% at diffuse white; preview convergence can't track a per-export peak. |
| 3 | [03-ffmpeg-licensing-ship-deps.md](03-ffmpeg-licensing-ship-deps.md) | **The task-130 "must be LGPL" premise is wrong** — ffmpeg is a pure subprocess (mere aggregation), so bundle a **full-GPL ffmpeg and comply for that binary** (co-hosted source, LICENSES dir, written offer). $0, keeps libx265. Patents are a separate axis (likely ~$0, needs a lawyer's yes/no). **Hard fork: Mac App Store is GPL-incompatible** — distribution channel is open question #1. Retire the LGPL wording in CANON §6.2 when accepted. |
| 4 | [04-upstream-maplibre-pr.md](04-upstream-maplibre-pr.md) | **Post patch 1 now** (cold binding file, applies clean to v6.5.0-pre.1); keep patch 2 vendored with a PR drafted; **do NOT upstream patch 3's imperative shape** — upstream shipped the declarative equivalent in GL JS (`*-layer-opacity`) with an open native request; check if our pinned GL JS 5.22.0 lets us retire the preview halo patch. Drift risk today: near-zero. |
| 5 | [05-windows-port-risks.md](05-windows-port-risks.md) | 19-row register. Port-shaping risk: **both 2026-07 patches are Metal-only and the Windows node binding is OpenGL** (win32 prebuilts ship, but halo compositing silently no-ops and GPU downsample reverts to the CPU bottleneck). Cheapest-first: fix `HOME` env read (`util/fs.rs:9` breaks recents/probe-cache/presets on Windows) + `CREATE_NO_WINDOW`, then run the patch probe that sizes the whole port. Filtergraph argv vs the 32k CreateProcess ceiling → move to `-filter_complex_script`. |

## Cross-report findings (things no single report owns)

- **Silent halo failure off-Metal — convergent finding of 04 and 05, and the
  one latent fail-loud violation.** Patch 3 (group-composite) advertises its
  capability marker unconditionally (`ensure-binding.mjs`), but only the Metal
  backend honors it; on the Windows OpenGL binding the halo compositing
  silently no-ops **and passes the loud guard**. Gate the capability honestly
  (or implement the GL path) before any Windows work — small, well-specified
  in report 04 §C / report 05 risk #1. Fold into the next session that
  touches halo code.
- **Reports 1 and 2 are the same lane and compose cleanly**: the tone map is
  ingest-side, the dither (if needed) is delivery-side pre-OETF; disjoint
  splice points, no interaction. The tone-map oracle (pin today's clipping)
  can land immediately without deciding the crawl question.
- **Report 3 unblocks report 5's encoder row**: the Windows encoder story is
  libx265-first everywhere (candidate lists already exist, `encoder.rs`),
  which only works if the GPL-bundle path is accepted.

## Decision queue for Matthew (each report has the full framing + a rec)

1. Distribution channel: direct download vs Mac App Store (report 3 — hard
   fork; everything else in that report follows from this).
2. Re-eyeball HLG/PQ post-encoder-fix; accept-or-dither call (report 1).
3. Tone-map look: mobius/peak≈6 rec; preview-convergence now vs task-120
   (report 2).
4. Post patch 1 upstream under your name/org (report 4).
5. Windows probe sequencing — approve the cheapest-first list (report 5).

Status note at time of writing: `main` is 13 commits ahead of `origin/main`
(everything since the Phase 4 re-gate — native cutover, crispness fix,
fix C′, marker library v11, halo compositing). Local-only per the standing
push hold; flagged as a backup risk.
