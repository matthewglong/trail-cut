# Export Gaps

Known shortcomings of the export-modal redesign that landed alongside it.
Each entry is a deliberate scope cut — not a bug. Listed here so the next
iteration knows what to pick up.

## GAP-001 — v5 → v6 migration drops `last_export_selection`

The v5 schema stored `last_export_selection` as a flat
`{ aspects, channels, output_dir }` shape. v6 replaces that with
`ExportGrid` (sparse cells map). Translating the flat form to the grid
would require synthesizing chips with default quality (1080p) and fps
(30) for every (aspect × channel) cross-product of the v5 axes, which
is rarely what the user actually wanted to re-render. The migration
drops the field instead — users re-configure once on first open
post-upgrade.

**Location**: `src-tauri/src/commands/project.rs` —
`migrate_v5_to_v6` removes the key without populating `ExportGrid`.

**Impact**: One-time UX friction on the upgrade; no data loss
(projects retain their clips, route, layouts).

## GAP-002 — No real per-job ETA estimator

The render banner shows `Job N of M · {aspect} {channel} · {quality}`
but no per-job ETA. The mockup wireframes `eta 1:24` and `est 0:38`;
the implementation shows `—` for running jobs and the actual
`wall_clock_ms` for done jobs.

Producing a real ETA needs a per-job throughput model (frames written
× fps_target / source_fps × seconds-per-frame coefficient that itself
depends on resolution and codec). None of that is wired up. The
`useExportQueue` hook surfaces only terminal `summary` from Rust; it
doesn't tap progress events mid-render.

**Location**: `src/components/ExportModal/QueueView.tsx`
(`metaLabel` returns `'—'` for running jobs).

**Next step**: subscribe to Rust's progress events and fit an EMA to
frames/sec; project remaining frames at that rate.

## GAP-003 — Hardcoded CRF in `encoder.rs`

The composite encoder's CRF (quality) is hardcoded. The Export modal's
secondary panel shows codec / color profile / bitrate / HDR /
stabilization-passthrough as **Coming later** — none of those are
wired through. A user picking 4K and 30 fps still gets the same CRF as
1080p · 30, with no way to influence file size or visual fidelity
beyond resolution.

**Location**: `src-tauri/src/export/encoder.rs` — CRF value baked in.

**Next step**: extend `ExportConfig` with a `codec_preference` /
`crf` field, surface the "Coming later" panel, and thread the value
through `buildJobRequest` → the wire's `codec_preference` /
(new) `crf` fields.

## GAP-004 — Auto-numbered folder probes filesystem twice

`resolve_output_dir(base, name)` runs on modal-open to pick a free
output-folder name like `Cascade Pass 2`. The renderer also probes
the filesystem at render-time when creating the directory. Between
those two probes, the on-disk state can change — another process
(or another TrailCut window) can claim `Cascade Pass 2`, and the
render proceeds against a name that's no longer free.

**Location**: `src-tauri/src/commands/project.rs` —
`resolve_output_dir`; race exists wherever the renderer ultimately
`mkdir`s.

**Impact**: Low — the worst case is overwriting files in a
sibling-named directory. The renderer's `exists()` check before
each write catches per-file collisions and prompts the user.

**Next step**: defer the auto-number probe to render-time only;
the modal can show a "(auto-numbered)" pill rather than the
concrete name. Or hold a sentinel `.trailcut-export` marker file
in the candidate directory to claim it.

## GAP-005 — No "retry failed job" affordance

If one job in a queue fails (`failed` state), the done view shows it
in red but the only affordance is "Render again" which resets the
whole modal to the configure view. The user has to re-derive the
intent of what failed (which aspect/channel/quality), then retry it
manually as a new export.

**Location**: `src/components/ExportModal/QueueSummary.tsx` — no
per-row retry button.

**Next step**: per-row "Retry" button that calls `queue.start`
with only the failed jobs. The wire builder is already pure, so
this is a UI-only change.
