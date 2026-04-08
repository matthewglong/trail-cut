// Map toolbar styling — re-exports EditToolbar's style objects so a single
// design-token change re-skins both toolbars in lockstep, plus segmented
// control styles for the tri-state mode pickers.

import { styles as editStyles } from '../EditToolbar/styles';
import { colors } from '../../theme/tokens';

export const styles: Record<string, React.CSSProperties> = {
  ...editStyles,

  segmented: {
    display: 'flex',
    alignItems: 'stretch',
    border: '1px solid #555',
    borderRadius: '20px',
    overflow: 'hidden',
    height: '22px',
  },
  segmentedBtn: {
    background: 'transparent',
    border: 'none',
    borderLeft: '1px solid #3a3a3a',
    color: '#888',
    fontSize: '10px',
    fontWeight: 600,
    letterSpacing: '0.04em',
    padding: '0 10px',
    cursor: 'pointer',
    userSelect: 'none' as const,
    transition: 'all 0.15s ease',
  },
  segmentedBtnActive: {
    backgroundColor: 'rgba(255, 107, 53, 0.18)',
    color: colors.accent,
  },
  segmentedBtnDisabled: {
    opacity: 0.35,
    cursor: 'not-allowed',
  },
};
