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
// Step 7 adds the `[Solid][Gradient]` toggle for Route and Waypoints in
// project scope. Gradient mode reads/writes
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
import { ShapeSection } from '../ShapeSection';
import { panelStyles } from './styles';
import { shapeHasSecondary } from '../../../lib/mapVisuals';
import {
  type ActiveWaypointMode,
  type Clip,
  type DecorationColor,
  type GradientStop,
  type MapSettings,
  type OverridePath,
  type PovPulseStyle,
  type PovPulseRate,
  type TriMode,
  type Waypoint,
  type WaypointLabelMode,
  type WaypointShape,
} from '../../../types';
import type { IndexedRoute } from '../../../lib/routeLocation';
import { progressUpTo } from '../../../lib/routeLocation';

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

export type DecorationKind = 'route' | 'waypoints' | 'pov';
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
}

export function DecorationPanel({
  decoration,
  settings,
  onChange,
  scope,
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
}: DecorationPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
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
    route:     'ROUTE',
    waypoints: 'WAYPOINTS',
    pov:       'POV',
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
            onScopeChange={onScopeChange}
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
            routeLoaded={routeLoaded}
            currentClip={currentClip}
            waypoints={waypoints}
            onWaypointsChange={onWaypointsChange}
            onOpenWaypointsPanel={onOpenWaypointsPanel}
            indexedRoute={indexedRoute}
          />
        )}

        {decoration === 'pov' && (
          <PovPanelBody
            settings={settings}
            onChange={onChange}
          />
        )}
      </div>

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
  onScopeChange,
  routeLoaded,
  waypoints,
  indexedRoute,
}: {
  settings: MapSettings;
  onChange: (next: MapSettings) => void;
  scope: 'project' | 'clip';
  onScopeChange: (scope: 'project' | 'clip') => void;
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
        {scope === 'clip' ? (
          <RouteColorReadOnly
            value={currentSolid}
            onSwitchToProject={() => onScopeChange('project')}
          />
        ) : (
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
          />
        )}
      </Section>

      <Section label="SIZE">
        <SizeRow
          label="Line"
          stored={settings.route.size.width}
          onStoredChange={setRouteLineWidth}
        />
      </Section>
    </>
  );
}

function RouteColorReadOnly({
  value,
  onSwitchToProject,
}: {
  value: string;
  onSwitchToProject: () => void;
}) {
  return (
    <div style={panelStyles.readOnlyBlock}>
      <div style={panelStyles.readOnlyHeader}>
        <span style={panelStyles.readOnlyTag}>PROJECT</span>
      </div>
      <ColorSection value={value} onChange={() => undefined} disabled />
      <p style={panelStyles.readOnlyNote}>Route color is set project-wide.</p>
      <button
        type="button"
        onClick={onSwitchToProject}
        style={panelStyles.switchScopeButton}
        data-testid="route-switch-to-project"
      >
        Switch to Project scope →
      </button>
    </div>
  );
}

// ---------- Waypoints panel body ------------------------------------------

