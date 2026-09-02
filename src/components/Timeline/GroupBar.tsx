// GroupBar — the clip-group overlay for the Timeline strip
// (docs/CLIP_GROUPS_HANDOFF.md §4). One thin rounded bar per group spans
// the top edge of its member cards; the bar is selectable (click),
// deletable (× cap / Delete / Backspace while selected) and resizable by
// dragging either end across neighbouring cards.
//
// Geometry: the overlay is an absolutely-positioned sibling layer INSIDE
// `styles.strip`, so it scrolls with the cards. Bars are laid out from the
// member cards' `offsetLeft` / `offsetWidth` (offset-parent = the strip,
// which is `position: relative`) — never `getBoundingClientRect`, which
// would shift with the scroller. The only client-rect read is the
// pointer→strip conversion during a drag. Measurement happens inside a
// `ResizeObserver` callback (which also delivers an initial observation),
// so no state is written from an effect body. A bar whose member card is
// not measurable (thumbnail churn, mid-batch render) is simply not drawn.
//
// The membership rule for the end-handle drag is `resizeGroupEdge` in
// `src/lib/clipGroups.ts` (pure, tested); this component only decides which
// card the pointer is over and renders a local pending membership until
// pointerup commits through `onResizeGroup`. Card measurement lives in
// `useCardGeometry.ts` (kept separate so this file only exports a component).

import { useEffect, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type { Clip, ClipGroup } from '../../types';
import { resizeGroupEdge } from '../../lib/clipGroups';
import type { CardGeometryMap } from './useCardGeometry';
import { styles } from './styles';

const isTypingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  const tag = el?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || !!el?.isContentEditable;
};

type Edge = 'start' | 'end';

interface PendingResize {
  groupId: string;
  clipIds: string[];
}

export interface GroupBarProps {
  /** Timeline-ordered clips. */
  clips: Clip[];
  /** Normalized groups (contiguous runs of ≥2 clip ids). */
  groups: ClipGroup[];
  /** Card geometry from `useCardGeometry`. */
  geometry: CardGeometryMap;
  /** The strip element — used only for the pointer→strip conversion during
   *  an end-handle drag. */
  stripRef: RefObject<HTMLDivElement | null>;
  selectedGroupId: string | null;
  highlightedGroupId: string | null;
  /** Click → `id`; Escape / click-away → `null`. */
  onSelectGroup?: (id: string | null) => void;
  /** × cap, Delete or Backspace while selected. Clips are untouched. */
  onDeleteGroup?: (id: string) => void;
  /** Committed on pointerup after an end-handle drag; `clipIds` is already
   *  normalized by `resizeGroupEdge`. */
  onResizeGroup?: (id: string, clipIds: string[]) => void;
}

export default function GroupBar({
  clips,
  groups,
  geometry,
  stripRef,
  selectedGroupId,
  highlightedGroupId,
  onSelectGroup,
  onDeleteGroup,
  onResizeGroup,
}: GroupBarProps) {
  const [pending, setPending] = useState<PendingResize | null>(null);

  // Keyboard + click-away, active only while a group is selected.
  useEffect(() => {
    if (selectedGroupId == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onSelectGroup?.(null);
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !isTypingTarget(e.target)) {
        e.preventDefault();
        onDeleteGroup?.(selectedGroupId);
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (el?.closest?.('[data-group-bar]')) return;
      onSelectGroup?.(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [selectedGroupId, onSelectGroup, onDeleteGroup]);

  /** Which clip an edge lands on for a pointer at strip-x `x`: the start
   *  edge snaps to the first card whose midpoint is right of the pointer,
   *  the end edge to the last card whose midpoint is left of it — so
   *  crossing a neighbour's midpoint flips its membership. */
  const clipAtEdge = (edge: Edge, x: number): string | null => {
    let fallback: string | null = null;
    if (edge === 'start') {
      for (const c of clips) {
        const g = geometry.get(c.id);
        if (!g) continue;
        fallback = c.id;
        if (g.left + g.width / 2 > x) return c.id;
      }
      return fallback;
    }
    for (let i = clips.length - 1; i >= 0; i -= 1) {
      const c = clips[i];
      const g = geometry.get(c.id);
      if (!g) continue;
      fallback = c.id;
      if (g.left + g.width / 2 < x) return c.id;
    }
    return fallback;
  };

  // End-handle drag — pointer capture on the handle (same pattern as
  // DecorationPanel's `startDrag`) so move/up arrive even when the pointer
  // leaves the strip. Membership is re-derived from the COMMITTED groups on
  // every move via `resizeGroupEdge`, rendered as `pending`, and committed
  // once on pointerup.
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>, groupId: string, edge: Edge) => {
    if (e.button !== 0) return;
    if (!onResizeGroup) return;
    const strip = stripRef.current;
    if (!strip) return;
    e.stopPropagation();
    e.preventDefault();
    onSelectGroup?.(groupId);
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);

    let latest: string[] | null = null;
    const move = (ev: PointerEvent) => {
      const x = ev.clientX - strip.getBoundingClientRect().left;
      const targetClipId = clipAtEdge(edge, x);
      if (!targetClipId) return;
      const next = resizeGroupEdge(groups, groupId, edge, targetClipId, clips);
      const g = next.find((gr) => gr.id === groupId);
      if (!g) return;
      latest = g.clip_ids;
      setPending({ groupId, clipIds: g.clip_ids });
    };
    const stop = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', stop);
      target.removeEventListener('pointercancel', stop);
      setPending(null);
      if (latest) onResizeGroup(groupId, latest);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', stop);
    target.addEventListener('pointercancel', stop);
  };

  return (
    <div style={styles.groupLayer}>
      {groups.map((g) => {
        const members = pending?.groupId === g.id ? pending.clipIds : g.clip_ids;
        if (members.length === 0) return null;
        const first = geometry.get(members[0]);
        const last = geometry.get(members[members.length - 1]);
        // Any missing member ref → hide this bar for now (thumbnail churn).
        if (!first || !last || members.some((id) => !geometry.has(id))) return null;
        const left = first.left;
        const width = last.left + last.width - first.left;
        const isSelected = selectedGroupId === g.id;
        const isActive = isSelected || highlightedGroupId === g.id;
        const canResize = !!onResizeGroup;

        return (
          <div
            key={g.id}
            data-group-bar={g.id}
            title={
              isSelected
                ? `Clip group (${members.length} clips) — drag an end to resize, Delete to remove`
                : `Clip group (${members.length} clips) — click to select`
            }
            style={{
              ...styles.groupBar,
              ...(isActive ? styles.groupBarActive : {}),
              left: `${left}px`,
              width: `${width}px`,
            }}
            onClick={(e) => {
              e.stopPropagation();
              onSelectGroup?.(g.id);
            }}
          >
            {canResize && (
              <div
                style={{ ...styles.groupHandle, ...styles.groupHandleStart }}
                onPointerDown={(e) => startDrag(e, g.id, 'start')}
                onClick={(e) => e.stopPropagation()}
              />
            )}
            {canResize && (
              <div
                style={{ ...styles.groupHandle, ...styles.groupHandleEnd }}
                onPointerDown={(e) => startDrag(e, g.id, 'end')}
                onClick={(e) => e.stopPropagation()}
              />
            )}
            {isSelected && onDeleteGroup && (
              <button
                type="button"
                style={styles.groupDeleteCap}
                title="Remove this group (clips are kept)"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteGroup(g.id);
                }}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
