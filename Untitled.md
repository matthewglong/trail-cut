
---
  You are taking over an in-flight orchestration of the map-decorations redesign. The previous orchestrator ran Steps 2–5 + 8-backend to completion (commit 6ead4f6, on top of Step 1's 9d498ad) and is handing off
  because its context window is filling.

  First, read /tmp/trailcut-orchestrator-state.md — it tells you what's been done, what tests pass, the per-step reviewer outcomes, and your next action.

  Then re-read the original orchestrator mission prompt below — your responsibilities are unchanged.

  After reading both, run git log -3 --oneline to confirm you're on commit 6ead4f6. Give me a one-paragraph confirmation that you understand the mission and the next action.

  Then before spawning Step 6: the previous orchestrator wanted me to walk through a hand-edit-JSON visual QA checklist, which I declined. Offer me two cleaner alternatives:
  - Option A — temporarily flip defaults in src/types.ts DEFAULT_MAP_SETTINGS (route/waypoints to gradient; cycle pov.pulse_style through the four styles) so I can spot-check by running npm run tauri dev. You
  revert when done.
  - Option B — skip the spot-check and go straight to Step 6 (the picker UI will surface any rendering bugs naturally because it writes into the same fields).

  Wait for my choice. If I pick B, spawn Step 6 immediately as a single sequential implementer agent (NOT parallel — Step 6 is one coherent UI feature; the previous orchestrator burned heavy context on
  parallel-implementation file contention and you should avoid repeating that). Use subagent_type: "feature-dev:code-architect" or "general-purpose". Brief from the per-step template in the original mission
  prompt and the Step 6 brief in the handoff doc.

  Step 6 file touch surface (per docs/map-decorations/IMPLEMENTATION-PLAN.md):
  - src/components/MapToolbar/MapToolbar.tsx — replace the Waypoints ModePicker with three ▾ panel triggers (Route, Waypoints, POV); overrideColor accepts OverridePath strings; decoration-button rollup via
  startsWith; Waypoints button additionally checks per-Waypoint overrides on the associated waypoint
  - src/components/MapToolbar/DecorationPanel/ (new) — panel shell with portal anchoring, recomputed on the existing ResizeObserver
  - src/components/MapToolbar/ColorSection/ (new) — swatch row (7 tiles: coral / pollen / chartreuse / azure / granite / white / CU) + custom react-colorful picker; routes "color set" calls to project
  (mapSettings), clip (MapOverrides.pov), or waypoint (wp.color) depending on scope
  - package.json — pin react-colorful@^5.7.0

  Acceptance criterion (verbatim from plan):

  ▎ All three panels open and edit; per-clip POV overrides round-trip through MapOverrides.pov; per-Waypoint color overrides round-trip through Waypoint.color.

  No gradient editor yet — that's Step 7. No shape gallery yet — that's Step 8-UI. Both run after Step 6 ships.

  After Step 6 implementer reports done, spawn feature-dev:code-reviewer per the original mission template. Anti-patterns to flag are unchanged (in the handoff doc and original mission). If reviewer passes,
  commit as a single per-step commit using the existing repo's lowercase commit-message style. Step 6 is sequential — clean per-step commit IS achievable here.

  Then advance to Step 7 + Step 8-UI in parallel (those two are independent once Step 6 lands).

  If your transcript gets heavy at any point: write a fresh /tmp/trailcut-orchestrator-state.md summarizing what you completed, and tell me. Same handoff protocol the previous orchestrator used.

  ---

# Mission

  Implement the map-decorations redesign in `docs/map-decorations/` end-to-end. You
  are the ORCHESTRATOR. You will not write production code yourself — you spawn
  subagents to do that, review their output, and gate progress through quality
  checks.

  # Source of truth (read these in order before doing anything)

  1. `docs/map-decorations/IMPLEMENTATION-PLAN.md` — the 8-step build sequence.
     This is your master plan.
  2. `docs/map-decorations/data-model.md` — canonical TypeScript + Rust types,
     `resolveMapSettings`, `computeClipOverrides`, `leafPaths`, and the v7→v8
     migration spec. Every type the agents write must match this doc verbatim.
  3. `docs/map-decorations/rendering.md` — MapLibre source/layer/paint plumbing.
  4. `docs/map-decorations/panel-ux.md` — toolbar panel structure and clip-scope
     behavior.
  5. `docs/map-decorations/color-gradient.md` — picker UX, gradient editor,
     per-Waypoint override behavior.
  6. `docs/map-decorations/shapes-pov.md` — shape gallery + SDF icons + (deferred)
     pulse styles.
  7. `docs/map-decorations/DESIGN.md` — high-level locked decisions.

  Also load:
  - `CLAUDE.md` (project conventions, dependencies, dev commands)
    and follow any feedback / project memories that touch map rendering. Especially
    honor `feedback_map_shared_data_contract.md`: every MapSettings-derived map
    state MUST flow through `src/lib/mapVisuals/` (`resolveStaticPaints` /
    `buildPerFrameState`) — NEVER as a direct `setPaintProperty` or
    `setLayoutProperty` in `MapView.tsx`. If you see an agent reach for that
    shortcut, reject the PR. Preview and export will silently diverge otherwise.

  # Hard rules

  - **Stop and ask** if any doc disagrees with another, or if you discover the
    codebase has evolved past what the docs assume. Do NOT make architectural
    decisions yourself — bring them to the user.
  - The 4 open questions in `IMPLEMENTATION-PLAN.md` ("Open questions before
    Step 5") have already been answered.
  - Schema v7 already shipped (`Project.waypoints: Waypoint[]`). The migration
    is v7→v8 and CURRENT_SCHEMA_VERSION goes from 7 to 8. Verify this
    assumption before Step 1 starts — read
    `src-tauri/src/commands/project.rs` and confirm.
  - Per-Waypoint overrides (`Waypoint.color`, `Waypoint.shape`) do NOT flow
    through `MapOverrides` or `resolveMapSettings`. They are read directly from
    each `Waypoint` in `buildWaypointsCollection` and baked into feature
    properties.
  - No `setPaintProperty` / `setLayoutProperty` in `MapView.tsx` outside the
    existing `resolveStaticPaints` apply loop. New paint values become new
    entries in `resolveStaticPaints` or `buildPerFramePaints`.
  - No `mkdir`, no scaffold scripts, no extra docs unless the user asks. Edit
    existing files; only create files the plan's "File touch surface" table
    names.
  - Production-quality only. No TODOs, no `// stub`, no commented-out fallbacks.
    If an agent ships partial work, the reviewer rejects and a new agent
    picks it up.

  # Dependency graph (parallelization map)

  Steps 1, 6, 7 are strictly sequential gates. Steps 2–5 and 8 can fan out
  once Step 1 lands.

  Step 1 (types + migration)                    [BLOCKS EVERYTHING]
     │
     ├──► Step 2 (solid-color plumbing) ──┐
     │                                      ├──► Step 6 (UI shell + swatch picker)
     ├──► Step 3 (route gradient)  ────────┤      │
     │                                      ├──► Step 7 (gradient editor UI)
     ├──► Step 4 (waypoint gradient) ──────┤      │
     │                                      └──► Step 8 (shape gallery UI part)
     ├──► Step 5 (POV color + override) ───┘
     │
     └──► Step 8 backend (SDF icons + symbol layer) — can start once Step 1 lands

  After Step 1 is merged and green, spawn Steps 2, 3, 4, 5, and 8-backend in
  PARALLEL. Each as its own `Agent` call in a single message. Step 6 starts only
  after 2–5 are all merged. Step 7 and Step 8-UI can run in parallel after Step 6.

  # Orchestrator loop (per step)

  For each step in the plan:

  1. **Spawn an implementer.** Use `Agent` with `subagent_type: "general-purpose"`
     or `feature-dev:code-architect` for design-heavy steps. Brief the agent
     with:
     - The specific step number and its acceptance criteria (verbatim from the
       plan)
     - File paths it is permitted to touch (from the "File touch surface" table)
     - Pointers to the canonical types in `data-model.md` for the data it will
       work with
     - The hard rules above
     - Instruction to run `npm run tauri dev` and visually verify the change
       before declaring done (or to run the relevant test suite when there's no
       visual surface)
  2. **Spawn a reviewer.** Once the implementer reports done, use
     `Agent` with `subagent_type: "feature-dev:code-reviewer"`. Brief with:
     - The same step + acceptance criteria
     - The diff to review (have it run `git diff` itself)
     - The hard rules above — especially the no-direct-setPaintProperty rule
     - Specific anti-patterns to flag (below)
  3. **Gate on review.** If the reviewer flags anything beyond cosmetic, the
     implementer agent (or a fresh one) addresses the feedback. Do NOT advance
     to the next step until the reviewer signs off.
  4. **Verify acceptance.** Run the tests yourself (`npm test`, `cargo test`
     from `src-tauri/`), and have the user spot-check anything visual before
     moving on.
  5. **Commit.** Create a separate commit per step using the existing repo's
     commit-message style. Do NOT push.

  # Context-budget handoff protocol

  You (the orchestrator) and every subagent have a finite context window. When
  ANY agent's transcript is approaching ~70% of its window, OR when an agent
  reports "I am running low on context," do the following:

  6. Have the agent write a HANDOFF document at
     `/tmp/trailcut-handoff-step-N.md` containing:
     - What was completed (with file paths + line ranges)
     - What is in progress (current edit-in-flight)
     - What remains for this step
     - Any non-obvious decisions made and their rationale
     - Open questions for the next agent
  7. Spawn a fresh agent (`Agent` call, fresh context) and brief it with:
     - The original step prompt
     - The handoff document path
     - Instruction to read the handoff first, then continue
  8. Discard the old agent.

  You yourself follow the same rule: when YOUR transcript is getting heavy
  (many steps completed, many reviewer roundtrips), summarize state into
  `/tmp/trailcut-orchestrator-state.md` and ask the user to start a fresh
  orchestrator session pointing at that file.

  # Anti-patterns that REJECT a PR automatically

  The reviewer must check for these. If any appear, the implementer redoes
  the work:

  9. Direct `map.setPaintProperty(...)` or `map.setLayoutProperty(...)` in
     `MapView.tsx` outside the existing `resolveStaticPaints` apply loop or
     `buildPerFramePaints` per-frame loop.
  10. `MapOverrides.waypoints.color` or `MapOverrides.waypoints.shape` anywhere
     in TypeScript or Rust — these moved to `Waypoint.color` / `Waypoint.shape`.
  11. `clip.map_overrides?.waypoints?.color` reads in any rendering code.
  12. `SolidColorOnly` Rust enum — removed in v8.
  13. Schema bump landing on anything other than 8.
  14. Missing `lineMetrics: true` at ANY of the four `addSource` sites
     (`MapView.tsx` × 2, `src-tauri/sidecars/renderer/index.ts` × 2).
  15. POV size overrides being dropped in the migration — they MUST survive
     v7→v8 (`pov.size.pulse_radius` etc.). Earlier doc drafts said to drop
     them; that decision was reversed.
  16. Hardcoded `#4a9eff` or `colors.accent` literals introduced anywhere new.
     Existing ones are migrated, not multiplied.
  17. New paint values added directly in `MapView.tsx`/`onStyleLoad` instead of
     `resolveStaticPaints`.
  18. Preview/export divergence — if the change touches `src/lib/mapVisuals/`,
      BOTH `MapView.tsx` AND `src-tauri/sidecars/renderer/index.ts` must consume
      the new state through the same module. The export renderer imports
      `lib/mapVisuals` directly; verify with `grep`.
  19. `// TODO`, `// FIXME`, `// stub`, or commented-out code blocks in the
      final diff.
  20. Tests skipped or marked `xfail` to make CI green.
  21. Migration test count below 4. Per `data-model.md` §8, there are four
      required v7→v8 tests.

  # Per-step briefing template

  When you spawn an implementer, use this shape:

  > You are implementing Step N of the map-decorations redesign. Read these
  > files first, in order:
  >   - docs/map-decorations/IMPLEMENTATION-PLAN.md (focus on "Step N" section)
  >   - docs/map-decorations/data-model.md (for canonical types)
  >   - docs/map-decorations/rendering.md (for paint/layer details)
  >   - [any other doc relevant to this step]
  >   - CLAUDE.md
  >
  > Your acceptance criterion: [verbatim from plan]
  > Files you may touch: [from plan's "File touch surface" table]
  > Files you may NOT touch: anything outside the table without orchestrator
  > approval.
  >
  > Hard rules:
  >   - All MapSettings-derived render state flows through src/lib/mapVisuals/.
  >     Never call setPaintProperty / setLayoutProperty directly in MapView.tsx.
  >   - Per-Waypoint overrides live on the Waypoint entity, NOT on
  >     clip.map_overrides.
  >   - Schema bump targets v8 (v7 already shipped).
  >   - No partial work, no TODOs, no stubs.
  >
  > Before declaring done:
  >   - Run `npm test` and `cargo test --manifest-path src-tauri/Cargo.toml`.
  >     Both must be green.
  >   - For UI work: start `npm run tauri dev` and visually verify the change
  >     in the browser. Report what you tested.
  >   - For data-model work: write a migration round-trip test in
  >     `src-tauri/src/commands/project.rs` per the existing pattern.
  >
  > When done, write a 200-word summary of what you changed and what acceptance
  > evidence you gathered. The orchestrator will hand your diff to a reviewer
  > before advancing.
  >
  > If you are running low on context: stop, write a handoff doc to
  > /tmp/trailcut-handoff-step-N.md, and tell the orchestrator.

  # Final acceptance (after Step 8)

  Before declaring the project complete:

  22. Full test suite green: `npm test` + `cargo test`.
  23. Build succeeds: `npm run tauri build --debug` runs to completion.
  24. Manual QA checklist (you walk through these with the user):
     - Load an existing v7 project: no visual change, no errors.
     - Set a Waypoint.color in JSON, reload: that one dot paints in the
       chosen color.
     - Toggle Route to gradient mode: line paints with the gradient stops.
     - Toggle Waypoints to gradient mode: each dot paints at its
       trail-distance fraction.
     - Override POV color on one clip: POV dot recolors during that clip,
       reverts at the next clip boundary.
     - Change a Waypoint.shape to 'diamond' in one waypoint: that waypoint
       renders as a diamond while others stay circles.
     - Export a short clip and confirm the exported MP4 matches the preview
       pixel-for-pixel for the new decorations.
  25. Code-review pass on the FULL diff (not per-step) by a final reviewer agent.

  # Start

  Begin by:
  26. Reading every doc listed above.
  27. Confirming the current schema version in
     `src-tauri/src/commands/project.rs` is 7.
  28. Running `git status` and `git log -5` to ground yourself in repo state.
  29. Reporting back a one-paragraph confirmation that you understand the
     mission, the parallelization map, and the quality gates, before spawning
     any agent.