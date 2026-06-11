# Ship Review — Frontend Non-Component Logic (App, types, screens, hooks, lib minus mapVisuals)

Date: 2026-06-11. Branch under review: `feat/control-panel`.
Scope: `src/App.tsx`, `src/types.ts`, `src/screens/`, `src/hooks/`, `src/lib/` excluding `mapVisuals/`, plus `src/utils/` (clips/format helpers that should arguably live in `lib/`).

Verdict in one line: **the pure `lib/` layer is the best code in the repo (deep, documented, shared verbatim with the export sidecar, parity-tested); the state-management layer above it is the soup** — a manually-mirrored wire type, an 11-useState prop-drilling lattice, and a lossy hand-assembled auto-save payload that silently drops live schema-v9 fields.

---

## 1. State-management architecture

### 1.1 Where project state lives

All project state is lifted into `App.tsx` as eleven independent `useState` hooks (`src/App.tsx:28-38`): `projectDir`, `clips`, `selectedClipId`, `route`, `mapSettings`, `transitionFeel`, `projectLayouts`, `selectedExportAspect`, `lastExportSelection`, `waypoints`, `playheadMs`. There is no context, no reducer, no store. The comment at `src/App.tsx:26-27` is candid about why:

```ts
// Shared state lifted here to break the circular dependency
// between useProject and useMediaImport
```

That is the tell: the hooks are not modules with interfaces, they are bags of behavior that all need write access to the same state, so the state got hoisted and every hook receives the setters of every other hook as parameters. `useProject` takes a **16-field parameter object, 12 of which are `React.Dispatch` setters or callbacks belonging to other hooks** (`src/hooks/useProject.ts:20-40`), including `setProxies`/`setThumbnails`/`setImportError` reaching into `useMediaImport`'s state and `loadRecentProjects` reaching into `useRecentProjects`. Interface complexity ≈ implementation complexity — the Ousterhout definition of a shallow module, applied to the entire state layer.

### 1.2 Prop drilling

- `ProjectView` receives **~45 props** (`src/screens/ProjectView.tsx:48-105`), mixing raw state, raw setters (`setClips`, `setWaypoints`, `setRoute` passed straight through), and named handlers. Several props exist only to be forwarded again (e.g. `projectLayouts`/`setProjectLayouts` → `MapPositioningModal`, `lastExportSelection` → `ExportModal`).
- `HomeScreen` receives **10 props of pure presentation micro-state** (`cardMenuOpen`, `renamingCard`, `renameDraft`, `deleteConfirm` + their setters, `src/screens/HomeScreen.tsx:4-21`) that live in `useRecentProjects` (`src/hooks/useRecentProjects.ts:8-11`) and round-trip through `App` (`src/App.tsx:110-127`). Card-menu-open state has no reason to live two layers above the card grid.

### 1.3 Change amplification (measured)

Adding **one persisted project field** currently requires touching at minimum:

1. `src/types.ts` `Project` interface
2. `src-tauri/src/models.rs` struct + serde default (out of scope here, but part of the chain)
3. `src/App.tsx` — new `useState` + wire into both hook param bags
4. `src/hooks/useProject.ts` — `openProjectDir` hydration (~line 119-166), `handleNewProject` reset (~174-203), `handleCloseProject` reset (~222-240) — three separate hand-maintained reset lists
5. `src/hooks/useAutoSave.ts` — params interface, payload object, dependency array (three more lists, ~16-112)
6. `src/screens/ProjectView.tsx` props interface + destructure, if the UI reads it

Empirical proof the chain is both heavy and leaky: `selectedExportAspect` exists in **four files** (`src/App.tsx:35,81`, `src/hooks/useProject.ts:146`, `src/hooks/useAutoSave.ts:31,69,87,109`, `src/types.ts:1031`) and is loaded from disk and saved back on every auto-save — but **no UI anywhere sets it** (verified by grep across `src/`; the only writer is the load path). It is pure vestigial round-trip plumbing carried through the whole lattice.

