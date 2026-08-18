// DecorationPanel — the floating popover hosted by each `▾` toolbar button.
// Anchored below its trigger, 280px wide, click-outside / Escape to close.
//
// Routing contract:
//  • Any MapSettings-derived field (POV color, sizes, route/waypoint mode,
//    label_mode, active_mode, gradient stops) is set by calling
//    `onChange(nextSettings)`. The parent (`ProjectView.handleMapToolbarChange`)
//    routes this through `computeClipOverrides` in clip scope, so MapOverrides
//    routing is free.
//  • Per-Waypoint colors are set via `onWaypointsChange(nextWaypoints)` —
//    these fields live on the Waypoint entity, not on MapSettings.
//
// The `[Solid][Gradient]` toggle for Route and Waypoints renders in BOTH
// scopes — every MapSettings-derived control is per-clip overridable with
// full capability parity (the old project-scope-only rules for route color
// and the halos are retired). Gradient mode reads/writes
// `mapSettings.{route,waypoints}.color.{mode,stops}` directly; the renderer
// (`src/lib/mapVisuals/styleSpec.ts` → `resolveStaticPaints`) picks up
// changes the same React tick. POV remains solid-only.
//
// `color_stops_cache` (per `color-gradient.md` §13) lives on the parent
// RouteSettings/WaypointsSettings type and is read/written here on mode
// toggles so the user can flip back and forth without losing their stops.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import SegmentedPicker from '../../SegmentedPicker';
import NumberStepper from '../../NumberStepper';
import { ColorSection } from '../ColorSection';
import {
  cloneStops,
  initialGradientFromSolid,
} from '../ColorSection/gradientMath';
import {
  MarkerSection,
  imageMarkerValue,
  imageIdOfMarkerValue,
  type MarkerValue,
} from '../MarkerSection';
import ConfirmModal from '../../shared/ConfirmModal';
import { panelStyles } from './styles';
import { sectionStyles } from '../ColorSection/styles';
import { shapeHasSecondary } from '../../../lib/mapVisuals';
import {
  povMarkerOf,
  DEFAULT_MARKER_HALO,
  DEFAULT_ROUTE_HALO,
  type ActiveWaypointMode,
  type Clip,
  type DecorationColor,
  type GradientStop,
  type HaloSettings,
  type MapSettings,
  type MarkerImageRef,
  type OverridePath,
  type EaseSpeed,
  type EaseStyle,
  type PovMarker,
  type PovMarkerShape,
  type PovPulseStyle,
  type PovPulseRate,
  type PovSettings,
  type SeamEase,
  type TransitionSettings,
  type TravelSettings,
  travelDrawRoute,
  travelShowPlayhead,
  travelSync,
  type TriMode,
  type Waypoint,
  type WaypointLabelMode,
  type WaypointShape,
} from '../../../types';
import type { IndexedRoute } from '../../../lib/routeLocation';
import { progressUpTo } from '../../../lib/routeLocation';
import { useMarkerImageImport } from '../../../hooks/useMarkerImageImport';

/** Canonical width used for `× 1080` display conversion. Same constant the
 *  rendering pipeline calls `PAINT_REFERENCE_WIDTH` (1080 CSS px). */
const PAINT_REFERENCE_WIDTH = 1080;

// --- Panel sizing constants -----------------------------------------------
// Defaults match the prior fixed dimensions (`width: 280; maxHeight: 480`)
// so first-open panels look identical. User-driven resize writes through
// `onSizeChange` and bypasses these.
const PANEL_DEFAULT_WIDTH = 280;
const PANEL_DEFAULT_MAX_HEIGHT = 480;
const PANEL_MIN_WIDTH = 240;
const PANEL_MAX_WIDTH = 640;
const PANEL_MIN_HEIGHT = 180;
/** Gap between a trigger button's bottom and the freshly-opened panel's top.
 *  Exported so MapToolbar can compute matching first-open positions. */
export const PANEL_TRIGGER_GAP = 4;

const TRI_OPTIONS: { value: TriMode; label: string }[] = [
  { value: 'none',    label: 'None'    },
  { value: 'visited', label: 'Visited' },
  { value: 'full',    label: 'Full'    },
];

const HALO_TOGGLE_OPTIONS: { value: 'off' | 'on'; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'on',  label: 'On'  },
];

const LABEL_MODE_OPTIONS: { value: WaypointLabelMode; label: string }[] = [
  { value: 'numbered', label: 'Numbered' },
  { value: 'labeled',  label: 'Labeled'  },
];

const ACTIVE_WAYPOINT_OPTIONS: { value: ActiveWaypointMode; label: string }[] = [
  { value: 'none',          label: 'None'   },
  { value: 'latest_passed', label: 'Latest' },
];

const PULSE_STYLE_OPTIONS: { value: PovPulseStyle; label: string }[] = [
  { value: 'steady',    label: 'Steady' },
  { value: 'throb',     label: 'Throb'  },
  { value: 'sonar',     label: 'Sonar'  },
  // Labeled `Heart` rather than `Heartbeat` so all four labels fit the
  // 4-up segmented strip at panel width without shrinking the type.
  { value: 'heartbeat', label: 'Heart'  },
];

const PULSE_RATE_OPTIONS: { value: PovPulseRate; label: string }[] = [
  { value: 'slow',   label: 'Slow'   },
  { value: 'medium', label: 'Medium' },
  { value: 'fast',   label: 'Fast'   },
];

export type DecorationKind = 'route' | 'waypoints' | 'pov' | 'transition';
export type DecorationPanelCloseOptions = { restoreFocus?: boolean };

export interface DecorationPanelProps {
  decoration: DecorationKind;
  settings: MapSettings;
  onChange: (next: MapSettings) => void;
  scope: 'project' | 'clip';
  overriddenKeys: Set<OverridePath> | null;
  onScopeChange: (scope: 'project' | 'clip') => void;
  onClose: (options?: DecorationPanelCloseOptions) => void;
  routeLoaded: boolean;
  currentClip: Clip | null;
  waypoints: Waypoint[];
  onWaypointsChange: (next: Waypoint[]) => void;
  /** Opens the existing WaypointsPanel modal for "no associated waypoint" CTA. */
  onOpenWaypointsPanel: () => void;
  /** Ref to the trigger button — read inside effects (click-outside,
   *  Escape, boundary check) to derive position and focus. */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  /** Optional 1-based ordinal of the current clip, used in scope-banner copy. */
  currentClipOrdinal: number | null;
  /** Indexed route — read by the gradient editor for waypoint Mercator
   *  fractions (snap ticks, preview dot positions) and total distance.
   *  Null when no GPX is loaded; the editor disables gradient mode in
   *  that state. */
  indexedRoute: IndexedRoute | null;
  /** Viewport-relative top-left position. The panel is always a floating
   *  window — there is no docked mode. Owned by MapToolbar so the position
   *  survives close/reopen. Optional (defaults to {0,0}) so existing tests
   *  that don't care about positioning compile unchanged. */
  position?: { x: number; y: number };
  /** Receives the next position on title-row drag. */
  onPositionChange?: (next: { x: number; y: number }) => void;
  /** User-set panel size. Null means "use defaults" (auto-height, default
   *  width). Survives close/reopen by living in the parent's state. */
  size?: { w: number; h: number } | null;
  /** Receives the next size on resize-handle drag. */
  onSizeChange?: (next: { w: number; h: number } | null) => void;
  /** Stacking index. Higher = renders on top. MapToolbar bumps this on any
   *  panel interaction so the most-recently-touched panel comes forward. */
  zIndex?: number;
  /** Called on any pointerdown inside the panel — used by the parent to
   *  bring this panel to the front of the stack. */
  onFocus?: () => void;
  /** Project bundle directory — the marker galleries' image upload copies
   *  assets into it (`import_marker_image` / `save_marker_icon`) and image
   *  tiles resolve their thumbnails against it. Optional so the route
   *  panel (and existing tests) compiles unchanged. */
  projectDir?: string | null;
  /** Library write — receives the FULL next `marker_images` list. Library
   *  mutations are project-level regardless of scope and MUST NOT flow
   *  through `onChange` (the clip-scope `computeClipOverrides` diff ignores
   *  `marker_images`, so a library write routed there would be dropped).
   *  Optional so the route panel compiles unchanged; the marker galleries
   *  hide their upload affordance without it. */
  onMarkerImagesChange?: (next: MarkerImageRef[]) => void;
  /** Confirmed delete of a library image. The parent (ProjectView) applies
   *  `removeMarkerImage` (reverts every use in both tools, drops the
   *  entry) and then deletes the bundle asset files. This panel owns only
   *  the right-click → "are you sure" confirmation. */
  onMarkerImageDelete?: (id: string) => void;
  /** The PROJECT-level MapSettings (unresolved by clip overrides) — the
   *  values every clip-scope "Reset to project" affordance writes back so
   *  the override diff collapses to nothing. Optional so project-scope-only
   *  tests compile unchanged; the reset affordances hide without it. */
  projectSettings?: MapSettings | null;
}

