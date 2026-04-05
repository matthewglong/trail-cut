import { useRef, useState, useEffect, useCallback } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { Clip, TrimRange, FocalPoint } from '../types';

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
  const [showFocalPoint, setShowFocalPoint] = useState(false);
  const [draggingFocal, setDraggingFocal] = useState(false);

  const trimInSec = clip?.trim ? clip.trim.in_ms / 1000 : 0;
  const trimOutSec = clip?.trim ? clip.trim.out_ms / 1000 : duration;
  const speed = clip?.effects.speed ?? 1.0;

  // Reset state when clip changes
  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setShowFocalPoint(false);
  }, [proxyPath]);

  // Apply playback speed
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = speed;
    }
  }, [speed, proxyPath]);

  // Enforce trim bounds during playback
  function handleTimeUpdate() {
    const video = videoRef.current;
    if (!video || dragging) return;
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
    if (video.paused) {
      if (video.currentTime < trimInSec || video.currentTime >= trimOutSec) {
        video.currentTime = trimInSec;
        setCurrentTime(trimInSec);
      }
      video.play();
      setPlaying(true);
    } else {
      video.pause();
      setPlaying(false);
    }
  }

  function handleLoadedMetadata() {
    if (videoRef.current) {
      setDuration(videoRef.current.duration);
    }
  }

  function handleEnded() {
    setPlaying(false);
  }

  // --- Seek bar with trim handles ---
  const getTimeFromMouseEvent = useCallback((e: React.MouseEvent | MouseEvent) => {
    const bar = seekBarRef.current;
    if (!bar || !duration) return 0;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    return ratio * duration;
  }, [duration]);

  function handleSeekBarMouseDown(e: React.MouseEvent) {
    if (!duration) return;
    const time = getTimeFromMouseEvent(e);
    const inPx = (trimInSec / duration) * (seekBarRef.current?.clientWidth ?? 0);
    const outPx = (trimOutSec / duration) * (seekBarRef.current?.clientWidth ?? 0);
    const rect = seekBarRef.current?.getBoundingClientRect();
    const px = e.clientX - (rect?.left ?? 0);

    // Check if near trim handles (within 8px)
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

  // --- Focal point dragging ---
  function handleFocalMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    setDraggingFocal(true);
    updateFocalFromMouse(e);
  }

  function updateFocalFromMouse(e: React.MouseEvent | MouseEvent) {
    const container = videoContainerRef.current;
    const video = videoRef.current;
    if (!container || !video || !onUpdateFocalPoint) return;

    const rect = container.getBoundingClientRect();
    // Account for object-fit: contain by calculating actual video area
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

    const x = Math.max(0, Math.min(1, (e.clientX - videoLeft) / videoW));
    const y = Math.max(0, Math.min(1, (e.clientY - videoTop) / videoH));
    onUpdateFocalPoint({ x, y });
  }

  useEffect(() => {
    if (!draggingFocal) return;
    function handleMouseMove(e: MouseEvent) { updateFocalFromMouse(e); }
    function handleMouseUp() { setDraggingFocal(false); }
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingFocal]);

  if (!proxyPath || !clip) {
    return (
      <div style={styles.empty}>
        <div style={styles.emptyIcon}>&#9654;</div>
        <p style={styles.emptyText}>Select a clip to preview</p>
      </div>
    );
  }

  const videoSrc = convertFileSrc(proxyPath);
  const inPct = duration ? (trimInSec / duration) * 100 : 0;
  const outPct = duration ? (trimOutSec / duration) * 100 : 100;
  const playPct = duration ? (currentTime / duration) * 100 : 0;

  const focalX = clip.focal_point.x;
  const focalY = clip.focal_point.y;

  return (
    <div style={styles.container}>
      {/* Video with optional focal point overlay */}
      <div
        ref={videoContainerRef}
        style={styles.videoWrapper}
        onMouseDown={showFocalPoint ? handleFocalMouseDown : undefined}
      >
        <video
          ref={videoRef}
          src={videoSrc}
          style={styles.video}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onEnded={handleEnded}
          onClick={showFocalPoint ? undefined : togglePlay}
          playsInline
        />
        {showFocalPoint && (
          <div style={styles.focalOverlay}>
            {/* Crosshair */}
            <div style={{ ...styles.focalLineH, top: `${focalY * 100}%` }} />
            <div style={{ ...styles.focalLineV, left: `${focalX * 100}%` }} />
            <div style={{
              ...styles.focalDot,
              left: `${focalX * 100}%`,
              top: `${focalY * 100}%`,
            }} />
            {/* 9:16 crop preview outline */}
            <CropPreview focalX={focalX} focalY={focalY} />
          </div>
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
          {/* Trimmed region highlight */}
          <div style={{
            ...styles.trimRegion,
            left: `${inPct}%`,
            width: `${outPct - inPct}%`,
          }} />
          {/* Excluded regions (dimmed) */}
          <div style={{ ...styles.trimExcluded, left: '0%', width: `${inPct}%` }} />
          <div style={{ ...styles.trimExcluded, left: `${outPct}%`, width: `${100 - outPct}%` }} />
          {/* In handle */}
          <div style={{ ...styles.trimHandle, left: `${inPct}%` }} title="Trim in">
            <div style={styles.trimHandleBar} />
          </div>
          {/* Out handle */}
          <div style={{ ...styles.trimHandle, left: `${outPct}%` }} title="Trim out">
            <div style={styles.trimHandleBar} />
          </div>
          {/* Playhead */}
          <div style={{ ...styles.playhead, left: `${playPct}%` }} />
        </div>

        <span style={styles.time}>{formatTime(duration)}</span>
        <button
          onClick={() => setShowFocalPoint((v) => !v)}
          style={{
            ...styles.focalToggle,
            ...(showFocalPoint ? styles.focalToggleActive : {}),
          }}
          title="Toggle focal point editor"
        >
          +
        </button>
      </div>
      <div style={styles.filename}>{clip.filename}{speed !== 1.0 && ` (${speed}x)`}</div>
    </div>
  );
}

/** Draws a 9:16 crop rectangle centered on the focal point */
function CropPreview({ focalX, focalY }: { focalX: number; focalY: number }) {
  // 9:16 aspect ratio — crop width is 56.25% of height
  // For the preview, show a rectangle that's ~40% of video width
  const cropW = 40; // percent of overlay width
  const cropH = cropW * (16 / 9); // taller than wide

  const left = Math.max(0, Math.min(100 - cropW, focalX * 100 - cropW / 2));
  const top = Math.max(0, Math.min(100 - cropH, focalY * 100 - cropH / 2));

  return (
    <div style={{
      position: 'absolute',
      left: `${left}%`,
      top: `${top}%`,
      width: `${cropW}%`,
      height: `${cropH}%`,
      border: '2px solid rgba(255, 107, 53, 0.8)',
      borderRadius: '2px',
      pointerEvents: 'none',
      boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.4)',
    }} />
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
    cursor: 'pointer',
  },
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
  // Custom seek bar
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
    top: '-2px',
    width: '12px',
    height: '24px',
    marginLeft: '-6px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'ew-resize',
    zIndex: 2,
  },
  trimHandleBar: {
    width: '4px',
    height: '16px',
    backgroundColor: '#ff6b35',
    borderRadius: '2px',
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
  // Focal point
  focalOverlay: {
    position: 'absolute',
    inset: 0,
    cursor: 'crosshair',
  },
  focalLineH: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: '1px',
    backgroundColor: 'rgba(255, 107, 53, 0.6)',
    pointerEvents: 'none',
  },
  focalLineV: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '1px',
    backgroundColor: 'rgba(255, 107, 53, 0.6)',
    pointerEvents: 'none',
  },
  focalDot: {
    position: 'absolute',
    width: '12px',
    height: '12px',
    borderRadius: '50%',
    backgroundColor: '#ff6b35',
    border: '2px solid #fff',
    transform: 'translate(-50%, -50%)',
    pointerEvents: 'none',
    zIndex: 1,
  },
  focalToggle: {
    width: '28px',
    height: '28px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2a2a2a',
    color: '#888',
    border: '1px solid #444',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '16px',
    flexShrink: 0,
    fontWeight: 'bold',
  },
  focalToggleActive: {
    backgroundColor: '#ff6b35',
    color: '#fff',
    borderColor: '#ff6b35',
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
};
