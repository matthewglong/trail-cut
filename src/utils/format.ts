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
