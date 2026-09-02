import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { Clip, ClipGroup } from '../../types';
import { InfoIcon, TrashIcon, EyeOpenIcon, EyeClosedIcon } from './icons';
import InfoPopover from './InfoPopover';
import GroupBar from './GroupBar';
import { useCardGeometry } from './useCardGeometry';
import { styles } from './styles';

interface TimelineProps {
  clips: Clip[];
  /** The clip to highlight as currently "active." Project-time-derived per
   *  `COMPILED_TIMELINE_PLAN.md` §"Implementation Plan → 7": during an auto-
   *  advance transition this is the destination clip, not the source. The
   *  user's persistent selection (`selectedClipId` upstream) drives video
   *  playback; the highlight follows whichever clip the timeline currently
   *  points at. The two reconverge whenever no transition is in flight. */
  activeClipId: string | null;
  onSelectClip: (id: string) => void;
  thumbnails?: Record<string, string>;
  proxies?: Record<string, string | 'generating' | null>;
  onRemoveClip?: (id: string) => void;
  onToggleVisibility?: (id: string) => void;
  // ── Clip groups (docs/CLIP_GROUPS_HANDOFF.md §4). All optional so other
  //    callers keep working without threading any of this.
  /** Normalized groups (contiguous runs of ≥2 clip ids). */
  groups?: ClipGroup[];
  /** Ephemeral multi-selection (shift/cmd-click). Distinct from
   *  `activeClipId`, which keeps its playback/seek semantics untouched. */
  selectedClipIds?: Set<string>;
  /** Modifier-aware card click. Falls back to `onSelectClip` when absent. */
  onCardClick?: (id: string, mods: { shift: boolean; meta: boolean }) => void;
  /** Group the current multi-selection (button shown only when groupable). */
  onGroupSelection?: () => void;
  /** Bar selection — ephemeral upstream state; `null` clears. */
  selectedGroupId?: string | null;
  /** Transient highlight (e.g. from the GROUP follow pill); the bar lights
   *  up and scrolls into view. */
  highlightedGroupId?: string | null;
  onSelectGroup?: (id: string | null) => void;
  /** Remove a group (clips untouched). */
  onDeleteGroup?: (id: string) => void;
  /** Commit an end-handle drag; `clipIds` is the new full membership. */
  onResizeGroup?: (id: string, clipIds: string[]) => void;
}

const EMPTY_SELECTION: ReadonlySet<string> = new Set();

/** Breathing room left past the active card when auto-scrolling it into
 *  view, so it doesn't sit flush against the strip's trailing edge. */
const AUTOSCROLL_TRAILING_GUTTER = 12;

