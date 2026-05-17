import type { LayoutConfig } from '../../lib/layout';

export type Corner = 'tl' | 'tr' | 'bl' | 'br';

export interface ChromeCornerAssignment {
  ratio: Corner;
  modePill: Corner;
  reset: Corner;
}

// Approximate rendered chrome dimensions. The mode pill is the widest /
// tallest of the three chrome elements; using its bbox as the danger-zone
// envelope means the ratio chip and reset button also get safe spacing.
const CHROME_W_PX = 90;
const CHROME_H_PX = 32;

// Breathing room beyond the chrome's bbox before the corner counts as clear.
const CHROME_PAD_PX = 16;

// The swap chip extends ~1 chip-radius outside the inset's nearest edge,
// and we want chrome to clear that too. Inflating the inset rect by a small
// normalized margin handles both visual breathing room and the chip.
const INSET_INFLATE = 0.04;

interface NormRect { x: number; y: number; w: number; h: number }

const overlaps = (a: NormRect, b: NormRect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const cornerRect = (corner: Corner, dw: number, dh: number): NormRect => {
  switch (corner) {
    case 'tl': return { x: 0,        y: 0,        w: dw, h: dh };
    case 'tr': return { x: 1 - dw,   y: 0,        w: dw, h: dh };
    case 'bl': return { x: 0,        y: 1 - dh,   w: dw, h: dh };
    case 'br': return { x: 1 - dw,   y: 1 - dh,   w: dw, h: dh };
  }
};

/** Compute the chrome safe-zone size in normalized space from rendered
 *  container dimensions. We clamp the result so degenerate containers
 *  (very small or 0) don't produce zero-area or whole-frame zones. */
export function chromeDangerSize(
  containerWidthPx: number,
  containerHeightPx: number,
): { dw: number; dh: number } {
  const w = Math.max(containerWidthPx, 1);
  const h = Math.max(containerHeightPx, 1);
  return {
    dw: Math.min(0.6, (CHROME_W_PX + CHROME_PAD_PX) / w),
    dh: Math.min(0.5, (CHROME_H_PX + CHROME_PAD_PX) / h),
  };
}

/** Which corners would a chrome element collide with given the current layout?
 *  PiP: corners whose safe-zone overlaps the (inflated) inset rect.
 *  Split: corners that fall on the same side as a near-edge divider. */
export function dangerousCorners(
  layout: LayoutConfig,
  dw: number,
  dh: number,
): Set<Corner> {
  const danger = new Set<Corner>();
  const all: Corner[] = ['tl', 'tr', 'bl', 'br'];

  if (layout.mode === 'pip') {
    const inflated: NormRect = {
      x: layout.inset.x - INSET_INFLATE,
      y: layout.inset.y - INSET_INFLATE,
      w: layout.inset.w + 2 * INSET_INFLATE,
      h: layout.inset.h + 2 * INSET_INFLATE,
    };
    for (const c of all) {
      if (overlaps(inflated, cornerRect(c, dw, dh))) danger.add(c);
    }
    return danger;
  }

  // Split mode. The divider line and its handle live in the middle of the
  // dividing axis — they only threaten a corner when the divider sits so
  // close to an edge that chrome at that edge corner would straddle it.
  const verticalDivider = layout.video_side === 'left' || layout.video_side === 'right';
  if (verticalDivider) {
    if (layout.divider < dw) { danger.add('tl'); danger.add('bl'); }
    if (layout.divider > 1 - dw) { danger.add('tr'); danger.add('br'); }
  } else {
    if (layout.divider < dh) { danger.add('tl'); danger.add('tr'); }
    if (layout.divider > 1 - dh) { danger.add('bl'); danger.add('br'); }
  }
  return danger;
}

// Preference lists used for PiP placement. Each element prefers its default
// corner; when displaced, it tries the unclaimed bl corner first, then falls
// back to other defaults. Priority for resolving conflicts (highest to
// lowest): mode pill > reset > ratio.
const MODE_PILL_PREFS: Corner[] = ['tr', 'bl', 'tl', 'br'];
const RESET_PREFS:     Corner[] = ['br', 'bl', 'tl', 'tr'];
const RATIO_PREFS:     Corner[] = ['tl', 'bl', 'tr', 'br'];

function pick(prefs: Corner[], taken: Set<Corner>, dangerous: Set<Corner>): Corner {
  for (const c of prefs) {
    if (!taken.has(c) && !dangerous.has(c)) return c;
  }
  for (const c of prefs) {
    if (!taken.has(c)) return c;
  }
  return prefs[0];
}

// Split mode placement. Each chrome element has a fixed default corner.
// When that default is encroached by the divider, the element flips to the
// mirror corner along the axis perpendicular to the divider:
//   • vertical divider (left/right split) → horizontal flip (left↔right)
//   • horizontal divider (top/bottom split) → vertical flip (top↔bottom)
// If the mirror is also encroached, the element stays at its default —
// no thrashing, no cascading displacement of other buttons.
const SPLIT_DEFAULTS: ChromeCornerAssignment = {
  ratio: 'tl',
  modePill: 'tr',
  reset: 'br',
};

const FLIP_H: Record<Corner, Corner> = { tl: 'tr', tr: 'tl', bl: 'br', br: 'bl' };
const FLIP_V: Record<Corner, Corner> = { tl: 'bl', bl: 'tl', tr: 'br', br: 'tr' };

export function assignChromeCorners(
  layout: LayoutConfig,
  containerWidthPx: number,
  containerHeightPx: number,
): ChromeCornerAssignment {
  const { dw, dh } = chromeDangerSize(containerWidthPx, containerHeightPx);
  const dangerous = dangerousCorners(layout, dw, dh);

  if (layout.mode === 'pip') {
    const taken = new Set<Corner>();
    const modePill = pick(MODE_PILL_PREFS, taken, dangerous); taken.add(modePill);
    const reset    = pick(RESET_PREFS,     taken, dangerous); taken.add(reset);
    const ratio    = pick(RATIO_PREFS,     taken, dangerous);
    return { ratio, modePill, reset };
  }

  const vertical = layout.video_side === 'left' || layout.video_side === 'right';
  const flip = vertical ? FLIP_H : FLIP_V;

  const place = (def: Corner): Corner => {
    if (!dangerous.has(def)) return def;
    const mirror = flip[def];
    if (!dangerous.has(mirror)) return mirror;
    return def;
  };

  return {
    ratio: place(SPLIT_DEFAULTS.ratio),
    modePill: place(SPLIT_DEFAULTS.modePill),
    reset: place(SPLIT_DEFAULTS.reset),
  };
}
