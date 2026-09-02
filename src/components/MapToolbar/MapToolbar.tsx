import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from 'react';
import {
  Route as RouteIcon,
  MapPin,
  Crosshair as PovIcon,
  Footprints as TransitionIcon,
  LocateFixed,
  Layers,
  ZoomIn,
  Compass,
  LayoutPanelTop,
  ListChecks,
} from 'lucide-react';
import Toolbar from '../Toolbar';
import ModePicker from '../ModePicker';
import NumberStepper from '../NumberStepper';
import {
  DecorationPanel,
  PANEL_TRIGGER_GAP,
  type DecorationKind,
  type DecorationPanelCloseOptions,
} from './DecorationPanel';
import type {
  Clip,
  MapSettings,
  MapStyleId,
  MarkerImageRef,
  OverridePath,
  Waypoint,
} from '../../types';
import type { IndexedRoute } from '../../lib/routeLocation';
import { colors, semantic } from '../../theme/tokens';
import { styles } from './styles';

// Right-to-left overflow wrap — items are an ordered list. A hidden off-screen
// mirror renders every item at its natural width; we walk left-to-right against
// the bar's available width and split at the first item that doesn't fit. Items
// before the cut render in the bar; items after wrap onto a second row that
// floats below the bar, right-aligned over the content beneath. Reorder = swap
// a line in the `items` array below.
const CONTENT_GAP = 4;

// Set true inside the hidden measurement mirror so stateful descendants
// (notably `DecorationButton`) can opt out of side effects that would conflict
// with their visible twin: triggerRef writes (last-write wins would otherwise
// pin refs to the offscreen mirror button) and the open DecorationPanel
// children (a duplicate panel would register a second document.mousedown
// listener whose panelRef points into the hidden tree, closing the panel on
// any click inside the visible one).
const MirrorContext = createContext(false);

export type MapToolbarScope = 'project' | 'clip';

interface MapToolbarProps {
  settings: MapSettings;
  onChange: (next: MapSettings) => void;
  /** Whether a GPX route is loaded — disables the visited option when false. */
  routeLoaded: boolean;
  /** Current editing scope. */
  scope: MapToolbarScope;
  onScopeChange: (scope: MapToolbarScope) => void;
  /** Which leaf paths the current clip overrides. Null when scope is 'project'. */
  overriddenKeys: Set<OverridePath> | null;
  /** Opens the Map Positioning modal. */
  onOpenPositioning: () => void;
  /** Opens the Waypoints list/edit panel. v7 affordance — rename and delete
   *  individual waypoints (clip-sourced ones, manual ones once we add the
   *  add-affordance). */
  onOpenWaypointsPanel: () => void;
  /** Selected clip — read in the decoration panels to find the associated
   *  Waypoint by `clip_id` and to compute the scope-banner ordinal. */
  currentClip: Clip | null;
  /** 1-based ordinal of the current clip (its index in the project's clip
   *  ordering). Passed through to the scope banner copy. */
  currentClipOrdinal: number | null;
  /** Full project waypoint list — read for the per-Waypoint override write
   *  in the Waypoints panel's clip-scope COLOR section. */
  waypoints: Waypoint[];
  /** Receives the entire next waypoints array on per-Waypoint edits. The
   *  parent persists via its `setWaypoints` setter. */
  onWaypointsChange: (next: Waypoint[]) => void;
  /** Indexed route — passed through to the decoration panels so the
   *  gradient editor can compute waypoint Mercator fractions for snap
   *  ticks + the trail preview SVG. Null when no GPX is loaded. */
  indexedRoute: IndexedRoute | null;
  /** Project bundle directory — passed to the marker galleries for image
   *  upload (assets are copied into the bundle) + thumbnail resolution. */
  projectDir?: string | null;
  /** Marker-library write — full next `marker_images` list. Project-level
   *  regardless of scope; see DecorationPanelProps.onMarkerImagesChange. */
  onMarkerImagesChange?: (next: MarkerImageRef[]) => void;
  /** Confirmed marker-image delete — the parent reverts every use and
   *  removes the bundle assets. */
  onMarkerImageDelete?: (id: string) => void;
  /** PROJECT-level MapSettings (unresolved by clip overrides) — the
   *  clip-scope "Reset to project" write-back source for every override
   *  pill in the decoration panels. */
  projectSettings?: MapSettings | null;
  /** Id of the clip group containing the current clip, or null. In clip
   *  scope a member clip's follow pill freezes into the GROUP state — the
   *  glide owns the camera (docs/CLIP_GROUPS_HANDOFF.md §3). Derived, never
   *  persisted. */
  groupIdForCurrentClip?: string | null;
  /** GROUP pill click — asks the parent to light up / scroll to the group
   *  bar. Never toggles `follow_playhead`. */
  onHighlightGroup?: (groupId: string) => void;
}

