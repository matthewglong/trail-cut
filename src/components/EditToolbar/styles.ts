import { colors } from '../../theme/tokens';

export const styles: Record<string, React.CSSProperties> = {
  // Collapsed summary chips
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
  chipAccent: {
    fontSize: '11px',
    color: colors.accent,
    fontVariantNumeric: 'tabular-nums',
  },

  // Expanded controls
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
};
