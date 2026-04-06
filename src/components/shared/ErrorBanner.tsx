import React from 'react';
import { colors } from '../../theme/tokens';

interface ErrorBannerProps {
  message: string;
  onDismiss: () => void;
}

export default function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  return (
    <div style={styles.error}>
      {message}
      <button style={styles.dismissBtn} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  error: {
    padding: '8px 16px',
    backgroundColor: colors.errorBg,
    color: colors.errorText,
    fontSize: '13px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dismissBtn: {
    background: 'none',
    border: 'none',
    color: colors.errorText,
    cursor: 'pointer',
    textDecoration: 'underline',
    fontSize: '12px',
  },
};