const STYLE_OPTIONS: { value: MapStyleId; label: string; short: string }[] = [
  { value: 'default', label: 'Default', short: 'D' },
  { value: '3d', label: '3D', short: '3D' },
  { value: 'satellite', label: 'Satellite', short: 'S' },
];

type Item = {
  id: string;
  menuLabel: string;
  /** The rendered content for one toolbar slot. The same React element instance
   *  is mounted in the visible bar (or overflow menu) AND the hidden mirror —
   *  controlled-prop state means duplication is safe. */
  node: ReactNode;
};

export default function MapToolbar({
  settings,
  onChange,
  routeLoaded,
  scope,
  onScopeChange,
  overriddenKeys,
  onOpenPositioning,
  onOpenWaypointsPanel,
  currentClip,
  currentClipOrdinal,
  waypoints,
  onWaypointsChange,
  indexedRoute,
  projectDir,
  onMarkerImagesChange,
  onMarkerImageDelete,
  projectSettings,
  groupIdForCurrentClip = null,
  onHighlightGroup,
}: MapToolbarProps) {
  const followOn = settings.camera.follow_playhead;
  const bearingAuto = settings.camera.bearing_mode === 'auto';

  /** Accent color when the given leaf path is overridden by the current clip,
   *  undefined (default icon color) otherwise. Spacing stays constant because
   *  only the color toggles — no element is added or removed. */
  const overrideColor = (path: OverridePath): string | undefined =>
    overriddenKeys?.has(path) ? colors.accent : undefined;

  /** Decoration-button override rollup — chartreuse if any path in the
   *  decoration's domain is overridden. Transition is an atomic top-level blob,
   *  so its "domain" is the exact `'transition'` path rather than a prefix. */
  const decorationOverrideColor = (
    prefix: 'route' | 'waypoints' | 'pov' | 'transition',
  ): string | undefined => {
    if (!overriddenKeys) return undefined;
    if (prefix === 'transition') {
      return overriddenKeys.has('transition') ? colors.accent : undefined;
    }
    for (const p of overriddenKeys) {
      if (p.startsWith(`${prefix}.`)) return colors.accent;
    }
    return undefined;
  };

  /** Per-Waypoint override rollup for the Waypoints decoration button. In
   *  clip scope we check the associated waypoint; in project scope we check
   *  whether any waypoint has an override. */
  const waypointsButtonOverride = ((): string | undefined => {
    const pathBased = decorationOverrideColor('waypoints');
    if (pathBased) return pathBased;
    if (scope === 'clip') {
      const associated = currentClip
        ? waypoints.find((w) => w.clip_id === currentClip.id)
        : null;
      if (associated && (associated.color !== undefined || associated.shape !== undefined)) {
        return colors.accent;
      }
      return undefined;
    }
    const anyOverride = waypoints.some(
      (w) => w.color !== undefined || w.shape !== undefined,
    );
    return anyOverride ? colors.accent : undefined;
  })();

  const setCamera = (patch: Partial<MapSettings['camera']>) =>
    onChange({ ...settings, camera: { ...settings.camera, ...patch } });

  // Clip scope + member of a clip group → frozen GROUP state: the glide
  // owns the camera, so the pill never writes `follow_playhead`; clicking
  // only highlights the group bar in the timeline.
  const groupLocked = scope === 'clip' && groupIdForCurrentClip != null;
  const followPill = groupLocked ? (
    <div
      onClick={() => onHighlightGroup?.(groupIdForCurrentClip)}
      style={styles.previewPillLocked}
      title="Camera is controlled by the clip group — click to show the group"
    >
      <span style={styles.previewDotLocked} />
      <span>GROUP</span>
    </div>
  ) : (
    <div
      onClick={() => setCamera({ follow_playhead: !followOn })}
      style={followOn ? styles.previewPillOn : styles.previewPillOff}
      title={followOn ? 'Map follows playhead — click to pan freely' : 'Free pan — click to follow playhead'}
    >
      <span style={followOn ? styles.previewDotOn : styles.previewDotOff} />
      <span>FOLLOW</span>
    </div>
  );

  const bearingPill = (
    <div
      onClick={() => setCamera({ bearing_mode: bearingAuto ? 'fixed' : 'auto' })}
      style={bearingAuto ? styles.previewPillOn : styles.previewPillOff}
      title={
        bearingAuto
          ? 'Bearing follows trail with predetermined stops — click for fixed'
          : 'Fixed bearing — click to auto-follow trail'
      }
    >
      <span style={bearingAuto ? styles.previewDotOn : styles.previewDotOff} />
      <span>{bearingAuto ? 'AUTO' : 'FIXED'}</span>
    </div>
  );

  const bearingStepper = bearingAuto ? (
    <NumberStepper
      value={settings.camera.bearing_stops}
      min={1}
      max={99}
      step={1}
      unit=""
      decimals={0}
      onChange={(v) => setCamera({ bearing_stops: Math.max(1, Math.round(v)) })}
    />
  ) : (
    <NumberStepper
      value={settings.camera.bearing_degrees}
      min={0}
      max={359}
      step={1}
      unit="°"
      decimals={0}
      onChange={(v) =>
        setCamera({ bearing_degrees: ((Math.round(v) % 360) + 360) % 360 })
      }
    />
  );

  // --- Decoration panel state ----------------------------------------------
  // Panels are independently open/closed (multi-open) and always render as
  // floating windows — there is no "docked" mode. Position, size, and
  // stacking order are owned here so they survive close/reopen.
  const [openPanels, setOpenPanels] = useState<Record<DecorationKind, boolean>>({
    route: false,
    waypoints: false,
    pov: false,
    transition: false,
  });
  const [positions, setPositions] = useState<Record<DecorationKind, { x: number; y: number } | null>>({
    route: null,
    waypoints: null,
    pov: null,
    transition: null,
  });
  const setPositionFor = useCallback(
    (kind: DecorationKind, pos: { x: number; y: number }) =>
      setPositions((cur) => ({ ...cur, [kind]: pos })),
    [],
  );
  const [panelSize, setPanelSize] = useState<Record<DecorationKind, { w: number; h: number } | null>>({
    route: null,
    waypoints: null,
    pov: null,
    transition: null,
  });
  const setPanelSizeFor = useCallback(
    (kind: DecorationKind, next: { w: number; h: number } | null) =>
      setPanelSize((cur) => ({ ...cur, [kind]: next })),
    [],
  );
  // Stacking order — last item is on top. Any pointerdown inside a panel
  // (or a trigger click that opens one) moves that kind to the end.
  // zIndex = BASE_Z + indexOf(kind), so we get monotonic stacking without
  // an ever-growing counter.
  const [stackOrder, setStackOrder] = useState<DecorationKind[]>(['route', 'waypoints', 'pov', 'transition']);
  const bringToFront = useCallback((kind: DecorationKind) => {
    setStackOrder((cur) => {
      if (cur[cur.length - 1] === kind) return cur;
      return [...cur.filter((k) => k !== kind), kind];
    });
  }, []);
  const BASE_Z = 200;
  const zIndexFor = (kind: DecorationKind) => BASE_Z + stackOrder.indexOf(kind);

  const routeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const waypointsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const povTriggerRef = useRef<HTMLButtonElement | null>(null);
  const transitionTriggerRef = useRef<HTMLButtonElement | null>(null);

  const triggerRefFor = useCallback(
    (kind: DecorationKind): RefObject<HTMLButtonElement | null> => {
      if (kind === 'route') return routeTriggerRef;
      if (kind === 'waypoints') return waypointsTriggerRef;
      if (kind === 'transition') return transitionTriggerRef;
      return povTriggerRef;
    },
    [],
  );

  const scheduleBlur = useCallback((kind: DecorationKind) => {
    const blur = () => triggerRefFor(kind).current?.blur();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(blur);
      return;
    }
    setTimeout(blur, 0);
  }, [triggerRefFor]);

  // Per-kind close — used by the panel's X button and Escape handler.
  // `restoreFocus: true` (Escape) skips the blur because the panel itself
  // calls `triggerRef.current?.focus()` to return focus there.
  const closePanelFor = useCallback(
    (kind: DecorationKind, options?: DecorationPanelCloseOptions) => {
      setOpenPanels((cur) => ({ ...cur, [kind]: false }));
      if (!options?.restoreFocus) scheduleBlur(kind);
    },
    [scheduleBlur],
  );

  // Trigger toggle. Opening a fresh panel seeds its position from the
  // trigger's viewport rect — same visual placement as the old dropdown's
  // first frame, but the panel persists and can be dragged thereafter.
  const toggle = useCallback(
    (kind: DecorationKind) => {
      if (openPanels[kind]) {
        setOpenPanels((cur) => ({ ...cur, [kind]: false }));
        scheduleBlur(kind);
        return;
      }
      if (!positions[kind]) {
        const rect = triggerRefFor(kind).current?.getBoundingClientRect();
        if (rect) {
          setPositions((cur) => ({
            ...cur,
            [kind]: { x: rect.left, y: rect.bottom + PANEL_TRIGGER_GAP },
          }));
        }
      }
      bringToFront(kind);
      setOpenPanels((cur) => ({ ...cur, [kind]: true }));
    },
    [openPanels, positions, triggerRefFor, bringToFront, scheduleBlur],
  );

  const items: Item[] = [
    {
      id: 'style',
      menuLabel: 'Style',
      node: (
        <ModePicker<MapStyleId>
          value={settings.camera.map_style}
          options={STYLE_OPTIONS}
          onChange={(v) => setCamera({ map_style: v })}
          title="Base map style"
          minWidth={76}
          icon={<Layers size={15} strokeWidth={2} />}
          variant="minimal"
          iconColor={overrideColor('camera.map_style')}
        />
      ),
    },
    {
      id: 'route',
      menuLabel: 'Route',
      node: (
        <DecorationButton
          id="route"
          icon={<RouteIcon size={15} strokeWidth={2} />}
          label="Route"
          isOpen={openPanels.route}
          overrideColor={decorationOverrideColor('route')}
          triggerRef={routeTriggerRef}
          onClick={() => toggle('route')}
        >
          {openPanels.route && (
            <DecorationPanel
              decoration="route"
              settings={settings}
              onChange={onChange}
              scope={scope}
              overriddenKeys={overriddenKeys}
              onScopeChange={onScopeChange}
              onClose={(opts) => closePanelFor('route', opts)}
              routeLoaded={routeLoaded}
              currentClip={currentClip}
              waypoints={waypoints}
              onWaypointsChange={onWaypointsChange}
              onOpenWaypointsPanel={onOpenWaypointsPanel}
              triggerRef={routeTriggerRef}
              currentClipOrdinal={currentClipOrdinal}
              indexedRoute={indexedRoute}
              projectSettings={projectSettings}
              position={positions.route ?? undefined}
              onPositionChange={(pos) => setPositionFor('route', pos)}
              size={panelSize.route}
              onSizeChange={(next) => setPanelSizeFor('route', next)}
              zIndex={zIndexFor('route')}
              onFocus={() => bringToFront('route')}
            />
          )}
        </DecorationButton>
      ),
    },
    {
      id: 'waypoints',
      menuLabel: 'Waypoints',
      node: (
        <DecorationButton
          id="waypoints"
          icon={<MapPin size={15} strokeWidth={2} />}
          label="Waypoints"
          isOpen={openPanels.waypoints}
          overrideColor={waypointsButtonOverride}
          triggerRef={waypointsTriggerRef}
          onClick={() => toggle('waypoints')}
        >
          {openPanels.waypoints && (
            <DecorationPanel
              decoration="waypoints"
              settings={settings}
              onChange={onChange}
              scope={scope}
              overriddenKeys={overriddenKeys}
              onScopeChange={onScopeChange}
              onClose={(opts) => closePanelFor('waypoints', opts)}
              routeLoaded={routeLoaded}
              currentClip={currentClip}
              waypoints={waypoints}
              onWaypointsChange={onWaypointsChange}
              onOpenWaypointsPanel={onOpenWaypointsPanel}
              triggerRef={waypointsTriggerRef}
              currentClipOrdinal={currentClipOrdinal}
              indexedRoute={indexedRoute}
              projectDir={projectDir}
              onMarkerImagesChange={onMarkerImagesChange}
              onMarkerImageDelete={onMarkerImageDelete}
              projectSettings={projectSettings}
              position={positions.waypoints ?? undefined}
              onPositionChange={(pos) => setPositionFor('waypoints', pos)}
              size={panelSize.waypoints}
              onSizeChange={(next) => setPanelSizeFor('waypoints', next)}
              zIndex={zIndexFor('waypoints')}
              onFocus={() => bringToFront('waypoints')}
            />
          )}
        </DecorationButton>
      ),
    },
    {
      id: 'pov',
      menuLabel: 'POV',
      node: (
        <DecorationButton
          id="pov"
          icon={<PovIcon size={15} strokeWidth={2} />}
          label="POV"
          isOpen={openPanels.pov}
          overrideColor={decorationOverrideColor('pov')}
          triggerRef={povTriggerRef}
          onClick={() => toggle('pov')}
        >
          {openPanels.pov && (
            <DecorationPanel
              decoration="pov"
              settings={settings}
              onChange={onChange}
              scope={scope}
              overriddenKeys={overriddenKeys}
              onScopeChange={onScopeChange}
              onClose={(opts) => closePanelFor('pov', opts)}
              routeLoaded={routeLoaded}
              currentClip={currentClip}
              waypoints={waypoints}
              onWaypointsChange={onWaypointsChange}
              onOpenWaypointsPanel={onOpenWaypointsPanel}
              triggerRef={povTriggerRef}
              currentClipOrdinal={currentClipOrdinal}
              indexedRoute={indexedRoute}
              projectDir={projectDir}
              onMarkerImagesChange={onMarkerImagesChange}
              onMarkerImageDelete={onMarkerImageDelete}
              projectSettings={projectSettings}
              position={positions.pov ?? undefined}
              onPositionChange={(pos) => setPositionFor('pov', pos)}
              size={panelSize.pov}
              onSizeChange={(next) => setPanelSizeFor('pov', next)}
              zIndex={zIndexFor('pov')}
              onFocus={() => bringToFront('pov')}
            />
          )}
        </DecorationButton>
      ),
    },
    {
      id: 'transition',
      menuLabel: 'Transition',
      node: (
        <DecorationButton
          id="transition"
          icon={<TransitionIcon size={15} strokeWidth={2} />}
          label="Transition"
          isOpen={openPanels.transition}
          overrideColor={decorationOverrideColor('transition')}
          triggerRef={transitionTriggerRef}
          onClick={() => toggle('transition')}
        >
          {openPanels.transition && (
            <DecorationPanel
              decoration="transition"
              settings={settings}
              onChange={onChange}
              scope={scope}
              overriddenKeys={overriddenKeys}
              onScopeChange={onScopeChange}
              onClose={(opts) => closePanelFor('transition', opts)}
              routeLoaded={routeLoaded}
              currentClip={currentClip}
              waypoints={waypoints}
              onWaypointsChange={onWaypointsChange}
              onOpenWaypointsPanel={onOpenWaypointsPanel}
              triggerRef={transitionTriggerRef}
              currentClipOrdinal={currentClipOrdinal}
              indexedRoute={indexedRoute}
              projectDir={projectDir}
              onMarkerImagesChange={onMarkerImagesChange}
              onMarkerImageDelete={onMarkerImageDelete}
              projectSettings={projectSettings}
              position={positions.transition ?? undefined}
              onPositionChange={(pos) => setPositionFor('transition', pos)}
              size={panelSize.transition}
              onSizeChange={(next) => setPanelSizeFor('transition', next)}
              zIndex={zIndexFor('transition')}
              onFocus={() => bringToFront('transition')}
            />
          )}
        </DecorationButton>
      ),
    },
    {
      id: 'waypoints_manage',
      menuLabel: 'Manage waypoints',
      node: (
        <button
          type="button"
          onClick={onOpenWaypointsPanel}
          title="Manage waypoints (rename, delete)"
          aria-label="Manage waypoints"
          style={positioningButtonStyle}
          data-testid="map-toolbar-waypoints-manage"
        >
          <ListChecks size={15} strokeWidth={2} />
        </button>
      ),
    },
    {
      id: 'zoom',
      menuLabel: 'Zoom',
      node: (
        <>
          <span
            style={{
              ...styles.groupLabel,
              color: overrideColor('camera.zoom') ?? styles.groupLabel.color,
              transition: 'color 0.15s ease',
            }}
            title="Default zoom level applied when entering a clip"
          >
            <ZoomIn size={15} strokeWidth={2} />
          </span>
          <NumberStepper
            value={settings.camera.zoom}
            min={1}
            max={20}
            step={0.5}
            unit=""
            onChange={(v) => setCamera({ zoom: v })}
          />
        </>
      ),
    },
    {
      id: 'positioning',
      menuLabel: 'Positioning',
      node: (
        <button
          type="button"
          onClick={onOpenPositioning}
          title="Map positioning"
          aria-label="Map positioning"
          style={positioningButtonStyle}
          data-testid="map-toolbar-positioning"
        >
          <LayoutPanelTop size={15} strokeWidth={2} />
        </button>
      ),
    },
    {
      id: 'follow',
      menuLabel: 'Follow',
      node: (
        <>
          <span
            style={{
              ...styles.groupLabel,
              color: overrideColor('camera.follow_playhead') ?? styles.groupLabel.color,
              transition: 'color 0.15s ease',
            }}
            title="Follow playhead"
          >
            <LocateFixed size={15} strokeWidth={2} />
          </span>
          {followPill}
        </>
      ),
    },
    {
      id: 'bearing',
      menuLabel: 'Bearing',
      node: (
        <>
          <span
            style={{
              ...styles.groupLabel,
              color:
                overrideColor('camera.bearing_mode') ??
                overrideColor('camera.bearing_degrees') ??
                styles.groupLabel.color,
              transition: 'color 0.15s ease',
            }}
            title="Map bearing"
          >
            <Compass size={15} strokeWidth={2} />
          </span>
          {bearingPill}
          {bearingStepper}
        </>
      ),
    },
  ];

  // --- Overflow measurement -------------------------------------------------
  const barRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(items.length);

  const recompute = useCallback(() => {
    const bar = barRef.current;
    const mirror = mirrorRef.current;
    if (!bar || !mirror) return;

    const content = bar.firstElementChild as HTMLElement | null;
    if (!content) return;

    const available = content.clientWidth;
    if (available <= 0) return;

    // The scope toggle is content's first child and never wraps. Each visible
    // wrapper after it is preceded by one flex gap (CONTENT_GAP). Each mirror
    // wrapper renders the SAME structure as a visible bar item (separator +
    // group), so its offsetWidth matches the in-bar footprint exactly.
    //
    // Negative margins reduce a flex item's main-axis footprint — the scope
    // toggle uses margin-left: -16px to bleed into the bar's left padding —
    // so we have to add horizontal margins to offsetWidth to get the actual
    // flex consumption.
    const pinned = content.firstElementChild as HTMLElement | null;
    const itemBudget = available - (pinned ? flexFootprint(pinned) : 0);

    const wrappers = mirror.querySelectorAll<HTMLElement>('[data-mt-item]');
    if (wrappers.length !== items.length) return;

    let used = 0;
    let nextCount = items.length;
    for (let i = 0; i < wrappers.length; i++) {
      const step = CONTENT_GAP + wrappers[i].offsetWidth;
      if (used + step > itemBudget) {
        nextCount = i;
        break;
      }
      used += step;
    }

    setVisibleCount((prev) => (prev === nextCount ? prev : nextCount));
  }, [items.length]);

  // Re-measure after every commit (catches content swaps like AUTO ↔ FIXED).
  useLayoutEffect(() => {
    recompute();
  });

  // Re-measure when the bar or any mirror item changes size.
  useEffect(() => {
    const bar = barRef.current;
    const mirror = mirrorRef.current;
    if (!bar || !mirror) return;
    const ro = new ResizeObserver(() => recompute());
    ro.observe(bar);
    mirror.querySelectorAll<HTMLElement>('[data-mt-item]').forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [recompute]);

  // --- Render ---------------------------------------------------------------
  const visibleItems = items.slice(0, visibleCount);
  const wrappedItems = items.slice(visibleCount);

  const barTint = scope === 'project' ? styles.barTintProject : styles.barTintClip;
  const barFinalStyle: React.CSSProperties = {
    ...barTint,
    overflow: 'visible', // allow the wrapped overflow row to escape the bar
  };

  return (
    <div style={styles.root}>
      <Toolbar barRef={barRef} barStyle={barFinalStyle} contentGap={CONTENT_GAP}>
        <ScopeToggle scope={scope} onScopeChange={onScopeChange} />

        {visibleItems.map((it, i) => (
          <ItemWrapper key={it.id} firstInRow={i === 0}>
            {it.node}
          </ItemWrapper>
        ))}
      </Toolbar>

      {wrappedItems.length > 0 && (
        <div style={{ ...styles.overflowRow, ...barTint }}>
          {wrappedItems.map((it, i) => (
            <ItemWrapper key={it.id} firstInRow={i === 0}>
              {it.node}
            </ItemWrapper>
          ))}
        </div>
      )}

      {/* Hidden measurement mirror — every item rendered at natural width,
          off-screen. We read each wrapper's offsetWidth to learn its footprint,
          then decide how many fit in the visible bar. items[0]'s wrapper has
          no leading separator (matching how it renders as the bar's first
          item); subsequent wrappers do, matching their in-bar appearance.
          MirrorContext tells DecorationButton descendants not to attach refs
          or render their panel children — both would conflict with the
          visible twins. */}
      <MirrorContext.Provider value={true}>
        <div ref={mirrorRef} style={styles.mirror} aria-hidden>
          {items.map((it, i) => (
            <ItemWrapper key={it.id} measured firstInRow={i === 0}>
              {it.node}
            </ItemWrapper>
          ))}
        </div>
      </MirrorContext.Provider>
    </div>
  );
}

