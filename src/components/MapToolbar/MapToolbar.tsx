import { Route as RouteIcon, MapPin, LocateFixed, Layers, ZoomIn } from 'lucide-react';
import CollapsibleToolbar from '../CollapsibleToolbar';
import ModePicker from '../ModePicker';
import NumberStepper from '../NumberStepper';
import type { MapSettings, MapStyleId, TriMode, MapOverrides } from '../../types';
import { colors } from '../../theme/tokens';
import { styles } from './styles';

export type MapToolbarScope = 'project' | 'clip';

interface MapToolbarProps {
  settings: MapSettings;
  onChange: (next: MapSettings) => void;
  /** Whether a GPX route is loaded — disables the visited option when false. */
  routeLoaded: boolean;
  /** Current editing scope. */
  scope: MapToolbarScope;
  onScopeChange: (scope: MapToolbarScope) => void;
  /** Which fields the current clip overrides (non-null keys). Null when scope is 'project'. */
  overriddenKeys: Set<keyof MapSettings> | null;
}

const TRI_OPTIONS: { value: TriMode; label: string; short: string }[] = [
  { value: 'none', label: 'None', short: 'N' },
  { value: 'visited', label: 'Visited', short: 'V' },
  { value: 'full', label: 'Full', short: 'F' },
];

const STYLE_OPTIONS: { value: MapStyleId; label: string; short: string }[] = [
  { value: 'default', label: 'Default', short: 'D' },
  { value: '3d', label: '3D', short: '3D' },
  { value: 'satellite', label: 'Satellite', short: 'S' },
];

const styleLabel = (s: MapStyleId) =>
  s === 'default' ? 'Default' : s === '3d' ? '3D' : 'Satellite';

const labelFor = (m: TriMode) =>
  m === 'none' ? 'None' : m === 'visited' ? 'Visited' : 'Full';

export default function MapToolbar({
  settings,
  onChange,
  routeLoaded,
  scope,
  onScopeChange,
  overriddenKeys,
}: MapToolbarProps) {
  const followOn = settings.follow_playhead;

  /** Accent color when the given field is overridden by the current clip,
   *  undefined (default icon color) otherwise. Spacing stays constant because
   *  only the color toggles — no element is added or removed. */
  const overrideColor = (field: keyof MapSettings): string | undefined =>
    overriddenKeys?.has(field) ? colors.accent : undefined;

  const collapsedContent = (
    <div style={styles.chipRow}>
      <ScopeToggle scope={scope} onScopeChange={onScopeChange} />
      <span style={styles.divider} />
      <span style={settings.route_mode === 'none' ? styles.chip : styles.chipAccent}>
        Route: {labelFor(settings.route_mode)}
      </span>
      <span style={styles.divider} />
      <span style={settings.waypoints_mode === 'none' ? styles.chip : styles.chipAccent}>
        Waypoints: {labelFor(settings.waypoints_mode)}
      </span>
      <span style={styles.divider} />
      <span style={followOn ? styles.chipAccent : styles.chip}>
        {followOn ? 'Following' : 'Free pan'}
      </span>
      <span style={styles.divider} />
      <span style={styles.chipAccent}>Style: {styleLabel(settings.map_style)}</span>
      <span style={styles.divider} />
      <span style={styles.chipAccent}>Zoom: {settings.zoom.toFixed(1)}</span>
    </div>
  );

  const barTint = scope === 'project'
    ? styles.barTintProject
    : styles.barTintClip;

  return (
    <CollapsibleToolbar collapsedContent={collapsedContent} contentGap={4} barStyle={barTint}>
      {/* Scope toggle */}
      <ScopeToggle scope={scope} onScopeChange={onScopeChange} />

      {/* Route mode */}
      <div style={styles.group}>
        <ModePicker<TriMode>
          value={settings.route_mode}
          options={TRI_OPTIONS}
          onChange={(v) => onChange({ ...settings, route_mode: v })}
          disabledValues={routeLoaded ? [] : ['visited']}
          title={routeLoaded ? 'Route line mode' : 'Import a GPX route to enable visited mode'}
          minWidth={68}
          icon={<RouteIcon size={15} strokeWidth={2} />}
          variant="minimal"
          iconColor={overrideColor('route_mode')}
        />
      </div>

      <div style={styles.separator} />

      {/* Waypoints */}
      <div style={styles.group}>
        <ModePicker<TriMode>
          value={settings.waypoints_mode}
          options={TRI_OPTIONS}
          onChange={(v) => onChange({ ...settings, waypoints_mode: v })}
          title="Clip waypoint visibility"
          minWidth={68}
          icon={<MapPin size={15} strokeWidth={2} />}
          variant="minimal"
          iconColor={overrideColor('waypoints_mode')}
        />
      </div>

      <div style={styles.separator} />

      {/* Follow playhead */}
      <div style={styles.group}>
        <span
          style={{ ...styles.groupLabel, color: overrideColor('follow_playhead') ?? styles.groupLabel.color, transition: 'color 0.15s ease' }}
          title="Follow playhead"
        >
          <LocateFixed size={15} strokeWidth={2} />
        </span>
        <div
          onClick={() => onChange({ ...settings, follow_playhead: !followOn })}
          style={followOn ? styles.previewPillOn : styles.previewPillOff}
          title={followOn ? 'Map follows playhead — click to pan freely' : 'Free pan — click to follow playhead'}
        >
          <span style={followOn ? styles.previewDotOn : styles.previewDotOff} />
          <span>FOLLOW</span>
        </div>
      </div>

      <div style={styles.separator} />

      {/* Zoom (default zoom applied when entering a clip) */}
      <div style={styles.group}>
        <span
          style={{ ...styles.groupLabel, color: overrideColor('zoom') ?? styles.groupLabel.color, transition: 'color 0.15s ease' }}
          title="Default zoom level applied when entering a clip"
        >
          <ZoomIn size={15} strokeWidth={2} />
        </span>
        <NumberStepper
          value={settings.zoom}
          min={1}
          max={20}
          step={0.5}
          unit=""
          onChange={(v) => onChange({ ...settings, zoom: v })}
        />
      </div>

      <div style={styles.separator} />

      {/* Map style */}
      <div style={styles.group}>
        <ModePicker<MapStyleId>
          value={settings.map_style}
          options={STYLE_OPTIONS}
          onChange={(v) => onChange({ ...settings, map_style: v })}
          title="Base map style"
          minWidth={76}
          icon={<Layers size={15} strokeWidth={2} />}
          variant="minimal"
          iconColor={overrideColor('map_style')}
        />
      </div>
    </CollapsibleToolbar>
  );
}

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
      {/* Back bracket (leftmost, smaller, open path) */}
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
      {/* Middle bracket (slightly smaller than front, open path) */}
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
      {/* Front frame (complete, filled to occlude) */}
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

function ScopeToggle({ scope, onScopeChange }: {
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