export function DecorationPanel({
  decoration,
  settings,
  onChange,
  scope,
  overriddenKeys,
  onScopeChange,
  onClose,
  routeLoaded,
  currentClip,
  waypoints,
  onWaypointsChange,
  onOpenWaypointsPanel,
  triggerRef,
  currentClipOrdinal,
  indexedRoute,
  position,
  onPositionChange,
  size = null,
  onSizeChange,
  zIndex,
  onFocus,
  projectDir,
  onMarkerImagesChange,
  onMarkerImageDelete,
  projectSettings,
}: DecorationPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  // ---- Marker-library shared plumbing (waypoints + pov galleries) ----
  // Import flow + delete confirmation live at the panel root so the two
  // gallery bodies stay identical thin consumers.
  const {
    importImages,
    importing: markerImporting,
    error: markerImportError,
  } = useMarkerImageImport(projectDir);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const handleMarkerUpload = useCallback(async () => {
    if (!onMarkerImagesChange) return;
    const existing = settings.marker_images;
    const added = await importImages(existing.map((m) => m.id));
    if (added.length > 0) onMarkerImagesChange([...existing, ...added]);
  }, [onMarkerImagesChange, settings.marker_images, importImages]);
  const pendingDeleteRef = pendingDeleteId
    ? settings.marker_images.find((m) => m.id === pendingDeleteId) ?? null
    : null;
  const currentWidth = size?.w ?? PANEL_DEFAULT_WIDTH;
  const pos = position ?? { x: 0, y: 0 };

  // Escape to close — returns focus to trigger. With multi-open, every open
  // panel registers its own listener; pressing Escape closes all of them,
  // which reads as a sensible "dismiss everything" gesture.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose({ restoreFocus: true });
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, triggerRef]);

  // Title-row drag: pointer-capture lets us receive move/up events even if
  // the pointer leaves the panel. Position writes go to the parent through
  // `onPositionChange`, which both moves the panel and (via the parent's
  // bringToFront) keeps it on top.
  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      if (!onPositionChange) return;
      const target = e.currentTarget;
      const panel = panelRef.current;
      if (!panel) return;
      target.setPointerCapture(e.pointerId);
      const startRect = panel.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const initialPanelX = startRect.left;
      const initialPanelY = startRect.top;

      setDragging(true);

      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        onPositionChange({ x: initialPanelX + dx, y: initialPanelY + dy });
      };
      const stop = () => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', stop);
        target.removeEventListener('pointercancel', stop);
        setDragging(false);
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', stop);
      target.addEventListener('pointercancel', stop);
    },
    [onPositionChange],
  );

  // Resize handle drag — independent of title drag. Reads current panel
  // dimensions at pointerdown (so user-set or auto-sized starting points
  // both work), then writes deltas through `onSizeChange`. Clamped to
  // sensible min/max so the gradient editor and segmented pickers stay
  // legible. The event is allowed to bubble so the panel root's onFocus
  // still fires and the parent brings this panel to the front.
  const startResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      if (!onSizeChange) return;
      const target = e.currentTarget;
      const panel = panelRef.current;
      if (!panel) return;
      target.setPointerCapture(e.pointerId);
      const startRect = panel.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const initialW = startRect.width;
      const initialH = startRect.height;

      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const w = clamp(initialW + dx, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH);
        const h = clamp(initialH + dy, PANEL_MIN_HEIGHT, window.innerHeight - 24);
        onSizeChange({ w, h });
      };
      const stop = () => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', stop);
        target.removeEventListener('pointercancel', stop);
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', stop);
      target.addEventListener('pointercancel', stop);
    },
    [onSizeChange],
  );

  const titleByDecoration: Record<DecorationKind, string> = {
    route:      'ROUTE',
    waypoints:  'WAYPOINTS',
    pov:        'POV',
    transition: 'TRANSITION',
  };

  const panelStyle: CSSProperties = {
    ...panelStyles.panel,
    position: 'fixed' as const,
    left: pos.x,
    top: pos.y,
    width: currentWidth,
    // User-set height when present; otherwise content-driven up to
    // PANEL_DEFAULT_MAX_HEIGHT so a freshly-opened panel hugs its content.
    ...(size?.h ? { height: size.h } : { maxHeight: PANEL_DEFAULT_MAX_HEIGHT }),
    ...(zIndex !== undefined ? { zIndex } : null),
  };

  const titleRowStyle: CSSProperties = {
    ...panelStyles.titleRow,
    ...(dragging ? panelStyles.titleRowDragging : null),
  };

  const supportsDrag = !!onPositionChange;
  const supportsResize = !!onSizeChange;

  // Any pointerdown inside the panel (title-row drag, body interactions,
  // resize handle) bubbles up here and triggers onFocus, which the parent
  // uses to bring this panel to the front of the stack.
  const onPanelPointerDown = onFocus ? () => onFocus() : undefined;

  const panel = (
    <div
      ref={panelRef}
      style={panelStyle}
      role="dialog"
      aria-label={`${decoration} decoration panel`}
      data-testid={`decoration-panel-${decoration}`}
      onPointerDown={onPanelPointerDown}
    >
      <div
        style={titleRowStyle}
        onPointerDown={supportsDrag ? startDrag : undefined}
        title={supportsDrag ? 'Drag to move' : undefined}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
          {supportsDrag && <span style={panelStyles.dragHandle} aria-hidden />}
          <span style={panelStyles.title}>{titleByDecoration[decoration]}</span>
        </span>
        <span style={panelStyles.titleActions}>
          <button
            type="button"
            onClick={() => onClose({ restoreFocus: false })}
            onPointerDown={(e) => e.stopPropagation()}
            style={panelStyles.titleClose}
            title="Close"
            aria-label="Close panel"
            data-testid={`decoration-panel-${decoration}-close`}
          >
            ×
          </button>
        </span>
      </div>

      <div style={panelStyles.body}>
        {scope === 'clip' && (
          <div style={panelStyles.scopeBanner}>
            <span style={panelStyles.scopeBannerIcon}>◫</span>
            <span style={panelStyles.scopeBannerText}>
              Clip {currentClipOrdinal ?? '—'} overrides
            </span>
            <button
              type="button"
              onClick={() => onScopeChange('project')}
              style={panelStyles.scopeBannerLink}
            >
              ← switch to proj
            </button>
          </div>
        )}

        {decoration === 'route' && (
          <RoutePanelBody
            settings={settings}
            onChange={onChange}
            scope={scope}
            overriddenKeys={overriddenKeys}
            projectSettings={projectSettings}
            routeLoaded={routeLoaded}
            waypoints={waypoints}
            indexedRoute={indexedRoute}
          />
        )}

        {decoration === 'waypoints' && (
          <WaypointsPanelBody
            settings={settings}
            onChange={onChange}
            scope={scope}
            overriddenKeys={overriddenKeys}
            projectSettings={projectSettings}
            routeLoaded={routeLoaded}
            currentClip={currentClip}
            waypoints={waypoints}
            onWaypointsChange={onWaypointsChange}
            onOpenWaypointsPanel={onOpenWaypointsPanel}
            indexedRoute={indexedRoute}
            projectDir={projectDir}
            onMarkerUpload={handleMarkerUpload}
            markerImporting={markerImporting}
            markerImportError={markerImportError}
            onRequestDeleteImage={setPendingDeleteId}
          />
        )}

        {decoration === 'pov' && (
          <PovPanelBody
            settings={settings}
            onChange={onChange}
            scope={scope}
            overriddenKeys={overriddenKeys}
            projectSettings={projectSettings}
            projectDir={projectDir}
            onMarkerUpload={handleMarkerUpload}
            markerImporting={markerImporting}
            markerImportError={markerImportError}
            onRequestDeleteImage={setPendingDeleteId}
          />
        )}

        {decoration === 'transition' && (
          <TransitionPanelBody
            settings={settings}
            onChange={onChange}
            scope={scope}
            overriddenKeys={overriddenKeys}
            projectSettings={projectSettings}
            projectDir={projectDir}
            onMarkerUpload={handleMarkerUpload}
            markerImporting={markerImporting}
            markerImportError={markerImportError}
            onRequestDeleteImage={setPendingDeleteId}
          />
        )}
      </div>

      {pendingDeleteRef && (
        <ConfirmModal
          title="Delete marker image?"
          message={`"${pendingDeleteRef.source_name}" will be removed from the library and its files deleted from the project. Every use — in both Waypoints and POV, including per-clip and per-waypoint overrides — reverts to the default marker.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            setPendingDeleteId(null);
            onMarkerImageDelete?.(pendingDeleteRef.id);
          }}
          onCancel={() => setPendingDeleteId(null)}
        />
      )}

      {supportsResize && (
        <div
          style={panelStyles.resizeHandle}
          onPointerDown={startResize}
          role="separator"
          aria-label="Resize panel"
          aria-orientation="horizontal"
          data-testid={`decoration-panel-${decoration}-resize`}
        />
      )}
    </div>
  );

  // Portal to document.body so the panel escapes the map pane's bounding box
  // (the split layout's right pane has constrained width and the toolbar
  // sits inside it). SSR isn't a concern — this is a Tauri webview app.
  return typeof document !== 'undefined'
    ? createPortal(panel, document.body)
    : panel;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

// ---------- Route panel body ----------------------------------------------

function RoutePanelBody({
  settings,
  onChange,
  scope,
  overriddenKeys,
  projectSettings,
  routeLoaded,
  waypoints,
  indexedRoute,
}: {
  settings: MapSettings;
  onChange: (next: MapSettings) => void;
  scope: 'project' | 'clip';
  overriddenKeys: Set<OverridePath> | null;
  projectSettings: MapSettings | null | undefined;
  routeLoaded: boolean;
  waypoints: Waypoint[];
  indexedRoute: IndexedRoute | null;
}) {
  const setMode = (mode: TriMode) =>
    onChange({ ...settings, route: { ...settings.route, mode } });

  // Solid-mode color setter — writes a fresh `{ mode: 'solid', solid }`
  // discriminant, leaving any existing `color_stops_cache` intact (so a
  // future Solid→Gradient toggle still has stops to restore).
  const setSolidColor = (hex: string) =>
    onChange({
      ...settings,
      route: { ...settings.route, color: { mode: 'solid', solid: hex } },
    });

  // Gradient-mode stops setter — writes a fresh
  // `{ mode: 'gradient', stops }` discriminant; renderer reads it through
  // `resolveStaticPaints` and applies the `line-gradient` expression.
  const setGradientStops = (stops: GradientStop[]) =>
    onChange({
      ...settings,
      route: { ...settings.route, color: { mode: 'gradient', stops } },
    });

  // Mode toggle — moves stops to/from `color_stops_cache` per §13. The
  // cache lives on RouteSettings (sibling of `color`); writing it from
  // here keeps the rule "renderer never reads the cache" intact.
  const setColorMode = (nextMode: 'solid' | 'gradient') => {
    if (nextMode === 'solid') {
      // Gradient → Solid: stash current stops, drop to solid using the
      // first stop's color (sensible "what was on the left endpoint").
      if (settings.route.color.mode === 'gradient') {
        const stops = settings.route.color.stops;
        const firstColor = stops[0]?.color ?? '#bced09';
        onChange({
          ...settings,
          route: {
            ...settings.route,
            color: { mode: 'solid', solid: firstColor },
            color_stops_cache: cloneStops(stops),
          },
        });
        return;
      }
      // Already solid — no-op.
      return;
    }
    // Solid → Gradient: prefer the cache; otherwise seed two-endpoint
    // stops both at the current solid color.
    const currentSolid =
      settings.route.color.mode === 'solid'
        ? settings.route.color.solid
        : '#bced09';
    const stops =
      settings.route.color_stops_cache && settings.route.color_stops_cache.length >= 2
        ? cloneStops(settings.route.color_stops_cache)
        : initialGradientFromSolid(currentSolid);
    onChange({
      ...settings,
      route: {
        ...settings.route,
        color: { mode: 'gradient', stops },
      },
    });
  };

  const setSize = (patch: Partial<MapSettings['route']['size']>) =>
    onChange({
      ...settings,
      route: { ...settings.route, size: { ...settings.route.size, ...patch } },
    });

  const setRouteLineWidth = (width: number) =>
    setSize({ width });

  // Copy Route → Waypoints. Effects a one-time deep copy of the stop array.
  // Per §9: when Waypoints is in solid mode, we switch it to gradient mode
  // first and preserve its prior solid value in `color_stops_cache` so a
  // later toggle-back restores it.
  const onCopyToWaypoints = () => {
    if (settings.route.color.mode !== 'gradient') return;
    const stopsCopy = cloneStops(settings.route.color.stops);
    if (settings.waypoints.color.mode === 'solid') {
      // Preserve the prior solid by stashing the *existing* waypoints
      // cache or, if none, the current waypoints solid wrapped in a
      // two-endpoint cache so the user can revert.
      const priorSolid = settings.waypoints.color.solid;
      const cacheToKeep =
        settings.waypoints.color_stops_cache && settings.waypoints.color_stops_cache.length >= 2
          ? settings.waypoints.color_stops_cache
          : initialGradientFromSolid(priorSolid);
      onChange({
        ...settings,
        waypoints: {
          ...settings.waypoints,
          color: { mode: 'gradient', stops: stopsCopy },
          color_stops_cache: cloneStops(cacheToKeep),
        },
      });
      return;
    }
    onChange({
      ...settings,
      waypoints: {
        ...settings.waypoints,
        color: { mode: 'gradient', stops: stopsCopy },
      },
    });
  };

  const currentSolid = readSolid(settings.route.color);
  const colorMode: 'solid' | 'gradient' =
    settings.route.color.mode === 'gradient' ? 'gradient' : 'solid';
  const gradientStops =
    settings.route.color.mode === 'gradient' ? settings.route.color.stops : undefined;
  const waypointProgress = useWaypointProgress(waypoints, indexedRoute);
  const totalDistMeters = indexedRoute?.totalDistMeters ?? 0;
  // Gradient mode is only meaningful with a usable route. A degenerate
  // route (zero Mercator length) is treated as "no route loaded".
  const gradientAvailable =
    routeLoaded && (indexedRoute?.totalMercatorMeters ?? 0) > 0;

  return (
    <>
      <Section label="VISIBILITY">
        <SegmentedPicker<TriMode>
          value={settings.route.mode}
          options={TRI_OPTIONS}
          onChange={setMode}
          disabledValues={routeLoaded ? [] : ['visited']}
          title={routeLoaded ? 'Route line mode' : 'Import a GPX route to enable visited mode'}
          ariaLabel="Route visibility"
        />
      </Section>

      <Section label="COLOR">
        {/* Full capability in BOTH scopes (gradient toggle included) — the
         *  old "route color is project-wide" read-only block is retired. In
         *  clip scope the parent diffs the emitted settings into
         *  `map_overrides.route.color` (deep-equal via
         *  `decorationColorEquals`). */}
        <ColorSection
          value={currentSolid}
          onChange={setSolidColor}
          mode={colorMode}
          onModeChange={setColorMode}
          gradientAvailable={gradientAvailable}
          gradientStops={gradientStops}
          onGradientStopsChange={setGradientStops}
          waypointProgress={waypointProgress}
          totalDistMeters={totalDistMeters}
          copyDirection="toWaypoints"
          onCopy={onCopyToWaypoints}
          copyVisible={colorMode === 'gradient'}
          overrideIndicator={clipOverrideIndicator(
            scope,
            overriddenKeys,
            'route.color',
            projectSettings
              ? () =>
                  onChange({
                    ...settings,
                    route: { ...settings.route, color: projectSettings.route.color },
                  })
              : null,
          )}
        />
      </Section>

      <Section label="SIZE">
        <SizeRow
          label="Line"
          stored={settings.route.size.width}
          onStoredChange={setRouteLineWidth}
        />
      </Section>

      <Section label="HALO">
        <HaloControls
          halo={settings.route.halo}
          seed={DEFAULT_ROUTE_HALO}
          onChange={(next) =>
            onChange({ ...settings, route: { ...settings.route, halo: next } })
          }
          title="Optional glow painted beneath the route line"
          ariaLabel="Route halo"
          colorTestId="route-halo-color"
          allowGradient
          gradientAvailable={gradientAvailable}
          waypointProgress={waypointProgress}
          totalDistMeters={totalDistMeters}
          overrideIndicator={clipOverrideIndicator(
            scope,
            overriddenKeys,
            'route.halo',
            projectSettings
              ? () =>
                  onChange({
                    ...settings,
                    route: { ...settings.route, halo: projectSettings.route.halo },
                  })
              : null,
          )}
        />
      </Section>
    </>
  );
}

// ---------- Waypoints panel body ------------------------------------------

function WaypointsPanelBody({
  settings,
  onChange,
  scope,
  overriddenKeys,
  projectSettings,
  routeLoaded,
  currentClip,
  waypoints,
  onWaypointsChange,
  onOpenWaypointsPanel,
  indexedRoute,
  projectDir,
  onMarkerUpload,
  markerImporting,
  markerImportError,
  onRequestDeleteImage,
}: {
  settings: MapSettings;
  onChange: (next: MapSettings) => void;
  scope: 'project' | 'clip';
  overriddenKeys: Set<OverridePath> | null;
  projectSettings: MapSettings | null | undefined;
  routeLoaded: boolean;
  currentClip: Clip | null;
  waypoints: Waypoint[];
  onWaypointsChange: (next: Waypoint[]) => void;
  onOpenWaypointsPanel: () => void;
  indexedRoute: IndexedRoute | null;
  projectDir: string | null | undefined;
  onMarkerUpload: () => void;
  markerImporting: boolean;
  markerImportError: string | null;
  onRequestDeleteImage: (id: string) => void;
}) {
  const setMode = (mode: TriMode) =>
    onChange({ ...settings, waypoints: { ...settings.waypoints, mode } });

  const setLabelMode = (label_mode: WaypointLabelMode) =>
    onChange({ ...settings, waypoints: { ...settings.waypoints, label_mode } });

  const setActiveMode = (active_mode: ActiveWaypointMode) =>
    onChange({ ...settings, waypoints: { ...settings.waypoints, active_mode } });

  const setSolidColor = (hex: string) =>
    onChange({
      ...settings,
      waypoints: {
        ...settings.waypoints,
        color: { mode: 'solid', solid: hex },
      },
    });

  const setGradientStops = (stops: GradientStop[]) =>
    onChange({
      ...settings,
      waypoints: {
        ...settings.waypoints,
        color: { mode: 'gradient', stops },
      },
    });

  // ---- Secondary color: identical channel shape as primary ----
  // Each setter writes into `waypoints.secondary_color` /
  // `secondary_color_stops_cache`. The two slots stay independent of each
  // other — toggling secondary's mode between solid/gradient does not
  // touch primary's mode or cache.
  const setSecondarySolidColor = (hex: string) =>
    onChange({
      ...settings,
      waypoints: {
        ...settings.waypoints,
        secondary_color: { mode: 'solid', solid: hex },
      },
    });

  const setSecondaryGradientStops = (stops: GradientStop[]) =>
    onChange({
      ...settings,
      waypoints: {
        ...settings.waypoints,
        secondary_color: { mode: 'gradient', stops },
      },
    });

  const setColorMode = (nextMode: 'solid' | 'gradient') => {
    if (nextMode === 'solid') {
      if (settings.waypoints.color.mode === 'gradient') {
        const stops = settings.waypoints.color.stops;
        const firstColor = stops[0]?.color ?? '#bced09';
        onChange({
          ...settings,
          waypoints: {
            ...settings.waypoints,
            color: { mode: 'solid', solid: firstColor },
            color_stops_cache: cloneStops(stops),
          },
        });
        return;
      }
      return;
    }
    const currentSolid =
      settings.waypoints.color.mode === 'solid'
        ? settings.waypoints.color.solid
        : '#bced09';
    const stops =
      settings.waypoints.color_stops_cache &&
      settings.waypoints.color_stops_cache.length >= 2
        ? cloneStops(settings.waypoints.color_stops_cache)
        : initialGradientFromSolid(currentSolid);
    onChange({
      ...settings,
      waypoints: {
        ...settings.waypoints,
        color: { mode: 'gradient', stops },
      },
    });
  };

  /** Same stash/restore protocol as `setColorMode`, but against the
   *  secondary slot's color + `secondary_color_stops_cache`. White is the
   *  fallback solid because the project-default secondary is white — same
   *  rationale as `resolveMapSettings`' `projectWaypointsSecondarySolid`. */
  const setSecondaryColorMode = (nextMode: 'solid' | 'gradient') => {
    if (nextMode === 'solid') {
      if (settings.waypoints.secondary_color.mode === 'gradient') {
        const stops = settings.waypoints.secondary_color.stops;
        const firstColor = stops[0]?.color ?? '#ffffff';
        onChange({
          ...settings,
          waypoints: {
            ...settings.waypoints,
            secondary_color: { mode: 'solid', solid: firstColor },
            secondary_color_stops_cache: cloneStops(stops),
          },
        });
        return;
      }
      return;
    }
    const currentSolid =
      settings.waypoints.secondary_color.mode === 'solid'
        ? settings.waypoints.secondary_color.solid
        : '#ffffff';
    const stops =
      settings.waypoints.secondary_color_stops_cache &&
      settings.waypoints.secondary_color_stops_cache.length >= 2
        ? cloneStops(settings.waypoints.secondary_color_stops_cache)
        : initialGradientFromSolid(currentSolid);
    onChange({
      ...settings,
      waypoints: {
        ...settings.waypoints,
        secondary_color: { mode: 'gradient', stops },
      },
    });
  };

  // Copy Route → Waypoints (initiated from the Waypoints panel). Hidden
  // unless Route is in gradient mode with ≥ 2 stops (per §9).
  const onCopyFromRoute = () => {
    if (settings.route.color.mode !== 'gradient') return;
    if (settings.route.color.stops.length < 2) return;
    const stopsCopy = cloneStops(settings.route.color.stops);
    if (settings.waypoints.color.mode === 'solid') {
      const priorSolid = settings.waypoints.color.solid;
      const cacheToKeep =
        settings.waypoints.color_stops_cache &&
        settings.waypoints.color_stops_cache.length >= 2
          ? settings.waypoints.color_stops_cache
          : initialGradientFromSolid(priorSolid);
      onChange({
        ...settings,
        waypoints: {
          ...settings.waypoints,
          color: { mode: 'gradient', stops: stopsCopy },
          color_stops_cache: cloneStops(cacheToKeep),
        },
      });
      return;
    }
    onChange({
      ...settings,
      waypoints: {
        ...settings.waypoints,
        color: { mode: 'gradient', stops: stopsCopy },
      },
    });
  };

  const setSize = (patch: Partial<MapSettings['waypoints']['size']>) =>
    onChange({
      ...settings,
      waypoints: {
        ...settings.waypoints,
        size: { ...settings.waypoints.size, ...patch },
      },
    });

  const associatedIdx = currentClip
    ? waypoints.findIndex((w) => w.clip_id === currentClip.id)
    : -1;
  const associatedWaypoint = associatedIdx >= 0 ? waypoints[associatedIdx] : null;
  const associatedOrdinal = associatedIdx >= 0 ? associatedIdx + 1 : null;

  const setWaypointColor = (hex: string) => {
    if (!associatedWaypoint) return;
    const nextWaypoints = waypoints.map((w) =>
      w.id === associatedWaypoint.id ? { ...w, color: hex } : w,
    );
    onWaypointsChange(nextWaypoints);
  };

  const clearWaypointColor = () => {
    if (!associatedWaypoint) return;
    const nextWaypoints = waypoints.map((w) =>
      w.id === associatedWaypoint.id ? omitColor(w) : w,
    );
    onWaypointsChange(nextWaypoints);
  };

  const setWaypointSecondaryColor = (hex: string) => {
    if (!associatedWaypoint) return;
    const nextWaypoints = waypoints.map((w) =>
      w.id === associatedWaypoint.id ? { ...w, secondary_color: hex } : w,
    );
    onWaypointsChange(nextWaypoints);
  };

  const clearWaypointSecondaryColor = () => {
    if (!associatedWaypoint) return;
    const nextWaypoints = waypoints.map((w) =>
      w.id === associatedWaypoint.id ? omitSecondaryColor(w) : w,
    );
    onWaypointsChange(nextWaypoints);
  };

  // Settings-level marker setter — writes through `onChange` (MapSettings)
  // in BOTH scopes; in clip scope the parent's `computeClipOverrides` diffs
  // the shape/image pair atomically into `map_overrides.waypoints.marker`.
  // Shape and image selections are mutually exclusive: picking a shape
  // clears `marker_image_id` (so the shape actually shows — the image wins
  // when both are set); picking an image just sets the id, leaving the
  // shape as the fallback a later image-delete reverts to.
  const setSettingsMarker = (next: MarkerValue) => {
    const imageId = imageIdOfMarkerValue(next);
    onChange({
      ...settings,
      waypoints: imageId
        ? { ...settings.waypoints, marker_image_id: imageId }
        : {
            ...settings.waypoints,
            shape: next as WaypointShape,
            marker_image_id: undefined,
          },
    });
  };

  // Clip-scope marker setter — writes `Waypoint.shape` / `Waypoint.
  // marker_image_id` on the associated entity via `onWaypointsChange`.
  // Same pattern as `setWaypointColor`. Per the v8 contract, marker
  // overrides live on the Waypoint, never on `clip.map_overrides`. The
  // two fields are mutually cleared: the waypoint-level choice is one
  // marker, not a shape plus an image.
  const setWaypointMarker = (next: MarkerValue) => {
    if (!associatedWaypoint) return;
    const imageId = imageIdOfMarkerValue(next);
    const nextWaypoints = waypoints.map((w) => {
      if (w.id !== associatedWaypoint.id) return w;
      return imageId
        ? omitShape({ ...w, marker_image_id: imageId })
        : { ...omitMarkerImage(w), shape: next as WaypointShape };
    });
    onWaypointsChange(nextWaypoints);
  };

  const clearWaypointMarker = () => {
    if (!associatedWaypoint) return;
    const nextWaypoints = waypoints.map((w) =>
      w.id === associatedWaypoint.id ? omitMarkerImage(omitShape(w)) : w,
    );
    onWaypointsChange(nextWaypoints);
  };

  const projectSolid = readSolid(settings.waypoints.color);
  const projectSecondarySolid = readSolid(settings.waypoints.secondary_color);
  const waypointColor = associatedWaypoint?.color ?? projectSolid;
  const waypointSecondaryColorValue =
    associatedWaypoint?.secondary_color ?? projectSecondarySolid;

  // Effective marker — what the gallery shows as selected. Image wins over
  // shape at each level (same precedence as `waypointMarkerProperty` in
  // sources.ts); in clip scope the per-Waypoint override wins wholesale
  // over the project default. Gates the color sections: image markers are
  // full-color bitmaps the color slots don't tint (a caption on COLOR, the
  // SECONDARY section hidden — same footgun rule as the one-color shapes,
  // which also hide SECONDARY via `shapeHasSecondary`).
  const projectMarkerValue: MarkerValue =
    settings.waypoints.marker_image_id !== undefined
      ? imageMarkerValue(settings.waypoints.marker_image_id)
      : settings.waypoints.shape;
  const waypointMarkerValue: MarkerValue | null = associatedWaypoint
    ? associatedWaypoint.marker_image_id !== undefined
      ? imageMarkerValue(associatedWaypoint.marker_image_id)
      : associatedWaypoint.shape ?? null
    : null;
  const effectiveMarker: MarkerValue =
    scope === 'clip'
      ? waypointMarkerValue ?? projectMarkerValue
      : projectMarkerValue;
  const effectiveIsImage = imageIdOfMarkerValue(effectiveMarker) !== null;
  const showSecondaryColor =
    !effectiveIsImage && shapeHasSecondary(effectiveMarker);

  const waypointsColorMode: 'solid' | 'gradient' =
    settings.waypoints.color.mode === 'gradient' ? 'gradient' : 'solid';
  const waypointsGradientStops =
    settings.waypoints.color.mode === 'gradient'
      ? settings.waypoints.color.stops
      : undefined;
  const waypointsSecondaryColorMode: 'solid' | 'gradient' =
    settings.waypoints.secondary_color.mode === 'gradient' ? 'gradient' : 'solid';
  const waypointsSecondaryGradientStops =
    settings.waypoints.secondary_color.mode === 'gradient'
      ? settings.waypoints.secondary_color.stops
      : undefined;
  const waypointProgress = useWaypointProgress(waypoints, indexedRoute);
  const totalDistMeters = indexedRoute?.totalDistMeters ?? 0;
  const waypointsGradientAvailable =
    routeLoaded && (indexedRoute?.totalMercatorMeters ?? 0) > 0;

  return (
    <>
      <Section label="VISIBILITY">
        <SegmentedPicker<TriMode>
          value={settings.waypoints.mode}
          options={TRI_OPTIONS}
          onChange={setMode}
          disabledValues={routeLoaded ? [] : ['visited']}
          title="Waypoint visibility"
          ariaLabel="Waypoint visibility"
        />
      </Section>

      <Section label="LABEL MODE">
        <SegmentedPicker<WaypointLabelMode>
          value={settings.waypoints.label_mode}
          options={LABEL_MODE_OPTIONS}
          onChange={setLabelMode}
          title="Waypoint label render mode"
          ariaLabel="Waypoint label render mode"
        />
      </Section>

      <Section label="ACTIVE MODE">
        <SegmentedPicker<ActiveWaypointMode>
          value={settings.waypoints.active_mode}
          options={ACTIVE_WAYPOINT_OPTIONS}
          onChange={setActiveMode}
          title="Active-waypoint highlight strategy"
          ariaLabel="Active-waypoint highlight strategy"
        />
      </Section>

      <Section label="COLOR">
        {/* Clip scope stacks TWO surfaces: first the clip-level default for
         *  ALL waypoints (full capability parity with project scope —
         *  gradients included — diffed into `map_overrides.waypoints.color`),
         *  then the per-Waypoint entity override for this clip's associated
         *  waypoint, which wins per feature over the clip-level value. */}
        <ColorSection
          value={projectSolid}
          onChange={setSolidColor}
          mode={waypointsColorMode}
          onModeChange={setColorMode}
          gradientAvailable={waypointsGradientAvailable}
          gradientStops={waypointsGradientStops}
          onGradientStopsChange={setGradientStops}
          waypointProgress={waypointProgress}
          totalDistMeters={totalDistMeters}
          copyDirection="fromRoute"
          onCopy={onCopyFromRoute}
          // Per `color-gradient.md` §9: visibility depends ONLY on the
          // source (Route) being in gradient mode with ≥ 2 stops.
          // Waypoints' own mode doesn't matter — pressing the button in
          // solid mode is exactly the affordance that flips Waypoints to
          // gradient (with the prior solid stashed in `color_stops_cache`).
          copyVisible={
            settings.route.color.mode === 'gradient' &&
            settings.route.color.stops.length >= 2
          }
          overrideIndicator={clipOverrideIndicator(
            scope,
            overriddenKeys,
            'waypoints.color',
            projectSettings
              ? () =>
                  onChange({
                    ...settings,
                    waypoints: {
                      ...settings.waypoints,
                      color: projectSettings.waypoints.color,
                    },
                  })
              : null,
          )}
        />
        {scope === 'clip' &&
          (associatedWaypoint ? (
            <>
              <p style={panelStyles.caption}>
                This clip's waypoint (solid-color only):
              </p>
              <ColorSection
                value={waypointColor}
                onChange={setWaypointColor}
                overrideIndicator={
                  associatedWaypoint.color !== undefined && associatedOrdinal != null
                    ? {
                        label: `Wp ${associatedOrdinal} · override`,
                        onClear: clearWaypointColor,
                      }
                    : undefined
                }
              />
            </>
          ) : (
            <NoAssociatedWaypointNote onOpenWaypointsPanel={onOpenWaypointsPanel} />
          ))}
        {effectiveIsImage && (
          <p style={panelStyles.caption}>
            With an image marker, colors tint shape markers and labels only —
            the image draws in its own colors.
          </p>
        )}
      </Section>

      {showSecondaryColor && (
        <Section label="SECONDARY COLOR">
          <ColorSection
            value={projectSecondarySolid}
            onChange={setSecondarySolidColor}
            mode={waypointsSecondaryColorMode}
            onModeChange={setSecondaryColorMode}
            gradientAvailable={waypointsGradientAvailable}
            gradientStops={waypointsSecondaryGradientStops}
            onGradientStopsChange={setSecondaryGradientStops}
            waypointProgress={waypointProgress}
            totalDistMeters={totalDistMeters}
            overrideIndicator={clipOverrideIndicator(
              scope,
              overriddenKeys,
              'waypoints.secondary_color',
              projectSettings
                ? () =>
                    onChange({
                      ...settings,
                      waypoints: {
                        ...settings.waypoints,
                        secondary_color: projectSettings.waypoints.secondary_color,
                      },
                    })
                : null,
            )}
          />
          {scope === 'clip' &&
            (associatedWaypoint ? (
              <>
                <p style={panelStyles.caption}>
                  This clip's waypoint (solid-color only):
                </p>
                <ColorSection
                  value={waypointSecondaryColorValue}
                  onChange={setWaypointSecondaryColor}
                  overrideIndicator={
                    associatedWaypoint.secondary_color !== undefined &&
                    associatedOrdinal != null
                      ? {
                          label: `Wp ${associatedOrdinal} · override`,
                          onClear: clearWaypointSecondaryColor,
                        }
                      : undefined
                  }
                />
              </>
            ) : (
              <NoAssociatedWaypointNote onOpenWaypointsPanel={onOpenWaypointsPanel} />
            ))}
        </Section>
      )}

      <Section label="MARKER">
        {/* Same two-surface stack as COLOR in clip scope: the clip-level
         *  default marker for ALL waypoints (diffed atomically into
         *  `map_overrides.waypoints.marker`), then the per-Waypoint entity
         *  override, which wins per feature. */}
        <MarkerSection
          domain="waypoint"
          value={projectMarkerValue}
          onChange={setSettingsMarker}
          markerImages={settings.marker_images}
          projectDir={projectDir}
          onUpload={onMarkerUpload}
          importing={markerImporting}
          onDeleteImage={onRequestDeleteImage}
          uploadError={markerImportError}
          ariaLabel="Waypoint marker"
          testIdPrefix="waypoint-marker-cell"
          overrideIndicator={clipOverrideIndicator(
            scope,
            overriddenKeys,
            'waypoints.marker',
            projectSettings
              ? () =>
                  onChange({
                    ...settings,
                    waypoints: {
                      ...settings.waypoints,
                      shape: projectSettings.waypoints.shape,
                      marker_image_id: projectSettings.waypoints.marker_image_id,
                    },
                  })
              : null,
          )}
        />
        {scope === 'clip' &&
          (associatedWaypoint ? (
            <>
              <p style={panelStyles.caption}>This clip's waypoint:</p>
              <MarkerSection
                domain="waypoint"
                value={effectiveMarker}
                onChange={setWaypointMarker}
                markerImages={settings.marker_images}
                projectDir={projectDir}
                onUpload={onMarkerUpload}
                importing={markerImporting}
                onDeleteImage={onRequestDeleteImage}
                uploadError={markerImportError}
                ariaLabel="Associated waypoint marker"
                testIdPrefix="associated-waypoint-marker-cell"
                overrideIndicator={
                  waypointMarkerValue !== null && associatedOrdinal != null
                    ? {
                        label: `Wp ${associatedOrdinal} · override`,
                        onClear: clearWaypointMarker,
                      }
                    : undefined
                }
              />
            </>
          ) : (
            <NoAssociatedWaypointNote onOpenWaypointsPanel={onOpenWaypointsPanel} />
          ))}
      </Section>

      <Section label="SIZE">
        <SizeRow
          label="Radius"
          stored={settings.waypoints.size.circle_radius}
          onStoredChange={(v) => setSize({ circle_radius: v })}
        />
        <SizeRow
          label="Active radius"
          stored={settings.waypoints.size.active_radius}
          onStoredChange={(v) => setSize({ active_radius: v })}
        />
        {/* Outline thickness for the secondary slot — baked into the
         *  secondary SDF icon at rasterize time. MapView re-registers the
         *  atlas on change (see the re-rasterize effect there). One-color
         *  shapes (today: `ring`) ignore this. */}
        <SizeRow
          label="Stroke"
          stored={settings.waypoints.size.stroke_width}
          onStoredChange={(v) => setSize({ stroke_width: v })}
        />
        <SizeRow
          label="Label size"
          stored={settings.waypoints.size.label_size}
          onStoredChange={(v) => setSize({ label_size: v })}
        />
      </Section>

      <Section label="HALO">
        <HaloControls
          halo={settings.waypoints.halo}
          seed={DEFAULT_MARKER_HALO}
          onChange={(next) =>
            onChange({
              ...settings,
              waypoints: { ...settings.waypoints, halo: next },
            })
          }
          title="Optional glow painted beneath every waypoint marker"
          ariaLabel="Waypoints halo"
          colorTestId="waypoints-halo-color"
          allowGradient
          gradientAvailable={waypointsGradientAvailable}
          waypointProgress={waypointProgress}
          totalDistMeters={totalDistMeters}
          overrideIndicator={clipOverrideIndicator(
            scope,
            overriddenKeys,
            'waypoints.halo',
            projectSettings
              ? () =>
                  onChange({
                    ...settings,
                    waypoints: {
                      ...settings.waypoints,
                      halo: projectSettings.waypoints.halo,
                    },
                  })
              : null,
          )}
        />
      </Section>
    </>
  );
}

function NoAssociatedWaypointNote({
  onOpenWaypointsPanel,
}: {
  onOpenWaypointsPanel: () => void;
}) {
  return (
    <div style={panelStyles.noWpBlock}>
      <p style={panelStyles.caption}>This clip has no associated waypoint.</p>
      <button
        type="button"
        onClick={onOpenWaypointsPanel}
        style={panelStyles.switchScopeButton}
        data-testid="open-waypoints-panel"
      >
        Open Waypoints panel
      </button>
    </div>
  );
}

// ---------- POV panel body ------------------------------------------------

function PovPanelBody({
  settings,
  onChange,
  scope,
  overriddenKeys,
  projectSettings,
  projectDir,
  onMarkerUpload,
  markerImporting,
  markerImportError,
  onRequestDeleteImage,
}: {
  settings: MapSettings;
  onChange: (next: MapSettings) => void;
  scope: 'project' | 'clip';
  overriddenKeys: Set<OverridePath> | null;
  projectSettings: MapSettings | null | undefined;
  projectDir: string | null | undefined;
  onMarkerUpload: () => void;
  markerImporting: boolean;
  markerImportError: string | null;
  onRequestDeleteImage: (id: string) => void;
}) {
  const setColor = (hex: string) =>
    onChange({ ...settings, pov: { ...settings.pov, color: hex } });

  // POV's secondary slot is a plain hex (POV is a single point that doesn't
  // sample a gradient). It paints the dot fill / the shape presets'
  // outline slot.
  const setSecondaryColor = (hex: string) =>
    onChange({ ...settings, pov: { ...settings.pov, secondary_color: hex } });

  const setPulseStyle = (pulse_style: PovPulseStyle) =>
    onChange({ ...settings, pov: { ...settings.pov, pulse_style } });

  const setPulseRate = (pulse_rate: PovPulseRate) =>
    onChange({ ...settings, pov: { ...settings.pov, pulse_rate } });

  const setSize = (patch: Partial<MapSettings['pov']['size']>) =>
    onChange({
      ...settings,
      pov: { ...settings.pov, size: { ...settings.pov.size, ...patch } },
    });

  // Effective marker (settings arrive resolved in clip scope, so this is
  // simply the current pov.marker with the dot default applied).
  const povMarker = povMarkerOf(settings.pov);
  const markerValue: MarkerValue =
    povMarker.kind === 'image'
      ? imageMarkerValue(povMarker.image_id)
      : povMarker.shape;
  const isImage = povMarker.kind === 'image';
  const isDot = povMarker.kind === 'shape' && povMarker.shape === 'dot';
  // SDF shape presets follow the waypoint secondary-slot convention: hide
  // the SECONDARY COLOR picker when the slot paints nothing — images
  // (never tinted) and one-color shapes (ring). The dot keeps it (it
  // drives the dot fill).
  const showSecondaryColor =
    !isImage && (isDot || shapeHasSecondary(povMarker.kind === 'shape' ? povMarker.shape : ''));

  // The marker gallery writes `pov.marker` through the normal settings
  // channel in BOTH scopes — in clip scope the parent's
  // `computeClipOverrides` diffs it (deep-equal via `povMarkerEquals`)
  // into `clip.map_overrides.pov.marker`, so per-clip marker swaps land at
  // the cut like every other pov override.
  const setMarker = (next: MarkerValue) => {
    const imageId = imageIdOfMarkerValue(next);
    const marker: PovMarker = imageId
      ? { kind: 'image', image_id: imageId }
      : { kind: 'shape', shape: next as PovMarkerShape };
    onChange({ ...settings, pov: { ...settings.pov, marker } });
  };

  const markerOverridden =
    scope === 'clip' && (overriddenKeys?.has('pov.marker') ?? false);
  const clearMarkerOverride = () =>
    onChange({
      ...settings,
      pov: {
        ...settings.pov,
        marker: projectSettings ? povMarkerOf(projectSettings.pov) : undefined,
      },
    });

  return (
    <>
      {/* MARKER — preset gallery (dot + pov-domain shapes) + the shared
       *  image library + upload tile. The selection replaces the dot as
       *  the marker BODY; the pulse rings are orthogonal and stay for
       *  every marker kind. Per-clip overridable via
       *  `map_overrides.pov.marker`; the image LIBRARY itself stays
       *  project-level (uploads from clip scope write project state). */}
      <Section label="MARKER">
        <MarkerSection
          domain="pov"
          value={markerValue}
          onChange={setMarker}
          markerImages={settings.marker_images}
          projectDir={projectDir}
          onUpload={onMarkerUpload}
          importing={markerImporting}
          onDeleteImage={onRequestDeleteImage}
          uploadError={markerImportError}
          ariaLabel="POV marker"
          testIdPrefix="pov-marker-cell"
          overrideIndicator={
            markerOverridden
              ? { label: 'Clip · override', onClear: clearMarkerOverride }
              : undefined
          }
        />
      </Section>

      <Section label="COLOR">
        <ColorSection value={settings.pov.color} onChange={setColor} />
        {isImage && (
          <p style={panelStyles.caption}>
            With an image marker, color tints the pulse only.
          </p>
        )}
      </Section>

      {/* Secondary color paints the marker's second slot (dot fill / shape
       *  outline) — meaningless while an image draws in its own colors or
       *  a one-color shape (ring) is selected, so the section hides to
       *  avoid the "I changed this and nothing happened" footgun. */}
      {showSecondaryColor && (
        <Section label="SECONDARY COLOR">
          <ColorSection
            value={settings.pov.secondary_color}
            onChange={setSecondaryColor}
          />
        </Section>
      )}

      <Section label="PULSE STYLE">
        <SegmentedPicker<PovPulseStyle>
          value={settings.pov.pulse_style}
          options={PULSE_STYLE_OPTIONS}
          onChange={setPulseStyle}
          title="Pulse animation style"
          ariaLabel="Pulse animation style"
        />
      </Section>

      <Section label="PULSE RATE">
        <SegmentedPicker<PovPulseRate>
          value={settings.pov.pulse_rate}
          options={PULSE_RATE_OPTIONS}
          onChange={setPulseRate}
          title="Pulse rate"
          ariaLabel="Pulse rate"
        />
      </Section>

      <Section label="SIZE">
        {isImage ? (
          <SizeRow
            label="Image size"
            stored={settings.pov.size.image_size}
            onStoredChange={(v) => setSize({ image_size: v })}
          />
        ) : isDot ? (
          <>
            <SizeRow
              label="Dot radius"
              stored={settings.pov.size.dot_radius}
              onStoredChange={(v) => setSize({ dot_radius: v })}
            />
            <SizeRow
              label="Dot stroke"
              stored={settings.pov.size.dot_stroke_width}
              onStoredChange={(v) => setSize({ dot_stroke_width: v })}
            />
          </>
        ) : (
          <>
            {/* SDF shape presets reuse the dot's size fields: radius drives
             *  icon-size, stroke drives the baked outline band. */}
            <SizeRow
              label="Marker radius"
              stored={settings.pov.size.dot_radius}
              onStoredChange={(v) => setSize({ dot_radius: v })}
            />
            <SizeRow
              label="Outline"
              stored={settings.pov.size.dot_stroke_width}
              onStoredChange={(v) => setSize({ dot_stroke_width: v })}
            />
          </>
        )}
        <SizeRow
          label="Pulse start r"
          stored={settings.pov.size.pulse_start_radius}
          onStoredChange={(v) => setSize({ pulse_start_radius: v })}
        />
        <SizeRow
          label="Pulse end r"
          stored={settings.pov.size.pulse_end_radius}
          onStoredChange={(v) => setSize({ pulse_end_radius: v })}
        />
      </Section>

      {/* Solid color only: the POV marker is a single point, nothing to
       *  gradient across. Per-clip overridable like every other POV field
       *  (`map_overrides.pov.halo`, diffed atomically). */}
      <Section label="HALO">
        <HaloControls
          halo={settings.pov.halo}
          seed={DEFAULT_MARKER_HALO}
          onChange={(next) =>
            onChange({ ...settings, pov: { ...settings.pov, halo: next } })
          }
          title="Optional glow painted beneath the POV marker"
          ariaLabel="POV halo"
          colorTestId="pov-halo-color"
          allowGradient={false}
          overrideIndicator={clipOverrideIndicator(
            scope,
            overriddenKeys,
            'pov.halo',
            projectSettings
              ? () =>
                  onChange({
                    ...settings,
                    pov: { ...settings.pov, halo: projectSettings.pov.halo },
                  })
              : null,
          )}
        />
      </Section>
    </>
  );
}

// ---------- Transition panel body -------------------------------------------

const TRAVEL_SYNC_OPTIONS: { value: 'synced' | 'custom'; label: string }[] = [
  { value: 'synced', label: 'Synced' },
  { value: 'custom', label: 'Custom' },
];

/** Ease style roster incl. the 'none' sentinel (absent block). */
type EaseStyleOption = EaseStyle | 'none';
const EASE_STYLE_OPTIONS: { value: EaseStyleOption; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'pop',  label: 'Pop'  },
  { value: 'fade', label: 'Fade' },
  { value: 'grow', label: 'Grow' },
];
const EASE_SPEED_OPTIONS: { value: EaseSpeed; label: string }[] = [
  { value: 'slow',   label: 'Slow'   },
  { value: 'medium', label: 'Medium' },
  { value: 'fast',   label: 'Fast'   },
];

/** One seam-ease editor (EASE IN / EASE OUT share it): a style strip with
 *  the None sentinel, plus a speed strip while a style is chosen. Picking
 *  None removes the block (absent = none). */
function EaseSection({
  label,
  ease,
  onChange,
  ariaLabel,
  caption,
}: {
  label: string;
  ease: SeamEase | undefined;
  onChange: (next: SeamEase | undefined) => void;
  ariaLabel: string;
  caption: string;
}) {
  return (
    <Section label={label}>
      <SegmentedPicker<EaseStyleOption>
        value={ease?.style ?? 'none'}
        options={EASE_STYLE_OPTIONS}
        onChange={(style) =>
          onChange(
            style === 'none'
              ? undefined
              : { style, speed: ease?.speed ?? 'medium' },
          )
        }
        title={caption}
        ariaLabel={ariaLabel}
      />
      {ease && (
        <SegmentedPicker<EaseSpeed>
          value={ease.speed}
          options={EASE_SPEED_OPTIONS}
          onChange={(speed) => onChange({ ...ease, speed })}
          title="Ease duration"
          ariaLabel={`${ariaLabel} speed`}
        />
      )}
      <p style={panelStyles.caption}>{caption}</p>
    </Section>
  );
}

/** One-shot deep-enough copy of a POV style block — the seed for a freshly
 *  unsynced traveling playhead (decoration-linking precedent: copy what the
 *  user currently sees, then diverge). Object leaves are cloned so later
 *  edits to the custom style can never alias the source POV config. */
function clonePovStyle(pov: PovSettings): PovSettings {
  return {
    ...pov,
    size: { ...pov.size },
    marker: pov.marker ? { ...pov.marker } : undefined,
    halo: pov.halo ? { ...pov.halo } : undefined,
  };
}

/** TRANSITION — everything that happens to the playhead at clip seams
 *  (`MapSettings.transition`, one atomic per-clip override blob via
 *  `MapOverrides.transition`). Three stacking layers:
 *
 *  - TRAVEL (nested `transition.travel`; the DESTINATION clip's resolved
 *    value governs the seam INTO it): master on/off, PLAYHEAD show/hide,
 *    DRAW ROUTE on/off (independent toggles), and the synced/custom STYLE
 *    picker (custom exposes the full POV control set on
 *    `travel.playhead`, seeded by copying the current playhead on first
 *    unsync).
 *  - EASE IN / EASE OUT (`transition.ease_in` / `.ease_out`): how this
 *    clip's playhead animates in/out at the seams where it appears and
 *    leaves — anchored at the cut on jump seams, at the style-swap window
 *    edges on traveled seams. Independent of the travel toggle. */
function TransitionPanelBody({
  settings,
  onChange,
  scope,
  overriddenKeys,
  projectSettings,
  projectDir,
  onMarkerUpload,
  markerImporting,
  markerImportError,
  onRequestDeleteImage,
}: {
  settings: MapSettings;
  onChange: (next: MapSettings) => void;
  scope: 'project' | 'clip';
  overriddenKeys: Set<OverridePath> | null;
  projectSettings: MapSettings | null | undefined;
  projectDir: string | null | undefined;
  onMarkerUpload: () => void;
  markerImporting: boolean;
  markerImportError: string | null;
  onRequestDeleteImage: (id: string) => void;
}) {
  const transition = settings.transition;
  const travel = transition?.travel;
  const enabled = travel?.enabled === true;
  // A fully-empty blob collapses back to absent so "everything off" and
  // "never touched" serialize identically (and record no phantom override).
  const setTransition = (next: TransitionSettings | undefined) => {
    const collapsed =
      next &&
      next.travel === undefined &&
      next.ease_in === undefined &&
      next.ease_out === undefined
        ? undefined
        : next;
    onChange({ ...settings, transition: collapsed });
  };
  const setTravel = (nextTravel: TravelSettings) =>
    setTransition({ ...(transition ?? {}), travel: nextTravel });
  const setEnabled = (next: 'off' | 'on') => {
    if (next === 'on') {
      // Flip in place so a previously chosen config (custom style, route
      // toggle) survives an off→on round trip (halo precedent).
      setTravel(travel ? { ...travel, enabled: true } : { enabled: true });
      return;
    }
    if (travel?.enabled) setTravel({ ...travel, enabled: false });
  };
  const setShowPlayhead = (next: 'off' | 'on') => {
    if (travel) setTravel({ ...travel, show_playhead: next === 'on' });
  };
  const setDrawRoute = (next: 'off' | 'on') => {
    if (travel) setTravel({ ...travel, draw_route: next === 'on' });
  };
  const setStyleMode = (next: 'synced' | 'custom') => {
    if (!travel) return;
    if (next === 'synced') {
      // Keep the stored custom style so re-unsyncing restores it (the
      // disabled-halo precedent: config survives the off-toggle).
      setTravel({ ...travel, sync: true });
      return;
    }
    setTravel({
      ...travel,
      sync: false,
      playhead: travel.playhead ?? clonePovStyle(settings.pov),
    });
  };
  const setPlayheadStyle = (nextPov: PovSettings) => {
    if (travel) setTravel({ ...travel, playhead: nextPov });
  };
  const setEaseIn = (next: SeamEase | undefined) =>
    setTransition({ ...(transition ?? {}), ease_in: next });
  const setEaseOut = (next: SeamEase | undefined) =>
    setTransition({ ...(transition ?? {}), ease_out: next });

  const overridden =
    scope === 'clip' && (overriddenKeys?.has('transition') ?? false);
  const clearOverride = () =>
    onChange({
      ...settings,
      transition: projectSettings ? projectSettings.transition : undefined,
    });

  const synced = travel ? travelSync(travel) : true;
  const customStyle = travel?.playhead ?? clonePovStyle(settings.pov);

  return (
    <>
      <Section label="TRAVEL">
        {overridden && projectSettings && (
          <div style={sectionStyles.overridePillRow}>
            <span style={sectionStyles.overridePill}>
              <span style={sectionStyles.overridePillDot} />
              Clip · override
            </span>
            <button
              type="button"
              onClick={clearOverride}
              style={sectionStyles.clearButton}
              title="Reset to project"
              data-testid="transition-clear-override"
            >
              × Reset to project
            </button>
          </div>
        )}
        <SegmentedPicker<'off' | 'on'>
          value={enabled ? 'on' : 'off'}
          options={HALO_TOGGLE_OPTIONS}
          onChange={setEnabled}
          title="Animate the playhead along the route during the transition into this clip"
          ariaLabel="Playhead travel"
        />
        <p style={panelStyles.caption}>
          Travels the route between clips instead of jumping at the cut.
        </p>
      </Section>

      {enabled && travel && (
        <>
          {/* Playhead visibility and route drawing are INDEPENDENT — the
           *  route can draw along the transition with the marker hidden,
           *  and vice versa. */}
          <Section label="PLAYHEAD">
            <SegmentedPicker<'off' | 'on'>
              value={travelShowPlayhead(travel) ? 'on' : 'off'}
              options={HALO_TOGGLE_OPTIONS}
              onChange={setShowPlayhead}
              title="Show the traveling playhead marker during the transition"
              ariaLabel="Traveling playhead"
            />
          </Section>

          <Section label="DRAW ROUTE">
            <SegmentedPicker<'off' | 'on'>
              value={travelDrawRoute(travel) ? 'on' : 'off'}
              options={HALO_TOGGLE_OPTIONS}
              onChange={setDrawRoute}
              title="Draw the route along with the travel (uses the Route decoration's style)"
              ariaLabel="Draw route during travel"
            />
            <p style={panelStyles.caption}>
              Draws the visited route along the transition, even while the
              route decoration is off.
            </p>
          </Section>

          <Section label="STYLE">
            <SegmentedPicker<'synced' | 'custom'>
              value={synced ? 'synced' : 'custom'}
              options={TRAVEL_SYNC_OPTIONS}
              onChange={setStyleMode}
              title="Synced: matches the destination clip's playhead. Custom: style the traveling playhead independently."
              ariaLabel="Traveling playhead style"
            />
            <p style={panelStyles.caption}>
              {synced
                ? 'Matches the destination clip’s playhead exactly.'
                : 'Fully independent style for the traveling playhead.'}
            </p>
          </Section>

          {!synced && (
            <PovStyleControls
              pov={customStyle}
              onPovChange={setPlayheadStyle}
              markerImages={settings.marker_images}
              projectDir={projectDir}
              onMarkerUpload={onMarkerUpload}
              markerImporting={markerImporting}
              markerImportError={markerImportError}
              onRequestDeleteImage={onRequestDeleteImage}
              ariaPrefix="Traveling playhead"
              testIdPrefix="travel-playhead"
            />
          )}
        </>
      )}

      {/* Seam eases — independent of the travel toggle: on jump seams they
       *  anchor at the cut; on traveled seams they soften the style swaps
       *  at the window edges. EASE IN plays where this clip's playhead
       *  appears; EASE OUT where it leaves. */}
      <EaseSection
        label="EASE IN"
        ease={transition?.ease_in}
        onChange={setEaseIn}
        ariaLabel="Playhead ease in"
        caption="Animates the playhead in when this clip arrives."
      />
      <EaseSection
        label="EASE OUT"
        ease={transition?.ease_out}
        onChange={setEaseOut}
        ariaLabel="Playhead ease out"
        caption="Animates the playhead out as this clip ends."
      />
    </>
  );
}

/** The full POV-style control set (marker gallery, colors, pulse, sizes,
 *  halo) bound to ONE PovSettings-shaped value. Used by the Travel panel's
 *  custom traveling-playhead style; mirrors the POV panel's controls minus
 *  the per-leaf override pills (a travel style is one atomic blob — the
 *  TRAVEL section's single pill covers all of it). */
function PovStyleControls({
  pov,
  onPovChange,
  markerImages,
  projectDir,
  onMarkerUpload,
  markerImporting,
  markerImportError,
  onRequestDeleteImage,
  ariaPrefix,
  testIdPrefix,
}: {
  pov: PovSettings;
  onPovChange: (next: PovSettings) => void;
  markerImages: MarkerImageRef[];
  projectDir: string | null | undefined;
  onMarkerUpload: () => void;
  markerImporting: boolean;
  markerImportError: string | null;
  onRequestDeleteImage: (id: string) => void;
  ariaPrefix: string;
  testIdPrefix: string;
}) {
  const marker = povMarkerOf(pov);
  const markerValue: MarkerValue =
    marker.kind === 'image' ? imageMarkerValue(marker.image_id) : marker.shape;
  const isImage = marker.kind === 'image';
  const isDot = marker.kind === 'shape' && marker.shape === 'dot';
  const showSecondaryColor =
    !isImage &&
    (isDot || shapeHasSecondary(marker.kind === 'shape' ? marker.shape : ''));

  const setMarker = (next: MarkerValue) => {
    const imageId = imageIdOfMarkerValue(next);
    const nextMarker: PovMarker = imageId
      ? { kind: 'image', image_id: imageId }
      : { kind: 'shape', shape: next as PovMarkerShape };
    onPovChange({ ...pov, marker: nextMarker });
  };
  const setSize = (patch: Partial<PovSettings['size']>) =>
    onPovChange({ ...pov, size: { ...pov.size, ...patch } });

  return (
    <>
      <Section label="MARKER">
        <MarkerSection
          domain="pov"
          value={markerValue}
          onChange={setMarker}
          markerImages={markerImages}
          projectDir={projectDir}
          onUpload={onMarkerUpload}
          importing={markerImporting}
          onDeleteImage={onRequestDeleteImage}
          uploadError={markerImportError}
          ariaLabel={`${ariaPrefix} marker`}
          testIdPrefix={`${testIdPrefix}-marker-cell`}
          containerTestId={`${testIdPrefix}-marker-section`}
        />
      </Section>

      <Section label="COLOR">
        <ColorSection
          value={pov.color}
          onChange={(hex) => onPovChange({ ...pov, color: hex })}
        />
        {isImage && (
          <p style={panelStyles.caption}>
            With an image marker, color tints the pulse only.
          </p>
        )}
      </Section>

      {showSecondaryColor && (
        <Section label="SECONDARY COLOR">
          <ColorSection
            value={pov.secondary_color}
            onChange={(hex) => onPovChange({ ...pov, secondary_color: hex })}
          />
        </Section>
      )}

      <Section label="PULSE STYLE">
        <SegmentedPicker<PovPulseStyle>
          value={pov.pulse_style}
          options={PULSE_STYLE_OPTIONS}
          onChange={(pulse_style) => onPovChange({ ...pov, pulse_style })}
          title="Pulse animation style"
          ariaLabel={`${ariaPrefix} pulse animation style`}
        />
      </Section>

      <Section label="PULSE RATE">
        <SegmentedPicker<PovPulseRate>
          value={pov.pulse_rate}
          options={PULSE_RATE_OPTIONS}
          onChange={(pulse_rate) => onPovChange({ ...pov, pulse_rate })}
          title="Pulse rate"
          ariaLabel={`${ariaPrefix} pulse rate`}
        />
      </Section>

      <Section label="SIZE">
        {isImage ? (
          <SizeRow
            label="Image size"
            stored={pov.size.image_size}
            onStoredChange={(v) => setSize({ image_size: v })}
          />
        ) : isDot ? (
          <>
            <SizeRow
              label="Dot radius"
              stored={pov.size.dot_radius}
              onStoredChange={(v) => setSize({ dot_radius: v })}
            />
            <SizeRow
              label="Dot stroke"
              stored={pov.size.dot_stroke_width}
              onStoredChange={(v) => setSize({ dot_stroke_width: v })}
            />
          </>
        ) : (
          <>
            <SizeRow
              label="Marker radius"
              stored={pov.size.dot_radius}
              onStoredChange={(v) => setSize({ dot_radius: v })}
            />
            <SizeRow
              label="Outline"
              stored={pov.size.dot_stroke_width}
              onStoredChange={(v) => setSize({ dot_stroke_width: v })}
            />
          </>
        )}
        <SizeRow
          label="Pulse start r"
          stored={pov.size.pulse_start_radius}
          onStoredChange={(v) => setSize({ pulse_start_radius: v })}
        />
        <SizeRow
          label="Pulse end r"
          stored={pov.size.pulse_end_radius}
          onStoredChange={(v) => setSize({ pulse_end_radius: v })}
        />
      </Section>

      <Section label="HALO">
        <HaloControls
          halo={pov.halo}
          seed={DEFAULT_MARKER_HALO}
          onChange={(next) => onPovChange({ ...pov, halo: next })}
          title="Optional glow painted beneath the traveling playhead"
          ariaLabel={`${ariaPrefix} halo`}
          colorTestId={`${testIdPrefix}-halo-color`}
          allowGradient={false}
        />
      </Section>
    </>
  );
}

// ---------- shared building blocks ----------------------------------------

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={panelStyles.section}>
      <div style={panelStyles.sectionHeader}>
        <span style={panelStyles.sectionLabel}>{label}</span>
      </div>
      <div style={panelStyles.sectionBody}>{children}</div>
    </div>
  );
}

