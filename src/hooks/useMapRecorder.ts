import { useCallback, useEffect, useRef, useState } from 'react';

export interface MapSample {
  zoom: number;
  bearing: number;
  pitch: number;
  lng: number;
  lat: number;
  isMoving: boolean;
}

export interface RecorderInputs {
  selectedClipId: string | null;
  playheadMs: number | null;
  follow: boolean;
  bearingMode: string;
  targetZoom: number;
  targetBearing: number;
}

interface FrameRow extends MapSample, RecorderInputs {
  t_ms: number;
  events: string;
}

export interface RecentEvent {
  t: number;
  msg: string;
}

export interface MapRecorder {
  isOpen: boolean;
  setOpen: (open: boolean) => void;
  recordEvent: (label: string) => void;
  registerFrameSampler: (sample: (() => MapSample | null) | null) => void;
  framesCount: number;
  recordingMs: number;
  recentEvents: RecentEvent[];
  copy: () => Promise<void>;
  clear: () => void;
  copyFlash: boolean;
}

const TSV_HEADER = [
  't_ms', 'zoom', 'bearing', 'pitch', 'lng', 'lat', 'isMoving',
  'selectedClip', 'playheadMs', 'follow', 'bearingMode',
  'targetZoom', 'targetBearing', 'events',
].join('\t');

export function useMapRecorder(inputs: RecorderInputs): MapRecorder {
  const [isOpen, setOpenState] = useState(false);
  const [framesCount, setFramesCount] = useState(0);
  const [recordingMs, setRecordingMs] = useState(0);
  const [recentEvents, setRecentEvents] = useState<RecentEvent[]>([]);
  const [copyFlash, setCopyFlash] = useState(false);

  const framesRef = useRef<FrameRow[]>([]);
  const recordingStartRef = useRef<number>(0);
  const samplerRef = useRef<(() => MapSample | null) | null>(null);
  const pendingEventsRef = useRef<string[]>([]);
  const recentEventsRef = useRef<RecentEvent[]>([]);
  const isOpenRef = useRef(false);
  const inputsRef = useRef<RecorderInputs>(inputs);
  inputsRef.current = inputs;

  const setOpen = useCallback((open: boolean) => {
    isOpenRef.current = open;
    setOpenState(open);
  }, []);

  const registerFrameSampler = useCallback(
    (sample: (() => MapSample | null) | null) => {
      samplerRef.current = sample;
    },
    [],
  );

  const recordEvent = useCallback((label: string) => {
    pendingEventsRef.current.push(label);
    const now = performance.now();
    const t = recordingStartRef.current > 0 ? now - recordingStartRef.current : 0;
    const next = [...recentEventsRef.current.slice(-9), { t, msg: label }];
    recentEventsRef.current = next;
    if (isOpenRef.current) setRecentEvents(next);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    if (recordingStartRef.current === 0) {
      recordingStartRef.current = performance.now();
    }
    let raf = 0;
    let counterTickAccum = 0;
    const tick = () => {
      const sampler = samplerRef.current;
      if (sampler) {
        const sample = sampler();
        if (sample) {
          const now = performance.now();
          const events = pendingEventsRef.current;
          const eventsStr = events.length ? events.join('|') : '';
          if (events.length) pendingEventsRef.current = [];
          framesRef.current.push({
            t_ms: Math.round(now - recordingStartRef.current),
            ...sample,
            ...inputsRef.current,
            events: eventsStr,
          });
          counterTickAccum++;
          if (counterTickAccum >= 10) {
            counterTickAccum = 0;
            setFramesCount(framesRef.current.length);
            setRecordingMs(now - recordingStartRef.current);
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isOpen]);

  const copy = useCallback(async () => {
    const rows = framesRef.current.map((f) => [
      f.t_ms,
      f.zoom.toFixed(4),
      f.bearing.toFixed(2),
      f.pitch.toFixed(1),
      f.lng.toFixed(6),
      f.lat.toFixed(6),
      f.isMoving ? 1 : 0,
      f.selectedClipId?.slice(0, 6) ?? '',
      f.playheadMs ?? '',
      f.follow ? 1 : 0,
      f.bearingMode,
      f.targetZoom,
      f.targetBearing.toFixed(2),
      f.events,
    ].join('\t'));
    const text = [TSV_HEADER, ...rows].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopyFlash(true);
      setTimeout(() => setCopyFlash(false), 1000);
    } catch {
      // clipboard write rejected (e.g., insecure context) — silently noop
    }
  }, []);

  const clear = useCallback(() => {
    framesRef.current = [];
    recentEventsRef.current = [];
    pendingEventsRef.current = [];
    recordingStartRef.current = isOpenRef.current ? performance.now() : 0;
    setFramesCount(0);
    setRecordingMs(0);
    setRecentEvents([]);
  }, []);

  return {
    isOpen,
    setOpen,
    recordEvent,
    registerFrameSampler,
    framesCount,
    recordingMs,
    recentEvents,
    copy,
    clear,
    copyFlash,
  };
}
