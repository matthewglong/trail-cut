// Unit test for the painter patch wrapper. The patch is the architectural
// load-bearing piece of the chromium renderer migration: without it, the
// browser painter's snap-to-pixel-grid behavior reproduces the same wobble
// the native renderer exhibits. With it, every painter.render call sees
// `options.moving = true` and bypasses the snap path.
//
// This test is the only check that runs cheaply enough to gate every CI
// build (vitest, no Chromium, no GPU). The end-to-end golden-frame test
// (task 117) is the real visual canary, but it's heavyweight; this is the
// fast smoke test that catches "the patch is structurally still there."

import { describe, it, expect, vi } from 'vitest';

import { applyPainterPatch } from '../page/painterPatch';

describe('applyPainterPatch', () => {
  it('forwards options.moving = true on every render call', () => {
    const orig = vi.fn();
    const painter = { render: orig };
    applyPainterPatch(painter);

    painter.render({ id: 'style' }, { rotating: false });

    expect(orig).toHaveBeenCalledTimes(1);
    expect(orig).toHaveBeenCalledWith(
      { id: 'style' },
      { rotating: false, moving: true },
    );
  });

  it('preserves other option fields and overrides any moving:false', () => {
    const orig = vi.fn();
    const painter = { render: orig };
    applyPainterPatch(painter);

    painter.render({ id: 's' }, { rotating: true, moving: false, zooming: true });

    expect(orig).toHaveBeenCalledWith(
      { id: 's' },
      { rotating: true, moving: true, zooming: true },
    );
  });

  it('handles a missing options argument gracefully', () => {
    const orig = vi.fn();
    const painter = { render: orig };
    applyPainterPatch(painter);

    painter.render({ id: 's' }, undefined);

    expect(orig).toHaveBeenCalledWith({ id: 's' }, { moving: true });
  });

  it('preserves the painter binding (the wrapper calls the original via .bind)', () => {
    const painter = {
      _seen: null as unknown,
      render(this: { _seen: unknown }, _style: unknown, _options: unknown) {
        this._seen = _options;
      },
    };
    applyPainterPatch(painter);

    painter.render({}, { rotating: true });
    // If the wrapper had dropped the `this` binding, _seen would never be
    // set (the call would write to a different `this`).
    expect(painter._seen).toEqual({ rotating: true, moving: true });
  });
});
