// WS9 — EditToolbar source-format dropdown integration tests. The dropdown
// is the per-clip Inspector affordance the brief calls for in §1; these
// tests assert that:
//   - the dropdown reflects the clip's current effective class
//   - selecting a non-Auto option calls onUpdateSourceFormat with the class
//   - selecting Auto calls onUpdateSourceFormat(null)
//   - the badge surfaces Detected / Suggested / Overridden per clip state

import { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import EditToolbar from '../EditToolbar';
import type { Clip } from '../../../types';

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

function clipFixture(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    path: '/tmp/c1.mov',
    filename: 'c1.mov',
    created_at: null,
    duration_ms: 1000,
    gps: null,
    resolution: null,
    frame_rate: null,
    trim: null,
    focal_point: { x: 0.5, y: 0.5, zoom: 1 },
    effects: { stabilize: { enabled: false, shakiness: 5 }, speed: 1 },
    visible: true,
    map_overrides: null,
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

function renderWith(clip: Clip, onUpdateSourceFormat = vi.fn()) {
  act(() => {
    root.render(
      <EditToolbar
        clip={clip}
        onUpdateFocalPoint={vi.fn()}
        onUpdateEffects={vi.fn()}
        onUpdateSourceFormat={onUpdateSourceFormat}
        previewAspect="16:9"
        onChangeAspect={vi.fn()}
        cropPreview={false}
        onToggleCropPreview={vi.fn()}
      />,
    );
  });
  return onUpdateSourceFormat;
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

describe('EditToolbar source-format dropdown', () => {
  it('renders Auto trigger label with the detected class for an un-overridden clip', () => {
    const clip = clipFixture({ source_color_class: 'hlg_bt2020' });
    renderWith(clip);
    const trigger = q('[data-testid="clip-source-format-trigger"]');
    expect(trigger.textContent).toContain('Auto');
    expect(trigger.textContent).toContain('HLG BT.2020 HDR');
  });

  it('renders the override class on the trigger when user_color_class_override is set', () => {
    const clip = clipFixture({
      source_color_class: 'sdr_bt709',
      user_color_class_override: 'd_log',
    });
    renderWith(clip);
    const trigger = q('[data-testid="clip-source-format-trigger"]');
    // Auto is no longer the choice; the trigger label is the override class.
    expect(trigger.textContent).toContain('D-Log');
    expect(trigger.textContent).not.toContain('Auto');
  });

  it('surfaces a DETECTED badge for a normal clip', () => {
    const clip = clipFixture({ source_color_class: 'sdr_bt709' });
    renderWith(clip);
    const badge = q('[data-testid="clip-source-format-badge"]');
    expect(badge.textContent).toBe('DETECTED');
  });

  it('surfaces a SUGGESTED badge with the suggested class when present', () => {
    const clip = clipFixture({
      source_color_class: 'sdr_bt709',
      suggested_log_class: 'd_log',
    });
    renderWith(clip);
    const badge = q('[data-testid="clip-source-format-badge"]');
    expect(badge.textContent).toContain('SUGGESTED');
    expect(badge.textContent).toContain('D-Log');
  });

  it('surfaces an OVERRIDE badge when the user has set an override', () => {
    const clip = clipFixture({ user_color_class_override: 'd_log' });
    renderWith(clip);
    const badge = q('[data-testid="clip-source-format-badge"]');
    expect(badge.textContent).toBe('OVERRIDE');
  });

  it('calls onUpdateSourceFormat with the picked class when user selects a non-Auto option', () => {
    const onUpdate = vi.fn();
    const clip = clipFixture({ source_color_class: 'sdr_bt709' });
    renderWith(clip, onUpdate);

    // Open the dropdown.
    click(q('[data-testid="clip-source-format-trigger"]'));
    // Select the D-Log option.
    click(q('[data-testid="clip-source-format-option-d_log"]'));

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith('d_log');
  });

  it('calls onUpdateSourceFormat(null) when user selects Auto to clear an override', () => {
    const onUpdate = vi.fn();
    const clip = clipFixture({
      source_color_class: 'sdr_bt709',
      user_color_class_override: 'd_log',
    });
    renderWith(clip, onUpdate);

    click(q('[data-testid="clip-source-format-trigger"]'));
    click(q('[data-testid="clip-source-format-option-auto"]'));

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith(null);
  });
});
