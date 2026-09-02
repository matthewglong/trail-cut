import { useEffect } from 'react';
import type React from 'react';
import type { Clip, TrimRange } from '../../types';

interface UseTrimDragOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  seekBarRef: React.RefObject<HTMLDivElement | null>;
  clip: Clip | null;
  duration: number;
  trimInSec: number;
  trimOutSec: number;
  onUpdateTrim?: (trim: TrimRange) => void;
  setCurrentTime: React.Dispatch<React.SetStateAction<number>>;
  dragging: 'in' | 'out' | 'seek' | null;
  setDragging: React.Dispatch<React.SetStateAction<'in' | 'out' | 'seek' | null>>;
}

export interface TrimDragState {
  handleSeekBarMouseDown: (e: React.MouseEvent) => void;
}

export function useTrimDrag({
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
}: UseTrimDragOptions): TrimDragState {

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
        // Round to whole ms — TrimRange is u64 on the Rust side and a
        // fractional value silently fails save_project's IPC deserialize.
        // The playhead then rides the ROUNDED bound, not the raw mouse
        // position: parking it on the exact committed bound is what keeps
        // it inside the trim once the drag releases.
        const inMs = Math.max(0, Math.round(Math.min(time, trimOutSec - 0.1) * 1000));
        const newIn = inMs / 1000;
        onUpdateTrim({ in_ms: inMs, out_ms: clip.trim.out_ms });
        if (videoRef.current) { videoRef.current.currentTime = newIn; setCurrentTime(newIn); }
      } else if (dragging === 'out' && onUpdateTrim && clip?.trim) {
        const outMs = Math.min(
          Math.round(Math.max(time, trimInSec + 0.1) * 1000),
          Math.round(duration * 1000),
        );
        const newOut = outMs / 1000;
        onUpdateTrim({ in_ms: clip.trim.in_ms, out_ms: outMs });
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
  }, [dragging, duration, trimInSec, trimOutSec, clip?.trim, onUpdateTrim, seekBarRef, setCurrentTime, setDragging, videoRef]);

  return {
    handleSeekBarMouseDown,
  };
}