/** Horizontal main-axis footprint of a flex item — offsetWidth plus
 *  horizontal margins. Margins can be negative (the scope toggle uses
 *  margin-left: -16px to bleed into the bar's left padding), and a flex item
 *  with negative margin consumes *less* than its offsetWidth would imply. */
function flexFootprint(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  const ml = parseFloat(cs.marginLeft) || 0;
  const mr = parseFloat(cs.marginRight) || 0;
  return el.offsetWidth + ml + mr;
}

/** A single toolbar slot. Renders an identical [separator + group] structure
 *  in the visible bar, the wrapped overflow row, and the hidden mirror — so
 *  the mirror's offsetWidth equals the in-bar footprint. The `measured` flag
 *  tags the wrapper for the recompute pass. `firstInRow` suppresses the
 *  leading separator (separators belong *between* items, not before them). */
function ItemWrapper({
  children,
  measured,
  firstInRow,
}: {
  children: ReactNode;
  measured?: boolean;
  firstInRow?: boolean;
}) {
  return (
    <div data-mt-item={measured || undefined} style={styles.itemWrapper}>
      {!firstInRow && <span style={styles.separator} />}
      <div style={styles.group}>{children}</div>
    </div>
  );
}

const positioningButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  background: 'transparent',
  border: 'none',
  color: '#c8c8c8',
  cursor: 'pointer',
  borderRadius: 4,
  padding: 0,
};

