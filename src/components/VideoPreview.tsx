import { useRef, useState, useEffect, useCallback } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { Clip, TrimRange, FocalPoint } from '../types';

const ASPECT_RATIOS: Record<string, number> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
  '4:5': 4 / 5,
};

interface VideoPreviewProps {
  clip: Clip | null;
  proxyPath: string | null;
  onUpdateTrim?: (trim: TrimRange) => void;
  onUpdateFocalPoint?: (fp: FocalPoint) => void;
}

function formatTime(seconds: number): string {
  const min = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${min}:${sec.toString().padStart(2, '0')}.${ms}`;
}

export default function VideoPreview({ clip, proxyPath, onUpdateTrim, onUpdateFocalPoint }: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [dragging, setDragging] = useState<'in' | 'out' | 'seek' | null>(null);
  const [draggingFocal, setDraggingFocal] = useState(false);
  const [videoNatural, setVideoNatural] = useState<{ w: number; h: number } | null>(null);
  const [previewAspect, setPreviewAspect] = useState<string>('16:9');
  const [cropPreview, setCropPreview] = useState(false);

  const trimInSec = clip?.trim ? clip.trim.in_ms / 1000 : 0;
  const trimOutSec = clip?.trim ? clip.trim.out_ms / 1000 : duration;
  const speed = clip?.effects.speed ?? 1.0;
  const focalX = clip?.focal_point.x ?? 0.5;
  const focalY = clip?.focal_point.y ?? 0.5;
  const zoom = clip?.focal_point.zoom ?? 1.0;

  // Reset state when clip changes
  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setVideoNatural(null);
  }, [proxyPath]);

  // For speeds > 1x, WebKit can't decode fast enough with playbackRate alone.
  // Use a manual timer to step currentTime for fast playback.
  const fastTimerRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);

  function stopFastTimer() {
    if (fastTimerRef.current !== null) {
      cancelAnimationFrame(fastTimerRef.current);
      fastTimerRef.current = null;
    }
  }

  function startFastTimer() {
    stopFastTimer();
    lastFrameTimeRef.current = performance.now();
    const tick = (now: number) => {
      const video = videoRef.current;
      if (!video) return;
      const elapsed = (now - lastFrameTimeRef.current) / 1000;
      lastFrameTimeRef.current = now;
      const newTime = video.currentTime + elapsed * speed;
      if (newTime >= trimOutSec) {
        video.pause();
        video.currentTime = trimInSec;
        setCurrentTime(trimInSec);
        setPlaying(false);
        stopFastTimer();
        return;
      }
      video.currentTime = newTime;
      setCurrentTime(newTime);
      fastTimerRef.current = requestAnimationFrame(tick);
    };
    fastTimerRef.current = requestAnimationFrame(tick);
  }

  // Clean up timer on unmount or clip change
  useEffect(() => stopFastTimer, [proxyPath]);

  // Apply playback speed for slow/normal rates
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = speed <= 1.0 ? speed : 1.0;
    }
  }, [speed, proxyPath]);

  // Enforce trim bounds during playback (only used for speed <= 1x)
  function handleTimeUpdate() {
    const video = videoRef.current;
    if (!video || dragging) return;
    if (speed > 1.0) return; // fast timer handles this
    const t = video.currentTime;
    setCurrentTime(t);
    if (t >= trimOutSec) {
      video.pause();
      video.currentTime = trimInSec;
      setCurrentTime(trimInSec);
      setPlaying(false);
    }
  }

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (!playing) {
      if (video.currentTime < trimInSec || video.currentTime >= trimOutSec) {
        video.currentTime = trimInSec;
        setCurrentTime(trimInSec);
      }
      if (speed > 1.0) {
        // Keep video paused, step currentTime manually via rAF
        // Paused video still renders the frame at the seeked position
        video.pause();
        startFastTimer();
      } else {
        video.playbackRate = speed;
        video.play();
      }
      setPlaying(true);
    } else {
      video.pause();
      stopFastTimer();
      setPlaying(false);
    }
  }

  function handleLoadedMetadata() {
    if (videoRef.current) {
      setDuration(videoRef.current.duration);
      const w = videoRef.current.videoWidth;
      const h = videoRef.current.videoHeight;
      setVideoNatural({ w, h });
      // Default to the closest standard aspect ratio
      const srcAspect = w / h;
      let closest = '16:9';
      let closestDiff = Infinity;
      for (const [name, ratio] of Object.entries(ASPECT_RATIOS)) {
        const diff = Math.abs(srcAspect - ratio);
        if (diff < closestDiff) {
          closestDiff = diff;
          closest = name;
        }
      }
      setPreviewAspect(closest);
    }
  }

  function handleEnded() {
    stopFastTimer();
    setPlaying(false);
  }

  // --- Seek bar with trim handles ---
  function handleSeekBarMouseDown(e: React.MouseEvent) {
    if (!duration || !seekBarRef.current) return;
    const rect = seekBarRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, px / rect.width));
    const time = ratio * duration;
    const inPx = (trimInSec / duration) * rect.width;
    const outPx = (trimOutSec / duration) * rect.width;

    if (Math.abs(px - inPx) < 8) {
      setDragging('in');
    } else if (Math.abs(px - outPx) < 8) {
      setDragging('out');
    } else {
      setDragging('seek');
      setCurrentTime(time);
      if (videoRef.current) videoRef.current.currentTime = time;
    }
  }

  useEffect(() => {
    if (!dragging) return;

    function handleMouseMove(e: MouseEvent) {
      const bar = seekBarRef.current;
      if (!bar || !duration) return;
      const rect = bar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const time = ratio * duration;

      if (dragging === 'seek') {
        setCurrentTime(time);
        if (videoRef.current) videoRef.current.currentTime = time;
      } else if (dragging === 'in' && onUpdateTrim && clip?.trim) {
        const newIn = Math.min(time, trimOutSec - 0.1);
        onUpdateTrim({ in_ms: Math.max(0, newIn * 1000), out_ms: clip.trim.out_ms });
        if (videoRef.current) { videoRef.current.currentTime = newIn; setCurrentTime(newIn); }
      } else if (dragging === 'out' && onUpdateTrim && clip?.trim) {
        const newOut = Math.max(time, trimInSec + 0.1);
        onUpdateTrim({ in_ms: clip.trim.in_ms, out_ms: Math.min(newOut * 1000, duration * 1000) });
        if (videoRef.current) { videoRef.current.currentTime = newOut; setCurrentTime(newOut); }
      }
    }

    function handleMouseUp() {
      setDragging(null);
    }

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging, duration, trimInSec, trimOutSec, clip?.trim, onUpdateTrim]);

  // --- Focal point: drag to pan ---
  const getVideoRect = useCallback(() => {
    const container = videoContainerRef.current;
    const video = videoRef.current;
    if (!container || !video) return null;
    const rect = container.getBoundingClientRect();
    const containerAspect = rect.width / rect.height;
    const videoAspect = video.videoWidth / video.videoHeight || 16 / 9;

    let videoLeft: number, videoTop: number, videoW: number, videoH: number;
    if (containerAspect > videoAspect) {
      videoH = rect.height;
      videoW = videoH * videoAspect;
      videoLeft = rect.left + (rect.width - videoW) / 2;
      videoTop = rect.top;
    } else {
      videoW = rect.width;
      videoH = videoW / videoAspect;
      videoLeft = rect.left;
      videoTop = rect.top + (rect.height - videoH) / 2;
    }
    return { videoLeft, videoTop, videoW, videoH };
  }, []);

  function focalFromMouse(e: MouseEvent | React.MouseEvent) {
    const vr = getVideoRect();
    if (!vr || !onUpdateFocalPoint || !clip) return;
    const x = Math.max(0, Math.min(1, (e.clientX - vr.videoLeft) / vr.videoW));
    const y = Math.max(0, Math.min(1, (e.clientY - vr.videoTop) / vr.videoH));
    onUpdateFocalPoint({ x, y, zoom: clip.focal_point.zoom });
  }

  function handleVideoMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    setDraggingFocal(true);
    focalFromMouse(e);
  }

  useEffect(() => {
    if (!draggingFocal) return;
    function handleMouseMove(e: MouseEvent) { focalFromMouse(e); }
    function handleMouseUp() { setDraggingFocal(false); }
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingFocal, clip?.focal_point.zoom, onUpdateFocalPoint]);

  // --- Zoom: scroll wheel ---
  function handleWheel(e: React.WheelEvent) {
    e.preventDefault();
    if (!onUpdateFocalPoint || !clip) return;
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    const newZoom = Math.max(1.0, Math.min(5.0, clip.focal_point.zoom + delta));
    onUpdateFocalPoint({ ...clip.focal_point, zoom: newZoom });
  }

  if (!proxyPath || !clip) {
    return (
      <div style={styles.empty}>
        <div style={styles.emptyIcon}>&#9654;</div>
        <p style={styles.emptyText}>Select a clip to preview</p>
      </div>
    );
  }

  // Compute crop-preview transform: scale video so only the crop region is visible
  const cropTransform = (() => {
    if (!cropPreview || !videoNatural) return undefined;
    const container = videoContainerRef.current;
    if (!container) return undefined;

    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (!cw || !ch) return undefined;

    const videoAspect = videoNatural.w / videoNatural.h;
    const containerAspect = cw / ch;
    let vw: number, vh: number, vx: number, vy: number;
    if (containerAspect > videoAspect) {
      vh = ch; vw = ch * videoAspect; vx = (cw - vw) / 2; vy = 0;
    } else {
      vw = cw; vh = cw / videoAspect; vx = 0; vy = (ch - vh) / 2;
    }

    const targetAspect = ASPECT_RATIOS[previewAspect] ?? 1;
    let cutW: number, cutH: number;
    if (targetAspect > videoAspect) { cutW = vw; cutH = vw / targetAspect; }
    else { cutH = vh; cutW = vh * targetAspect; }
    cutW /= zoom; cutH /= zoom;

    const focalPxX = vx + focalX * vw;
    const focalPxY = vy + focalY * vh;
    let cutX = focalPxX - cutW / 2;
    let cutY = focalPxY - cutH / 2;
    cutX = Math.max(vx, Math.min(vx + vw - cutW, cutX));
    cutY = Math.max(vy, Math.min(vy + vh - cutH, cutY));

    // Scale so the crop region fills the container (fit inside)
    const scaleX = cw / cutW;
    const scaleY = ch / cutH;
    const scale = Math.min(scaleX, scaleY);

    // Translate so the crop center maps to the container center
    // CSS applies right-to-left: scale first, then translate
    const cropCenterX = cutX + cutW / 2;
    const cropCenterY = cutY + cutH / 2;
    const tx = cw / 2 - scale * cropCenterX;
    const ty = ch / 2 - scale * cropCenterY;

    // Clip to only show the crop region (black bars for mismatched aspect)
    const visW = cutW * scale;
    const visH = cutH * scale;
    const clipTop = (ch - visH) / 2;
    const clipRight = (cw - visW) / 2;
    const clipBottom = clipTop;
    const clipLeft = clipRight;

    return {
      transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
      transformOrigin: '0 0' as const,
      clip: `inset(${clipTop}px ${clipRight}px ${clipBottom}px ${clipLeft}px)`,
    };
  })();

  const videoSrc = convertFileSrc(proxyPath);
  const inPct = duration ? (trimInSec / duration) * 100 : 0;
  const outPct = duration ? (trimOutSec / duration) * 100 : 100;
  const playPct = duration ? (currentTime / duration) * 100 : 0;

  return (
    <div style={styles.container}>
      {/* Video with crosshair overlay */}
      <div
        ref={videoContainerRef}
        style={{
          ...styles.videoWrapper,
          cursor: cropPreview ? 'default' : 'crosshair',
          ...(cropTransform ? { clipPath: cropTransform.clip } : {}),
        }}
        onMouseDown={cropPreview ? undefined : handleVideoMouseDown}
        onWheel={cropPreview ? undefined : handleWheel}
      >
        <div style={cropTransform ? { ...cropTransform, width: '100%', height: '100%' } : { width: '100%', height: '100%' }}>
          <video
            ref={videoRef}
            src={videoSrc}
            style={styles.video}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onEnded={handleEnded}
            onDoubleClick={togglePlay}
            playsInline
          />
        </div>
        {/* Crosshair — hidden in crop preview mode */}
        {!cropPreview && (
          <div style={styles.crosshairOverlay}>
            <div style={{
              position: 'absolute',
              left: `calc(${focalX * 100}% - 12px)`,
              top: `${focalY * 100}%`,
              width: '24px',
              height: '2px',
              backgroundColor: '#ff6b35',
              transform: 'translateY(-50%)',
            }} />
            <div style={{
              position: 'absolute',
              left: `${focalX * 100}%`,
              top: `calc(${focalY * 100}% - 12px)`,
              width: '2px',
              height: '24px',
              backgroundColor: '#ff6b35',
              transform: 'translateX(-50%)',
            }} />
          </div>
        )}
        {/* Aspect ratio crop overlay — hidden in crop preview mode */}
        {!cropPreview && videoNatural && (
          <CropOverlay
            containerRef={videoContainerRef}
            videoW={videoNatural.w}
            videoH={videoNatural.h}
            focalX={focalX}
            focalY={focalY}
            zoom={zoom}
            aspectRatio={previewAspect}
          />
        )}
      </div>

      {/* Controls */}
      <div style={styles.controls}>
        <button onClick={togglePlay} style={styles.playBtn}>
          {playing ? '\u275A\u275A' : '\u25B6'}
        </button>
        <span style={styles.time}>{formatTime(currentTime)}</span>

        {/* Custom seek bar with trim handles */}
        <div
          ref={seekBarRef}
          style={styles.seekBarTrack}
          onMouseDown={handleSeekBarMouseDown}
        >
          <div style={{
            ...styles.trimRegion,
            left: `${inPct}%`,
            width: `${outPct - inPct}%`,
          }} />
          <div style={{ ...styles.trimExcluded, left: '0%', width: `${inPct}%` }} />
          <div style={{ ...styles.trimExcluded, left: `${outPct}%`, width: `${100 - outPct}%` }} />
          <div style={{ ...styles.trimHandle, left: `${inPct}%` }} title="Trim in">
            <div style={styles.trimHandleBar}>
              <div style={styles.trimHandleGrip} />
              <div style={styles.trimHandleGrip} />
              <div style={styles.trimHandleGrip} />
            </div>
          </div>
          <div style={{ ...styles.trimHandle, left: `${outPct}%` }} title="Trim out">
            <div style={styles.trimHandleBar}>
              <div style={styles.trimHandleGrip} />
              <div style={styles.trimHandleGrip} />
              <div style={styles.trimHandleGrip} />
            </div>
          </div>
          <div style={{ ...styles.playhead, left: `${playPct}%` }} />
        </div>

        <span style={styles.time}>{formatTime(duration)}</span>
        <select
          value={previewAspect}
          onChange={(e) => setPreviewAspect(e.target.value)}
          style={styles.aspectSelect}
        >
          <option value="16:9">16:9</option>
          <option value="9:16">9:16</option>
          <option value="1:1">1:1</option>
          <option value="4:5">4:5</option>
        </select>
        <button
          onClick={() => setCropPreview(p => !p)}
          style={{
            ...styles.playBtn,
            backgroundColor: cropPreview ? '#ff6b35' : '#2a2a2a',
            color: cropPreview ? '#000' : '#fff',
            fontSize: '11px',
            width: 'auto',
            padding: '0 8px',
          }}
          title={cropPreview ? 'Exit crop preview' : 'Preview crop result'}
        >
          {cropPreview ? 'Edit' : 'Preview'}
        </button>
      </div>
      <div style={styles.filename}>
        {clip.filename}
        {speed !== 1.0 && ` \u00b7 ${speed}x`}
      </div>
    </div>
  );
}

/** Draws a semi-transparent overlay with a cutout for the crop region */
function CropOverlay({
  containerRef,
  videoW,
  videoH,
  focalX,
  focalY,
  zoom,
  aspectRatio,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  videoW: number;
  videoH: number;
  focalX: number;
  focalY: number;
  zoom: number;
  aspectRatio: string;
}) {
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
        border: '2px solid #ff6b35',
        borderRadius: '2px',
        boxSizing: 'border-box',
      }} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    backgroundColor: '#000',
  },
  videoWrapper: {
    flex: 1,
    position: 'relative',
    overflow: 'hidden',
    minHeight: 0,
  },
  video: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    pointerEvents: 'none',
  },
  // Crosshair overlay
  crosshairOverlay: {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
  },
  // Controls
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 12px',
    backgroundColor: '#1a1a1a',
    borderTop: '1px solid #333',
  },
  playBtn: {
    width: '32px',
    height: '32px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2a2a2a',
    color: '#fff',
    border: '1px solid #444',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '14px',
    flexShrink: 0,
  },
  time: {
    fontSize: '12px',
    color: '#999',
    fontVariantNumeric: 'tabular-nums',
    minWidth: '46px',
    flexShrink: 0,
  },
  seekBarTrack: {
    flex: 1,
    height: '20px',
    position: 'relative',
    cursor: 'pointer',
    backgroundColor: '#333',
    borderRadius: '3px',
    userSelect: 'none',
  },
  trimRegion: {
    position: 'absolute',
    top: 0,
    height: '100%',
    backgroundColor: 'rgba(255, 107, 53, 0.25)',
    borderRadius: '3px',
  },
  trimExcluded: {
    position: 'absolute',
    top: 0,
    height: '100%',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  trimHandle: {
    position: 'absolute',
    top: '50%',
    width: '18px',
    height: '36px',
    marginLeft: '-9px',
    transform: 'translateY(-50%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'ew-resize',
    zIndex: 2,
  },
  trimHandleBar: {
    width: '8px',
    height: '32px',
    backgroundColor: '#ff6b35',
    borderRadius: '4px',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: '3px',
    boxShadow: '0 1px 4px rgba(0, 0, 0, 0.4)',
  },
  trimHandleGrip: {
    width: '4px',
    height: '1px',
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    borderRadius: '1px',
  },
  playhead: {
    position: 'absolute',
    top: 0,
    width: '2px',
    height: '100%',
    backgroundColor: '#fff',
    marginLeft: '-1px',
    zIndex: 3,
    pointerEvents: 'none',
  },
  filename: {
    padding: '4px 12px',
    fontSize: '11px',
    color: '#666',
    backgroundColor: '#1a1a1a',
    textAlign: 'center',
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    backgroundColor: '#0a0a0a',
  },
  emptyIcon: {
    fontSize: '48px',
    color: '#333',
    marginBottom: '8px',
  },
  emptyText: {
    color: '#555',
    fontSize: '14px',
  },
  aspectSelect: {
    backgroundColor: '#2a2a2a',
    color: '#ccc',
    border: '1px solid #444',
    borderRadius: '4px',
    padding: '4px 6px',
    fontSize: '12px',
    cursor: 'pointer',
    flexShrink: 0,
  },
};
