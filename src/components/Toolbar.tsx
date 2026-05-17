import type { ReactNode, Ref } from 'react';

interface ToolbarProps {
  children?: ReactNode;
  /** Horizontal gap between top-level children in the content row. */
  contentGap?: number;
  /** Optional style overrides for the bar container. */
  barStyle?: React.CSSProperties;
  /** Optional className on the bar container. */
  barClassName?: string;
  /** Optional ref to the bar container — used by consumers that need to
   *  observe its size (e.g. MapToolbar's overflow measurement). */
  barRef?: Ref<HTMLDivElement>;
}

export default function Toolbar({
  children,
  contentGap,
  barStyle,
  barClassName,
  barRef,
}: ToolbarProps) {
  const contentStyle =
    contentGap != null ? { ...styles.content, gap: `${contentGap}px` } : styles.content;
  const mergedBar = barStyle ? { ...styles.bar, ...barStyle } : styles.bar;

  return (
    <div ref={barRef} className={barClassName} style={mergedBar}>
      <div style={contentStyle}>{children}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    padding: '0 16px',
    backgroundColor: '#1a1a1a',
    borderBottom: '1px solid #2a2a2a',
    height: '40px',
    overflow: 'hidden',
  },
  content: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    flex: 1,
    minWidth: 0,
  },
};
