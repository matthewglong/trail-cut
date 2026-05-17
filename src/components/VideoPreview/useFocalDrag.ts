import { useState, useEffect, useRef } from 'react';
import type React from 'react';
import type { Clip, FocalPoint } from '../../types';

interface UseFocalDragOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoContainerRef: React.RefObject<HTMLDivElement | null>;
  clip: Clip | null;
  onUpdateFocalPoint?: (fp: FocalPoint) => void;
}

export interface FocalDragState {
  draggingFocal: boolean;
  handleVideoMouseDown: (e: React.MouseEvent) => void;
  handleWheel: (e: React.WheelEvent) => void;
  getVideoRect: () => { videoLeft: number; videoTop: number; videoW: number; videoH: number } | null;
}

export function useFocalDrag({
  videoRef,
  videoContainerRef,
  clip,
  onUpdateFocalPoint,
}: UseFocalDragOptions): FocalDragState {
  const [draggingFocal, setDraggingFocal] = useState(false);

  // Mirror non-ref reactive inputs onto a ref so the drag effect can subscribe
  // only to `draggingFocal` and still read the freshest clip / callback when
  // mousemove fires.
  const latestRef = useRef({ clip, onUpdateFocalPoint });
  latestRef.current = { clip, onUpdateFocalPoint };

  function getVideoRect() {
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
  }

  function applyFocalAt(clientX: number, clientY: number) {
    const { clip: c, onUpdateFocalPoint: cb } = latestRef.current;
    const vr = getVideoRect();
    if (!vr || !cb || !c) return;
    const x = Math.max(0, Math.min(1, (clientX - vr.videoLeft) / vr.videoW));
    const y = Math.max(0, Math.min(1, (clientY - vr.videoTop) / vr.videoH));
    cb({ x, y, zoom: c.focal_point.zoom });
  }

  function handleVideoMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    setDraggingFocal(true);
    applyFocalAt(e.clientX, e.clientY);
  }

  useEffect(() => {
    if (!draggingFocal) return;
    function handleMouseMove(e: MouseEvent) { applyFocalAt(e.clientX, e.clientY); }
    function handleMouseUp() { setDraggingFocal(false); }
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingFocal]);

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault();
    if (!onUpdateFocalPoint || !clip) return;
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    const newZoom = Math.max(1.0, Math.min(5.0, clip.focal_point.zoom + delta));
    onUpdateFocalPoint({ ...clip.focal_point, zoom: newZoom });
  }

  return {
    draggingFocal,
    handleVideoMouseDown,
    handleWheel,
    getVideoRect,
  };
}
