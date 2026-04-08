import { useState, useRef, useEffect, useLayoutEffect, type ReactNode } from 'react';
import { colors } from '../theme/tokens';

interface ModeOption<T extends string> {
  value: T;
  label: string;
  /** 1–2 char shorthand shown in the minimal-variant trigger badge. */
  short?: string;
}

interface ModePickerProps<T extends string> {
  value: T;
  options: ModeOption<T>[];
  onChange: (next: T) => void;
  disabledValues?: T[];
  title?: string;
  /** Optional minimum card width (px). Otherwise sized to fit longest label. */
  minWidth?: number;
  /** Optional leading icon. In `full` variant the icon sits beside the pill;
   *  in `minimal` variant the icon itself is the clickable trigger. */
  icon?: ReactNode;
  /** Visual variant. `minimal` collapses the trigger to icon + shorthand badge. */
  variant?: 'full' | 'minimal';
}

const ICON_GAP = 6;

const ANIM_MS = 240;
const STAGGER_MS = 35;
const Y_GAP = 7;

/** Fan-style mode picker — same interaction as AspectRatioPicker but generic
 *  over any small set of string options. Click the active card to expand;
 *  the alternatives stagger out beneath it. */
export default function ModePicker<T extends string>({
  value,
  options,
  onChange,
  disabledValues = [],
  title,
  minWidth,
  icon,
  variant = 'full',
}: ModePickerProps<T>) {
  const isMinimal = variant === 'minimal';
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number; w: number; h: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // Stable id for the click-outside check (one per instance)
  const layerIdRef = useRef(`mode-fan-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const id = requestAnimationFrame(() => setExpanded(true));
      return () => cancelAnimationFrame(id);
    } else {
      setExpanded(false);
      const totalMs = ANIM_MS + STAGGER_MS * (options.length - 1);
      const id = setTimeout(() => setMounted(false), totalMs);
      return () => clearTimeout(id);
    }
  }, [open, options.length]);

  useLayoutEffect(() => {
    if (!mounted) return;
    const update = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setAnchor({ left: r.left, top: r.top, w: r.width, h: r.height });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [mounted]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return;
      const el = document.getElementById(layerIdRef.current);
      if (el?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const activeOption = options.find((o) => o.value === value) ?? options[0];

  // Fan geometry differs by variant. In `full`, the active option overlays
  // the trigger (slot 0). In `minimal`, the icon trigger stays put and the
  // fan starts one slot below it.
  const triggerSlots = isMinimal ? 1 : 0;
  const fanW = anchor ? (isMinimal ? (minWidth ?? anchor.w) : anchor.w) : 0;
  const fanH = anchor?.h ?? 22;
  const fanOriginTop = anchor ? anchor.top + triggerSlots * (anchor.h + Y_GAP) : 0;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: isMinimal ? 0 : ICON_GAP }}>
      {!isMinimal && icon && (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            color: '#c8c8c8',
          }}
          title={title}
        >
          {icon}
        </span>
      )}
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        style={{
          ...(isMinimal ? minimalTriggerStyle : activeStyle),
          position: 'relative',
          height: '22px',
          padding: isMinimal ? '0 4px' : '0 10px',
          transition: 'all 0.15s ease',
          ...(!isMinimal && minWidth ? { minWidth } : {}),
          ...(!isMinimal && expanded ? { visibility: 'hidden' } : {}),
        }}
        title={title}
      >
        {isMinimal ? (
          <>
            {icon && (
              <span style={{ display: 'inline-flex', alignItems: 'center', color: '#c8c8c8' }}>
                {icon}
              </span>
            )}
            <span style={minimalBadgeStyle}>
              {activeOption.short ?? activeOption.label.slice(0, 2).toUpperCase()}
            </span>
          </>
        ) : (
          /* Render every label stacked in a grid so the button auto-sizes
           *  to the widest one. Only the active label is visible. */
          <span style={{ display: 'grid', alignItems: 'center', justifyItems: 'center' }}>
            {options.map((opt) => (
              <span
                key={opt.value}
                style={{
                  gridArea: '1 / 1',
                  visibility: opt.value === activeOption.value ? 'visible' : 'hidden',
                }}
              >
                {opt.label}
              </span>
            ))}
          </span>
        )}
      </button>

      {mounted && anchor && (
        <div id={layerIdRef.current} style={styles.fanLayer}>
          {options.map((opt, i) => {
            const isActive = opt.value === value;
            const disabled = disabledValues.includes(opt.value);
            const dy = expanded ? i * (fanH + Y_GAP) : 0;
            const opacity = expanded ? (disabled ? 0.4 : 1) : isMinimal ? 0 : isActive ? 1 : 0;
            const delay = expanded ? i * STAGGER_MS : (options.length - 1 - i) * STAGGER_MS;
            return (
              <button
                key={opt.value}
                disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  onChange(opt.value);
                  setOpen(false);
                }}
                style={{
                  ...(isActive ? activeStyle : styles.fanBtn),
                  position: 'absolute',
                  ...(disabled ? { cursor: 'not-allowed' } : {}),
                  left: anchor.left,
                  top: fanOriginTop + dy,
                  width: fanW,
                  height: fanH,
                  opacity,
                  transition: `top ${ANIM_MS}ms cubic-bezier(0.2, 0.9, 0.3, 1.3) ${delay}ms, opacity ${ANIM_MS}ms ease ${delay}ms`,
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}

// Luxurious glass-pill aesthetic. Trigger reads as the active state of the
// fan, so opening the picker simply slides additional options out below it
// without any visual jolt.
const styles: Record<string, React.CSSProperties> = {
  activeBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '24px',
    padding: '0 16px',
    border: `1px solid ${colors.accent}`,
    backgroundColor: '#2a1a13',
    backgroundImage:
      'linear-gradient(180deg, #4a2719 0%, #2a1812 100%)',
    borderRadius: '999px',
    fontSize: '11px',
    fontWeight: 400,
    letterSpacing: '0.05em',
    textTransform: 'uppercase' as const,
    color: '#ffd5c2',
    textShadow: '0 1px 0 rgba(0,0,0,0.35)',
    cursor: 'pointer',
    userSelect: 'none' as const,
    transition: 'all 0.15s ease',
    fontFamily: 'inherit',
    boxShadow:
      'inset 0 1px 0 rgba(255,255,255,0.10), 0 1px 0 rgba(0,0,0,0.35)',
  },
  fanLayer: {
    position: 'fixed',
    inset: 0,
    pointerEvents: 'none',
    zIndex: 1000,
  },
  // Inactive option — soft glass over map, hairline border
  fanBtn: {
    position: 'absolute',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid rgba(255,255,255,0.10)',
    backgroundColor: 'rgba(20,20,22,0.92)',
    backgroundImage:
      'linear-gradient(180deg, rgba(28,28,30,0.92) 0%, rgba(20,20,22,0.92) 100%)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    borderRadius: '999px',
    fontSize: '11px',
    fontWeight: 400,
    letterSpacing: '0.05em',
    textTransform: 'uppercase' as const,
    color: 'rgba(235,235,240,0.78)',
    textShadow: '0 1px 0 rgba(0,0,0,0.35)',
    cursor: 'pointer',
    pointerEvents: 'auto',
    padding: 0,
    boxSizing: 'border-box',
    fontFamily: 'inherit',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
  },
};

// Complete active style — used by both trigger and the active fan option
// without any spread merging, so they're guaranteed to render identically.
const activeStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: `1px solid ${colors.accent}`,
  backgroundColor: '#2a1a13',
  backgroundImage: 'linear-gradient(180deg, #4a2719 0%, #2a1812 100%)',
  borderRadius: '999px',
  fontSize: '11px',
  fontWeight: 400,
  letterSpacing: '0.05em',
  textTransform: 'uppercase' as const,
  color: '#ffd5c2',
  textShadow: '0 1px 0 rgba(0,0,0,0.35)',
  cursor: 'pointer',
  userSelect: 'none' as const,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
  padding: 0,
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.10), 0 1px 0 rgba(0,0,0,0.35)',
};

// Minimal trigger — borderless icon button with a tiny shorthand badge.
// Reads as a single click target; no chrome to compete with the map.
const minimalTriggerStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  border: 'none',
  background: 'transparent',
  borderRadius: '6px',
  cursor: 'pointer',
  userSelect: 'none' as const,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
  color: '#c8c8c8',
};

const minimalBadgeStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 14,
  fontSize: '10px',
  fontWeight: 600,
  letterSpacing: '0.05em',
  textTransform: 'uppercase' as const,
  color: colors.accent,
  textShadow: '0 1px 0 rgba(0,0,0,0.35)',
};
