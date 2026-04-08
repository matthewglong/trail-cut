import { useState, type ReactNode } from 'react';

const ChevronDown = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path d="M3 5L6 8L9 5" stroke="#888" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ChevronUp = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path d="M3 8L6 5L9 8" stroke="#888" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

interface CollapsibleToolbarProps {
  children?: ReactNode;
  collapsedContent?: ReactNode;
  defaultExpanded?: boolean;
  /** Horizontal gap between top-level children in the expanded content row. */
  contentGap?: number;
}

export default function CollapsibleToolbar({
  children,
  collapsedContent,
  defaultExpanded = true,
  contentGap,
}: CollapsibleToolbarProps) {
  const contentStyle =
    contentGap != null ? { ...styles.content, gap: `${contentGap}px` } : styles.content;
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (!expanded) {
    return (
      <div style={styles.bar} onClick={() => setExpanded(true)}>
        <div style={contentStyle}>
          {collapsedContent}
        </div>
        <button style={styles.toggleBtn} onClick={(e) => { e.stopPropagation(); setExpanded(true); }}>
          <ChevronDown />
        </button>
      </div>
    );
  }

  return (
    <div style={styles.bar}>
      <div style={contentStyle}>
        {children}
      </div>
      <button style={styles.toggleBtn} onClick={() => setExpanded(false)}>
        <ChevronUp />
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 16px',
    backgroundColor: '#1a1a1a',
    borderBottom: '1px solid #2a2a2a',
    height: '40px',
    cursor: 'default',
    overflow: 'hidden',
  },
  content: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    flex: 1,
  },
  toggleBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '2px',
    display: 'flex',
    alignItems: 'center',
    marginLeft: '12px',
    flexShrink: 0,
  },
};
