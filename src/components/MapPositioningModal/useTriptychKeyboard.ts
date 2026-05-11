import { useEffect } from 'react';
import type { AspectRatio } from '../../lib/layout';

export interface UseTriptychKeyboardArgs {
  open: boolean;
  setActiveRatio: (next: AspectRatio) => void;
  onApply: () => void;
  onCancel: () => void;
}

const RATIO_KEYS: Record<string, AspectRatio> = {
  '1': '16_9',
  '2': '4_5',
  '3': '9_16',
};

export function useTriptychKeyboard({
  open,
  setActiveRatio,
  onApply,
  onCancel,
}: UseTriptychKeyboardArgs) {
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) {
        // Don't hijack typing inside form fields. Escape still goes through —
        // a user typing in a not-yet-existing field should still be able to
        // bail out — but the digit-to-ratio bindings would be confusing.
        if (e.key !== 'Escape') return;
      }
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key === 'Enter') {
        e.stopPropagation();
        onApply();
        return;
      }
      const ratio = RATIO_KEYS[e.key];
      if (ratio) {
        e.stopPropagation();
        setActiveRatio(ratio);
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, setActiveRatio, onApply, onCancel]);
}