function SizeRow({
  label,
  stored,
  onStoredChange,
}: {
  /** Display label shown to the left of the stepper. */
  label: string;
  /** Stored value (fraction of `PAINT_REFERENCE_WIDTH`). */
  stored: number;
  /** Receives a new stored fraction. */
  onStoredChange: (next: number) => void;
}) {
  const displayed = stored * PAINT_REFERENCE_WIDTH;
  return (
    <div style={panelStyles.sizeRow}>
      <span style={panelStyles.sizeRowLabel}>{label}</span>
      <NumberStepper
        value={displayed}
        min={0.5}
        max={120}
        step={0.5}
        unit="px"
        decimals={1}
        onChange={(v) => onStoredChange(v / PAINT_REFERENCE_WIDTH)}
      />
    </div>
  );
}

/** Label + percent stepper. Stores a 0–1 fraction, displays 0–100%. Used by
 *  the halo's Fade and Opacity controls. */
function PercentRow({
  label,
  value,
  onChange,
}: {
  label: string;
  /** Stored fraction in [0, 1]. */
  value: number;
  /** Receives the new stored fraction. */
  onChange: (next: number) => void;
}) {
  return (
    <div style={panelStyles.sizeRow}>
      <span style={panelStyles.sizeRowLabel}>{label}</span>
      <NumberStepper
        value={Math.round(value * 100)}
        min={0}
        max={100}
        step={5}
        unit="%"
        decimals={0}
        onChange={(v) => onChange(v / 100)}
      />
    </div>
  );
}

