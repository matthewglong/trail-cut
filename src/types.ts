export interface GpsCoord {
  lat: number;
  lng: number;
}

export interface ClipMetadata {
  id: string;
  path: string;
  filename: string;
  created_at: string | null;
  duration_ms: number | null;
  gps: GpsCoord | null;
  resolution: string | null;
  frame_rate: number | null;
}

export interface TrimRange {
  in_ms: number;
  out_ms: number;
}

export interface FocalPoint {
  x: number;
  y: number;
  zoom: number;
}

export interface StabilizeSettings {
  enabled: boolean;
  shakiness: number;
}

export interface Effects {
  stabilize: StabilizeSettings;
  color_lut: string | null;
  speed: number;
}

export interface Clip {
  id: string;
  path: string;
  filename: string;
  created_at: string | null;
  duration_ms: number | null;
  gps: GpsCoord | null;
  resolution: string | null;
  frame_rate: number | null;
  trim: TrimRange | null;
  focal_point: FocalPoint;
  effects: Effects;
  visible: boolean;
}

export interface TrackPoint {
  lat: number;
  lng: number;
  elevation: number | null;
  timestamp: string | null;
}

export interface Route {
  source_path: string;
  format: string;
  trackpoints: TrackPoint[];
}

export interface ExportLayout {
  video_pct: number;
  map_position: string;
  map_visible: string;
}

export interface ExportResolution {
  width: number;
  height: number;
}

export interface ExportConfig {
  name: string;
  aspect_ratio: string;
  resolution: ExportResolution;
  layout: ExportLayout;
  codec: string;
  quality: string;
}

export interface Project {
  version: number;
  clips: Clip[];
  route: Route | null;
  exports: ExportConfig[];
}

export interface RecentProject {
  path: string;
  name: string;
  clip_count: number;
  last_opened: string;
}
