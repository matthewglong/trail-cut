import { useState, useRef, useEffect, useLayoutEffect } from 'react';

const RATIOS = ['16:9', '9:16', '1:1', '4:5'];

interface AspectRatioPickerProps {
  value: string;
  onChange: (ratio: string) => void;
}

const ANIM_MS = 240;
const STAGGER_MS = 35;

export default function AspectRatioPicker({ value, onChange }: AspectRatioPickerProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number; w: number; h: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Two-phase mount/unmount so the close animation has time to run
  useEffect(() => {
    if (open) {
      setMounted(true);
      // next frame, flip to expanded so transition fires
      const id = requestAnimationFrame(() => setExpanded(true));
      return () => cancelAnimationFrame(id);
    } else {
      setExpanded(false);
      const totalMs = ANIM_MS + STAGGER_MS * (RATIOS.length - 1);
      const id = setTimeout(() => setMounted(false), totalMs);
      return () => clearTimeout(id);
    }
  }, [open]);

  // Recompute anchor position when mounted, and on scroll/resize while mounted
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

  // Click-outside to close
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return;
      const el = document.getElementById('aspect-fan-layer');
      if (el?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  // Diagonal staircase, exponential offset (slow at first, accelerating)
  const Y_GAP = 5;

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        style={{
          ...styles.activeBtn,
          ...(expanded ? { visibility: 'hidden' } : {}),
        }}
        title="Aspect ratio"
      >
        {value}
      </button>

      {mounted && anchor && (
        <div id="aspect-fan-layer" style={styles.fanLayer}>
          {RATIOS.map((r, i) => {
            const isActive = r === value;
            const dy = expanded ? i * (anchor.h + Y_GAP) : 0;
            const opacity = expanded ? 1 : isActive ? 1 : 0;
            // Reverse the stagger order on close so the last items leave first
            const delay = expanded ? i * STAGGER_MS : (RATIOS.length - 1 - i) * STAGGER_MS;
            return (
              <button
                key={r}
                onClick={() => {
                  onChange(r);
                  setOpen(false);
                }}
                style={{
                  ...styles.fanBtn,
                  ...(isActive ? styles.fanBtnActive : {}),
                  left: anchor.left,
                  top: anchor.top,
                  width: anchor.w,
                  height: anchor.h,
                  transform: `translate(0, ${dy}px)`,
                  opacity,
                  transition: `transform ${ANIM_MS}ms cubic-bezier(0.2, 0.9, 0.3, 1.3) ${delay}ms, opacity ${ANIM_MS}ms ease ${delay}ms`,
                }}
              >
                {r}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  activeBtn: {
    padding: '5px 12px',
    backgroundColor: '#ff6b35',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
    minWidth: '44px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
    transition: 'transform 0.15s ease',
  },
  activeBtnOpen: {
    transform: 'scale(1.05)',
  },
  fanLayer: {
    position: 'fixed',
    inset: 0,
    pointerEvents: 'none',
    zIndex: 1000,
  },
  fanBtn: {
    position: 'absolute',
    borderRadius: 6,
    backgroundColor: '#2a2a2a',
    color: '#ddd',
    border: '1px solid #444',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    pointerEvents: 'auto',
    boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    boxSizing: 'border-box',
  },
  fanBtnActive: {
    backgroundColor: '#ff6b35',
    color: '#fff',
    border: '1px solid #ff6b35',
  },
};
