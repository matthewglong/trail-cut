// Dropdown — single-trigger picker that opens to a popup option list, in
// the same Inverse (Norton Commander) language as `SegmentedPicker` and
// `GridPicker`. Use this when:
//   • the option list is too long for a horizontal segmented strip
//   • the row needs to stay compact and only surface the current value
//
// Closed:
//   ┌──────────────────────────────────────┐
//   │ TOPOGRAPHIC                       ▼ │
//   └──────────────────────────────────────┘
//
// Open:
//   ┌──────────────────────────────────────┐
//   │ TOPOGRAPHIC                       ▲ │
//   ├──────────────────────────────────────┤
//   │   STANDARD                          │
//   │ ▓▓▓ TOPOGRAPHIC ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │  ← active = solid chartreuse, dark text
//   │   SATELLITE                         │
//   └──────────────────────────────────────┘
//
// Mechanics:
//   • Single trigger; click toggles open. Active option in the open menu
//     gets the same solid-chartreuse + canvas-dark treatment as the active
//     segment of `SegmentedPicker`. Hover on idle options brightens text.
//   • Click-outside and Escape close the menu (Escape restores focus to
//     the trigger).
//   • ARIA: trigger is `aria-haspopup="listbox"` + `aria-expanded`; menu is
//     `role="listbox"` with each row `role="option"` and `aria-selected`.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { ChevronDown } from 'lucide-react';
import { semantic, fonts, radii, typeScale } from '../theme/tokens';

interface DropdownOption<T extends string> {
  value: T;
  label: string;
  /** Optional tooltip; falls back to `label`. */
  title?: string;
}

interface DropdownProps<T extends string> {
  value: T;
  options: DropdownOption<T>[];
  onChange: (next: T) => void;
  disabledValues?: T[];
  /** Disables the trigger entirely. */
  disabled?: boolean;
  /** Accessible label for the listbox (and the trigger's aria-label). */
  ariaLabel?: string;
  /** Native title attribute on the trigger. */
  title?: string;
  /** Optional placeholder rendered when `value` doesn't match any option. */
  placeholder?: string;
  /** Anchor side for the popup. Defaults to `left`; pass `right` when the
   *  trigger sits on the right edge of a panel so the popup doesn't clip. */
  anchor?: 'left' | 'right';
  /** Test-id base for the trigger + listbox. Defaults to `dropdown`. */
  testId?: string;
}

const TRIGGER_HEIGHT = 26;
const ANIM_MS = 180;
const ANIM_EASING = 'cubic-bezier(0.6, 0, 0.2, 1)';

