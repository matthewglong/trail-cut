// One-shot validation probe for task 590 (docs/migration/tasks/590-validate-behavior.md).
// Loads a real .trailcut project off disk, compiles its timeline, and verifies the
// continuity invariants from COMPILED_TIMELINE_PLAN.md §"Continuity Invariants" hold
// at every span boundary.
//
// This is intentionally not a permanent test — its job is to produce numeric evidence
// for the validation report, then go away once the migration ships. Keep it gated to
// VALIDATION_PROBE=1 so it doesn't run in normal CI.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import {
  compileTimeline,
  cameraAt,
  resolveIntent,
  type ResolvedCamera,
  type Viewport,
  type CompileTimelineProjectSettings,
} from './cameraIntent';
import { parseTimestamp, type IndexedRoute } from './routeLocation';
import { DEFAULT_MAP_SETTINGS, type Clip, type Project } from '../types';

const TEST_PROJECT_PATH = '/Users/personal/Desktop/bri test/MyHike.trailcut/project.json';
const VIEWPORT: Viewport = { width: 1080, height: 1920, dpr: 2 };
const EPSILON_MS = 0.001; // sub-millisecond tolerance for boundary spot checks

const shouldRun = process.env.VALIDATION_PROBE === '1';

function cameraDelta(a: ResolvedCamera, b: ResolvedCamera): number {
  const dLng = a.center.lng - b.center.lng;
  const dLat = a.center.lat - b.center.lat;
  const dZoom = a.zoom - b.zoom;
  const dBearing = a.bearing - b.bearing;
  const dPitch = a.pitch - b.pitch;
  return Math.sqrt(
    dLng * dLng + dLat * dLat + dZoom * dZoom + dBearing * dBearing + dPitch * dPitch,
  );
}

