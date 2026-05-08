// Tiny "Show layout" / "Hide layout" toggle that lives in the VideoPreview
// pane (task 080). Pure UI: parent owns the boolean state and persistence
// (localStorage keyed by project dir, per the task's lower-friction option).

import type { CSSProperties } from 'react';

interface LayoutPreviewToggleProps {
  visible: boolean;
  onToggle: () => void;
  /** Optional style overrides for placement adjustments by the parent. */
  style?: CSSProperties;
}

export function LayoutPreviewToggle({ visible, onToggle, style }: LayoutPreviewToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={visible
        ? 'Hide the 9:16 layout overlay'
        : 'Show the 9:16 layout overlay (where map and video sit in the export)'
      }
      style={{ ...baseStyle, ...(visible ? activeStyle : null), ...style }}
      data-testid="layout-preview-toggle"
    >
      {visible ? 'Hide layout' : 'Show layout'}
    </button>
  );
}

const baseStyle: CSSProperties = {
  padding: '4px 10px',
  backgroundColor: 'rgba(20, 20, 20, 0.78)',
  color: '#ccc',
  border: '1px solid #3a3a3a',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12,
  fontFamily: 'inherit',
  userSelect: 'none' as const,
  whiteSpace: 'nowrap' as const,
};

const activeStyle: CSSProperties = {
  backgroundColor: 'rgba(82, 214, 255, 0.18)',
  color: '#52d6ff',
  borderColor: '#52d6ff',
};

export default LayoutPreviewToggle;