### 1.4 Auto-save flow — three real defects

`useAutoSave` (`src/hooks/useAutoSave.ts:75-112`) debounces 1s and hand-assembles the wire `Project` from an 11-field parameter list.

**(a) HIGH — lossy round-trip silently erases persisted fields.** The payload at `useAutoSave.ts:80-92` includes only the fields App-state carries. It omits `start_camera`, `default_entry_transition`, and `working_color_space` — all declared on the TS `Project` type (`src/types.ts:1040,1043,1060`) and on the Rust struct (`src-tauri/src/models.rs`, `start_camera`/`default_entry_transition`/`working_color_space` all `#[serde(default, skip_serializing_if=...)]`). The load path (`src/hooks/useProject.ts:119-166`) never hydrates them into App state either. Consequence: open a project whose `project.json` contains any of these → first debounced auto-save sends a payload without them → Rust deserializes absent → default → `skip_serializing_if` drops them from disk. **`working_color_space` is a live schema-v9 field** (the per-project working-space discriminant for the color pipeline), so this is not a theoretical trap: the moment any tool or migration writes a non-default value, the editor erases it within ~1 second of opening the project. Same fate awaits `start_camera` the day the planned override UI ships. Root cause: the save payload is a third hand-maintained copy of the Project shape rather than being derived from one canonical state object.

**(b) MEDIUM — auto-save refuses to run for empty projects.** `if (!projectDir || clips.length === 0) return;` (`useAutoSave.ts:76`). Removing the *last* clip is never persisted (reopen → the clip is back). Importing a GPX route or tuning map settings before importing any media is never persisted either.

**(c) MEDIUM — save failures are silently swallowed**, in direct tension with the project's own "loud failures" principle. `invoke('save_project', ...).catch(() => {})` (`useAutoSave.ts:93`). The codebase *knows* this is a defect — `handleSplitClip`'s comment narrates it (`src/hooks/useProject.ts:350-354`):

```
// fails serde's u64 deserialize. That break is
// silent on save (useAutoSave swallows the IPC error) and loud on
// render_export ...
```

A documented silent-data-loss path was patched around (rounding to whole ms) rather than making the save loud. The same swallow pattern appears in proxy/thumbnail generation (`useProject.ts:334-336,418`, `useMediaImport.ts` is better — it `console.error`s).

**(d) LOW — `version: 1` hardcoded** (`useAutoSave.ts:81`). Harmless only because Rust's `save_project` force-overwrites `schema_version` (`src-tauri/src/commands/project.rs:29-30`), but see §2: TS and Rust disagree about which version field even exists.

---

## 2. The TS/Rust type mirror (`src/types.ts`, 1070 lines)

### 2.1 How sync is maintained: comments and discipline, nothing else

The mirror is entirely manual. Sync is enforced by doc comments — "Mirrors the Rust `PerAxisOverride` struct" (`types.ts:42`), "Mirrors the Rust `WorkingColorSpaceId` enum" (`types.ts:60-62`), "Keep in lockstep with `DeliveryTarget::all()` in Rust" (`types.ts:128`) — with **no codegen (no ts-rs / specta), and no parity test for the Project wire shape**. The discipline is genuinely high (the comments are accurate today), but every field addition is a two-sided manual edit with silent-failure semantics: serde defaults on the Rust side mean a forgotten TS field doesn't error, it just quietly round-trips wrong (exactly the §1.4(a) failure mode).

### 2.2 Observed drift

