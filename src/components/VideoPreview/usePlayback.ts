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
}: UsePlaybackOptions): PlaybackState {
  const pendingAutoPlayRef = useRef(false);
  const onClipEndedRef = useRef(onClipEnded);
  const playbackModeRef = useRef(playbackMode);
  const onPlayIntentRef = useRef(onPlayIntent);
  useEffect(() => { onClipEndedRef.current = onClipEnded; }, [onClipEnded]);
  useEffect(() => { playbackModeRef.current = playbackMode; }, [playbackMode]);
  useEffect(() => { onPlayIntentRef.current = onPlayIntent; }, [onPlayIntent]);
  useEffect(() => {
    if (autoPlayToken && autoPlayToken > 0) pendingAutoPlayRef.current = true;
  }, [autoPlayToken]);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [videoNatural, setVideoNatural] = useState<{ w: number; h: number } | null>(null);

  const trimInSec = trim ? trim.in_ms / 1000 : 0;
  const trimOutSec = trim ? trim.out_ms / 1000 : duration;

  const fastTimerRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);

  // Reset state when clip changes
  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setVideoNatural(null);
  }, [proxyPath]);

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
        if (playbackModeRef.current === 'continuous' && onClipEndedRef.current) {
          stopFastTimer();
          video.pause();
          setPlaying(false);
          onClipEndedRef.current();
          return;
        }
        video.currentTime = trimInSec;
        setCurrentTime(trimInSec);
        fastTimerRef.current = requestAnimationFrame(tick);
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

  function handleTimeUpdate() {
    const video = videoRef.current;
    if (!video || dragging) return;
    if (speed > 1.0) return; // fast timer handles this
    const t = video.currentTime;
    setCurrentTime(t);
    if (t >= trimOutSec) {
      if (playbackModeRef.current === 'continuous' && onClipEndedRef.current) {
        video.pause();
        setPlaying(false);
        onClipEndedRef.current();
        return;
      }
      video.currentTime = trimInSec;
      setCurrentTime(trimInSec);
      video.play();
    }
  }

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
        startFastTimer();
      } else {
        video.playbackRate = speed;
        video.play();
      }
      setPlaying(true);
    }
  }

  function handleEnded() {
    const video = videoRef.current;
    if (!video) return;
    if (playbackModeRef.current === 'continuous' && onClipEndedRef.current) {
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
