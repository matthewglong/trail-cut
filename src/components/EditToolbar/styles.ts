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
    gap: '7px',
    height: '24px',
  },
  groupLabel: {
    display: 'flex',
    alignItems: 'center',
    color: '#c8c8c8',
  },
  separator: {
    width: '1px',
    height: '16px',
    backgroundColor: '#2a2a2a',
    flexShrink: 0,
    margin: '0 4px',
  },

  // Preview pill (matches GPX chip style from ProjectView)
  previewPillOff: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '3px 10px',
    border: '1px dashed #555',
    borderRadius: '20px',
    cursor: 'pointer',
    fontSize: '11px',
    color: '#777',
    userSelect: 'none' as const,
    transition: 'all 0.15s ease',
  },
  previewPillOn: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '3px 10px',
    border: '1px solid #4a7c59',
    borderRadius: '20px',
    backgroundColor: 'rgba(74, 124, 89, 0.15)',
    cursor: 'pointer',
    fontSize: '11px',
    color: '#8bc49a',
    userSelect: 'none' as const,
    transition: 'all 0.15s ease',
  },
  previewDotOff: {
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    border: '1px solid #555',
    flexShrink: 0,
  },
  previewDotOn: {
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    backgroundColor: '#6abf7b',
    flexShrink: 0,
  },
};
