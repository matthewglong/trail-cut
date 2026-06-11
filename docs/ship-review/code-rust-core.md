# Ship Review — Rust Core (outside `export/`)

**Scope:** `src-tauri/src/models.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/commands/`
(`project.rs`, `media.rs`, `gpx.rs`, `ffmpeg.rs`, `encoder.rs`, `recent.rs`,
`camera_presets.rs`), `src-tauri/src/util/` (`color.rs`, `color_space.rs`,
`log_detection.rs`, `exiftool.rs`, `hash.rs`, `fs.rs`).
**Date:** 2026-06-11. **Branch at review time:** `feat/control-panel` (note:
`src-tauri/src/util/color_space.rs` is **untracked** and `models.rs` / `commands/project.rs`
are **modified-uncommitted** — the entire schema-v9 / atomic-axes color work reviewed here
is uncommitted work riding on a control-panel branch).

Line counts: `models.rs` 1643, `commands/project.rs` 1921 (≈1200 of those are tests),
`commands/ffmpeg.rs` 1270 (≈620 tests), `util/color.rs` 1357 (≈650 tests),
`util/color_space.rs` 551 (≈170 tests), `lib.rs` 40.

---

## 1. Verdict in one paragraph

This is the **strongest-built region of the codebase reviewed so far**, not the soupiest.
Test density is high and the tests encode real contracts (byte-equality of generated FFmpeg
strings, migration fixtures per schema version, read-time-only backfill guarantees). The
new `util/color_space.rs` atomic-axes registry is a genuine deep module — exactly the
Ousterhout direction the owner wants — and `util/color.rs` is mid-migration onto it, not a
duplicate. The soup signals that DO exist are: (a) the `Clip` / `ClipMetadata` field
mirror in `models.rs` (every color field exists 3× counting TS), (b) the proxy/thumbnail
filter chains in `commands/ffmpeg.rs` that still hardcode the color strings the registry
was built to own, (c) pervasive stringly-typed model fields (`mode: String`,
`shape: String`, `source: String`), and (d) two parallel versioning mechanisms in
`load_project` (explicit `schema_version` + field-presence sniffing). One genuine ship
risk: `save_project` is a non-atomic write fired by a ~1s auto-save loop.

---

## 2. Schema / migration design (`commands/project.rs` + `models.rs`)

### 2.1 Mechanism — sound

- Versions are explicit: `CURRENT_SCHEMA_VERSION: u32 = 9` at `models.rs:978`, with
  legacy files defaulting to v1 (`default_schema_version`, `models.rs:980-983`).
- Migrations are **value-level** (`serde_json::Value → Value`), chained, with a single
  final typed deserialize (`migrate_v8_to_v9`, `project.rs:406-412`). This is the right
  shape: a half-old file never has to round-trip through the current `Project` struct
  mid-chain.
- Unknown future versions fail **loud**: `project.rs:125-130` returns
  `"Unknown project schema version {} (this app supports v1–v9)"` instead of guessing.
- `save_project` always re-stamps `CURRENT_SCHEMA_VERSION` and strips the in-memory
  `route` (canonical source is `route.gpx`) — `project.rs:29-37`.
- The one *real* structural migration (v7→v8 flat→nested `map_settings` /
  `map_overrides`) is done carefully: sparse on overrides (only keys present in input land
  in output), idempotent (`!ms.contains_key(...)` guards), with per-key default fallbacks —
  `migrate_map_settings_to_v8` (`project.rs:416-513`) and `migrate_map_overrides_to_v8`
  (`project.rs:518-614`).
- Test corpus is excellent: per-version JSON fixtures (`V1_PROJECT_JSON` `project.rs:718`,
  `V2_...:787`, `V3_...:751`), full-chain load tests, and notably
  `load_does_not_overwrite_disk_when_backfilling_layouts` (`project.rs:1275-1314`) which
  pins "load is a non-side-effecting operation" as a byte-equality contract.

### 2.2 Accretion signals — real but contained