/** Compact icon button that triggers a `DecorationPanel`. The panel is
 *  rendered as `children`, positioned absolutely beneath this button. When
 *  mounted inside the measurement mirror (MirrorContext === true), the button
 *  skips its triggerRef and its panel children so the visible twin owns both
 *  the ref and the live document listeners — duplicates would either pin the
 *  ref to an offscreen node or close the panel on any inner click. */
function DecorationButton({
  id,
  icon,
  label,
  isOpen,
  overrideColor,
  triggerRef,
  onClick,
  children,
}: {
  id: DecorationKind;
  icon: ReactNode;
  label: string;
  isOpen: boolean;
  overrideColor: string | undefined;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onClick: () => void;
  children: ReactNode;
}) {
  const isMirror = useContext(MirrorContext);
  return (
    <div style={decorationButtonWrapper}>
      <button
        ref={isMirror ? undefined : triggerRef}
        type="button"
        // Prevent the button from receiving focus on mouse-down. WebKit's
        // default focus ring (`-webkit-focus-ring-color auto 1px`) otherwise
        // lingers after a click-to-open / click-outside-to-close cycle and
        // reads as a stuck highlight — especially when the system accent
        // color is in the same hue range as `accentTint`. Keyboard users
        // still focus normally via Tab, since `keydown` doesn't go through
        // `mousedown`.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        data-testid={`decoration-trigger-${id}`}
        style={{
          ...decorationButtonStyle,
          ...(isOpen ? decorationButtonStyleOpen : null),
          color: isOpen ? semantic.fg : '#c8c8c8',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center' }}>{icon}</span>
        {overrideColor && (
          <span
            style={{ ...overrideDotStyle, backgroundColor: overrideColor }}
            aria-hidden
          />
        )}
      </button>
      {!isMirror && children}
    </div>
  );
}

const decorationButtonWrapper: React.CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
};

const decorationButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 24,
  backgroundColor: 'transparent',
  border: 'none',
  color: '#c8c8c8',
  cursor: 'pointer',
  borderRadius: 4,
  padding: 0,
  position: 'relative',
  transition: 'background-color 0.15s ease, color 0.15s ease',
};

