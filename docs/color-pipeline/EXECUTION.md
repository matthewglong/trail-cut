# Execution Plan

How to dispatch agents against the workstream briefs. Each round is a barrier — wait for all agents in the round to complete before starting the next.

## Phase 1 dispatch

### Round 1 (serial, 1 agent) — Foundation
- **WS0** [Foundation](phase-1/WS0-foundation.md)

Blocks WS1, WS2, WS3.

### Round 2 (parallel, 4 agents) — Pipelines + tests
- **WS1** [Proxy pipeline](phase-1/WS1-proxy-pipeline.md)
- **WS2** [Thumbnail pipeline](phase-1/WS2-thumbnail-pipeline.md)
- **WS3** [Working-space export architecture](phase-1/WS3-working-space-export.md)
- **WS6** [Tests, fixtures, CI](phase-1/WS6-tests-fixtures.md)

WS6 can start immediately and develops fixtures + harness in parallel.

### Round 3 (serial, 1 agent) — Delivery transforms
- **WS4** [Delivery transforms](phase-1/WS4-delivery-transforms.md)

Depends on WS3 landing (delivery formulas plug into the working-space architecture).

### Round 4 (serial, 1 agent) — Export UI
- **WS5** [Export UI: delivery target selection](phase-1/WS5-export-ui.md)

Depends on WS4 (UI calls the delivery formulas).

### Round 5 (serial, 1 agent) — Validation
- **WS7** [Validation](phase-1/WS7-validation.md)

Final smoke test. Validates that the three original bugs are gone.

## Phase 2 dispatch

Can begin as soon as Phase 1 ships.

### Round 1 (parallel, 2 agents) — Groundwork
- **WS8** [Log format detection](phase-2/WS8-log-detection.md)
- **WS10** [Log LUT bundling and ingest](phase-2/WS10-log-luts.md)

### Round 2 (serial, 1 agent) — UI
- **WS9** [Source format UI](phase-2/WS9-source-format-ui.md)

Depends on both WS8 (detection results) and WS10 (LUT formulas) landing.

## Dispatching from a new session

To execute this plan from a fresh Claude Code session, the user should:

1. Open the repo: `cd /Users/personal/Documents/trail-cut`
2. Start a new session with a prompt like:

> "Execute Phase 1 of the color pipeline plan in `docs/color-pipeline/`. Read `docs/color-pipeline/README.md`, `docs/color-pipeline/ARCHITECTURE.md`, and `docs/color-pipeline/EXECUTION.md` first. Then dispatch the workstreams in the order specified, using parallel agent fan-out where the execution plan allows it. Each workstream brief is self-contained — pass the agent the brief's file path and let it execute."

The orchestrator agent should:
- Dispatch Round 1 (WS0) as a single agent, wait for completion.
- Dispatch Round 2 (WS1, WS2, WS3, WS6) as four parallel agents, wait for all to complete.
- Dispatch Round 3 (WS4), wait.
- Dispatch Round 4 (WS5), wait.
- Dispatch Round 5 (WS7) for validation.
- Report back any workstream failures with the agent's output.

## Per-agent dispatch template

When spawning an agent for a workstream, the prompt should be roughly:

> "Execute workstream WS<N> per the brief at `docs/color-pipeline/phase-<N>/WS<N>-<name>.md`. Read the brief fully and the linked references (especially `ARCHITECTURE.md`). Make the code changes specified. Run the acceptance criteria checks. Report what you did, what passed, and anything blocked or out of spec."

The agent should be told to:
- Treat the brief as authoritative.
- Not expand scope beyond the brief.
- Stop and report rather than guess if a file or pattern doesn't match what the brief expects.

## Stopping conditions

The orchestrator should halt the round-by-round dispatch and surface to the user if:

- Any workstream agent reports a blocked acceptance criterion that can't be resolved.
- An agent's changes break an unrelated test that wasn't in the brief's scope.
- ffprobe-based golden assertions in WS6 fail after WS3 or WS4.
- WS7 validation finds any of the three original bugs still present.

Do not autonomously skip workstreams or reorder rounds without surfacing to the user.