- **Version-stamp-only migrations.** Of 8 steps, 5 do nothing but write the version
  number: v1→v2 (`project.rs:187-194`), v2→v3 (`:215-222`), v4→v5 (`:270-277`),
  v6→v7 (`:326-333`), v8→v9 (`:392-402`). Only v3→v4 (drops `exports`, `:242-250`),
  v5→v6 (drops incompatible `last_export_selection`, `:298-306`), and v7→v8 do work.
  Purely-additive serde-default changes were given version bumps anyway, inflating the
  chain. Defensible ("make the bump load-bearing for the future") but it means the ladder
  grows by one arm per feature forever.
- **The dispatch ladder is hand-unrolled** (`project.rs:69-131`): nine `match` arms each
  spelling out the remaining chain. A `while version < CURRENT { raw = migrate_step(version, raw)? }`
  loop would collapse ~60 lines to ~6 and remove the copy-paste risk of a future v10 arm
  forgetting a step. Each step also carries a `#[cfg(test)]` typed-wrapper twin
  (`migrate_v1_to_v2` etc.) — more per-version boilerplate.
- **Second, implicit versioning mechanism layered on top.** `is_pre_100 =
  raw.get("selected_export_aspect").is_none()` (`project.rs:67`) drives the layouts
  backfill policy (`project.rs:133-167`): pre-100 bundles get null aspects re-seeded,
  post-100 bundles preserve nulls as user intent. The logic is correct and exhaustively
  tested (`project.rs:1170-1272`, `:1317-1362`), but it is **versioning by field
  sniffing**, coexisting with explicit `schema_version`. The honest design would have been
  a v-bump ("task 100" landed between v4 and v5 without one). This is the clearest
  example in this subsystem of history accreting into load-path code: ~35 lines of
  comments explaining tasks 080/100/110 to justify a three-case branch. Anyone touching
  layouts must now reconstruct that timeline.
