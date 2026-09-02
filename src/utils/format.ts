/** Format seconds to "M:SS.t" (one decimal) — from VideoPreview */
export function formatTime(seconds: number): string {
  const min = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${min}:${sec.toString().padStart(2, '0')}.${ms}`;
}

/** Format ms to "M:SS" integer or fallback — from Timeline */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '--:--';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

/** Format ms to "M:SS.s" with decimal — from ClipInfo */
export function formatMs(ms: number): string {
  const totalSec = ms / 1000;
  const min = Math.floor(totalSec / 60);
  const sec = (totalSec % 60).toFixed(1);
  return `${min}:${sec.padStart(4, '0')}`;
}

/** Parse seconds text input to ms — from ClipInfo */
export function parseMsInput(value: string, fallback: number): number {
  const num = parseFloat(value);
  return isNaN(num) ? fallback : Math.max(0, num * 1000);
}

/** Format a project-time value to "M:SS.t" / "H:MM:SS.t". Unlike
 *  `formatDuration`, minutes roll over into an hours field so long projects
 *  stay readable, and the tenths digit is kept so the global readout resolves
 *  finer than a whole second. */
export function formatTotalDuration(ms: number): string {
  const totalTenths = Math.round(Math.max(0, ms) / 100);
  const tenth = totalTenths % 10;
  const totalSec = Math.floor(totalTenths / 10);
  const hrs = Math.floor(totalSec / 3600);
  const min = Math.floor((totalSec % 3600) / 60);
  const sec = (totalSec % 60).toString().padStart(2, '0');
  const base =
    hrs > 0 ? `${hrs}:${min.toString().padStart(2, '0')}:${sec}` : `${min}:${sec}`;
  return `${base}.${tenth}`;
}
