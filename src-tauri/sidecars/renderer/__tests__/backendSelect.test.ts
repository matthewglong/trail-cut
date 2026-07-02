// Backend-selection contract (Phase 5 cutover). The DEFAULT renderer
// backend is native — this is the flip the cutover landed, so it gets its
// own pin. Unknown values must throw (the worker turns that into a loud
// exit(1)); nothing may silently fall back.

import { describe, it, expect } from 'vitest';

import { selectBackendName } from '../backend';

describe('selectBackendName', () => {
  it('defaults to native when the env var is unset', () => {
    expect(selectBackendName(undefined)).toBe('native');
  });

  it('defaults to native on empty/whitespace values', () => {
    expect(selectBackendName('')).toBe('native');
    expect(selectBackendName('  ')).toBe('native');
  });

  it('resolves the explicit value', () => {
    expect(selectBackendName('native')).toBe('native');
  });

  it("throws a removal notice on 'chrome' — never silently renders native", () => {
    expect(() => selectBackendName('chrome')).toThrow(/chrome backend was removed/);
  });

  it('throws loud on unknown values — no silent fallback', () => {
    expect(() => selectBackendName('natve')).toThrow(/unknown TRAILCUT_RENDERER_BACKEND/);
    expect(() => selectBackendName('Chrome')).toThrow(/unknown TRAILCUT_RENDERER_BACKEND/);
  });
});
