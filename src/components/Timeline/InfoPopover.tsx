import { useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Clip } from '../../types';
import { popoverStyles } from './styles';

interface InfoPopoverProps {
  clip: Clip;
  anchorRect: DOMRect;
  onClose: () => void;
}

/** Info popover shown when clicking the info icon */
export default function InfoPopover({ clip, anchorRect, onClose }: InfoPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    const timer = setTimeout(() => document.addEventListener('click', handleClick), 0);
    return () => { clearTimeout(timer); document.removeEventListener('click', handleClick); };
  }, [onClose]);

  // Clamp horizontally so it doesn't go off-screen
  const popoverWidth = 220; // matches minWidth
  const centerX = anchorRect.left + anchorRect.width / 2;
  const clampedLeft = Math.max(8, Math.min(centerX - popoverWidth / 2, window.innerWidth - popoverWidth - 8));

  const popoverContent = (
    <div ref={ref} style={{
      ...popoverStyles.container,
      left: `${clampedLeft}px`,
      top: `${anchorRect.top - 8}px`,
      transform: 'translateY(-100%)',
    }}>
      <div style={popoverStyles.title}>{clip.filename}</div>
      <div style={popoverStyles.rows}>
        {clip.created_at && (
          <div style={popoverStyles.row}>
            <span style={popoverStyles.label}>Filmed</span>
            <span style={popoverStyles.value}>{clip.created_at}</span>
          </div>
        )}
        {clip.duration_ms !== null && (
          <div style={popoverStyles.row}>
            <span style={popoverStyles.label}>Duration</span>
            <span style={popoverStyles.value}>{(clip.duration_ms / 1000).toFixed(1)}s</span>
          </div>
        )}
        {clip.resolution && (
          <div style={popoverStyles.row}>
            <span style={popoverStyles.label}>Resolution</span>
            <span style={popoverStyles.value}>{clip.resolution}</span>
          </div>
        )}
        {clip.frame_rate && (
          <div style={popoverStyles.row}>
            <span style={popoverStyles.label}>FPS</span>
            <span style={popoverStyles.value}>{clip.frame_rate}</span>
          </div>
        )}
        {clip.gps && (
          <div style={popoverStyles.row}>
            <span style={popoverStyles.label}>GPS</span>
            <span style={popoverStyles.value}>{clip.gps.lat.toFixed(5)}, {clip.gps.lng.toFixed(5)}</span>
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(popoverContent, document.body);
}
