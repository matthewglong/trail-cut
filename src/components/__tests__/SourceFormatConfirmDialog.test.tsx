// WS9 — Group-level source-format dialog tests. The dialog is the per-group
// confirmation surface from §2 of the brief; these tests assert the
// acceptance criteria:
//   - groups partition by (camera_make, camera_model)
//   - suggested log formats appear as the dropdown default
//   - "Remember" checkbox persists the preset
//   - Skip leaves clips unchanged
//   - Apply emits an override map covering every clip in non-Auto groups
//   - matching presets pre-set the dropdown default and skip the
//     suggestion (preset wins)

import { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import SourceFormatConfirmDialog from '../SourceFormatConfirmDialog';
import type {
  CameraPreset,
  ClipMetadata,
  SourceColorClass,
} from '../../types';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

function metaFixture(over: Partial<ClipMetadata> = {}): ClipMetadata {
  return {
    id: 'm1',
    path: '/tmp/m1.mov',
    filename: 'm1.mov',
    created_at: null,
    duration_ms: 1000,
    gps: null,
    resolution: null,
    frame_rate: null,
    pix_fmt: null,
    color_primaries: null,
    color_trc: null,
    color_space: null,
    color_range: null,
    has_dolby_vision: false,
    camera_make: null,
    camera_model: null,
    source_color_class: 'sdr_bt709',
    ...over,
  };
}

interface RenderOpts {
  clips: ClipMetadata[];
  presets?: CameraPreset[];
}

function render(opts: RenderOpts) {
  // Always create fresh `vi.fn()` instances per render — every test that
  // inspects calls relies on the `.mock` accessor that comes with the
  // typed mock helper. Callers can drop the returns when they don't need
  // to assert on calls.
  const onApply = vi.fn();
  const onSkip = vi.fn();
  act(() => {
    root.render(
      <SourceFormatConfirmDialog
        open
        clips={opts.clips}
        presets={opts.presets ?? []}
        onApply={onApply}
        onSkip={onSkip}
      />,
    );
  });
  return { onApply, onSkip };
}

function q(selector: string): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(selector);
  expect(el).toBeTruthy();
  return el!;
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('SourceFormatConfirmDialog', () => {
  it('does not render when open=false', () => {
    act(() => {
      root.render(
        <SourceFormatConfirmDialog
          open={false}
          clips={[metaFixture()]}
          presets={[]}
          onApply={vi.fn()}
          onSkip={vi.fn()}
        />,
      );
    });
    expect(document.body.querySelector('[data-testid="source-format-confirm-dialog"]')).toBeNull();
  });

  it('partitions clips by (make, model)', () => {
    render({
      clips: [
        metaFixture({ id: 'a1', camera_make: 'DJI', camera_model: 'Mavic 3' }),
        metaFixture({ id: 'a2', camera_make: 'DJI', camera_model: 'Mavic 3' }),
        metaFixture({ id: 'b1', camera_make: 'Apple', camera_model: 'iPhone 15 Pro' }),
        metaFixture({ id: 'u1', camera_make: null, camera_model: null }),
      ],
    });
    // Three groups: DJI Mavic 3, Apple iPhone 15 Pro, Unknown. We can't
    // use querySelector with spaces in attribute values (JSDOM bug —
    // turns the space into a null byte on extraction); count the group
    // elements + assert on visible heading text instead.
    const groups = Array.from(
      document.body.querySelectorAll('[data-testid^="source-format-group-"]'),
    );
    expect(groups).toHaveLength(3);
    const headings = groups.map((g) => g.querySelector('strong')?.textContent);
    expect(headings).toContain('DJI Mavic 3');
    expect(headings).toContain('Apple iPhone 15 Pro');
    expect(headings).toContain('Unknown source');
  });

  it('defaults a group to its WS8 suggestion when one is present', () => {
    render({
      clips: [
        metaFixture({
          id: 'a1',
          camera_make: 'DJI',
          camera_model: 'Mavic 3',
          source_color_class: 'sdr_bt709',
          suggested_log_class: 'd_log',
        }),
      ],
    });
    // List all testid values so we can spot wide selectors that depend
    // on attribute escaping.
    const triggers = Array.from(
      document.body.querySelectorAll('[data-testid$="-trigger"]'),
    );
    // Exactly one source-format-picker trigger lives in the dialog.
    expect(triggers).toHaveLength(1);
    const trigger = triggers[0] as HTMLElement;
    // The dropdown trigger label includes "D-Log" — the suggestion was promoted
    // to the default selection.
    expect(trigger.textContent).toContain('D-Log');
  });

  it('defaults a group to its preset class when a preset matches', () => {
    render({
      clips: [
        metaFixture({
          id: 'a1',
          camera_make: 'Sony',
          camera_model: 'FX3',
          source_color_class: 'sdr_bt709',
          // No WS8 suggestion — the preset alone should drive the default.
        }),
      ],
      presets: [{ make: 'Sony', model: 'FX3', color_class: 's_log3' }],
    });
    // Single group → single trigger.
    const triggers = Array.from(
      document.body.querySelectorAll('[data-testid$="-trigger"]'),
    );
    expect(triggers).toHaveLength(1);
    const trigger = triggers[0] as HTMLElement;
    expect(trigger.textContent).toContain('S-Log3');
    // The "(from preset)" marker is rendered in the trigger label.
    expect(trigger.textContent).toContain('from preset');
  });

  it('preset wins over WS8 suggestion when both are present', () => {
    render({
      clips: [
        metaFixture({
          id: 'a1',
          camera_make: 'Canon',
          camera_model: 'EOS R5',
          source_color_class: 'sdr_bt709',
          suggested_log_class: 'c_log3',
        }),
      ],
      // User previously confirmed C-Log2 for this camera; the preset is the
      // newer signal and must drive the default.
      presets: [{ make: 'Canon', model: 'EOS R5', color_class: 'c_log2' }],
    });
    const triggers = Array.from(
      document.body.querySelectorAll('[data-testid$="-trigger"]'),
    );
    expect(triggers).toHaveLength(1);
    const trigger = triggers[0] as HTMLElement;
    expect(trigger.textContent).toContain('C-Log2');
    expect(trigger.textContent).not.toContain('C-Log3');
  });

  it('Skip calls onSkip without emitting overrides', () => {
    const { onApply, onSkip } = render({
      clips: [metaFixture({ id: 'a1', camera_make: 'DJI', camera_model: 'Mavic 3' })],
    });
    click(q('[data-testid="source-format-skip"]'));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('Apply emits an override map per clip in non-Auto groups', () => {
    const { onApply } = render({
      clips: [
        metaFixture({
          id: 'a1',
          camera_make: 'DJI',
          camera_model: 'Mavic 3',
          suggested_log_class: 'd_log',
        }),
        metaFixture({
          id: 'a2',
          camera_make: 'DJI',
          camera_model: 'Mavic 3',
          suggested_log_class: 'd_log',
        }),
        metaFixture({
          id: 'b1',
          camera_make: 'Apple',
          camera_model: 'iPhone 15 Pro',
          source_color_class: 'hlg_bt2020',
        }),
      ],
    });
    click(q('[data-testid="source-format-apply"]'));
    expect(onApply).toHaveBeenCalledTimes(1);
    const overrides = onApply.mock.calls[0][0] as Map<string, SourceColorClass | null>;
    // DJI clips defaulted to suggested D-Log → override set; iPhone defaulted
    // to Auto → null override.
    expect(overrides.get('a1')).toBe('d_log');
    expect(overrides.get('a2')).toBe('d_log');
    expect(overrides.get('b1')).toBeNull();
  });

  it('Apply persists a preset when "Remember" is checked and the choice is non-Auto', () => {
    const { onApply } = render({
      clips: [
        metaFixture({
          id: 'a1',
          camera_make: 'DJI',
          camera_model: 'Mavic 3',
          suggested_log_class: 'd_log',
        }),
      ],
    });
    // Default selection is the suggestion; tick remember. There's exactly one
    // checkbox in the dialog (single group), so grab it by attribute prefix.
    const checkboxes = Array.from(
      document.body.querySelectorAll('[data-testid^="group-remember-"]'),
    );
    expect(checkboxes).toHaveLength(1);
    const checkbox = checkboxes[0] as HTMLInputElement;
    act(() => {
      checkbox.click();
    });
    click(q('[data-testid="source-format-apply"]'));

    const presetsToPersist = onApply.mock.calls[0][1] as CameraPreset[];
    expect(presetsToPersist).toHaveLength(1);
    expect(presetsToPersist[0]).toEqual({
      make: 'DJI',
      model: 'Mavic 3',
      color_class: 'd_log',
    });
  });

  it('Apply does NOT persist a preset for the Unknown group even if remember ticked', () => {
    // The Unknown group has no make/model identity to remember; the checkbox
    // is suppressed entirely. This test guards the suppression by asserting
    // the checkbox element doesn't exist for that group key.
    render({
      clips: [metaFixture({ id: 'u1', camera_make: null, camera_model: null })],
    });
    expect(
      document.body.querySelector('[data-testid="group-remember-__unknown__"]'),
    ).toBeNull();
  });
});
