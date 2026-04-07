import { useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { Clip, TrimRange, FocalPoint } from '../../types';
import { formatTime } from '../../utils/format';
import { ASPECT_RATIOS } from './constants';
import { styles } from './styles';
import { colors } from '../../theme/tokens';
import CropOverlay from './CropOverlay';
import { usePlayback } from './usePlayback';
import { useTrimDrag } from './useTrimDrag';
import { useFocalDrag } from './useFocalDrag';

interface VideoPreviewProps {
  clip: Clip | null;
  proxyPath: string | null;
  onUpdateTrim?: (trim: TrimRange) => void;
  onUpdateFocalPoint?: (fp: FocalPoint) => void;
  previewAspect: string;
  cropPreview: boolean;
}

export default function VideoPreview({
  clip,
  proxyPath,
  onUpdateTrim,
  onUpdateFocalPoint,
  previewAspect,
  cropPreview,
}: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);

  const speed = clip?.effects.speed ?? 1.0;
  const focalX = clip?.focal_point.x ?? 0.5;
  const focalY = clip?.focal_point.y ?? 0.5;
  const zoom = clip?.focal_point.zoom ?? 1.0;

  // Trim drag needs to be initialized first so we can pass dragging to playback
  const [dragging, setDragging] = useState<'in' | 'out' | 'seek' | null>(null);

  const {
    playing, currentTime, duration, videoNatural,
    trimInSec, trimOutSec,
    togglePlay, handleTimeUpdate, handleLoadedMetadata, handleEnded,
    setCurrentTime,
  } = usePlayback({
    videoRef,
    proxyPath,
    trim: clip?.trim ?? null,
    speed,
    dragging,
  });

  const { handleSeekBarMouseDown } = useTrimDrag({
    videoRef,
    seekBarRef,
    clip,
    duration,
    trimInSec,
    trimOutSec,
    onUpdateTrim,
    setCurrentTime,
    dragging,
    setDragging,
  });

  // Spacebar toggles play/pause when a clip is loaded
  useEffect(() => {
    if (!clip || !proxyPath) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      e.preventDefault();
      togglePlay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clip, proxyPath, togglePlay]);

  const { handleVideoMouseDown, handleWheel } = useFocalDrag({
    videoRef,
    videoContainerRef,
    clip,
    onUpdateFocalPoint,
  });

  if (!clip) {
    return (
      <div style={styles.empty}>
        <div style={styles.emptyIcon}>&#9654;</div>
        <p style={styles.emptyText}>Select a clip to preview</p>
      </div>
    );
  }

  if (!proxyPath) {
    return (
      <div style={styles.empty}>
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
        <div style={styles.spinner} />
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

    const scaleX = cw / cutW;
    const scaleY = ch / cutH;
    const scale = Math.min(scaleX, scaleY);

    const cropCenterX = cutX + cutW / 2;
    const cropCenterY = cutY + cutH / 2;
    const tx = cw / 2 - scale * cropCenterX;
    const ty = ch / 2 - scale * cropCenterY;

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
              backgroundColor: colors.accent,
              transform: 'translateY(-50%)',
            }} />
            <div style={{
              position: 'absolute',
              left: `${focalX * 100}%`,
              top: `calc(${focalY * 100}% - 12px)`,
              width: '2px',
              height: '24px',
              backgroundColor: colors.accent,
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
      </div>
    </div>
  );
}
