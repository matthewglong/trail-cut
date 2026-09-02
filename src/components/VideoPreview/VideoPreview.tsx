import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
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

/** Half-width of the flag's pointer triangle — how close to the flag's own
 *  edge the pointer may slide before it stops tracking the playhead. */
const FLAG_POINTER_INSET = 7;

/** Round seconds to a tenth. `formatTime` floors its tenths digit, so a
 *  value like 1.9999999 (float subtraction of trim bounds) must be settled
 *  before formatting or it reads a full tenth low. */
function roundTenth(sec: number): number {
  return Math.round(sec * 10) / 10;
}

/** Trim bounds are quantized to whole milliseconds (TrimRange is u64 ms),
 *  while the playhead is a float second. Landing exactly ON a bound must
 *  read as INSIDE the trim, so the in/out test carries one ms of slack. */
const TRIM_EDGE_TOLERANCE_SEC = 0.001;

interface VideoPreviewProps {
  clip: Clip | null;
  proxyPath: string | null;
  onUpdateTrim?: (trim: TrimRange) => void;
  onUpdateFocalPoint?: (fp: FocalPoint) => void;
  previewAspect: string;
  cropPreview: boolean;
  /** If provided, VideoPreview publishes its togglePlay function here so
   *  external keyboard shortcuts (Space) can drive playback. */
  togglePlayRef?: MutableRefObject<(() => void) | null>;
  /** Fired whenever the playhead moves, in media seconds from the start of
   *  the source video (unaffected by trim or speed). */
  onPlayheadChange?: (mediaSeconds: number) => void;
  /** Synchronous per-frame callback fired from inside the rAF tick (no React
   *  state in between). Same units as `onPlayheadChange`. Used by the map
   *  render loop to read the freshest playhead within the same frame. */
  onLivePlayheadSeconds?: (mediaSeconds: number) => void;
  /** Split the current clip at the playhead (right-click menu + ⌘B). */
  onSplitAtPlayhead?: () => void;
  /** 'loop' repeats the current clip; 'continuous' advances to next via onClipEnded. */
  playbackMode?: 'loop' | 'continuous';
  onChangePlaybackMode?: (mode: 'loop' | 'continuous') => void;
  /** Called when playback reaches trimOut in continuous mode. */
  onClipEnded?: () => void;
  /** Incrementing token — any change auto-plays this clip on next load. */
  autoPlayToken?: number;
  onPlayingChange?: (playing: boolean) => void;
  onPlayIntent?: () => boolean;
}

