import { useState, useEffect, useRef } from 'react';
import type React from 'react';
import type { TrimRange } from '../../types';

interface UsePlaybackOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  proxyPath: string | null;
  trim: TrimRange | null;
  speed: number;
  dragging: 'in' | 'out' | 'seek' | null;
  playbackMode?: 'loop' | 'continuous';
  onClipEnded?: () => void;
  autoPlayToken?: number;
  onPlayingChange?: (playing: boolean) => void;
  onPlayIntent?: () => boolean;
  /** Synchronous per-frame callback fired from inside the rAF tick with the
   *  current media-seconds playhead. Bypasses React state so consumers (the
   *  map's render loop) read the freshest value within the same frame
   *  instead of two commits/effects later. */
  onLivePlayheadSeconds?: (mediaSeconds: number) => void;
}

export interface PlaybackState {
  playing: boolean;
  currentTime: number;
  duration: number;
  videoNatural: { w: number; h: number } | null;
  trimInSec: number;
  trimOutSec: number;
  togglePlay: () => void;
  handleTimeUpdate: () => void;
  handleLoadedMetadata: () => void;
  handleEnded: () => void;
  setCurrentTime: React.Dispatch<React.SetStateAction<number>>;
}

export function usePlayback({
  videoRef,
  proxyPath,
  trim,
  speed,
  dragging,
  playbackMode = 'loop',
  onClipEnded,
  autoPlayToken,
  onPlayingChange,
  onPlayIntent,
  onLivePlayheadSeconds,
}: UsePlaybackOptions): PlaybackState {
  const pendingAutoPlayRef = useRef(false);
  const onClipEndedRef = useRef(onClipEnded);
  const playbackModeRef = useRef(playbackMode);
  const onPlayIntentRef = useRef(onPlayIntent);
  const draggingRef = useRef(dragging);
  // Mirror onLivePlayheadSeconds on a ref so changes to the callback identity
  // don't restart the rAF loop. The tick reads the latest callback through
  // the ref each frame.
  const onLivePlayheadSecondsRef = useRef(onLivePlayheadSeconds);
  useEffect(() => { onClipEndedRef.current = onClipEnded; }, [onClipEnded]);
  useEffect(() => { playbackModeRef.current = playbackMode; }, [playbackMode]);
  useEffect(() => { onPlayIntentRef.current = onPlayIntent; }, [onPlayIntent]);
  useEffect(() => { draggingRef.current = dragging; }, [dragging]);
  useEffect(() => { onLivePlayheadSecondsRef.current = onLivePlayheadSeconds; }, [onLivePlayheadSeconds]);
  useEffect(() => {
    if (autoPlayToken && autoPlayToken > 0) pendingAutoPlayRef.current = true;
  }, [autoPlayToken]);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [videoNatural, setVideoNatural] = useState<{ w: number; h: number } | null>(null);

  const trimInSec = trim ? trim.in_ms / 1000 : 0;
  const trimOutSec = trim ? trim.out_ms / 1000 : duration;

  // Refs mirror values the rAF playhead loop reads. The loop is started
  // imperatively from togglePlay/handleLoadedMetadata; without refs its
  // closure would not pick up trim/speed edits that happen mid-playback.
  const trimInSecRef = useRef(trimInSec);
  const trimOutSecRef = useRef(trimOutSec);
  const speedRef = useRef(speed);
  useEffect(() => { trimInSecRef.current = trimInSec; }, [trimInSec]);
  useEffect(() => { trimOutSecRef.current = trimOutSec; }, [trimOutSec]);
  useEffect(() => { speedRef.current = speed; }, [speed]);

  const playheadLoopRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);

  // Reset state when clip changes. Derive-during-render pattern (per
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders)
  // avoids the cascading render an equivalent effect would cause.
  const [prevProxyPath, setPrevProxyPath] = useState(proxyPath);
  if (prevProxyPath !== proxyPath) {
    setPrevProxyPath(proxyPath);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setVideoNatural(null);
  }

  function stopPlayheadLoop() {
    if (playheadLoopRef.current !== null) {
      cancelAnimationFrame(playheadLoopRef.current);
      playheadLoopRef.current = null;
    }
  }

  // rAF-driven playhead loop. Drives React state at frame cadence so
  // downstream consumers (MapView marker + slime trail) update smoothly
  // instead of riding the irregular HTMLVideoElement `timeupdate` event.
  // For speed > 1.0 the loop also manually advances video.currentTime
  // (the video element's playbackRate caps at 1.0 for the proxy path).
  function startPlayheadLoop() {
    stopPlayheadLoop();
    lastFrameTimeRef.current = performance.now();
    const tick = (now: number) => {
      const video = videoRef.current;
      if (!video) return;
      const curSpeed = speedRef.current;
      const curTrimIn = trimInSecRef.current;
      const curTrimOut = trimOutSecRef.current;
      let t: number;
      if (curSpeed > 1.0) {
        const elapsed = (now - lastFrameTimeRef.current) / 1000;
        lastFrameTimeRef.current = now;
        t = video.currentTime + elapsed * curSpeed;
        video.currentTime = t;
      } else {
        t = video.currentTime;
      }
      if (t >= curTrimOut && !draggingRef.current) {
        if (playbackModeRef.current === 'continuous' && onClipEndedRef.current) {
          stopPlayheadLoop();
          video.pause();
          setPlaying(false);
          onClipEndedRef.current();
          return;
        }
        video.currentTime = curTrimIn;
        setCurrentTime(curTrimIn);
        onLivePlayheadSecondsRef.current?.(curTrimIn);
        playheadLoopRef.current = requestAnimationFrame(tick);
        return;
      }
      setCurrentTime(t);
      onLivePlayheadSecondsRef.current?.(t);
      playheadLoopRef.current = requestAnimationFrame(tick);
    };
    playheadLoopRef.current = requestAnimationFrame(tick);
  }

  // Clean up loop on unmount or clip change
  useEffect(() => stopPlayheadLoop, [proxyPath]);

  // Apply playback speed for slow/normal rates
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = speed <= 1.0 ? speed : 1.0;
    }
  }, [speed, proxyPath, videoRef]);

  // Retained as a no-op listener so the <video onTimeUpdate> wire stays
  // valid; the rAF playhead loop is now the single source of state updates
  // and trim-out handling while playing.
  function handleTimeUpdate() {}

  useEffect(() => {
    if (onPlayingChange) onPlayingChange(playing);
  }, [playing, onPlayingChange]);

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (!playing) {
      if (onPlayIntentRef.current && onPlayIntentRef.current()) return;
      if (video.currentTime < trimInSec || video.currentTime >= trimOutSec) {
        video.currentTime = trimInSec;
        setCurrentTime(trimInSec);
      }
      if (speed > 1.0) {
        video.pause();
      } else {
        video.playbackRate = speed;
        video.play();
      }
      startPlayheadLoop();
      setPlaying(true);
    } else {
      video.pause();
      stopPlayheadLoop();
      setPlaying(false);
    }
  }

  function handleLoadedMetadata() {
    const video = videoRef.current;
    if (!video) return;
    setDuration(video.duration);
    setVideoNatural({ w: video.videoWidth, h: video.videoHeight });
    if (pendingAutoPlayRef.current) {
      pendingAutoPlayRef.current = false;
      const inSec = trim ? trim.in_ms / 1000 : 0;
      video.currentTime = inSec;
      setCurrentTime(inSec);
      if (speed > 1.0) {
        video.pause();
      } else {
        video.playbackRate = speed;
        video.play();
      }
      startPlayheadLoop();
      setPlaying(true);
    }
  }

  function handleEnded() {
    const video = videoRef.current;
    if (!video) return;
    if (playbackModeRef.current === 'continuous' && onClipEndedRef.current) {
      stopPlayheadLoop();
      setPlaying(false);
      onClipEndedRef.current();
      return;
    }
    video.currentTime = trimInSec;
    setCurrentTime(trimInSec);
    if (playing && speed <= 1.0) {
      video.play();
    }
  }

  return {
    playing,
    currentTime,
    duration,
    videoNatural,
    trimInSec,
    trimOutSec,
    togglePlay,
    handleTimeUpdate,
    handleLoadedMetadata,
    handleEnded,
    setCurrentTime,
  };
}
