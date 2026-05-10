// Tiny "Show layout" / "Hide layout" toggle that lives in the VideoPreview
// pane (task 080). Pure UI: parent owns the boolean state and persistence
// (localStorage keyed by project dir, per the task's lower-friction option).

import type { CSSProperties } from 'react';

interface LayoutPreviewToggleProps {
  visible: boolean;
  onToggle: () => void;
  /** Optional secondary "Edit" affordance — when provided, renders a small
   *  pencil button next to the toggle that calls `onEdit` when clicked.
   *  Wired by the configurator (110) to mount the interactive editor. */
  onEdit?: () => void;
  /** Optional style overrides for placement adjustments by the parent. */
  style?: CSSProperties;
}

export function LayoutPreviewToggle({ visible, onToggle, onEdit, style }: LayoutPreviewToggleProps) {
  return (
    <div style={{ ...wrapperStyle, ...style }}>
      <button
        type="button"
        onClick={onToggle}
        title={visible
          ? 'Hide layout overlay'
          : 'Show layout overlay (where map and video sit in the export)'
        }
        style={{ ...baseStyle, ...(visible ? activeStyle : null) }}
        data-testid="layout-preview-toggle"
      >
        {visible ? 'Hide layout' : 'Show layout'}
      </button>
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          title="Edit the layout"
          style={{ ...baseStyle, ...editButtonStyle }}
          data-testid="layout-preview-edit"
          aria-label="Edit layout"
        >
          {pencilIcon}
        </button>
      )}
    </div>
  );
}

const pencilIcon = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
  </svg>
);

const wrapperStyle: CSSProperties = {
  display: 'inline-flex',
  gap: 6,
  alignItems: 'center',
};

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

const editButtonStyle: CSSProperties = {
  padding: '4px 8px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

export default LayoutPreviewToggle;