- **TS `Project` has no `schema_version`**; Rust has *both* `schema_version` (serde-defaulted, force-overwritten on save) and a vestigial `version: u32` with no serde default (`src-tauri/src/models.rs:1003-1004`) — meaning the frontend is *obligated* to send the meaningless `version: 1` forever or deserialization fails. A confusing two-field protocol neither side fully owns.
- **`DELIVERY_TARGETS` duplicates Rust data, not just types** (`types.ts:129-165`): labels, short labels, container extensions, and the channel-compatibility matrix are all re-stated in TS and must match `DeliveryTarget::label()/short_label()/container_extension()` and `validate_target_for_channel` in Rust by hand.
- **`ExportChannel` is defined twice in TS** (`types.ts:904` and `lib/exportRequest.ts:33`) — deliberate and documented ("redeclared here so the export-modal UI can depend on types.ts without pulling in the request builder"), as is `TransitionFeel` (`types.ts:975` duplicating `cameraIntent.ts:115`). Each duplication is individually defensible; collectively they are more lockstep lists.
- **The one place that does it right**: `lib/layout.ts` has a real cross-language parity contract — a shared fixture (`src-tauri/tests/fixtures/layout_parity.json`) loaded by *both* `src/lib/__tests__/layout.test.ts:28` and `src-tauri/tests/layout_parity.rs:53`, asserting byte-equal `resolveSlots` output. This is the gold standard the rest of the mirror lacks, and proof the team knows how to build it.

### 2.3 types.ts is a grab-bag, not a types module

Beyond declarations it contains: `DEFAULT_MAP_SETTINGS` (`:530`), a ~70-line gradient validator with fallback policy (`validateGradient`, `:598-649`), the settings merge `resolveMapSettings` (`:662-732`), the override-path enumerator `leafPaths` (`:753-793`), and the settings differ `computeClipOverrides` (`:798-867`). Meanwhile `useProject` defines a *second, parallel* block-merge (`mergeMapSettings`, `src/hooks/useProject.ts:46-76`) for the load path — including a `full_width → width` legacy shim that exists nowhere else. Two near-identical deep-merge functions in different files, guaranteed to drift.

### 2.4 The MapOverrides quadruple-bookkeeping

The per-clip override system requires **four hand-synchronized enumerations of the same field set**: the `MapOverrides` interface (`types.ts:506-528`), the `OverridePath` template-literal union (`:736-751`), the `leafPaths` walker (`:753-793`), and `computeClipOverrides` with its hardcoded `cameraKeys` array (`:806-813`). Adding one overridable setting = four edits in `types.ts` alone, plus the toolbar. The template-literal typing is clever and catches *some* drift, but `leafPaths`' `as OverridePath` casts (`:758,764` etc.) neutralize part of that protection.

---

## 3. `cameraIntent.ts` — depth assessment (1259 lines)

**This is a genuinely deep module, and the single best argument against a from-scratch rewrite of the frontend.**

- **Simple interface, large hidden machinery.** Public surface is effectively four functions — `compileTimeline` (`:866`), `cameraAt` (`:1230`), `activeClipIdAt` (`:1202`), `resolveIntent` (`:391`) — hiding: a Web Mercator port of MapLibre's `cameraForBounds` (`:276`), a full implementation of Van Wijk & Nuij (2003) with the eq.(10) linear branch and degenerate-arc handling (`:546-683`), the project-time compiler with the boundary-formula clamping for entry-bias transitions (`:947-1015`), wall-clock↔clip-local↔project-time translation (`:1069-1076`), and the canonical-viewport collapse for transition endpoints (`:439-470`).
- **Pure and renderer-portable, and actually shared.** Zero React/DOM/MapLibre imports. The export renderer sidecar imports it directly — `src-tauri/sidecars/renderer/index.ts:89` imports from `'../../../src/lib/cameraIntent'` and `:90` from `routeLocation` — so preview and export evaluate the *same* compiled timeline with the *same* evaluator. Preview/export camera parity here is structural, not aspirational (unlike the color pipeline, where parity is the active pain).
- **Tested in proportion**: 1485 lines (`cameraIntent.test.ts`) + 255 lines of invariant validation (`cameraIntent.validation.test.ts`).
- **Decision rationale is recorded at the decision site**: why padding is a fraction of the smaller dimension (`:53-67`), why bearing keyframes are frozen on the intent (`:97-101`), why `WORLD_SIZE_AT_ZOOM_0 = 512` (`:235-237`), why transitions collapse follow-intents to snapshots (`:443-451`), why transition endpoints anchor at the playhead's actual wall-clock rather than mediaIn/Out (`:1138-1146`).

