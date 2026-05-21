# Color Pipeline Overhaul

A multi-phase rebuild of TrailCut's color handling, from import through proxy/thumbnail generation to export. Replaces the current ad-hoc pipeline (no color tagging, no normalization, no working space) with an enterprise-style architecture: source → ingest transform → working space → delivery transform → output.

## Why this exists

Three user-reported symptoms drove the investigation:

1. **Washed-out video** in thumbnails, previews, and exports.
2. **PIP map saturation** in picture-in-picture composite exports (side-by-side is unaffected).
3. **QuickTime per-frame color warnings** on exported files.

Multi-agent investigation traced all three to the same root: TrailCut has no color management. Sources are decoded without classification, intermediates are not normalized before compositing, and outputs ship without explicit color tagging. See [`background/investigation-findings.md`](background/investigation-findings.md) for the full technical trace.

## How to use this directory

This plan is structured for agent fan-out. Each workstream brief is **self-contained** — a fresh agent reading only that brief (plus its linked references) has enough context to execute.

- Read [`ARCHITECTURE.md`](ARCHITECTURE.md) first for the conceptual model (working space, formulas, data flow).
- Read [`EXECUTION.md`](EXECUTION.md) for the dispatch shape (which workstreams run in parallel vs serial, who blocks whom).
- Phase 1 briefs live in [`phase-1/`](phase-1/). Phase 2 briefs live in [`phase-2/`](phase-2/).
- Background context (investigation findings, design decisions) lives in [`background/`](background/).

## Phase summary

### Phase 1 — Fix the three bugs, ship the working architecture

| # | Workstream | Blocks |
|---|---|---|
| WS0 | [Foundation: probe + classify + model](phase-1/WS0-foundation.md) | WS1, WS2, WS3 |
| WS1 | [Proxy pipeline](phase-1/WS1-proxy-pipeline.md) | — |
| WS2 | [Thumbnail pipeline](phase-1/WS2-thumbnail-pipeline.md) | — |
| WS3 | [Working-space export architecture](phase-1/WS3-working-space-export.md) | WS4 |
| WS4 | [Delivery transforms](phase-1/WS4-delivery-transforms.md) | WS5 |
| WS5 | [Export UI: delivery target selection](phase-1/WS5-export-ui.md) | — |
| WS6 | [Tests, fixtures, CI](phase-1/WS6-tests-fixtures.md) | — |
| WS7 | [Validation](phase-1/WS7-validation.md) | — |

### Phase 2 — Log format support

| # | Workstream | Blocks |
|---|---|---|
| WS8 | [Log format detection](phase-2/WS8-log-detection.md) | WS9 |
| WS9 | [Source format UI](phase-2/WS9-source-format-ui.md) | — |
| WS10 | [Log LUT bundling and ingest](phase-2/WS10-log-luts.md) | WS9 |

## Out of scope (named explicitly)

- HDR proxy preview — blocked on browser/WKWebView HDR support.
- Custom user LUT import — defer indefinitely.
- Per-clip manual color grading (lift/gamma/gain, curves) — separate future design.
- ACES color management — overkill; the linear-light working space gives 90% of the benefit.
- More LUTs beyond DJI/GoPro/Canon — add reactively as users request.
