# Design Decisions

The architectural choices that landed during planning, with the rationale that drove each. When a workstream brief references "the working space choice" or "the per-export delivery model," this document is the source.

## Decision 1 — Working space is linear-light, wide-gamut, float precision

**Options considered:**
- **A. BT.709 SDR limited-range working space.** Cheap, simple, what most consumer tools do. Cannot ever export HDR from a project once ingested.
- **B. Linear-light, BT.2020 primaries, float precision.** Heavy, future-proof. Same project can export SDR (any target) and HDR.
- **C. Project-typed (SDR project vs HDR project).** User picks at project creation; SDR projects use option A, HDR projects use option B.

**Chosen: B.** Two reasons:

1. **YouTube 4K HDR is in scope.** The user confirmed delivery targets include YouTube 4K, not just TikTok/Instagram. Hiking footage (alpenglow, snowfields, deep canyon shadows) is exactly the content type where HDR delivery pays off. Locking to SDR forecloses this.
2. **Source variety eliminates the "SDR-only project" use case.** Sources include iPhone (HDR by default since iPhone 12), GoPro HERO 10+ (HLG by default), DJI drones, Canon DSLRs. Almost no user has an SDR-only project. Option C's "SDR project type" would be a fringe case for users who explicitly turned HDR off — not worth the cognitive cost of a project type chooser.

**Cost accepted:** ~10–20% slower export (extra linearization steps), more complex FFmpeg filter graphs, more test surface. Worth it for the universal delivery capability and clean log-format handling in Phase 2.

## Decision 2 — Delivery target is a per-export choice, not a project property

**Pattern:** one project → many delivery formulas. Pick the target at export time. Multi-export (batch render TikTok + YouTube HDR from the same edit) is a first-class feature.

**Why:** the working space holds everything; the delivery transform is just the last step. Architecturally cheap to expose per-export. UX-wise it matches what users expect from social media workflows ("publish to all platforms").

**Per-target list:** `social_sdr_vertical` (TikTok/IG Reels), `social_sdr_square` (IG feed), `youtube_sdr_4k`, `youtube_hdr_4k`, `prores_master`.

## Decision 3 — Export reads source, not proxy

**Enterprise pattern.** Proxies are an editing-speed convenience for fast scrubbing during edit. Final delivery always reads from the original source files and re-runs the same ingest transform.

**Why not export from proxy:** proxies are 720p, CRF 28 H.264 — quite lossy. Using them at delivery means a second generation of compression on top of the source's first generation, visible quality loss on the final.

**The "preview matches export" property** comes from both paths sharing the same `F_ingest_{class}` formula, not from export reading the proxy file itself.

**Future option deferred:** a "draft export from proxy" mode (faster, lower quality) is feasible but not in scope. The orchestrator plumbing differs slightly; revisit if requested.

## Decision 4 — Proxy is always SDR

**Constraint:** WKWebView (the macOS browser engine inside Tauri) does not reliably display HDR video. Even if a proxy carries HDR color tags, the `<video>` element's rendering is inconsistent across macOS versions.

**Therefore:** proxies are always tone-mapped to BT.709 SDR at generation time, regardless of working space or source.

**Implication:** preview-matches-export holds exactly for SDR delivery targets. HDR exports are previewed as their SDR equivalent (close enough to be useful for editing decisions). Documented to the user explicitly.

## Decision 5 — Auto-detect HDR, manually declare log

**Detection reliability matrix:**

| Source type | Detection signal | Reliability |
|---|---|---|
| SDR Rec.709 | `transfer=bt709` | Universal |
| HLG HDR | `transfer=arib-std-b67` | Universal |
| PQ HDR | `transfer=smpte2084` | Universal |
| Dolby Vision | `side_data_list` contains DOVI | Universal |
| D-Log | None (tags as `bt709`) | Not detectable from color metadata |
| C-Log | None | Not detectable |
| GP-Log | None | Not detectable |
| V-Log, S-Log | None | Not detectable |

**Decision:** auto-detect what's reliable; require manual declaration for log formats.

**Why not auto-detect log from camera metadata:** container metadata can suggest log (DJI Mavic + 10-bit + bt709 → probably D-Log), but false positives are destructive. Applying a D-Log → 709 LUT to a plain Rec.709 clip crushes shadows and oversaturates colors badly. Enterprise editors (Resolve, Premiere, Final Cut, Avid) all require user declaration for H.264/H.265 log footage — none of them auto-apply LUTs even when they have high-confidence metadata suggestions.

**Phase 2 approach:** detect from camera metadata, surface as *suggestion* in UI, require explicit user confirmation before applying LUT.

## Decision 6 — Group-level format declaration is the workflow win for log

**Pattern borrowed from enterprise editors:** when importing 50 drone clips, declaring "D-Log" once for the whole group is the difference between a tolerable workflow and a punishing one.

**UI shape (Phase 2):**
- During import, group clips by `(camera_make, camera_model)` from container metadata.
- For each group, show: "32 clips from DJI Mavic 3 detected — set source format for all: [Auto-detected: D-Log (suggested) ▼]".
- One click applies to all 32. Per-clip override remains available in the Inspector.
- Persist per-camera preferences: if user always declares Mavic as D-Log, store the preference and auto-suggest on next import.

## Decision 7 — Log support is Phase 2

**Why deferred:** the three reported bugs (washout, PIP saturation, QuickTime warnings) are independent of log support. Fixing them requires Phase 1 only. Log support is a meaningful chunk of work (LUT licensing, knowledge base, UI) that would slow the bug fix if bundled.

**Phase 1 behavior for log footage:** treated as plain SDR. Looks flat (as it does today), but the pipeline doesn't *break* on it. Per-clip override dropdown ships in Phase 2 to fix it.

## Decision 8 — Out-of-scope items, named explicitly

To prevent scope creep during execution:

- **HDR proxy preview** — blocked on browser/WKWebView HDR support; not solvable at our layer.
- **Custom user LUT import** — defer indefinitely; revisit if requested.
- **Per-clip manual color grading** (lift/gamma/gain, curves, scopes) — separate future design.
- **ACES color management** — overkill; the linear-light working space gives 90% of the benefit at a fraction of the complexity.
- **More LUTs** (Panasonic V-Log, Sony S-Log, Blackmagic Film) — add reactively as users ask.
- **Dolby Vision RPU preservation** — discarded for Phase 1; treat DV as HLG base layer.
- **HDR delivery beyond HLG** (PQ delivery, Dolby Vision delivery) — Phase 1 ships HLG only.