Minor nits only: `playheadMs` mutated-by-overwrite on a field documented as "initial value; evaluator overwrites" (`:349-351`) is a slightly awkward intent-as-mutable-record shape, and `easeInOut`'s unused `_feel` parameter (`:477`) is API symmetry without a consumer. Neither matters.

`routeLocation.ts` (513 lines) is the same caliber: the **dual cumulative-length arrays** (geodesic haversine *and* Web Mercator) exist because MapLibre's `line-progress` parameterizes in projected space, with the empirical justification recorded — "~36px offset at zoom 20, lat 37.7°" (`src/lib/routeLocation.ts:54-62`). That distinction is exactly the kind of hard-won, easy-to-lose knowledge a rewrite would re-discover the painful way. Also home of the `parseTimestamp` ExifTool-format normalizer (`:24-36`) the whole time model depends on.

---

## 4. lib/ module boundaries

Generally **good** — the lib layer is where this codebase stops being soup:

| Module | Boundary quality | Notes |
|---|---|---|
| `cameraIntent.ts` | Deep, clean | §3. Imports only `types` + `routeLocation`. |
| `routeLocation.ts` | Deep, clean | Zero-dependency time/geo math; consumed by sidecar. |
| `layout.ts` (439) | Deep, clean | Pure slot math; even-floor rationale tied to concrete zscale error 1027 (`:204-209`); divider-first rounding preserves the sum invariant by construction (`:240-246`); cross-language parity fixture (§2.2). |
| `waypoints.ts` (141) | Clean | Sticky-deletion contract stated at top and honored by callers; reference-equality no-change returns (`:91-99,105-140`) show React-aware design. The `appendClipWaypoints` doc comment honestly documents its own hazard (`:68-73`: "Callers must restrict input to genuinely new clip ids") — a contract enforced by convention, not types. |
| `exportRequest.ts` (296) | Clean | Pure wire-payload builder, no Tauri imports; Split-legality validation mirrored on both sides (`:203-211`). Carries deprecated `codec_preference` wire baggage, documented (`:39-42`). |
| `exportFilenames.ts` (205) | Clean | Deterministic filename schema + queue ordering, tested. |
| `sourceFormat.ts` (152) | Clean | Catalog + `effectiveSourceClass` mirroring Rust's `Clip::effective_color_class()` (`:79-87`) — another comment-enforced lockstep. |
| `exportEstimate.ts` (37) | Honest stub | `// validate against 3 real exports post-launch` (`:4`). |
| `livePlayhead.ts` (6) | Deliberate global | Module-level mutable ref bridging rAF and React (`:6`); documented as preview-only. Acceptable, but it is a hidden coupling channel between `ProjectView` and `MapView` invisible to the props graph. |

Boundary defects:

- **`src/utils/` vs `src/lib/` split is arbitrary.** `utils/clips.ts` (`newClipFromMetadata`, `mergeClips` — core import/merge domain logic, including the WS9 override-preservation rules at `:26-47`) lives outside `lib/` for no discernible reason.
- **`mergeClips`' type-defeating double cast.** `useMediaImport._finalizeImport` builds finished `Clip[]`, then feeds them back through `mergeClips(prev, finalisedClips as unknown as ClipMetadata[])` (`src/hooks/useMediaImport.ts:220`), whereupon `mergeClips` calls `newClipFromMetadata` on them *again* (`src/utils/clips.ts:53`), re-spreading and re-defaulting `trim`/`focal_point`/`effects`. It happens to be harmless for fresh imports, but `as unknown as` at exactly the boundary the type mirror exists to guard means the compiler can no longer catch a Clip/ClipMetadata divergence here. `mergeClips` should accept `Clip[]` or the finalize path shouldn't double-construct.

---

## 5. Screens and remaining hooks