export default function Timeline({
  clips,
  activeClipId,
  onSelectClip,
  thumbnails = {},
  proxies = {},
  onRemoveClip,
  onToggleVisibility,
  groups = [],
  selectedClipIds = EMPTY_SELECTION as Set<string>,
  onCardClick,
  onGroupSelection,
  selectedGroupId = null,
  highlightedGroupId = null,
  onSelectGroup,
  onDeleteGroup,
  onResizeGroup,
}: TimelineProps) {
  const [infoClipId, setInfoClipId] = useState<string | null>(null);
  const [infoAnchorRect, setInfoAnchorRect] = useState<DOMRect | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Strip-relative card geometry — drives the group bars and the floating
  // Group button so both scroll with the cards.
  const geometry = useCardGeometry(stripRef, clips, thumbnails);

  // clip id → owning group id (groups are normalized, so ≤1 owner per clip).
  const groupByClipId = new Map<string, string>();
  for (const g of groups) for (const id of g.clip_ids) groupByClipId.set(id, g.id);

  // "Group" is offered when ≥2 clips are multi-selected, all present in
  // `clips`, contiguous in timeline order, and none already grouped.
  const selectedIndices = clips
    .map((c, i) => (selectedClipIds.has(c.id) ? i : -1))
    .filter((i) => i >= 0);
  const canGroup =
    selectedIndices.length >= 2 &&
    selectedIndices.length === selectedClipIds.size &&
    selectedIndices[selectedIndices.length - 1] - selectedIndices[0] + 1 === selectedIndices.length &&
    !clips.some((c) => selectedClipIds.has(c.id) && groupByClipId.has(c.id));
  // Centre of the selection span, from the first/last selected card's
  // strip-relative geometry (null until measured).
  let groupBtnCenter: number | null = null;
  if (canGroup) {
    const first = geometry.get(clips[selectedIndices[0]].id);
    const last = geometry.get(clips[selectedIndices[selectedIndices.length - 1]].id);
    if (first && last) groupBtnCenter = (first.left + last.left + last.width) / 2;
  }

  // Pass-through playback walks `activeClipId` down the timeline on its own,
  // so the active card can drift outside the scrollport with the user never
  // having touched the strip. Scroll only when it is not fully visible, and
  // land it at the TRAILING edge — the active clip reads as the last one in
  // the queue, with the run-up behind it still on screen.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!activeClipId || !scroller) return;
    const card = stripRef.current?.querySelector<HTMLElement>(
      `[data-clip-card="${CSS.escape(activeClipId)}"]`,
    );
    if (!card) return;
    // The strip sits at x=0 of the scroll content (the scroller has no
    // horizontal padding), so the card's strip-relative offsetLeft is
    // already in scroll coordinates.
    const cardLeft = card.offsetLeft;
    const cardRight = cardLeft + card.offsetWidth;
    const viewLeft = scroller.scrollLeft;
    const viewRight = viewLeft + scroller.clientWidth;
    if (cardLeft >= viewLeft && cardRight <= viewRight) return;
    scroller.scrollTo({
      left: Math.max(0, cardRight + AUTOSCROLL_TRAILING_GUTTER - scroller.clientWidth),
      behavior: 'smooth',
    });
  }, [activeClipId, clips]);

  // Highlight → bring the group's first member card into view.
  useEffect(() => {
    if (!highlightedGroupId) return;
    const g = groups.find((gr) => gr.id === highlightedGroupId);
    const firstId = g?.clip_ids[0];
    if (!firstId) return;
    const card = stripRef.current?.querySelector<HTMLElement>(
      `[data-clip-card="${CSS.escape(firstId)}"]`,
    );
    card?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [highlightedGroupId, groups]);

  const handleCardClick = (id: string, e: MouseEvent) => {
    if (onCardClick) {
      onCardClick(id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });
    } else {
      onSelectClip(id);
    }
  };

  if (clips.length === 0) {
    return (
      <div style={styles.empty}>
        <p style={styles.emptyText}>Import a folder of hiking videos to get started</p>
      </div>
    );
  }

  return (
    <div ref={scrollRef} style={styles.container}>
      <div ref={stripRef} style={styles.strip}>
        {/* Group-bar overlay + floating Group button (both strip-relative). */}
        <GroupBar
          clips={clips}
          groups={groups}
          geometry={geometry}
          stripRef={stripRef}
          selectedGroupId={selectedGroupId}
          highlightedGroupId={highlightedGroupId}
          onSelectGroup={onSelectGroup}
          onDeleteGroup={onDeleteGroup}
          onResizeGroup={onResizeGroup}
        />
        {canGroup && onGroupSelection && groupBtnCenter !== null && (
          <button
            type="button"
            style={{ ...styles.groupBtn, left: `${groupBtnCenter}px` }}
            title={`Group ${selectedIndices.length} selected clips into one camera glide`}
            onClick={(e) => { e.stopPropagation(); onGroupSelection(); }}
          >
            Group ({selectedIndices.length})
          </button>
        )}
        {clips.map((clip, index) => {
          // Two independent states on two channels: selection owns the
          // border (and overrides the active ring); active owns the bottom
          // action bar and, when not selected, a narrow ring. Selection is
          // ONLY the user's click/shift/cmd set — `selectedClipId` upstream
          // follows playback (auto-advance), so it must not draw as selected.
          const isActive = activeClipId === clip.id;
          const isSelected = selectedClipIds.has(clip.id);
          const isHidden = !clip.visible;

          return (
            <div
              key={clip.id}
              data-clip-card={clip.id}
              data-clip-group={groupByClipId.get(clip.id)}
              style={{
                ...styles.card,
                ...(isActive && !isSelected ? styles.cardActive : {}),
                ...(isSelected ? styles.cardSelected : {}),
                ...(isHidden ? styles.cardHidden : {}),
              }}
            >
              {/* Thumbnail / click to select (shift = range, cmd/ctrl = toggle) */}
              <div
                onClick={(e) => handleCardClick(clip.id, e)}
                style={styles.thumbBtn}
              >
                {thumbnails[clip.id] ? (
                  <img
                    src={convertFileSrc(thumbnails[clip.id])}
                    alt={clip.filename}
                    style={{
                      ...styles.thumbnail,
                      ...(isHidden ? { opacity: 0.3 } : {}),
                    }}
                  />
                ) : (
                  <div style={styles.thumbPlaceholder}>{index + 1}</div>
                )}
                {proxies[clip.id] === 'generating' && (
                  <div style={styles.proxyBadge}>...</div>
                )}
              </div>

              {/* Action buttons — bar background marks the active clip */}
              <div style={{ ...styles.actions, ...(isActive ? styles.actionsActive : {}) }}>
                <button
                  style={{ ...styles.actionBtn, ...(isActive ? styles.actionBtnOnActive : {}) }}
                  title="Clip info"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (infoClipId === clip.id) {
                      setInfoClipId(null);
                      setInfoAnchorRect(null);
                    } else {
                      setInfoClipId(clip.id);
                      setInfoAnchorRect((e.currentTarget as HTMLElement).closest('[data-clip-card]')!.getBoundingClientRect());
                    }
                  }}
                >
                  <InfoIcon />
                </button>
                <button
                  style={{
                    ...styles.actionBtn,
                    ...(isActive ? styles.actionBtnOnActive : {}),
                    ...(isHidden ? { color: '#ff6b35' } : {}),
                  }}
                  title={isHidden ? 'Show clip' : 'Hide clip'}
                  onClick={(e) => { e.stopPropagation(); onToggleVisibility?.(clip.id); }}
                >
                  {isHidden ? <EyeClosedIcon /> : <EyeOpenIcon />}
                </button>
                <button
                  style={{ ...styles.actionBtn, ...(isActive ? styles.actionBtnOnActive : {}) }}
                  title="Remove clip"
                  onClick={(e) => { e.stopPropagation(); onRemoveClip?.(clip.id); }}
                >
                  <TrashIcon />
                </button>
              </div>

              {/* Info popover (rendered via portal) */}
              {infoClipId === clip.id && infoAnchorRect && (
                <InfoPopover clip={clip} anchorRect={infoAnchorRect} onClose={() => { setInfoClipId(null); setInfoAnchorRect(null); }} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
