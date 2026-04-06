import { useEffect } from 'react';

/**
 * Closes a dropdown/popover when clicking outside.
 * Uses the setTimeout trick to avoid closing on the same click that opened it.
 */
export function useDropdownClose(isOpen: boolean, onClose: () => void) {
  useEffect(() => {
    if (!isOpen) return;
    const close = () => onClose();
    const timer = setTimeout(() => document.addEventListener('click', close), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', close);
    };
  }, [isOpen, onClose]);
}
