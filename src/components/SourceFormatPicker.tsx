// WS9 — Source-format picker.
//
// A single dropdown that surfaces "Auto / Rec.709 SDR / HLG / PQ / Dolby
// Vision / divider / Log variants". Used by:
//   - EditToolbar (per-clip Inspector affordance — see WS9 §1).
//   - SourceFormatConfirmDialog (per-group import-time picker — §2).
//
// Implementation is a custom <button>+popup combo rather than a native
// <select> so the divider row renders correctly and the visual matches the
// rest of the toolbar's dark/inverse-mode language. Behaviour mirrors the
// existing `Dropdown` component (click toggles open, click-outside closes,
// Escape closes + restores focus) but the layout and styling are tuned for
// inline use in a horizontal toolbar.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  SOURCE_FORMAT_OPTIONS,
  type SourceFormatChoice,
} from '../lib/sourceFormat';

interface SourceFormatPickerProps {
  /** Currently-displayed choice. `'auto'` means "no override; use detected". */
  value: SourceFormatChoice;
  onChange: (next: SourceFormatChoice) => void;
  /** Label rendered on the trigger button. Caller composes this so it can
   *  surface detection state — e.g. `"Auto (detected: HLG BT.2020)"`. */
  triggerLabel: string;
  /** Native title for the trigger. */
  title?: string;
  /** Optional minimum trigger width in px. Useful in the import dialog
   *  where the dropdown sits in a wider row. */
  minWidth?: number;
  /** Test ID base for the trigger / menu / options. */
  testId?: string;
  /** Disable the entire control (e.g. while a proxy regeneration is in
   *  flight from a prior change). */
  disabled?: boolean;
}

const TRIGGER_HEIGHT = 24;

export default function SourceFormatPicker({
  value,
  onChange,
  triggerLabel,
  title,
  minWidth = 160,
  testId = 'source-format-picker',
  disabled = false,
}: SourceFormatPickerProps) {
  const [open, setOpen] = useState(false);
  // Viewport-anchored position for the popup. The toolbar shell that hosts
  // this control has `overflow: hidden` and a fixed 40px height, so an
  // absolutely-positioned menu would be clipped behind the panel/video. We
  // render the menu `position: fixed` and pin it to the trigger's bounding
  // rect instead — same escape hatch ModePicker (the aspect picker beside us)
  // uses in this exact toolbar.
  const [anchor, setAnchor] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Measure the trigger when the menu opens and keep it pinned as the layout
  // shifts (window resize, or any scrolling ancestor — capture-phase `scroll`
  // catches nested scrollers too).
  useLayoutEffect(() => {
    if (!open) return undefined;
    const update = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (r) setAnchor({ left: r.left, top: r.bottom + 4, width: r.width });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open, close]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  const handleSelect = (next: SourceFormatChoice) => {
    if (next !== value) onChange(next);
    close(true);
  };

  return (
    <div style={{ ...wrapperStyle, minWidth }}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Source format"
        title={title}
        onClick={() => {
          if (disabled) return;
          setOpen((o) => !o);
        }}
        data-testid={`${testId}-trigger`}
        style={triggerStyle({ open, disabled })}
      >
        <span style={triggerLabelStyle}>{triggerLabel}</span>
        <span style={caretStyle} aria-hidden="true">▾</span>
      </button>

      {open && (
        <div
          ref={menuRef}
          role="listbox"
          aria-label="Source format"
          data-testid={`${testId}-menu`}
          style={{
            ...menuStyle,
            left: anchor?.left ?? 0,
            top: anchor?.top ?? 0,
            minWidth: anchor?.width ?? minWidth,
          }}
        >
          {SOURCE_FORMAT_OPTIONS.map((opt, idx) => {
            if (opt.kind === 'divider') {
              return (
                <div
                  key={`divider-${idx}`}
                  role="separator"
                  style={dividerStyle}
                  aria-hidden="true"
                />
              );
            }
            const isActive = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isActive}
                onClick={() => handleSelect(opt.value)}
                data-testid={`${testId}-option-${opt.value}`}
                style={optionStyle(isActive)}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const wrapperStyle: CSSProperties = {
  position: 'relative',
  display: 'inline-block',
};

function triggerStyle({
  open,
  disabled,
}: {
  open: boolean;
  disabled: boolean;
}): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    height: TRIGGER_HEIGHT,
    padding: '0 8px 0 10px',
    boxSizing: 'border-box',
    backgroundColor: open ? '#222' : '#1a1a1a',
    border: '1px solid #3a3a3a',
    borderRadius: 4,
    color: '#ddd',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    fontSize: 12,
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
}

const triggerLabelStyle: CSSProperties = {
  flex: 1,
  textAlign: 'left',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const caretStyle: CSSProperties = {
  marginLeft: 8,
  color: '#888',
  fontSize: 10,
};

const menuStyle: CSSProperties = {
  // Fixed (viewport-relative) so the toolbar's `overflow: hidden` can't clip
  // it; `left`/`top`/`minWidth` are supplied per-open from the trigger's
  // bounding rect. zIndex matches ModePicker's fan layer so it wins against
  // the video preview / inspector panel.
  position: 'fixed',
  backgroundColor: '#222',
  border: '1px solid #3a3a3a',
  borderRadius: 4,
  boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
  zIndex: 1000,
  padding: 4,
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
};

function optionStyle(isActive: boolean): CSSProperties {
  return {
    display: 'block',
    width: '100%',
    padding: '6px 10px',
    backgroundColor: isActive ? '#4a7c59' : 'transparent',
    color: isActive ? '#fff' : '#ccc',
    border: 'none',
    borderRadius: 3,
    cursor: 'pointer',
    fontSize: 12,
    fontFamily: 'inherit',
    textAlign: 'left',
    whiteSpace: 'nowrap',
  };
}

const dividerStyle: CSSProperties = {
  height: 1,
  margin: '4px 6px',
  backgroundColor: '#3a3a3a',
};