const decorationButtonStyleOpen: React.CSSProperties = {
  backgroundColor: semantic.accentTint,
};

const overrideDotStyle: React.CSSProperties = {
  position: 'absolute',
  top: 3,
  right: 3,
  width: 4,
  height: 4,
  borderRadius: 999,
};

/** Complete perspective frame — wider on left (facing), tapering right (receding).
 *  Closed path with rounded corners. ~7×12 local units. */
const FRAME = 'M1,2 C1,0.8 1.6,0.3 2.6,0.5 L5.4,1.3 C6.4,1.6 7,2.4 7,3.4 L7,9.2 C7,10.2 6.4,10.8 5.4,11 L2.6,11.7 C1.6,11.9 1,11.3 1,10.2 Z';

/** Medium partial — slightly smaller than FRAME, open left-edge bracket. */
const PARTIAL_MED = 'M5.5,1.8 L2.8,1.1 C1.8,0.9 1.2,1.4 1.2,2.5 L1.2,9.7 C1.2,10.8 1.8,11.3 2.8,11.1 L5.5,10.4';

/** Small partial — shorter left edge bracket peeking out. */
const PARTIAL_SMALL = 'M5,3 L3,2.4 C2.2,2.2 1.6,2.7 1.6,3.6 L1.6,8.6 C1.6,9.5 2.2,10 3,9.8 L5,9.2';