/** Label + signed px stepper for the halo drop-shadow offset. Same
 *  fraction-of-`PAINT_REFERENCE_WIDTH` storage convention as `SizeRow`,
 *  but symmetric around 0 (positive = right / down in screen space). */
function OffsetRow({
  label,
  stored,
  onStoredChange,
}: {
  label: string;
  /** Stored value (signed fraction of `PAINT_REFERENCE_WIDTH`). */
  stored: number;
  /** Receives a new stored fraction. */
  onStoredChange: (next: number) => void;
}) {
  const displayed = stored * PAINT_REFERENCE_WIDTH;
  return (
    <div style={panelStyles.sizeRow}>
      <span style={panelStyles.sizeRowLabel}>{label}</span>
      <NumberStepper
        value={displayed}
        min={-120}
        max={120}
        step={0.5}
        unit="px"
        decimals={1}
        onChange={(v) => onStoredChange(v / PAINT_REFERENCE_WIDTH)}
      />
    </div>
  );
}

/** Shared halo control block — one component for all three decorations
 *  (Route / Waypoints / POV) so the halo parameter surface can't drift
 *  between panels. Owns the on/off toggle (first enable seeds `seed`;
 *  disable flips `enabled` in place so the user's config survives a round
 *  trip), the color picker (gradient-capable where the decoration supports
 *  distance gradients; POV passes `allowGradient: false` per the "single
 *  point, nothing to gradient across" rule), and the numeric rows:
 *  Spread / Fade / Falloff / Opacity / Offset X / Offset Y. `falloff` and
 *  the offsets are optional on persisted blocks (pre-falloff projects) —
 *  they read as 0 here and are written explicitly on first edit. */