(shouldRun ? describe : describe.skip)('compiled-timeline real-project validation probe', () => {
  if (!existsSync(TEST_PROJECT_PATH)) {
    it.skip('test project missing, skipping', () => {});
    return;
  }

  const project = JSON.parse(readFileSync(TEST_PROJECT_PATH, 'utf8')) as Project;
  const clips: Clip[] = project.clips;
  const projectSettings: CompileTimelineProjectSettings = {
    transition_feel: project.transition_feel,
    start_camera: project.start_camera,
    default_entry_transition: project.default_entry_transition,
  };

  it('reports project shape', () => {
    console.log('\n=== Project ===');
    console.log(`  name:          ${project.name}`);
    console.log(`  schema:        ${project.schema_version}`);
    console.log(`  clip_count:    ${clips.length}`);
    console.log(`  transition_feel:           ${project.transition_feel ?? '(default natural)'}`);
    console.log(`  start_camera override:     ${project.start_camera ? 'yes' : 'no'}`);
    console.log(`  default_entry_transition:  ${project.default_entry_transition ? 'yes' : 'no'}`);
    expect(clips.length).toBeGreaterThan(0);
  });

  it('compiles deterministically (purity check)', () => {
    const a = compileTimeline(clips, null, DEFAULT_MAP_SETTINGS, projectSettings);
    const b = compileTimeline(clips, null, DEFAULT_MAP_SETTINGS, projectSettings);
    expect(a).toEqual(b);
    console.log(`\n=== Compiled Timeline ===`);
    console.log(`  totalDurationMs: ${a.totalDurationMs.toFixed(1)}`);
    console.log(`  clipSpans:       ${a.clipSpans.length}`);
    console.log(`  transitionSpans: ${a.transitionSpans.length} (incl. project-start → clip-1)`);
    console.log(`  startCamera:     center=(${a.startCamera.center.lng.toFixed(4)},${a.startCamera.center.lat.toFixed(4)}) zoom=${a.startCamera.zoom.toFixed(2)} bearing=${a.startCamera.bearing} pitch=${a.startCamera.pitch}`);
  });

  it('reports clip and transition spans', () => {
    const tl = compileTimeline(clips, null, DEFAULT_MAP_SETTINGS, projectSettings);
    console.log('\n=== Clip Spans ===');
    console.log('  i  clipId                                   startMs    endMs    lengthMs    speed  intent');
    for (let i = 0; i < tl.clipSpans.length; i++) {
      const s = tl.clipSpans[i];
      console.log(
        `  ${String(i).padStart(2)} ${s.clipId.slice(0, 36)} ${String(s.startMs.toFixed(0)).padStart(8)} ${String(s.endMs.toFixed(0)).padStart(8)} ${String((s.endMs - s.startMs).toFixed(0)).padStart(11)} ${String(s.speed).padStart(6)}  ${s.intent.kind}`,
      );
    }
    console.log('\n=== Transition Spans ===');
    console.log('  i  fromClipId                               toClipId                                 startMs   cutMs    endMs    durMs');
    for (let i = 0; i < tl.transitionSpans.length; i++) {
      const t = tl.transitionSpans[i];
      console.log(
        `  ${String(i).padStart(2)} ${(t.fromClipId ?? 'null'.padEnd(36)).slice(0, 36)} ${t.toClipId.slice(0, 36)} ${String(t.startMs.toFixed(0)).padStart(7)} ${String(t.cutMs.toFixed(0)).padStart(7)} ${String(t.endMs.toFixed(0)).padStart(7)} ${String(t.effectiveDurationMs.toFixed(0)).padStart(7)}`,
      );
    }
  });

  it('honors continuity at every span boundary', () => {
    const tl = compileTimeline(clips, null, DEFAULT_MAP_SETTINGS, projectSettings);
    const boundaries: number[] = [];
    for (const s of tl.clipSpans) {
      boundaries.push(s.startMs);
      boundaries.push(s.endMs);
    }
    for (const t of tl.transitionSpans) {
      boundaries.push(t.startMs);
      boundaries.push(t.cutMs);
      boundaries.push(t.endMs);
    }
    const uniq = Array.from(new Set(boundaries.map((b) => Number(b.toFixed(3)))))
      .sort((a, b) => a - b)
      .filter((b) => b - EPSILON_MS >= 0 && b + EPSILON_MS <= tl.totalDurationMs);

    console.log('\n=== Boundary Continuity (||cam(t-ε) - cam(t+ε)||) ===');
    console.log('  boundary_t   delta');
    let maxDelta = 0;
    for (const b of uniq) {
      const before = resolveIntent(cameraAt(tl, b - EPSILON_MS), VIEWPORT);
      const after = resolveIntent(cameraAt(tl, b + EPSILON_MS), VIEWPORT);
      const d = cameraDelta(before, after);
      maxDelta = Math.max(maxDelta, d);
      console.log(`  ${String(b.toFixed(3)).padStart(11)}  ${d.toExponential(3)}`);
    }
    console.log(`\n  max delta across ${uniq.length} boundaries: ${maxDelta.toExponential(3)}`);
    // Bearing/pitch are linearly lerped and zoom is sampled from Van Wijk; sub-ms epsilon
    // should produce sub-1e-3 deltas everywhere if continuity holds.
    expect(maxDelta).toBeLessThan(1e-2);
  });

  it('samples 5 random project-times', () => {
    const tl = compileTimeline(clips, null, DEFAULT_MAP_SETTINGS, projectSettings);
    // Deterministic pseudo-random samples (avoid Math.random for reproducibility)
    const samples = [0.07, 0.23, 0.41, 0.68, 0.91].map((f) => f * tl.totalDurationMs);
    console.log('\n=== 5 Sampled Project-Times ===');
    console.log('  t          intent.kind  center                          zoom    bearing  pitch');
    for (const t of samples) {
      const r = resolveIntent(cameraAt(tl, t), VIEWPORT);
      const intent = cameraAt(tl, t);
      console.log(
        `  ${String(t.toFixed(1)).padStart(8)}   ${intent.kind.padEnd(10)}  (${r.center.lng.toFixed(5)},${r.center.lat.toFixed(5)})  ${r.zoom.toFixed(3).padStart(7)}  ${r.bearing.toFixed(2).padStart(7)}  ${r.pitch.toFixed(2).padStart(5)}`,
      );
    }
  });

  // Follow-mode boundary continuity. The default test runs every clip with
  // `route: null`, which collapses follow → point and hides any seam between
  // the transition's anchor cameras and the clip-span's live `follow`
  // resolution. This block synthesizes a moving route covering the project's
  // wall-clock window so resolveIntent actually walks the IndexedRoute on
  // both sides of every span boundary.
  it('honors continuity at every span boundary — follow mode (synthetic route)', () => {
    // Wall-clock window: from 60s before the first clip starts to 60s after
    // the last clip ends. Padding ensures locationAt has bracketing samples
    // for the transition spans that extend past clip bounds.
    const minWall = Math.min(
      ...clips.map((c) => parseTimestamp(c.created_at)),
    );
    const maxWall = Math.max(
      ...clips.map((c) => parseTimestamp(c.created_at) + c.duration_ms),
    );
    const startMs = minWall - 60_000;
    const endMs = maxWall + 60_000;

    // 500 evenly-spaced points along a ~5km diagonal line. Matters that
    // locationAt produces a *moving* target — the bug would manifest as a
    // delta between cameraAt(span.endMs - ε) and cameraAt(span.endMs + ε)
    // proportional to (span.endMs - span.cutMs) * speed of that motion.
    const N = 500;
    const lng0 = -122.485;
    const lat0 = 37.770;
    const dLng = 0.025; // ~2.2 km east
    const dLat = 0.020; // ~2.2 km north
    const points = Array.from({ length: N }, (_, i) => {
      const f = i / (N - 1);
      return {
        lng: lng0 + dLng * f,
        lat: lat0 + dLat * f,
        timeMs: startMs + (endMs - startMs) * f,
      };
    });

    // cumulative distance fields aren't read by follow-intent resolution
    // (locationAt + bearingFromKeyframes are time-indexed). Zero-fill is fine.
    const zeros = new Array<number>(N).fill(0);
    const route: IndexedRoute = {
      points,
      minTimeMs: points[0].timeMs,
      maxTimeMs: points[N - 1].timeMs,
      cumulativeDistMeters: zeros,
      totalDistMeters: 0,
      cumulativeMercatorMeters: zeros,
      totalMercatorMeters: 0,
    };

    const tl = compileTimeline(clips, route, DEFAULT_MAP_SETTINGS, projectSettings);

    // Sanity: at least one clip should have resolved to a follow intent. If
    // they all came out point, the rest of this test is meaningless.
    const followCount = tl.clipSpans.filter((s) => s.intent.kind === 'follow').length;
    expect(followCount).toBeGreaterThan(0);

    const boundaries: number[] = [];
    for (const s of tl.clipSpans) {
      boundaries.push(s.startMs);
      boundaries.push(s.endMs);
    }
    for (const t of tl.transitionSpans) {
      boundaries.push(t.startMs);
      boundaries.push(t.cutMs);
      boundaries.push(t.endMs);
    }
    const uniq = Array.from(new Set(boundaries.map((b) => Number(b.toFixed(3)))))
      .sort((a, b) => a - b)
      .filter((b) => b - EPSILON_MS >= 0 && b + EPSILON_MS <= tl.totalDurationMs);

    console.log('\n=== Follow-Mode Boundary Continuity (||cam(t-ε) - cam(t+ε)||) ===');
    console.log(`  follow-clip-count: ${followCount} / ${tl.clipSpans.length}`);
    console.log('  boundary_t   delta');
    let maxDelta = 0;
    for (const b of uniq) {
      const before = resolveIntent(cameraAt(tl, b - EPSILON_MS), VIEWPORT);
      const after = resolveIntent(cameraAt(tl, b + EPSILON_MS), VIEWPORT);
      const d = cameraDelta(before, after);
      maxDelta = Math.max(maxDelta, d);
      console.log(`  ${String(b.toFixed(3)).padStart(11)}  ${d.toExponential(3)}`);
    }
    console.log(`\n  max delta across ${uniq.length} boundaries: ${maxDelta.toExponential(3)}`);
    // Tight tolerance: with the transition-anchor wall-clock fix in place,
    // post-fix max delta on this synthetic route is ~6e-8 (float dust from
    // vanWijkSample). Pre-fix it sits at ~1.2e-6 — driven by
    // (effectivePostCut * speed * route_velocity) at every transition's
    // span.startMs/endMs boundary. 5e-7 sits in the gap and asserts the fix.
    expect(maxDelta).toBeLessThan(5e-7);
  });

  it('cameraAt(span endpoints) match the documented invariants', () => {
    const tl = compileTimeline(clips, null, DEFAULT_MAP_SETTINGS, projectSettings);
    console.log('\n=== Endpoint Invariants ===');
    for (let i = 0; i < tl.clipSpans.length; i++) {
      const s = tl.clipSpans[i];
      const camAtStart = resolveIntent(cameraAt(tl, s.startMs), VIEWPORT);
      const camAtEnd = resolveIntent(cameraAt(tl, s.endMs), VIEWPORT);
      console.log(
        `  clip[${i}] startMs=${s.startMs.toFixed(0)} → zoom=${camAtStart.zoom.toFixed(3)}; endMs=${s.endMs.toFixed(0)} → zoom=${camAtEnd.zoom.toFixed(3)}`,
      );
    }
    for (let i = 0; i < tl.transitionSpans.length; i++) {
      const t = tl.transitionSpans[i];
      if (t.effectiveDurationMs <= 0) continue;
      const camAtStart = resolveIntent(cameraAt(tl, t.startMs), VIEWPORT);
      const camAtEnd = resolveIntent(cameraAt(tl, t.endMs), VIEWPORT);
      console.log(
        `  trans[${i}] startMs=${t.startMs.toFixed(0)} → zoom=${camAtStart.zoom.toFixed(3)}; endMs=${t.endMs.toFixed(0)} → zoom=${camAtEnd.zoom.toFixed(3)}`,
      );
    }
  });
});
