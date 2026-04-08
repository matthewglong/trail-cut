import { Route as RouteIcon, MapPin, LocateFixed, Layers } from 'lucide-react';
import CollapsibleToolbar from '../CollapsibleToolbar';
import ModePicker from '../ModePicker';
import type { MapSettings, MapStyleId, TriMode } from '../../types';
import { styles } from './styles';

interface MapToolbarProps {
  settings: MapSettings;
  onChange: (next: MapSettings) => void;
  /** Whether a GPX route is loaded — disables the visited option when false. */
  routeLoaded: boolean;
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

export default function MapToolbar({ settings, onChange, routeLoaded }: MapToolbarProps) {
  const followOn = settings.follow_playhead;

  const collapsedContent = (
    <div style={styles.chipRow}>
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
    </div>
  );

  return (
    <CollapsibleToolbar collapsedContent={collapsedContent} contentGap={4}>
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
        />
      </div>

      <div style={styles.separator} />

      {/* Follow playhead */}
      <div style={styles.group}>
        <span style={styles.groupLabel} title="Follow playhead">
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
        />
      </div>
    </CollapsibleToolbar>
  );
}
