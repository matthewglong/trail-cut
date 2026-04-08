import { Route as RouteIcon, MapPin, LocateFixed } from 'lucide-react';
import CollapsibleToolbar from '../CollapsibleToolbar';
import type { MapSettings } from '../../types';
import { styles } from './styles';

interface MapToolbarProps {
  settings: MapSettings;
  onChange: (next: MapSettings) => void;
  /** Whether a GPX route is loaded — disables the trail toggle when false. */
  routeLoaded: boolean;
}

export default function MapToolbar({ settings, onChange, routeLoaded }: MapToolbarProps) {
  const trailOn = settings.route_mode === 'trail';
  const waypointsOn = settings.show_waypoints;
  const followOn = settings.follow_playhead;

  const collapsedContent = (
    <div style={styles.chipRow}>
      <span style={trailOn ? styles.chipAccent : styles.chip}>
        {trailOn ? 'Trail' : 'Full route'}
      </span>
      <span style={styles.divider} />
      <span style={waypointsOn ? styles.chipAccent : styles.chip}>
        {waypointsOn ? 'Waypoints on' : 'Waypoints off'}
      </span>
      <span style={styles.divider} />
      <span style={followOn ? styles.chipAccent : styles.chip}>
        {followOn ? 'Following' : 'Free pan'}
      </span>
    </div>
  );

  const Pill = ({
    on,
    onClick,
    label,
    title,
    disabled,
  }: { on: boolean; onClick: () => void; label: string; title: string; disabled?: boolean }) => (
    <div
      onClick={disabled ? undefined : onClick}
      style={{
        ...(on ? styles.previewPillOn : styles.previewPillOff),
        ...(disabled ? styles.pillDisabled : null),
      }}
      title={title}
    >
      <span style={on ? styles.previewDotOn : styles.previewDotOff} />
      <span>{label}</span>
    </div>
  );

  return (
    <CollapsibleToolbar collapsedContent={collapsedContent}>
      {/* Route mode */}
      <div style={styles.group}>
        <span style={styles.groupLabel} title="Route mode">
          <RouteIcon size={15} strokeWidth={2} />
        </span>
        <Pill
          on={trailOn}
          onClick={() => onChange({ ...settings, route_mode: trailOn ? 'full' : 'trail' })}
          label="TRAIL"
          title={
            !routeLoaded
              ? 'Import a GPX route to enable the slime trail'
              : trailOn
                ? 'Showing trail to playhead — click for full route'
                : 'Showing full route — click for slime trail'
          }
          disabled={!routeLoaded}
        />
      </div>

      <div style={styles.separator} />

      {/* Waypoints */}
      <div style={styles.group}>
        <span style={styles.groupLabel} title="Clip waypoints">
          <MapPin size={15} strokeWidth={2} />
        </span>
        <Pill
          on={waypointsOn}
          onClick={() => onChange({ ...settings, show_waypoints: !waypointsOn })}
          label="WAYPOINTS"
          title={waypointsOn ? 'Hide clip waypoints' : 'Show clip waypoints'}
        />
      </div>

      <div style={styles.separator} />

      {/* Follow playhead */}
      <div style={styles.group}>
        <span style={styles.groupLabel} title="Follow playhead">
          <LocateFixed size={15} strokeWidth={2} />
        </span>
        <Pill
          on={followOn}
          onClick={() => onChange({ ...settings, follow_playhead: !followOn })}
          label="FOLLOW"
          title={followOn ? 'Map follows playhead — click to pan freely' : 'Free pan — click to follow playhead'}
        />
      </div>
    </CollapsibleToolbar>
  );
}