- **`CURRENT_SCHEMA_VERSION` doc comment skips v8 entirely** (`models.rs:958-977`
  documents v3, v4, v5, v6, v7, then v9 — the v8 map-decorations restructure, the largest
  migration in the chain, is missing from the constant's own history). Symptom of doc
  accretion by append.

### 2.3 Ship-risk: non-atomic project writes — HIGH

`save_project` writes `project.json` with a direct `std::fs::write` (`project.rs:35`);
`create_project` (`:17`) and `rename_project` (`:629`) likewise. Per `CLAUDE.md` the
frontend auto-saves on a ~1s debounce, so this write fires constantly during editing. A
crash / power loss / full disk mid-write leaves a truncated `project.json` and the load
path has **no recovery** (parse error → project unopenable; there is no `.bak`, no
temp-file + `rename` swap). For an app shipping to thousands of users, write-to-temp +
atomic rename is table stakes. Same pattern in `recent.rs:94` and
`camera_presets.rs:59` (lower stakes — those files self-heal via `unwrap_or_default()`,
though that means a corrupted `recent.json` silently wipes the user's project gallery:
`recent.rs:15`, `camera_presets.rs:52`).

### 2.4 `delete_project` deletes an unvalidated path — MEDIUM

`project.rs:640-645`: `std::fs::remove_dir_all(dir)` on the raw string from IPC, with no
check that the directory is actually a `.trailcut` bundle (e.g. `project.json` exists, or
extension check). Any bug (or compromised webview) that passes the wrong path recursively
deletes it. One `if !dir.join("project.json").exists() { return Err(...) }` guard would
bound the blast radius.

---

## 3. `models.rs` — god-file assessment

It is large (1643 lines) but ~550 lines are tests and ~90 are serde-default free
functions; the type definitions themselves are coherent. The actual problems:

### 3.1 `Clip` / `ClipMetadata` mirror — MEDIUM (change amplification)

`ClipMetadata` (`models.rs:95-159`) and `Clip` (`models.rs:215-273`) duplicate **all
eight metadata fields and all six color fields**, plus a hand-written
`From<ClipMetadata> for Clip` (`models.rs:303-348`) that must be updated for every new
field, plus duplicated `effective_color_class()` impls (`models.rs:175-178` and
`:280-282`). Counting `src/types.ts`, every color field exists in **three places** that
must stay in sync by hand. The doc comment at `models.rs:237-242` openly explains the
duplication ("`ClipMetadata` is the import-time DTO"). A composition shape
(`Clip { meta: ClipMetadata, edit: EditState }` with `#[serde(flatten)]`) would delete the
mirror and the `From` impl. This is a textbook shallow-interface cost: the WS8
`suggested_log_class` addition alone touched 4 sites in this file
(`models.rs:154-155, 263-269, 344, plus tests`).

### 3.2 Stringly-typed settings — MEDIUM

`RouteSettings.mode: String` (`models.rs:432-433`), `CameraSettings.bearing_mode: String`
(`:395-396`), `WaypointsSettings.shape / label_mode / active_mode: String`
(`:493-499`), `PovSettings.pulse_style / pulse_rate: String` (`:576-579`),
`Waypoint.source: String // "clip" | "gpx" | "manual"` (`:838`). The codebase clearly
knows how to do typed wire enums (`TransitionFeel` `:859-865`, `ExportChannel`
`:907-913`, `WaypointPosition` tagged enum `:808-820`, `DecorationColor` `:374-379` are
all done properly). The string fields mean invalid states deserialize silently, the
TS-literal-union ↔ Rust contract is enforced nowhere, and renderer/preview consumers
must defensive-match. This is the same class of preview/export-divergence risk the
mapVisuals contract exists to prevent, one layer down.

### 3.3 Layering inversion — MEDIUM

`models.rs:1-3` imports `DeliveryTarget`, `ProjectLayouts`, `AspectRatio`,
`OutputResolution` from `crate::export::…` — the domain-model module depends on the
export-pipeline module, while `export/` depends on `models` back. The "core types" for
persistence live half in `models.rs`, half in `export/layout.rs` / `export/resolution.rs`
/ `export/delivery.rs`. Any fresh-start layering should pull persisted types into one
crate-level `model` layer with `export/` strictly downstream.

### 3.4 Default-function noise — LOW

~30 `fn default_*()` free functions (`models.rs:606-693`) because serde can't take
literals. Unavoidable with serde, but the overlay sizing defaults
(`default_overlay_route_width` etc., `:634-663`) duplicate numbers that also exist in
`migrate_map_settings_to_v8`'s fallbacks (`project.rs:445, 459-462, 487-495`) — and the
two sets **disagree** (e.g. route width default `0.006` at `models.rs:635` vs migration
fallback `0.004` at `project.rs:445`; waypoint `circle_radius` `0.02` vs `0.015`). That
may be intentional ("migrated v7 projects keep old-look sizes, fresh projects get new
defaults") but nothing says so; it reads as drift.

### 3.5 What's good here

The serde discipline is genuinely strong: every additive field has
`#[serde(default)]` + `skip_serializing_if` with a test pinning that absent-field JSONs
parse and `None` fields stay off disk byte-identically (`models.rs:1211-1238`,
`:1293-1303`, `:1581-1593`). The doc comments on fields carry real contracts
("Never read by the renderer", "UI-only; never consulted by the ingest pipeline") and the
tests enforce them (`suggested_log_class_does_not_affect_effective_color_class`,
`models.rs:1596-1607`).

---

## 4. Command-layer boundaries

`lib.rs` is a clean 40-line registry of 18 commands. Module split per area
(media / project / gpx / ffmpeg / recent / camera_presets / encoder) is sensible.
Boundaries are mostly clean; issues:

- **All errors are `String`.** Every command returns `Result<T, String>` with
  `format!`-built messages. Fine for surfacing in a dialog; means zero programmatic error
  handling on the frontend (can't distinguish "ffmpeg missing" from "source file moved"
  from "disk full"). For a shipped product that wants actionable error UX (per project
  scope: end users, not Matthew), a small typed error enum serialized over IPC would pay
  for itself. Severity: low-medium, pervasive.
- **Blocking process I/O inside `async` commands** — MEDIUM.
  `generate_proxy` / `regenerate_proxy_for_class` / `generate_thumbnail{,_at}` are
  `async fn`s that call **blocking** `std::process::Command::output()`
  (`commands/ffmpeg.rs:266, 322, 575, 629`), pinning a tokio worker thread for the full
  multi-second/minute FFmpeg run. The same file's probe path is properly async
  (`probe_clip` via `export::ffprobe`). Several concurrent proxy generations can starve
  the runtime that all other async commands (imports, probes) share. Fix is mechanical:
  `tokio::process::Command` or `spawn_blocking`. (`commands/media.rs:69`'s synchronous
  `run_exiftool` inside async `import_media` has the same shape, mitigated by exiftool
  being one fast batch call.)
- **`commands/ffmpeg.rs` is mis-homed knowledge.** It contains the proxy/thumbnail
  color filter chains (see §5.3), the bundled sRGB ICC materialization
  (`ffmpeg.rs:462-484`), and an ExifTool ICC-embed call (`:492-526`) — i.e. it is really
  "preview-asset color pipeline", not "ffmpeg command wrappers". The split between this
  and `util/color.rs` is where the duplication in §5.3 hides.
- `commands/encoder.rs` (12 lines) and `commands/gpx.rs` (70 lines) are appropriately
  thin. `parse_gpx`'s copy-into-bundle-before-parse ordering is documented and deliberate
  (`gpx.rs:7-16`).
- `get_recent_projects` / `register_recent_project` deserialize `project.json` straight
  into `Project` **without the migration chain** (`recent.rs:24, 55`). Works today only
  because serde defaults absorb old shapes; a future non-additive change would silently
  show `clip_count: 0` / lose thumbnails for old bundles in the gallery. Low.

---

## 5. Color utilities: `util/color.rs` vs `util/color_space.rs`

**Answer to the audit question: it is a migration in progress, not duplication — and the
direction is exactly right. But it is (a) uncommitted, and (b) incomplete in a way that
matters for the HDR constraint.**

### 5.1 `color_space.rs` — the deep module this codebase needs (GEM)

Untracked new file, 551 lines. A four-axis registry (`Primaries` / `Transfer` / `Range` /
`Matrix` + optional `npl`) where each axis value carries both its zscale token and its
FFmpeg `-color_*` flag spelling — which **differ** for the legacy transfers
(`170m` vs `smpte170m`, `color_space.rs:86-98`) — plus generators
`ingest_zscale_chain` (`:277-315`) and `delivery_zscale_chain` (`:321-329`). The module
header states the acceptance test explicitly ("adding a new transfer … is ONE new enum
arm … and NOTHING else changes", `:21-26`) and the test section pins **byte-equality with
the pre-registry hardcoded strings** (`ingest_sdr_matches_legacy` `:392-398`,
`ingest_map_matches_legacy` `:437-448`, `delivery_never_emits_npl` `:477-483`). The
two-form ingest (clip-form vs explicit-tags map-form) encodes the hard-won zimg-3074
lesson (see §7 gems). `with_overrides` (`:228-250`) ignores unrecognized tokens so no
unvalidated string reaches FFmpeg, with the per-clip override surface
(`PerAxisOverride`, `models.rs:26-58`) defaulting safely. This is the model for what
"deep module" means here: simple interface (`ColorSpace` value + two generator fns)
hiding genuinely hard knowledge.

### 5.2 `color.rs` — half-migrated façade

The old constants are now **derived** from the registry (`WORKING_SPACE_PIX_FMT` etc.,
`color.rs:57-74`) and `ingest_filter_for` / `map_ingest_filter` route through
`ingest_zscale_chain` (`color.rs:114-176, 458-470`) — "The legacy hardcoded zscale strings
are gone" (`:127`). What remains in `color.rs` legitimately: the coarse
`SourceColorClass` enum (UI / LUT routing / camera presets still need it, `:479-513`),
`classify()` (`:596-606`), the inference layer (`inferred_color_space`, `:636-698`), and
the WS10 bundled-LUT machinery (`:207-426`). The seam between coarse-class world and
atomic-axes world is one function, `source_color_space_for` (`:187-205`). This is a clean
strangler-fig migration, not a parallel implementation.

### 5.3 The migration stops at the export path — MEDIUM

`commands/ffmpeg.rs` still **hardcodes** the very strings the registry owns:
`"zscale=tin=arib-std-b67:t=linear:npl=400,format=gbrpf32le,…"` in `build_proxy_args`
(`ffmpeg.rs:102-118`) and again, nearly verbatim, in `build_thumbnail_args`
(`ffmpeg.rs:401-413`). The HLG/PQ source descriptions (`tin`, `npl=400/1000`) duplicate
`ColorSpace::HDR_HLG_BT2020` / `HDR_PQ_BT2020` (`color_space.rs:206-221`). The registry
header's claim ("the single source of truth for every color string the export pipeline
emits") is true only for export; proxy and thumbnail are off-registry. Evidence of the
resulting change amplification is already in the file: the "Fix #7: linearise before
scale" change carries near-identical 15-line comment blocks in both builders
(`ffmpeg.rs:75-87` and `:381-388`) because the fix had to be applied twice. The
proxy/thumbnail tonemap chains can't be fully registry-generated today (the registry has
no tonemap-operator concept), but the source-space halves can and should be.

### 5.4 The diagnosed HDR reference-white fix is not in the registry — HIGH

Per the project's own diagnosis (memory: *HDR map reference white*), HDR-HLG map export is
dark because SDR/sRGB graphics are linearized scene-referred instead of being anchored at
BT.2408 reference white (`npl=203`); the verified fix is `npl=203` on the relevant
zscale step. Grep confirms **no `npl=203` (or any 203 constant) exists anywhere** in
`color_space.rs`, `color.rs`, or `export/delivery.rs`. `ColorSpace::SRGB` carries
`npl: None` (`color_space.rs:188-194`), `default_npl_for` only knows HLG=400 / PQ=1000
(`:332-338`), and `delivery_zscale_chain` deliberately never emits `npl` (`:321-329`,
pinned by test `:477-483` as "matches pre-registry behavior exactly"). So the new
single-source-of-truth registry **freezes the known-buggy HDR behavior in as the
canonical contract**, byte-equality tests and all. Given HDR is a co-equal current
delivery target, the registry's axes are incomplete: it models signal encoding but not
display-referred anchoring (reference-white nits at the SDR↔HDR boundary). Fixing the
HDR map bug will now require amending the registry + its legacy byte-equality tests —
fine, but it should be designed in (an `anchor_npl` on the ingest pair or per-boundary
policy), not patched as a fifth string special case.

### 5.5 Smaller color notes

- `BundledLut` slot list is spelled in **four places** within `color.rs`: the enum
  (`:232-238`), `filename()` (`:244-251`), `embedded_bytes()` (`:259-275`),
  `bundled_lut_for_class` (`:392-402`), plus a fifth `OnceLock` mapping in
  `bundled_lut_path` (`:319-330`) and a sixth copy in tests (`:1010-1016`). One
  `const SLOTS: &[(SourceColorClass, &str, &[u8])]` table would collapse it. Low.
- The placeholder-LUT design (ship licensing-safe placeholder `.cube` files, validate at
  runtime via `is_real_cube_lut` `:284-304`, fall back to SDR) is thoughtful, and the
  tests are written to flip behavior automatically when a real LUT lands
  (`:991-1031, 1034-1089`). Note this fallback is a deliberate, documented *silent*
  degradation (flat/gray footage) — acceptable per WS10 brief, but it is the one place
  the "fail loud" house rule is consciously traded away.

---

## 6. CLI invocation patterns (exiftool / ffmpeg / ffprobe)

### 6.1 Injection robustness — GOOD

Every invocation uses arg-vector `Command` (no shell): `exiftool.rs:22-38`,
`ffmpeg.rs:266, 322, 501, 575, 629`. Paths are passed as discrete argv elements, so shell
injection is structurally impossible. The one place a path is embedded *inside* a filter
string (lut3d) is explicitly escaped for FFmpeg's filtergraph metacharacters
(`escape_lut3d_filename`, `color.rs:375-387`, with tests `:1113-1123`). Residual nit: a
video file whose name begins with `-` would be parsed by exiftool as an option
(`exiftool.rs:34-36` appends paths directly, no `--` / absolute-path guard); paths come
from native file dialogs in practice. Low.

### 6.2 PATH resolution — known, documented, ship-blocking elsewhere

`Command::new("exiftool")` (`exiftool.rs:22`), `Command::new("ffmpeg")` (`ffmpeg.rs:266`
etc.), `PathBuf::from("ffprobe")` — with the helper **triplicated** at
`commands/media.rs:157-159`, `commands/ffmpeg.rs:196`, and `export/mod.rs:995`, each
carrying the same "task 130 will swap all call sites together" comment. The duplication
is at least self-aware, but three copies of a one-line function with a synchronization
promise in comments is exactly the change-amplification pattern under review. Sidecar
bundling is already tracked as required-before-ship; the consolidation should happen with
it.

### 6.3 Error handling quality — mixed

- ffmpeg failures: stderr captured and returned, **partial output file removed**
  (`ffmpeg.rs:271-275, 327-331, 580-583`) — good hygiene.
- ffprobe failures degrade per-clip to `Unknown` with an `eprintln!`
  (`media.rs:112-121`, `ffmpeg.rs:199-210`). Reasonable product behavior (import never
  blocks), but observability is dev-console-only; an end user whose ffprobe is broken
  gets silently miscolored proxies with no surfaced signal. Medium-low given the
  "fail loud" house rule.
- `run_exiftool` is **all-or-nothing**: exiftool exits non-zero if *any* file in the
  batch fails, and the whole import errors (`exiftool.rs:40-43`). One corrupt file in a
  folder kills the import of 60 good ones (exiftool still emits JSON for the good files
  on stderr-warning cases, but a hard non-zero status discards it). Medium for import UX.
- GPS `(0.0, 0.0)` is treated as "no GPS" (`exiftool.rs:69-74`) — correct pragmatically
  (exiftool emits 0/0 for absent), worth the comment it doesn't have.
- `parse_duration_ms` (`exiftool.rs:120-140`) and `format_clip_date`
  (`exiftool.rs:143-158`) hand-roll parsing while `chrono` is already a dependency
  (`recent.rs:80`). Low.
- `gpx.rs:35-42`: unparseable `lat`/`lon` attributes default to **`0.0` silently**,
  injecting a point off the coast of Africa into the route instead of skipping the
  trackpoint. Low-medium (malformed GPX exists in the wild).

### 6.4 `util/hash.rs` — unstable hash keys proxy/thumbnail cache — MEDIUM

`path_hash` uses `std::collections::hash_map::DefaultHasher` (`hash.rs:1-8`), whose
algorithm is explicitly **not guaranteed stable across Rust releases**. Proxy and
thumbnail filenames in every user's bundle are derived from it
(`ffmpeg.rs:247-248, 292-293, 546-547, 604-605`). A toolchain bump in a future app update
can silently invalidate every proxy/thumbnail in every existing bundle: all media
re-transcodes on next open (minutes of churn) and the orphaned old files are **never
cleaned up** (nothing deletes stale hashes), so bundles grow monotonically. Fix is
five lines: any stable hash (e.g. fnv/xxhash/sha1 of the path). Should land before
Windows ship (different toolchain builds make divergence more likely).

---

## 7. Gems (hard-won knowledge that must survive any rewrite)

1. **zimg error-3074 asymmetry** — bare `rawvideo` RGBA (the map canvas) propagates no
   color tags, so *all four* source tags AND output tags must be explicit on the first
   zscale or planning fails; the matrix for RGB-identity is `gbr`, not `bt709`.
   Documented at `color.rs:428-457`, generated via the `explicit_source_tags` form
   (`color_space.rs:260-306`), pinned byte-exact (`color_space.rs:437-448`).
2. **libx264 silently drops `-color_primaries`/`-color_trc`** unless duplicated in
   `-x264-params colorprim=…:transfer=…` (`ffmpeg.rs:163-175`); and the mp4 muxer writes
   a `colr` atom only when frames carry color params, hence the `setparams=` tail on
   every proxy chain (`ffmpeg.rs:56-69`). Both are empirical QuickTime/WS6-7 findings.
3. **Fix #7 — linearize HDR before scaling** (resampling in PQ/HLG domain crushes
   highlights), with the deliberate counter-decision that SDR stays scale-first for
   speed (`ffmpeg.rs:75-87`), enforced by ordering tests
   (`proxy_hlg_branch_linearises_before_scale_fix_7`).
4. **Fix #6 — legacy SDR transfer disambiguation**: `classify()` collapses
   `smpte170m`/`bt470bg` into `SdrBt709`, but the original trc is threaded through so
   zscale gets `tin=170m`/`tin=470bg` (`color.rs:91-104, 187-205`), tests
   `color.rs:867-914`.
5. **The atomic-axes registry itself** + its byte-equality-with-legacy test strategy
   (`color_space.rs` throughout) — the template for collapsing string-duplication soup.
6. **"Suggest, never auto-apply" log-format contract** enforced at every layer:
   knowledge base HDR-gate (`log_detection.rs:87-95`), import-path class gate
   (`media.rs:131-134`), model-level test
   (`models.rs:1596-1607`), with the destructive-false-positive rationale written down
   (`color.rs:550-556`). Plus the Sony internal-codename matching
   (`ILCE-7SM3` etc., `log_detection.rs:140-156`) — real-world container-tag knowledge.
7. **Migration test corpus + "load never writes disk"** invariant
   (`project.rs:1275-1314`) and the v7→v8 sparse/idempotent value-level restructure
   (`project.rs:416-614`) — the reference implementation for the next structural
   migration.
8. **Licensing-aware LUT slots**: compile-time-embedded placeholder `.cube` files +
   runtime `LUT_3D_SIZE` validation + SDR fallback + filtergraph escaping
   (`color.rs:207-426`) — the whole vendor-EULA problem solved without breaking builds.
9. **CreationDate > CreateDate > MediaCreateDate** fallback chain with the
   AirDrop-corruption rationale (`exiftool.rs:59-65`).
10. **Per-axis override semantics** — unrecognized tokens never reach FFmpeg, empty
    override object ≡ no override (`models.rs:46-58`, `color_space.rs:228-250`).

---

## 8. Questionable decisions (severity-ranked)

| # | Finding | Location | Severity |
|---|---------|----------|----------|
| Q1 | Non-atomic `project.json` writes under a ~1s auto-save loop; no temp+rename, no backup, no recovery path | `project.rs:35` (also `:17`, `:629`; `recent.rs:94`; `camera_presets.rs:59`) | **high** |
| Q2 | New color registry freezes the diagnosed HDR ref-white bug as canonical (no `npl=203` / display-anchoring axis; byte-equality tests pin the buggy strings) | `color_space.rs:188-194, 321-338, 477-483`; grep: no `203` in color modules | **high** |
| Q3 | `path_hash` uses unstable `DefaultHasher` for persistent proxy/thumbnail cache filenames; toolchain bump orphans every bundle's cache, no GC of stale files | `hash.rs:4-8`; consumers `ffmpeg.rs:247, 292, 546, 604` | medium |
| Q4 | `Clip`/`ClipMetadata` 14-field mirror + hand-written `From` (+ third copy in TS) — every metadata change touches 3-4 sites | `models.rs:95-159, 215-273, 303-348` | medium |
| Q5 | Proxy/thumbnail color chains hardcode HLG/PQ source strings off-registry; Fix-class changes must be applied 2-3× (Fix #7 comment duplicated verbatim) | `ffmpeg.rs:102-118, 401-413` vs `color_space.rs:206-221` | medium |
| Q6 | Stringly-typed model fields (`mode`, `shape`, `bearing_mode`, `label_mode`, `pulse_style`, `source`) — invalid states deserialize silently; TS↔Rust union contract unenforced | `models.rs:395, 432, 493-499, 576-579, 838` | medium |
| Q7 | Blocking `Command::output()` inside `async` Tauri commands pins tokio workers for full FFmpeg runs | `ffmpeg.rs:266, 322, 575, 629` | medium |
| Q8 | `models.rs` imports from `crate::export` (layering inversion; persisted types split across model and export modules) | `models.rs:1-3` | medium |
| Q9 | `delete_project` runs `remove_dir_all` on an unvalidated IPC-supplied path | `project.rs:640-645` | medium |
| Q10 | Dual versioning: explicit `schema_version` + field-presence sniffing (`is_pre_100`) with a 3-case backfill policy explained only by task-number archaeology | `project.rs:57-67, 133-167` | low-medium |
| Q11 | Migration ladder hand-unrolled (9 arms × chain) + per-step `#[cfg(test)]` typed twins; 5 of 8 steps are version-stamp no-ops | `project.rs:69-131, 196-412` | low |
| Q12 | `run_exiftool` all-or-nothing: one bad file fails the whole import batch | `exiftool.rs:40-43` | low-medium |
| Q13 | Default-size constants drift between `models.rs` serde defaults and v7→v8 migration fallbacks (0.006 vs 0.004 route width, 0.02 vs 0.015 circle radius) — intent undocumented | `models.rs:634-663` vs `project.rs:445, 459-462` | low |
| Q14 | GPX trackpoints with unparseable lat/lon silently become `(0.0, 0.0)` instead of being skipped | `gpx.rs:35-42` | low |
| Q15 | `recent.rs` parses `project.json` without the migration chain; corrupted `recent.json` silently resets the gallery | `recent.rs:15, 24, 55` | low |
| Q16 | All command errors are flat `String`s — no typed error surface for product-grade error UX | pervasive (`commands/*`) | low |
| Q17 | `ffprobe_path()` triplicated with comment-promises to change together (task 130) | `media.rs:157`, `ffmpeg.rs:196`, `export/mod.rs:995` | low |
| Q18 | Schema-v9 + entire `color_space.rs` registry uncommitted, riding an unrelated `feat/control-panel` branch (`??` in git status) | git status; `models.rs:978` vs CLAUDE.md "v8" | low (process) |

---

## 9. Salvage assessment

**Grade: keep-with-cleanup.** This subsystem is not the source of the "soupy and
shallow" feeling — it is the counter-example. `color_space.rs` is a genuinely deep
module; the migration machinery is verbose but sound and superbly tested; the CLI
invocation layer carries irreplaceable empirical FFmpeg/QuickTime knowledge with
regression tests. In a fresh-start scenario I would carry `color_space.rs`,
`util/color.rs`'s classification + LUT layer, `log_detection.rs`, `exiftool.rs`'s
timestamp logic, and the v7→v8 migration pattern across nearly verbatim, and the test
corpora wholesale.

The cleanup list, in order of leverage:
1. Atomic writes for `project.json` (Q1) — small, ship-blocking-grade risk.
2. Design the reference-white/display-anchoring axis into the registry **before** more
   code calcifies on byte-equality tests (Q2) — this is the open recurring roadblock
   (SDR-vs-HDR overlay compositing) and the registry is the right place to solve it once.
3. Finish the registry migration into proxy/thumbnail builders (Q5) and collapse
   `build_proxy_args`/`build_thumbnail_args` around a shared per-class source-space
   resolution.
4. Replace `DefaultHasher` (Q3) before Windows ship; add stale-cache GC.
5. Merge `Clip`/`ClipMetadata` via composition (Q4) and type the string fields (Q6) —
   the two changes that most reduce model-layer change amplification.
6. Collapse the migration ladder to a loop and retire field-sniff versioning at the next
   bump (Q10/Q11).

None of these require redesigning interfaces consumers see; all are verifiable with the
existing test style (byte-equality, fixture round-trips), which is exactly what makes
cleanup-in-place low-risk for this subsystem.