function HaloControls({
  halo,
  seed,
  onChange,
  title,
  ariaLabel,
  colorTestId,
  allowGradient,
  gradientAvailable,
  waypointProgress,
  totalDistMeters,
  overrideIndicator,
}: {
  halo: HaloSettings | undefined;
  seed: HaloSettings;
  onChange: (next: HaloSettings) => void;
  title: string;
  ariaLabel: string;
  colorTestId: string;
  allowGradient: boolean;
  gradientAvailable?: boolean;
  waypointProgress?: number[];
  totalDistMeters?: number;
  /** Clip-scope override pill + reset — covers the WHOLE halo block (the
   *  override is one atomic `HaloSettings` leaf, not per-field). Rendered
   *  above the on/off toggle with the same pill/clear look as
   *  `ColorSection`'s indicator. */
  overrideIndicator?: { label: string; onClear: () => void };
}) {
  const enabled = halo?.enabled === true;

  const setEnabled = (next: 'off' | 'on') => {
    if (next === 'on') {
      onChange(halo ? { ...halo, enabled: true } : { ...seed });
      return;
    }
    if (halo && halo.enabled) onChange({ ...halo, enabled: false });
  };

  const setSolidColor = (hex: string) => {
    if (!halo) return;
    onChange({ ...halo, color: { mode: 'solid', solid: hex } });
  };

  const setGradientStops = (stops: GradientStop[]) => {
    if (!halo) return;
    onChange({ ...halo, color: { mode: 'gradient', stops } });
  };

  // Same stash/restore contract as the decoration colors' mode toggles,
  // against the halo's own `color_stops_cache`.
  const setColorMode = (nextMode: 'solid' | 'gradient') => {
    if (!halo) return;
    if (nextMode === 'solid') {
      if (halo.color.mode === 'gradient') {
        const stops = halo.color.stops;
        onChange({
          ...halo,
          color: { mode: 'solid', solid: stops[0]?.color ?? '#ffffff' },
          color_stops_cache: cloneStops(stops),
        });
      }
      return;
    }
    const solidNow = halo.color.mode === 'solid' ? halo.color.solid : '#ffffff';
    const stops =
      halo.color_stops_cache && halo.color_stops_cache.length >= 2
        ? cloneStops(halo.color_stops_cache)
        : initialGradientFromSolid(solidNow);
    onChange({ ...halo, color: { mode: 'gradient', stops } });
  };

  const solid = halo ? readSolid(halo.color) : '#ffffff';
  const colorMode: 'solid' | 'gradient' =
    halo?.color.mode === 'gradient' ? 'gradient' : 'solid';
  const gradientStops =
    halo?.color.mode === 'gradient' ? halo.color.stops : undefined;

  return (
    <>
      {overrideIndicator && (
        <div style={sectionStyles.overridePillRow}>
          <span style={sectionStyles.overridePill}>
            <span style={sectionStyles.overridePillDot} />
            {overrideIndicator.label}
          </span>
          <button
            type="button"
            onClick={overrideIndicator.onClear}
            style={sectionStyles.clearButton}
            title="Reset to project"
          >
            × Reset to project
          </button>
        </div>
      )}
      <SegmentedPicker<'off' | 'on'>
        value={enabled ? 'on' : 'off'}
        options={HALO_TOGGLE_OPTIONS}
        onChange={setEnabled}
        title={title}
        ariaLabel={ariaLabel}
      />
      {enabled && halo && (
        <>
          {/* Scoping wrapper: ColorSection's internal testids are static,
              and the host panel's COLOR section mounts its own instance —
              tests disambiguate via within(). */}
          <div data-testid={colorTestId}>
            {allowGradient ? (
              <ColorSection
                value={solid}
                onChange={setSolidColor}
                mode={colorMode}
                onModeChange={setColorMode}
                gradientAvailable={gradientAvailable}
                gradientStops={gradientStops}
                onGradientStopsChange={setGradientStops}
                waypointProgress={waypointProgress}
                totalDistMeters={totalDistMeters}
              />
            ) : (
              <ColorSection value={solid} onChange={setSolidColor} />
            )}
          </div>
          <SizeRow
            label="Spread"
            stored={halo.size}
            onStoredChange={(size) => onChange({ ...halo, size })}
          />
          <PercentRow
            label="Fade"
            value={halo.fade}
            onChange={(fade) => onChange({ ...halo, fade })}
          />
          <PercentRow
            label="Falloff"
            value={halo.falloff ?? 0}
            onChange={(falloff) => onChange({ ...halo, falloff })}
          />
          <PercentRow
            label="Opacity"
            value={halo.opacity}
            onChange={(opacity) => onChange({ ...halo, opacity })}
          />
          <OffsetRow
            label="Offset X"
            stored={halo.offset_x ?? 0}
            onStoredChange={(offset_x) => onChange({ ...halo, offset_x })}
          />
          <OffsetRow
            label="Offset Y"
            stored={halo.offset_y ?? 0}
            onStoredChange={(offset_y) => onChange({ ...halo, offset_y })}
          />
        </>
      )}
    </>
  );
}

