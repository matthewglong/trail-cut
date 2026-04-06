import type React from 'react';
import { ASPECT_RATIOS } from './constants';
import { colors } from '../../theme/tokens';

interface CropOverlayProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  videoW: number;
  videoH: number;
  focalX: number;
  focalY: number;
  zoom: number;
  aspectRatio: string;
}

/** Draws a semi-transparent overlay with a cutout for the crop region */
export default function CropOverlay({
  containerRef,
  videoW,
  videoH,
  focalX,
  focalY,
  zoom,
  aspectRatio,
}: CropOverlayProps) {
  const container = containerRef.current;
  if (!container) return null;

  const cw = container.clientWidth;
  const ch = container.clientHeight;
  if (!cw || !ch) return null;

  // Compute where the video is rendered within the container (object-fit: contain)
  const videoAspect = videoW / videoH;
  const containerAspect = cw / ch;
  let vw: number, vh: number, vx: number, vy: number;
  if (containerAspect > videoAspect) {
    vh = ch;
    vw = ch * videoAspect;
    vx = (cw - vw) / 2;
    vy = 0;
  } else {
    vw = cw;
    vh = cw / videoAspect;
    vx = 0;
    vy = (ch - vh) / 2;
  }

  // The crop rectangle: fits the target aspect ratio inside the video area,
  // scaled down by 1/zoom, centered on the focal point
  const targetAspect = ASPECT_RATIOS[aspectRatio] ?? 1;

  // Max cutout size that fits within the video display area
  let cutW: number, cutH: number;
  if (targetAspect > videoAspect) {
    // Target is wider than video — width-constrained
    cutW = vw;
    cutH = vw / targetAspect;
  } else {
    // Target is taller than video — height-constrained
    cutH = vh;
    cutW = vh * targetAspect;
  }

  // Apply zoom: shrink the cutout
  cutW /= zoom;
  cutH /= zoom;

  // Position centered on focal point (in container coordinates)
  const focalPxX = vx + focalX * vw;
  const focalPxY = vy + focalY * vh;

  // Clamp so the cutout stays within the video area
  let cutX = focalPxX - cutW / 2;
  let cutY = focalPxY - cutH / 2;
  cutX = Math.max(vx, Math.min(vx + vw - cutW, cutX));
  cutY = Math.max(vy, Math.min(vy + vh - cutH, cutY));

  // Use clip-path to create the cutout (polygon with a hole)
  // Outer rect = full container, inner rect = cutout (wound opposite direction)
  const ox1 = 0, oy1 = 0, ox2 = cw, oy2 = ch;
  const ix1 = cutX, iy1 = cutY, ix2 = cutX + cutW, iy2 = cutY + cutH;

  const clipPath = `polygon(
    evenodd,
    ${ox1}px ${oy1}px, ${ox2}px ${oy1}px, ${ox2}px ${oy2}px, ${ox1}px ${oy2}px, ${ox1}px ${oy1}px,
    ${ix1}px ${iy1}px, ${ix1}px ${iy2}px, ${ix2}px ${iy2}px, ${ix2}px ${iy1}px, ${ix1}px ${iy1}px
  )`;

  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      clipPath,
      pointerEvents: 'none',
    }}>
      {/* Cutout border */}
      <div style={{
        position: 'absolute',
        left: `${ix1}px`,
        top: `${iy1}px`,
        width: `${cutW}px`,
        height: `${cutH}px`,
        border: `2px solid ${colors.accent}`,
        borderRadius: '2px',
        boxSizing: 'border-box',
      }} />
    </div>
  );
}