/** Inverse-style dropdown picker. See module docstring. */
export default function Dropdown<T extends string>({
  value,
  options,
  onChange,
  disabledValues = [],
  disabled = false,
  ariaLabel,
  title,
  placeholder,
  anchor = 'left',
  testId = 'dropdown',
}: DropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const [hoveredValue, setHoveredValue] = useState<T | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const activeOption = options.find((o) => o.value === value) ?? null;

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Click-outside closes the menu (without restoring focus — the click
  // landed somewhere else on purpose).
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

  // Escape closes the menu and returns focus to the trigger.
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

  const handleSelect = (opt: DropdownOption<T>) => {
    if (disabledValues.includes(opt.value)) return;
    if (opt.value !== value) onChange(opt.value);
    close(true);
  };

  return (
    <div style={wrapperStyle}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (disabled) return;
          setOpen((o) => !o);
        }}
        data-testid={`${testId}-trigger`}
        style={triggerStyle({ open, disabled })}
      >
        <span style={triggerLabelStyle}>
          {activeOption?.label ?? placeholder ?? '—'}
        </span>
        <span style={caretStyle(open)} aria-hidden="true">
          <ChevronDown size={12} strokeWidth={2.5} />
        </span>
      </button>

      {open && (
        <div
          ref={menuRef}
          role="listbox"
          aria-label={ariaLabel}
          data-testid={`${testId}-menu`}
          style={menuStyle(anchor)}
        >
          {options.map((opt) => {
            const isActive = opt.value === value;
            const isDisabled = disabledValues.includes(opt.value);
            const isHovered = hoveredValue === opt.value && !isDisabled;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isActive}
                disabled={isDisabled}
                title={opt.title ?? opt.label}
                onMouseEnter={() => setHoveredValue(opt.value)}
                onMouseLeave={() => setHoveredValue(null)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleSelect(opt)}
                data-testid={`${testId}-option-${opt.value}`}
                style={optionStyle({ isActive, isDisabled, isHovered })}
              >
                <span style={optionLabelStyle}>{opt.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- styles --------------------------------------------------------

const wrapperStyle: CSSProperties = {
  position: 'relative',
  display: 'inline-block',
  width: '100%',
};

function triggerStyle({
  open,
  disabled,
}: {
  open: boolean;
  disabled: boolean;
}): CSSProperties {
  return {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    height: TRIGGER_HEIGHT,
    padding: '0 8px 0 10px',
    boxSizing: 'border-box',
    backgroundColor: 'rgba(8, 12, 14, 0.7)',
    border: '1px solid rgba(76, 91, 92, 0.55)',
    borderRadius: radii.base,
    color: open ? semantic.fg : semantic.fgMuted,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.35 : 1,
    fontFamily: fonts.mono,
    fontSize: typeScale.eyebrow,
    fontWeight: 500,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    transition: 'color 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease',
    boxShadow: open
      ? '0 0 0 1px rgba(188, 237, 9, 0.45)'
      : 'inset 0 1px 0 rgba(255, 255, 255, 0.03), inset 0 -1px 0 rgba(0, 0, 0, 0.28)',
    userSelect: 'none',
  };
}

const triggerLabelStyle: CSSProperties = {
  display: 'inline-block',
  flex: 1,
  textAlign: 'left',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

function caretStyle(open: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: open ? semantic.accent : semantic.fgDim,
    marginLeft: 6,
    transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
    transition: `transform ${ANIM_MS}ms ${ANIM_EASING}, color 0.18s ease`,
  };
}

function menuStyle(anchor: 'left' | 'right'): CSSProperties {
  return {
    position: 'absolute',
    top: TRIGGER_HEIGHT + 4,
    [anchor]: 0,
    minWidth: '100%',
    maxHeight: 260,
    overflowY: 'auto',
    padding: 4,
    boxSizing: 'border-box',
    backgroundColor: 'rgba(8, 12, 14, 0.96)',
    border: '1px solid rgba(76, 91, 92, 0.55)',
    borderRadius: radii.base,
    boxShadow:
      '0 10px 28px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(0, 0, 0, 0.35)',
    zIndex: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
  };
}

function optionStyle({
  isActive,
  isDisabled,
  isHovered,
}: {
  isActive: boolean;
  isDisabled: boolean;
  isHovered: boolean;
}): CSSProperties {
  return {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    width: '100%',
    height: TRIGGER_HEIGHT - 2,
    padding: '0 10px',
    background: isActive ? semantic.accent : 'transparent',
    border: 'none',
    borderRadius: 2,
    color: isActive
      ? semantic.bg
      : isHovered
        ? semantic.fg
        : semantic.fgMuted,
    cursor: isDisabled ? 'not-allowed' : 'pointer',
    opacity: isDisabled ? 0.35 : 1,
    fontFamily: fonts.mono,
    fontSize: typeScale.eyebrow,
    fontWeight: isActive ? 700 : 500,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    textAlign: 'left',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    boxShadow: isActive
      ? 'inset 0 1px 0 rgba(255, 255, 255, 0.45), inset 0 -1px 0 rgba(0, 0, 0, 0.3)'
      : undefined,
    textShadow: isActive ? '0 1px 0 rgba(188, 237, 9, 0.6)' : undefined,
    transition: 'color 0.15s ease, background-color 0.15s ease',
    userSelect: 'none',
  };
}

const optionLabelStyle: CSSProperties = {
  display: 'inline-block',
  flex: 1,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