// ---------- helpers --------------------------------------------------------

/** Clip-scope override pill descriptor for a MapSettings-level override
 *  leaf. Returns undefined in project scope, when the leaf isn't overridden,
 *  or when no reset write-back is available (no `projectSettings`) — the
 *  control then renders with no pill, exactly like project scope. */
function clipOverrideIndicator(
  scope: 'project' | 'clip',
  overriddenKeys: Set<OverridePath> | null,
  path: OverridePath,
  onClear: (() => void) | null,
): { label: string; onClear: () => void } | undefined {
  if (scope !== 'clip' || onClear == null) return undefined;
  if (!overriddenKeys?.has(path)) return undefined;
  return { label: 'Clip · override', onClear };
}

function readSolid(color: DecorationColor): string {
  if (color.mode === 'solid') return color.solid.toLowerCase();
  // Gradient mode at Step 6 → fall back to first stop's color; writes flip
  // back to a solid arm in the parent setter, so this is read-only here.
  return (color.stops[0]?.color ?? '#bced09').toLowerCase();
}

function omitColor(wp: Waypoint): Waypoint {
  const next: Waypoint = { ...wp };
  delete (next as { color?: string }).color;
  return next;
}

function omitSecondaryColor(wp: Waypoint): Waypoint {
  const next: Waypoint = { ...wp };
  delete (next as { secondary_color?: string }).secondary_color;
  return next;
}