const TRANSITION = 'transform 0.3s cubic-bezier(0.4, 0.0, 0.2, 1), opacity 0.3s ease';

const SCOPE_FILLS: Record<string, string> = {
  project: '#4a7c59',
  clip: '#ff6b35',
};

/** Animated scope icon — in project mode, three cards stacked left-to-right
 *  with the back two showing only their left edges. In clip mode, converges
 *  to a single centered frame. */
function ScopeIcon({ isProject, fill }: { isProject: boolean; fill: string }) {
  const cx = 6;   // centered x for clip mode
  const px = 12;  // front frame x in project mode
  return (
    <svg width="22" height="14" viewBox="0 0 22 14" fill="none">
      <path
        d={PARTIAL_SMALL}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        style={{
          transform: `translateX(${isProject ? 0 : cx}px)`,
          opacity: isProject ? 1 : 0,
          transition: TRANSITION,
        }}
      />
      <path
        d={PARTIAL_MED}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        style={{
          transform: `translateX(${isProject ? 5.5 : cx}px)`,
          opacity: isProject ? 1 : 0,
          transition: TRANSITION,
        }}
      />
      <path
        d={FRAME}
        stroke="currentColor"
        strokeWidth="1.3"
        fill={fill}
        style={{
          transform: `translateX(${isProject ? px : cx}px)`,
          opacity: 1,
          transition: TRANSITION,
        }}
      />
    </svg>
  );
}

function ScopeToggle({
  scope,
  onScopeChange,
}: {
  scope: MapToolbarScope;
  onScopeChange: (scope: MapToolbarScope) => void;
}) {
  const isProject = scope === 'project';
  return (
    <button
      onClick={() => onScopeChange(isProject ? 'clip' : 'project')}
      style={isProject ? styles.scopeTabProject : styles.scopeTabClip}
      title={isProject
        ? 'Editing project-wide map defaults — click to switch to clip overrides'
        : 'Editing map settings for this clip — click to switch to project defaults'
      }
    >
      <ScopeIcon isProject={isProject} fill={SCOPE_FILLS[scope]} />
    </button>
  );
}
