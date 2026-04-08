// Map toolbar styling — intentionally re-exports EditToolbar's style objects
// so a single change to the design tokens or the EditToolbar look re-skins
// both toolbars in lockstep.

import { styles as editStyles } from '../EditToolbar/styles';

export const styles: Record<string, React.CSSProperties> = {
  ...editStyles,
  pillDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
};
