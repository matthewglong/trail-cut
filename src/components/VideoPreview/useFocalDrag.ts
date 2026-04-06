import { useState, useEffect, useCallback } from 'react';
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
