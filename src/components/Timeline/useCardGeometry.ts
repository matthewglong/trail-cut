// Strip-relative card geometry for the Timeline overlays (GroupBar + the
// floating Group button). Measures `offsetLeft` / `offsetWidth` of every
// `[data-clip-card="<clipId>"]` inside the strip — the strip is the offset
// parent (`position: relative`), so values are scroll-immune and map 1:1
// onto absolutely-positioned children of the strip. Measurement runs inside
// a `ResizeObserver` callback (which also delivers an initial observation),
// so no state is written from an effect body.

import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { Clip } from '../../types';

export interface CardGeometry {
  /** `offsetLeft` relative to the strip. */
  left: number;
  /** `offsetWidth`. */
  width: number;
}
export type CardGeometryMap = ReadonlyMap<string, CardGeometry>;

const EMPTY_GEOMETRY: CardGeometryMap = new Map();

function measureCards(strip: HTMLElement): Map<string, CardGeometry> {
  const out = new Map<string, CardGeometry>();
  strip.querySelectorAll<HTMLElement>('[data-clip-card]').forEach((el) => {
    const id = el.dataset.clipCard;
    if (!id) return;
    out.set(id, { left: el.offsetLeft, width: el.offsetWidth });
  });
  return out;
}

function sameGeometry(a: CardGeometryMap, b: CardGeometryMap): boolean {
  if (a.size !== b.size) return false;
  for (const [id, g] of a) {
    const o = b.get(id);
    if (!o || o.left !== g.left || o.width !== g.width) return false;
  }
  return true;
}

/** Measures every `[data-clip-card="<clipId>"]` inside `stripRef` and keeps
 *  the map current via a `ResizeObserver` on the strip and each card.
 *  Re-subscribes when `clips` or `layoutKey` change (new cards, thumbnail
 *  swaps). Values are strip-relative offsets, scroll-immune. */
export function useCardGeometry(
  stripRef: RefObject<HTMLDivElement | null>,
  clips: Clip[],
  layoutKey?: unknown,
): CardGeometryMap {
  const [geometry, setGeometry] = useState<CardGeometryMap>(EMPTY_GEOMETRY);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const remeasure = () => {
      const next = measureCards(strip);
      setGeometry((prev) => (sameGeometry(prev, next) ? prev : next));
    };
    const ro = new ResizeObserver(remeasure);
    // `observe` delivers an initial observation, so the first measurement
    // lands without a synchronous setState here.
    ro.observe(strip);
    strip.querySelectorAll<HTMLElement>('[data-clip-card]').forEach((el) => ro.observe(el));
    return () => ro.disconnect();
    // `layoutKey` is a deliberate re-subscribe trigger (thumbnail churn).
  }, [stripRef, clips, layoutKey]);

  return geometry;
}