- **`ProjectView.tsx` (1080 lines)** is a working but maximal component: ~300 lines of inline style objects (`:774-1080`; a `src/theme/tokens.ts` exists but isn't used here), resizer drag plumbing, playback orchestration, and the timeline/scope/override wiring. Most of the orchestration logic is well-commented and correct (the playhead clamp rationale at `:620-628`, the rAF ref-bridge at `:370-406`). One genuine defect: a **dead effect** at `:186-195` — both branches of the `if` are empty comments; the stated behavior ("auto-reverts to 'clip' when the selected clip changes", `:183`) is not implemented and the effect does literally nothing except maintain a ref nothing reads. Shipped dead code with misleading documentation.
- **Ref-mirroring as a recurring pattern**: `projectDirRef`/`proxiesRef` (`useMediaImport.ts:76-83`), `selectedClipSpanRef`/`playheadSecRef`/`isPlayingRef`/`needsRewindRef`/`togglePlayRef` (`ProjectView.tsx:161-162,359-375`). Each is individually justified (rAF callbacks, stale-closure avoidance), but the density indicates the state model fights React rather than composing with it.
- **`useMediaImport`** carries leftover `console.log` debug output on the hot import path (`:86-91,119`) and two `eslint-disable react-hooks/exhaustive-deps` (`:264,276`) with a partially incorrect justification comment (claims `_finalizeImport` "reads refs / direct setters" — it also closes over `generateProxiesAndThumbnails`; stable today, fragile contract).
- **`useExportQueue` (156)** is tight and correct: sequential queue with a cancel latch, per-job Tauri progress channels, careful `cancelled` vs `done` terminal-state distinction (`:128-136`). No complaints.
- **`useRecentProjects` / `HomeScreen`**: fine internally; the prop-drilled presentation state is §1.2's problem, not theirs.
- **`useProject.handleSplitClip`** (`useProject.ts:344-420`) is good domain logic in an awkward home — nested-state cloning, proxy reuse, sticky waypoint semantics, and the ms-rounding fix all correct and explained; it belongs in a `lib/` module with tests, like `waypoints.ts`, instead of inside a hook closure where it is untestable without rendering.

---

## 6. Gems (preserve regardless of fresh-start decision)

1. **`cameraIntent.ts` whole module** — see §3. The compiled-timeline model (project-time axis, transition spans with `cutMs`, boundary-formula clamping) plus the Van Wijk implementation, shared verbatim with the export sidecar.
2. **`routeLocation.ts` dual-parameterization insight** (`:44-62`) — geodesic vs Web-Mercator cumulative length, with the empirical 36px@z20 divergence note; plus the ExifTool timestamp normalizer (`:24-36`).
3. **`layout.ts` parity-fixture pattern** (`src-tauri/tests/fixtures/layout_parity.json` + tests on both sides) and the even-dimension/divider-first rounding rationale (`:204-246`) — the template for how *all* TS↔Rust shared logic should be held in sync.
4. **The lever model in `canonicalMapViewport`** (`layout.ts:80-115`) — cssViewport tracks slot shape, pixelRatio absorbs resolution; the perceived-scale-invariance constraint reduced to one pure function mirrored in Rust.
5. **Sticky-deletion waypoint contract** (`lib/waypoints.ts` header + `syncClipWaypointTrim`'s explicit stale-`fallback_gps` handling `:118-128`) — small, subtle UX semantics correctly encoded as pure functions with reference-equality no-ops.
6. **`mergeClips` re-import preservation rules** (`src/utils/clips.ts:26-47`) — "incoming wins when set; existing preserved when absent" for `user_color_class_override`/`suggested_log_class`; protects user color declarations from being clobbered by re-import. Hard-won WS9 lesson.
7. **`useExportQueue`'s cancel-latch state machine** (`useExportQueue.ts:101-137`) — clean sequential-queue semantics with the `cancelling→cancelled` distinction.
8. **Defensive-normalization commentary at the IPC boundary** — e.g. the `route ?? null` undefined-vs-null serde note (`useProject.ts:130-136`), the u64/fractional-ms serde note (`:348-355`). These comments encode real Tauri/serde footguns that cost debugging time to learn.

## 7. Questionable decisions (severity-ranked)

| # | Finding | Location | Severity |
|---|---|---|---|
| Q1 | Auto-save round-trip silently drops `working_color_space` (live, schema v9), `start_camera`, `default_entry_transition` from disk | `src/hooks/useAutoSave.ts:80-92` + `src/hooks/useProject.ts:119-166` (no hydration) | **High** |
| Q2 | Project wire shape mirrored manually with no codegen and no parity test (unlike layout); drift already present (`schema_version` missing in TS; vestigial mandatory `version`) | `src/types.ts` throughout; `src-tauri/src/models.rs:1003-1004` | **High** |
| Q3 | Auto-save swallows save errors (`catch(() => {})`) — known, documented, unfixed; violates the loud-failure principle | `useAutoSave.ts:93`; narrated at `useProject.ts:350-354` | **Medium** |
| Q4 | Auto-save skipped when `clips.length === 0` — last-clip removal and empty-project edits never persist | `useAutoSave.ts:76` | **Medium** |
| Q5 | Hook-lattice state architecture: 12-setter param bags, 45-prop screens, 3 hand-maintained reset lists + payload list per field; `selectedExportAspect` proves the vestigial-plumbing failure mode | `App.tsx:28-84`, `useProject.ts:20-40`, `ProjectView.tsx:48-105` | **Medium** |
| Q6 | Two parallel MapSettings deep-merges (`mergeMapSettings` vs `resolveMapSettings`), one with a legacy shim the other lacks | `useProject.ts:46-76` vs `types.ts:662-732` | **Medium** |
| Q7 | MapOverrides quadruple bookkeeping (interface / OverridePath union / leafPaths / computeClipOverrides) | `types.ts:506-528,736-867` | **Medium** |
| Q8 | `as unknown as ClipMetadata[]` double-cast + double construction at the import boundary | `useMediaImport.ts:220`, `utils/clips.ts:53` | **Medium** |
| Q9 | Dead scope-revert effect with misleading doc comment | `ProjectView.tsx:183-195` | **Low** |
| Q10 | `utils/` vs `lib/` arbitrary split; domain logic (`mergeClips`, split-clip) outside the tested lib layer | `src/utils/clips.ts`, `useProject.ts:344-420` | **Low** |
| Q11 | Debug `console.log` on the import hot path; `eslint-disable exhaustive-deps` with stale justification | `useMediaImport.ts:86-123,264,276` | **Low** |
| Q12 | ~300 lines/screen of inline styles despite `src/theme/tokens.ts` existing | `ProjectView.tsx:774-1080`, `HomeScreen.tsx` styles | **Low** |

## 8. Fresh-start guidance for this subsystem

Split the verdict by layer:

- **`src/lib/` (minus mapVisuals, reviewed elsewhere): keep as-is.** `cameraIntent`, `routeLocation`, `layout`, `waypoints`, `exportRequest`, `exportFilenames`, `sourceFormat` are deep modules with the right boundaries, real tests, and (in layout's case) the parity mechanism the rest of the codebase should copy. Rewriting these would re-derive Van Wijk numerics, the Mercator-vs-geodesic progress lesson, and the even-dimension rounding invariants for no benefit.
- **State layer (`App.tsx`, `useProject`, `useAutoSave`, `useMediaImport` wiring, `types.ts`-as-grab-bag): redesign the interface.** Concretely: (1) one canonical in-memory `Project` object in a single store, with load = deserialize-whole and save = serialize-whole (eliminates Q1/Q4/Q5's parallel lists by construction); (2) generate the TS mirror from `models.rs` (ts-rs/specta) or extend the layout-parity-fixture pattern to the Project shape (kills Q2); (3) make save failures loud (Q3); (4) move pure logic out of `types.ts` and hook closures into `lib/` next to its tests (Q6/Q7/Q10).

The pure-lib layer demonstrates the team's ceiling; the state layer is accumulated scaffolding around it, and it is replaceable without touching the gems.