function omitShape(wp: Waypoint): Waypoint {
  const next: Waypoint = { ...wp };
  delete (next as { shape?: WaypointShape }).shape;
  return next;
}

function omitMarkerImage(wp: Waypoint): Waypoint {
  const next: Waypoint = { ...wp };
  delete (next as { marker_image_id?: string }).marker_image_id;
  return next;
}

/** Per-waypoint Web Mercator progress fractions in [0, 1]. Used as snap
 *  ticks on the gradient bar and as dot positions on the trail preview SVG.
 *  Wall-clock-anchored waypoints get a real `progressUpTo` value;
 *  fixed-position waypoints fall back to 0 because they have no defined
 *  route progress. Matches the convention in `buildWaypointsCollection`
 *  so editor previews and rendered dot colors agree at the same fraction.
 *
 *  Memoized cheaply by referential identity of the inputs — a fresh array
 *  is created on every render, but the consumer (`GradientEditor`) only
 *  reads the contents, not the array identity. */
function useWaypointProgress(
  waypoints: Waypoint[],
  indexedRoute: IndexedRoute | null,
): number[] {
  if (!indexedRoute) return [];
  return waypoints.map((wp) => {
    if (wp.position.kind === 'wall_clock_ms') {
      return progressUpTo(wp.position.ms, indexedRoute);
    }
    return 0;
  });
}