function WaypointsPanelBody({
  settings,
  onChange,
  scope,
  routeLoaded,
  currentClip,
  waypoints,
  onWaypointsChange,
  onOpenWaypointsPanel,
  indexedRoute,
}: {
  settings: MapSettings;
  onChange: (next: MapSettings) => void;
  scope: 'project' | 'clip';
  routeLoaded: boolean;
  currentClip: Clip | null;
  waypoints: Waypoint[];
  onWaypointsChange: (next: Waypoint[]) => void;
  onOpenWaypointsPanel: () => void;
  indexedRoute: IndexedRoute | null;
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

  // Project-default shape setter — writes through `onChange` (MapSettings).
  const setProjectShape = (shape: WaypointShape) =>
    onChange({ ...settings, waypoints: { ...settings.waypoints, shape } });

  // Clip-scope shape setter — writes `Waypoint.shape` on the associated
  // entity via `onWaypointsChange`. Same pattern as `setWaypointColor`.
  // Per the v8 contract, shape overrides live on the Waypoint, never on
  // `clip.map_overrides` (`MapOverrides.waypoints` has no `shape` field).
  const setWaypointShape = (shape: WaypointShape) => {
    if (!associatedWaypoint) return;
    const nextWaypoints = waypoints.map((w) =>
      w.id === associatedWaypoint.id ? { ...w, shape } : w,
    );
    onWaypointsChange(nextWaypoints);
  };

  const clearWaypointShape = () => {
    if (!associatedWaypoint) return;
    const nextWaypoints = waypoints.map((w) =>
      w.id === associatedWaypoint.id ? omitShape(w) : w,
    );
    onWaypointsChange(nextWaypoints);
  };

  const projectSolid = readSolid(settings.waypoints.color);
  const projectSecondarySolid = readSolid(settings.waypoints.secondary_color);
  const waypointColor = associatedWaypoint?.color ?? projectSolid;
  const waypointSecondaryColorValue =
    associatedWaypoint?.secondary_color ?? projectSecondarySolid;

  // Effective shape — the shape the gallery shows as selected. In clip
  // scope, the per-Waypoint override wins; in project scope (or when there
  // is no associated waypoint) we fall back to the project default.
  // Gates the SECONDARY COLOR section: shapes whose descriptor has no
  // `secondary` rasterizer (today: `ring`) hide the secondary picker so
  // editing a color that paints nothing isn't possible.
  const effectiveShape: WaypointShape =
    scope === 'clip'
      ? (associatedWaypoint?.shape ?? settings.waypoints.shape)
      : settings.waypoints.shape;
  const showSecondaryColor = shapeHasSecondary(effectiveShape);

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
        {scope === 'project' ? (
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
          />
        ) : associatedWaypoint ? (
          <>
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
            <p style={panelStyles.caption}>
              Per-waypoint overrides are solid-color only.
            </p>
          </>
        ) : (
          <NoAssociatedWaypointNote onOpenWaypointsPanel={onOpenWaypointsPanel} />
        )}
      </Section>

      {showSecondaryColor && (
        <Section label="SECONDARY COLOR">
          {scope === 'project' ? (
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
            />
          ) : associatedWaypoint ? (
            <>
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
              <p style={panelStyles.caption}>
                Per-waypoint secondary overrides are solid-color only.
              </p>
            </>
          ) : (
            <NoAssociatedWaypointNote onOpenWaypointsPanel={onOpenWaypointsPanel} />
          )}
        </Section>
      )}

      <Section label="SHAPE">
        {scope === 'project' ? (
          <ShapeSection value={settings.waypoints.shape} onChange={setProjectShape} />
        ) : associatedWaypoint ? (
          <ShapeSection
            value={effectiveShape}
            onChange={setWaypointShape}
            overrideIndicator={
              associatedWaypoint.shape !== undefined && associatedOrdinal != null
                ? {
                    label: `Wp ${associatedOrdinal} · override`,
                    onClear: clearWaypointShape,
                  }
                : undefined
            }
          />
        ) : (
          <NoAssociatedWaypointNote onOpenWaypointsPanel={onOpenWaypointsPanel} />
        )}
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
}: {
  settings: MapSettings;
  onChange: (next: MapSettings) => void;
}) {
  const setColor = (hex: string) =>
    onChange({ ...settings, pov: { ...settings.pov, color: hex } });

  // POV's secondary slot is a plain hex (POV is a single point that doesn't
  // sample a gradient). Today this drives the `live-marker-dot` fill that
  // used to be hard-coded white.
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

  return (
    <>
      <Section label="COLOR">
        <ColorSection value={settings.pov.color} onChange={setColor} />
      </Section>

      <Section label="SECONDARY COLOR">
        <ColorSection
          value={settings.pov.secondary_color}
          onChange={setSecondaryColor}
        />
      </Section>

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

// ---------- helpers --------------------------------------------------------

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