export default function VideoPreview({
  clip,
  proxyPath,
  onUpdateTrim,
  onUpdateFocalPoint,
  previewAspect,
  cropPreview,
  togglePlayRef,
  onPlayheadChange,
  onLivePlayheadSeconds,
  onSplitAtPlayhead,
  playbackMode = 'continuous',
  onChangePlaybackMode,
  onClipEnded,
  autoPlayToken,
  onPlayingChange,
  onPlayIntent,
}: VideoPreviewProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const videoContainerRef = useRef<HTMLDivElement | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number } | null>(null);

  // Callback ref: maintain `videoContainerRef` for child consumers AND
  // track dimensions in state so render-time math reacts to resize.
  const setVideoContainerNode = useCallback((el: HTMLDivElement | null) => {
    videoContainerRef.current = el;
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    if (!el) {
      setContainerSize(null);
      return;
    }
    const update = () => {
      setContainerSize((prev) => {
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (prev && prev.w === w && prev.h === h) return prev;
        return { w, h };
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    resizeObserverRef.current = ro;
  }, []);

  useEffect(() => () => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
  }, []);

  // --- Playhead flag geometry -------------------------------------------
  // The flag reads out the playhead position and is clamped to the seek-bar
  // track in PIXELS, so it never hangs off either end when the playhead sits
  // at 0% or 100%. Both widths come from ResizeObservers (which deliver an
  // initial observation), so nothing is measured from an effect body.
  const [trackW, setTrackW] = useState(0);
  const [flagW, setFlagW] = useState(0);
  const flagRoRef = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    const el = seekBarRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTrackW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
    // The track only mounts once a playable clip is loaded (the early
    // returns below), so re-attach when that gate flips.
  }, [clip, proxyPath]);

  const setFlagNode = useCallback((el: HTMLDivElement | null) => {
    flagRoRef.current?.disconnect();
    flagRoRef.current = null;
    if (!el) {
      setFlagW(0);
      return;
    }
    const ro = new ResizeObserver(() => setFlagW(el.offsetWidth));
    ro.observe(el);
    flagRoRef.current = ro;
  }, []);

  useEffect(() => () => {
    flagRoRef.current?.disconnect();
    flagRoRef.current = null;
  }, []);

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
    playbackMode,
    onClipEnded,
    autoPlayToken,
    onPlayingChange,
    onPlayIntent,
    fallbackDurationSec: clip?.duration_ms ? clip.duration_ms / 1000 : 0,
    onLivePlayheadSeconds,
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

  // Publish togglePlay so the editor's keyboard shortcuts can drive playback.
  // Only publish when there's an actually-playable clip loaded.
  useEffect(() => {
    if (!togglePlayRef) return;
    if (!clip || !proxyPath) {
      togglePlayRef.current = null;
      return;
    }
    togglePlayRef.current = togglePlay;
    return () => {
      if (togglePlayRef.current === togglePlay) togglePlayRef.current = null;
    };
  }, [togglePlayRef, clip, proxyPath, togglePlay]);

  // Publish playhead position upward (in media seconds, raw video.currentTime).
  useEffect(() => {
    if (onPlayheadChange) onPlayheadChange(currentTime);
  }, [currentTime, onPlayheadChange]);

  // Dismiss the split context menu on any click elsewhere or Escape.
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

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
    if (!cropPreview || !videoNatural || !containerSize) return undefined;
    const { w: cw, h: ch } = containerSize;
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

  // Playhead flag readout. Inside the trimmed region the flag speaks the
  // KEPT clip's axis (position within the trim / trimmed length) — that's
  // the footage that actually ships. Outside it, the trim is irrelevant, so
  // it falls back to the raw source axis (position / full source length).
  // Values are rounded to a tenth first: `formatTime` floors, so a
  // subtraction landing on 1.9999999 would otherwise read "0:01.9".
  //
  // While a trim handle is being dragged the playhead rides the handle, so
  // it sits exactly ON a trim bound: the drag writes `currentTime` locally
  // while the new bound arrives a commit later through `onUpdateTrim`, and
  // the raw comparison flickers in/out of the trim every frame. A drag is
  // definitionally about the kept region, so pin the readout to it.
  const draggingTrim = dragging === 'in' || dragging === 'out';
  const inTrim = draggingTrim
    || (duration > 0
      && currentTime >= trimInSec - TRIM_EDGE_TOLERANCE_SEC
      && currentTime <= trimOutSec + TRIM_EDGE_TOLERANCE_SEC);
  // Clamping matters only during a drag, where currentTime can lead or lag
  // the committed bounds by a frame; inside the trim it's a no-op.
  const flagPosSec = roundTenth(
    inTrim ? Math.max(0, Math.min(currentTime, trimOutSec) - trimInSec) : currentTime,
  );
  const flagTotalSec = roundTenth(inTrim ? Math.max(0, trimOutSec - trimInSec) : duration);
  const flagText = `${formatTime(flagPosSec)}/${formatTime(flagTotalSec)}`;

  // Clamp the (centered) flag inside the track; the pointer stays under the
  // playhead so a clamped flag still reads as belonging to it.
  const measured = trackW > 0 && flagW > 0;
  const playX = (playPct / 100) * trackW;
  const flagLeft = measured
    ? Math.max(0, Math.min(trackW - flagW, playX - flagW / 2))
    : 0;
  const pointerLeft = measured
    ? Math.max(FLAG_POINTER_INSET, Math.min(flagW - FLAG_POINTER_INSET, playX - flagLeft))
    : 0;

  return (
    <div style={styles.container}>
      {/* Video with crosshair overlay */}
      <div
        ref={setVideoContainerNode}
        style={{
          ...styles.videoWrapper,
          cursor: cropPreview ? 'default' : 'crosshair',
          ...(cropTransform ? { clipPath: cropTransform.clip } : {}),
        }}
        onMouseDown={cropPreview ? undefined : handleVideoMouseDown}
        onWheel={cropPreview ? undefined : handleWheel}
        onContextMenu={(e) => {
          if (!onSplitAtPlayhead) return;
          e.preventDefault();
          setContextMenu({ x: e.clientX, y: e.clientY });
        }}
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
        {!cropPreview && videoNatural && containerSize && (
          <CropOverlay
            cw={containerSize.w}
            ch={containerSize.h}
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
          <div style={{ ...styles.playhead, left: `${playPct}%` }}>
            <div style={{ ...styles.playheadHoop, top: 0 }} />
            <div style={styles.playheadBar} />
          </div>
          {/* Paused-only: while playing the numbers churn per frame, which
              reads as noise rather than a readout. */}
          {!playing && (
          <div
            ref={setFlagNode}
            style={{
              ...styles.playheadFlag,
              ...(inTrim ? {} : styles.playheadFlagUntrimmed),
              ...(measured
                ? { left: `${flagLeft}px` }
                : { left: `${playPct}%`, transform: 'translateX(-50%)' }),
            }}
            title={
              inTrim
                ? 'Position within the trimmed clip / trimmed length'
                : 'Outside the trim — position in the raw source / source length'
            }
            data-testid="playhead-flag"
          >
            {flagText}
            <div
              style={{
                ...styles.playheadFlagPointer,
                ...(inTrim ? {} : styles.playheadFlagPointerUntrimmed),
                ...(measured
                  ? { left: `${pointerLeft}px` }
                  : { left: '50%' }),
              }}
            />
          </div>
          )}
        </div>

        {onChangePlaybackMode && (
          <button
            type="button"
            onClick={() =>
              onChangePlaybackMode(playbackMode === 'loop' ? 'continuous' : 'loop')
            }
            style={styles.modePill}
            title={
              playbackMode === 'loop'
                ? 'Loop current clip (click to play through)'
                : 'Play through clips (click to loop)'
            }
            aria-label="Toggle playback mode"
          >
            <span
              style={{
                ...styles.modeSeg,
                ...(playbackMode === 'loop' ? styles.modeSegActive : {}),
              }}
            >
              {'\u21BB'}
            </span>
            <span
              style={{
                ...styles.modeSeg,
                ...(playbackMode === 'continuous' ? styles.modeSegActive : {}),
              }}
            >
              {'\u2192'}
            </span>
          </button>
        )}
      </div>
      {contextMenu && onSplitAtPlayhead && (
        <div
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            backgroundColor: '#2a2a2a',
            border: '1px solid #444',
            borderRadius: 6,
            overflow: 'hidden',
            zIndex: 1000,
            minWidth: 180,
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              onSplitAtPlayhead();
              setContextMenu(null);
            }}
            style={{
              display: 'block',
              width: '100%',
              padding: '8px 14px',
              backgroundColor: 'transparent',
              color: '#ccc',
              border: 'none',
              cursor: 'pointer',
              fontSize: 13,
              textAlign: 'left',
            }}
          >
            Split at Playhead&nbsp;&nbsp;<span style={{ color: '#777' }}>⌘B</span>
          </button>
        </div>
      )}
    </div>
  );
}
