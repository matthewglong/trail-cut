# Ship Review Receipts — June 2026

Evidence corpus behind [`/SHIP_REVIEW.md`](../../SHIP_REVIEW.md) (the synthesis + verdict). Produced 2026-06-11 by a 16-agent review on branch `feat/control-panel`: 6 code auditors, 3 doc reconcilers, 4 external-research agents, 3 adversarial judges. Every receipt is self-contained with file:line citations or URLs.

## Code audits (one per subsystem, with salvage grades)

| Receipt | Scope | Salvage grade |
|---|---|---|
| [code-export-pipeline.md](code-export-pipeline.md) | `src-tauri/src/export/` — filtergraph, orchestrator, clip_chain, layout, delivery, protocol | keep-with-cleanup |
| [code-rust-core.md](code-rust-core.md) | models, commands, migrations v1→v9, util/color + color_space, CLI invocation | keep-with-cleanup |
| [code-renderer-mapvisuals.md](code-renderer-mapvisuals.md) | renderer sidecar + `src/lib/mapVisuals/` — the preview/export parity backbone | keep-with-cleanup |
| [code-frontend-lib.md](code-frontend-lib.md) | hooks/state/auto-save, types.ts mirror, cameraIntent/routeLocation/layout | redesign-interface (state layer only; lib/ is deep) |
| [code-frontend-components.md](code-frontend-components.md) | MapToolbar/DecorationPanel, MapView, ExportModal, LayoutConfigurator, … | keep-with-cleanup |
| [code-tests-quality.md](code-tests-quality.md) | what's actually verified vs what merely executes; CI absence; silent skips | keep-with-cleanup |

## Doc reconciliation (what's true, what's dead, what conflicts)

- [docs-root-specs.md](docs-root-specs.md) — the 12 root docs: four unsuperseded generations; conflict + stale ledger; which decisions still bind.
- [docs-tree.md](docs-tree.md) — `docs/` (export tasks, migration, color-pipeline, map-decorations): status-ledger corrections; the lost preview≡export parity gate (task 640 → 120, never authored).
- [docs-spikes.md](docs-spikes.md) — the spike corpus: definitive conclusion of each spike, what the codebase never absorbed (the entire HDR A+B+C+D port), settled rejections never to re-litigate (keyline/halo).

## External research (source-verified, 2025–2026)

- [research-color-hdr.md](research-color-hdr.md) — BT.2408 graphics white verified; npl must be coherent at ingest+delivery; BT.2446-A pairing; zscale vs libplacebo; premultiplied-alpha open question.
- [research-map-export-fidelity.md](research-map-export-fidelity.md) — architecture ecosystem-validated; binary WebSocket transport fix; color-profile hardening; 4:2:0 reality and remaining crispness levers.
- [research-maplibre-native.md](research-maplibre-native.md) — "must fork native" is wrong: binding-surface gap, upstream PR #4137, `setGestureInProgress` route, prebuilt platform coverage.
- [research-shipping-deps.md](research-shipping-deps.md) — LGPL FFmpeg bundling, ExifTool → nom-exif, Chrome-for-Testing non-redistributability, signing/notarization gates.

## Verdict

- [judge-panel.md](judge-panel.md) — three judges' full arguments, honest cross-scores, salvage lists, thread orderings, risks. Consensus: hybrid/strangler; rewrite scored 2–4/10 even by its own advocate.
