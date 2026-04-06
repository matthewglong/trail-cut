import { colors } from '../../theme/tokens';

export const styles: Record<string, React.CSSProperties> = {
  // Collapsed state
  collapsed: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 16px',
    backgroundColor: '#1a1a1a',
    borderBottom: '1px solid #2a2a2a',
    cursor: 'pointer',
    userSelect: 'none',
  },
  chipRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  chip: {
    fontSize: '11px',
    color: '#999',
    fontVariantNumeric: 'tabular-nums',
  },
  divider: {
    width: '1px',
    height: '12px',
    backgroundColor: '#333',
  },
  expandBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '2px',
    display: 'flex',
    alignItems: 'center',
  },

  // Expanded state
  bar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 16px',
    backgroundColor: '#1a1a1a',
    borderBottom: '1px solid #2a2a2a',
  },
  sections: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    flex: 1,
  },
  group: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  groupLabel: {
    display: 'flex',
    alignItems: 'center',
    color: '#666',
  },
  groupControls: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  separator: {
    width: '1px',
    height: '20px',
    backgroundColor: '#2a2a2a',
    flexShrink: 0,
  },


  // Preview
  previewToggle: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    border: '1px solid #3a3a3a',
    borderRadius: '5px',
    cursor: 'pointer',
    padding: 0,
  },

  // Color grade
  lutChip: {
    fontSize: '11px',
    color: '#ccc',
    maxWidth: '80px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  lutClear: {
    background: 'none',
    border: 'none',
    color: '#666',
    cursor: 'pointer',
    padding: '2px',
    display: 'flex',
    alignItems: 'center',
  },
  lutBtn: {
    padding: '4px 10px',
    backgroundColor: '#222',
    color: '#999',
    border: '1px solid #3a3a3a',
    borderRadius: '5px',
    fontSize: '11px',
    cursor: 'pointer',
  },

  collapseBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '2px',
    display: 'flex',
    alignItems: 'center',
    marginLeft: '12px',
  },

  // Accent color chip (used in collapsed crop preview)
  chipAccent: {
    fontSize: '11px',
    color: colors.accent,
    fontVariantNumeric: 'tabular-nums',
  },
};
