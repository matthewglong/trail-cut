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

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import ModePicker from '../../ModePicker';
import NumberStepper from '../../NumberStepper';
import { ColorSection } from '../ColorSection';
import {
  cloneStops,
  initialGradientFromSolid,
} from '../ColorSection/gradientMath';
import { panelStyles } from './styles';
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
} from '../../../types';
import type { IndexedRoute } from '../../../lib/routeLocation';
import { progressUpTo } from '../../../lib/routeLocation';

/** Canonical width used for `× 1080` display conversion. Same constant the
 *  rendering pipeline calls `PAINT_REFERENCE_WIDTH` (1080 CSS px). */
const PAINT_REFERENCE_WIDTH = 1080;

const TRI_OPTIONS: { value: TriMode; label: string; short: string }[] = [
  { value: 'none',    label: 'None',    short: 'N' },
  { value: 'visited', label: 'Visited', short: 'V' },
  { value: 'full',    label: 'Full',    short: 'F' },
];

const LABEL_MODE_OPTIONS: { value: WaypointLabelMode; label: string; short: string }[] = [
  { value: 'numbered', label: 'Numbered', short: '#' },
  { value: 'labeled',  label: 'Labeled',  short: 'A' },
];

const ACTIVE_WAYPOINT_OPTIONS: { value: ActiveWaypointMode; label: string; short: string }[] = [
  { value: 'none',          label: 'None',   short: 'N' },
  { value: 'latest_passed', label: 'Latest', short: 'L' },
];

const PULSE_STYLE_OPTIONS: { value: PovPulseStyle; label: string; short: string }[] = [
  { value: 'steady',    label: 'Steady',    short: 'St' },
  { value: 'throb',     label: 'Throb',     short: 'Th' },
  { value: 'sonar',     label: 'Sonar',     short: 'So' },
  { value: 'heartbeat', label: 'Heartbeat', short: 'Hb' },
];

const PULSE_RATE_OPTIONS: { value: PovPulseRate; label: string; short: string }[] = [
  { value: 'slow',   label: 'Slow',   short: 'Sl' },
  { value: 'medium', label: 'Medium', short: 'Md' },
  { value: 'fast',   label: 'Fast',   short: 'Fs' },
];

export type DecorationKind = 'route' | 'waypoints' | 'pov';

export interface DecorationPanelProps {
  decoration: DecorationKind;
  settings: MapSettings;
  onChange: (next: MapSettings) => void;
  scope: 'project' | 'clip';
  overriddenKeys: Set<OverridePath> | null;
  onScopeChange: (scope: 'project' | 'clip') => void;
  onClose: () => void;
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
}: DecorationPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Click-outside to close.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [onClose, triggerRef]);

  // Escape to close — returns focus to trigger.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, triggerRef]);

  // Boundary check: if `left: 0` would overflow the window, anchor to right.
  const panelPlacement = useAnchorSide(triggerRef);

  const titleByDecoration: Record<DecorationKind, string> = {
    route:     'ROUTE',
    waypoints: 'WAYPOINTS',
    pov:       'POV',
  };

  return (
    <div
      ref={panelRef}
      style={{
        ...panelStyles.panel,
        ...(panelPlacement === 'right' ? panelStyles.panelAnchorRight : panelStyles.panelAnchorLeft),
      }}
      role="dialog"
      aria-label={`${decoration} decoration panel`}
      data-testid={`decoration-panel-${decoration}`}
    >
      <div style={panelStyles.titleRow}>
        <span style={panelStyles.title}>{titleByDecoration[decoration]}</span>
      </div>

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
  );
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
        <ModePicker<TriMode>
          value={settings.route.mode}
          options={TRI_OPTIONS}
          onChange={setMode}
          disabledValues={routeLoaded ? [] : ['visited']}
          title={routeLoaded ? 'Route line mode' : 'Import a GPX route to enable visited mode'}
          minWidth={68}
          variant="full"
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
          label="Full line"
          stored={settings.route.size.full_width}
          onStoredChange={(v) => setSize({ full_width: v })}
        />
        <SizeRow
          label="Trail line"
          stored={settings.route.size.trail_width}
          onStoredChange={(v) => setSize({ trail_width: v })}
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

  const projectSolid = readSolid(settings.waypoints.color);
  const waypointColor = associatedWaypoint?.color ?? projectSolid;

  const waypointsColorMode: 'solid' | 'gradient' =
    settings.waypoints.color.mode === 'gradient' ? 'gradient' : 'solid';
  const waypointsGradientStops =
    settings.waypoints.color.mode === 'gradient'
      ? settings.waypoints.color.stops
      : undefined;
  const waypointProgress = useWaypointProgress(waypoints, indexedRoute);
  const totalDistMeters = indexedRoute?.totalDistMeters ?? 0;
  const waypointsGradientAvailable =
    routeLoaded && (indexedRoute?.totalMercatorMeters ?? 0) > 0;

  return (
    <>
      <Section label="VISIBILITY">
        <ModePicker<TriMode>
          value={settings.waypoints.mode}
          options={TRI_OPTIONS}
          onChange={setMode}
          disabledValues={routeLoaded ? [] : ['visited']}
          title="Waypoint visibility"
          minWidth={68}
          variant="full"
        />
      </Section>

      <Section label="LABEL MODE">
        <ModePicker<WaypointLabelMode>
          value={settings.waypoints.label_mode}
          options={LABEL_MODE_OPTIONS}
          onChange={setLabelMode}
          title="Waypoint label render mode"
          minWidth={76}
          variant="full"
        />
      </Section>

      <Section label="ACTIVE MODE">
        <ModePicker<ActiveWaypointMode>
          value={settings.waypoints.active_mode}
          options={ACTIVE_WAYPOINT_OPTIONS}
          onChange={setActiveMode}
          title="Active-waypoint highlight strategy"
          minWidth={72}
          variant="full"
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

      <Section label="PULSE">
        <div style={panelStyles.pulseRow}>
          <ModePicker<PovPulseStyle>
            value={settings.pov.pulse_style}
            options={PULSE_STYLE_OPTIONS}
            onChange={setPulseStyle}
            title="Pulse animation style"
            minWidth={92}
            variant="full"
          />
          <ModePicker<PovPulseRate>
            value={settings.pov.pulse_rate}
            options={PULSE_RATE_OPTIONS}
            onChange={setPulseRate}
            title="Pulse rate"
            minWidth={80}
            variant="full"
          />
        </div>
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
        max={30}
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

/** Decide whether the panel should anchor to its trigger's left or right
 *  edge. Measured in a layout effect so the read happens after the trigger
 *  is in the DOM but before the browser paints. The synchronous `setSide`
 *  is intentional — same pattern `ModePicker` uses for its anchor read. */
function useAnchorSide(
  triggerRef: React.RefObject<HTMLButtonElement | null>,
): 'left' | 'right' {
  const PANEL_WIDTH = 280;
  const [side, setSide] = useState<'left' | 'right'>('left');
  useLayoutEffect(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSide(rect.left + PANEL_WIDTH > window.innerWidth ? 'right' : 'left');
  }, [triggerRef]);
  return side;
}
