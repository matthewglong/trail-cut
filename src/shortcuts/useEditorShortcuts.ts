import { useEffect, useRef, type MutableRefObject } from 'react';
import type { Clip, FocalPoint, Effects } from '../types';
import { SHORTCUTS } from './catalog';

// ---------- Tunables ----------
const DOUBLE_TAP_MS = 300;

const ZOOM_STEP = 0.05;
const ZOOM_MIN = 1.0;
const ZOOM_MAX = 5.0;
const DEFAULT_ZOOM = 1.0;

const SPEED_STEP = 0.25;
const SPEED_MIN = 0.25;
const SPEED_MAX = 4.0;
const DEFAULT_SPEED = 1.0;

const ASPECTS = ['16:9', '9:16', '1:1', '4:5'] as const;
const DEFAULT_ASPECT = '16:9';

const DEFAULT_FOCAL = { x: 0.5, y: 0.5 };

// Focal point game-loop config
const FOCAL_SPEED = 0.7;   // units (0..1) per second at full speed
const FOCAL_RAMP_MS = 180; // accelerate to full speed over this window
const FOCAL_RAMP_START = 0.25;

// ---------- Internal helpers ----------
type HeldKeyState = { held: boolean; consumed: boolean; lastTap: number };
const newHeld = (): HeldKeyState => ({ held: false, consumed: false, lastTap: 0 });

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round = (v: number, step: number) => Math.round(v / step) * step;

const isTypingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  const tag = el?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || !!el?.isContentEditable;
};

/**
 * Handles the tap/release behavior of a held modifier key.
 * - Clears `held`
 * - If the hold was not "consumed" (no secondary key pressed during the hold),
 *   detects double-tap within DOUBLE_TAP_MS and fires `onDoubleTap`
 */
function handleRelease(s: HeldKeyState, onDoubleTap: (() => void) | null) {
  s.held = false;
  if (!s.consumed && onDoubleTap) {
    const now = performance.now();
    if (now - s.lastTap < DOUBLE_TAP_MS) {
      onDoubleTap();
      s.lastTap = 0;
    } else {
      s.lastTap = now;
    }
  }
  s.consumed = false;
}

// ---------- Hook params ----------
export interface UseEditorShortcutsParams {
  selectedClip: Clip | null;
  clips: Clip[];
  selectedClipId: string | null;
  setSelectedClipId: (id: string) => void;
  onUpdateFocalPoint: (fp: FocalPoint) => void;
  onUpdateEffects: (effects: Effects) => void;
  previewAspect: string;
  setPreviewAspect: (a: string) => void;
  setCropPreview: (fn: (prev: boolean) => boolean) => void;
  /** VideoPreview writes its togglePlay function into this ref. */
  togglePlayRef: MutableRefObject<(() => void) | null>;
  /** Split the selected clip at the current playhead (FCP-style ⌘B). */
  splitAtPlayhead: () => void;
}

// ---------- The hook ----------
export function useEditorShortcuts(params: UseEditorShortcutsParams) {
  // Held modifier state
  const held = useRef({
    z: newHeld(),
    s: newHeld(),
    a: newHeld(),
    t: newHeld(),
  });

  // Game-loop state for T+arrow focal point movement
  const arrows = useRef({ up: false, down: false, left: false, right: false });
  const focalLoop = useRef<{ raf: number | null; last: number; moveStart: number }>({
    raf: null,
    last: 0,
    moveStart: 0,
  });

  // Latest props mirror — lets the (single, attach-once) effect read fresh
  // values without having to re-run on every prop change.
  const latestRef = useRef(params);
  latestRef.current = params;

  // Game loop: drives focal point while T + arrows are held
  const startFocalLoop = () => {
    if (focalLoop.current.raf !== null) return;
    const t0 = performance.now();
    focalLoop.current.last = t0;
    focalLoop.current.moveStart = t0;
    const tick = (now: number) => {
      const dt = (now - focalLoop.current.last) / 1000;
      focalLoop.current.last = now;
      const a = arrows.current;
      const dx = (a.right ? 1 : 0) - (a.left ? 1 : 0);
      const dy = (a.down ? 1 : 0) - (a.up ? 1 : 0);
      const { selectedClip: clip, onUpdateFocalPoint: update } = latestRef.current;
      if (clip && (dx !== 0 || dy !== 0)) {
        const ramp = Math.min(1, (now - focalLoop.current.moveStart) / FOCAL_RAMP_MS);
        const eased = 1 - Math.pow(1 - ramp, 2);
        const mult = FOCAL_RAMP_START + (1 - FOCAL_RAMP_START) * eased;
        const speed = FOCAL_SPEED * mult;
        const fp = clip.focal_point;
        update({
          ...fp,
          x: clamp(fp.x + dx * speed * dt, 0, 1),
          y: clamp(fp.y + dy * speed * dt, 0, 1),
        });
      }
      const stillMoving = held.current.t.held && (a.up || a.down || a.left || a.right);
      if (stillMoving) {
        focalLoop.current.raf = requestAnimationFrame(tick);
      } else {
        focalLoop.current.raf = null;
      }
    };
    focalLoop.current.raf = requestAnimationFrame(tick);
  };

  const stopFocalLoop = () => {
    if (focalLoop.current.raf !== null) {
      cancelAnimationFrame(focalLoop.current.raf);
      focalLoop.current.raf = null;
    }
    arrows.current.up = false;
    arrows.current.down = false;
    arrows.current.left = false;
    arrows.current.right = false;
  };

  useEffect(() => {
    // Resolve catalog keys once on mount
    const ZOOM_KEY = SHORTCUTS.zoomHold.key.toLowerCase();
    const SPEED_KEY = SHORTCUTS.speedHold.key.toLowerCase();
    const ASPECT_KEY = SHORTCUTS.aspectHold.key.toLowerCase();
    const FOCAL_KEY = SHORTCUTS.focalHold.key.toLowerCase();
    const CROP_KEY = SHORTCUTS.cropToggle.key.toLowerCase();

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;

      // ⌘B / Ctrl+B → split at playhead (FCP "Blade at Playhead")
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        if (!e.repeat) latestRef.current.splitAtPlayhead();
        return;
      }

      // Space → play/pause (delegated to VideoPreview via ref)
      if (e.code === 'Space') {
        const tp = latestRef.current.togglePlayRef.current;
        if (tp) {
          e.preventDefault();
          tp();
        }
        return;
      }

      const key = e.key.toLowerCase();

      // Hold modifiers
      if (key === ZOOM_KEY)   { held.current.z.held = true; return; }
      if (key === SPEED_KEY)  { held.current.s.held = true; return; }
      if (key === ASPECT_KEY) { held.current.a.held = true; return; }
      if (key === FOCAL_KEY)  { held.current.t.held = true; return; }

      // Tap toggles
      if (key === CROP_KEY) {
        if (!e.repeat) latestRef.current.setCropPreview((p) => !p);
        return;
      }

      // Everything below is arrow keys
      if (!e.key.startsWith('Arrow')) return;

      // T held → focal point game loop (consumes any arrow direction)
      if (held.current.t.held) {
        e.preventDefault();
        held.current.t.consumed = true;
        if (e.key === 'ArrowUp') arrows.current.up = true;
        if (e.key === 'ArrowDown') arrows.current.down = true;
        if (e.key === 'ArrowLeft') arrows.current.left = true;
        if (e.key === 'ArrowRight') arrows.current.right = true;
        startFocalLoop();
        return;
      }

      // Left/Right with no modifier → navigate clips
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const { clips, selectedClipId, setSelectedClipId } = latestRef.current;
        if (clips.length === 0) return;
        const anyMod =
          held.current.z.held ||
          held.current.s.held ||
          held.current.a.held ||
          held.current.t.held;
        if (anyMod) return;
        e.preventDefault();
        const idx = clips.findIndex((c) => c.id === selectedClipId);
        const base = idx === -1 ? 0 : idx;
        const next = e.key === 'ArrowRight'
          ? (base + 1) % clips.length
          : (base - 1 + clips.length) % clips.length;
        setSelectedClipId(clips[next].id);
        return;
      }

      // Up/Down → dispatch to whichever modifier is currently held
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const delta = e.key === 'ArrowUp' ? 1 : -1;

      if (held.current.a.held) {
        e.preventDefault();
        held.current.a.consumed = true;
        const { previewAspect, setPreviewAspect } = latestRef.current;
        const idx = ASPECTS.indexOf(previewAspect as (typeof ASPECTS)[number]);
        const base = idx === -1 ? 0 : idx;
        const next = (base + delta + ASPECTS.length) % ASPECTS.length;
        setPreviewAspect(ASPECTS[next]);
        return;
      }

      const clip = latestRef.current.selectedClip;
      if (!clip) return;

      if (held.current.z.held) {
        e.preventDefault();
        held.current.z.consumed = true;
        const next = clamp(
          round(clip.focal_point.zoom + delta * ZOOM_STEP, ZOOM_STEP),
          ZOOM_MIN,
          ZOOM_MAX,
        );
        latestRef.current.onUpdateFocalPoint({ ...clip.focal_point, zoom: next });
      } else if (held.current.s.held) {
        e.preventDefault();
        held.current.s.consumed = true;
        const next = clamp(
          round(clip.effects.speed + delta * SPEED_STEP, SPEED_STEP),
          SPEED_MIN,
          SPEED_MAX,
        );
        latestRef.current.onUpdateEffects({ ...clip.effects, speed: next });
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      // Always clear arrow flags first (focal loop self-terminates next frame)
      if (e.key === 'ArrowUp') arrows.current.up = false;
      if (e.key === 'ArrowDown') arrows.current.down = false;
      if (e.key === 'ArrowLeft') arrows.current.left = false;
      if (e.key === 'ArrowRight') arrows.current.right = false;

      const key = e.key.toLowerCase();

      if (key === ZOOM_KEY) {
        const clip = latestRef.current.selectedClip;
        handleRelease(
          held.current.z,
          clip
            ? () => latestRef.current.onUpdateFocalPoint({ ...clip.focal_point, zoom: DEFAULT_ZOOM })
            : null,
        );
      } else if (key === SPEED_KEY) {
        const clip = latestRef.current.selectedClip;
        handleRelease(
          held.current.s,
          clip
            ? () => latestRef.current.onUpdateEffects({ ...clip.effects, speed: DEFAULT_SPEED })
            : null,
        );
      } else if (key === ASPECT_KEY) {
        handleRelease(held.current.a, () => latestRef.current.setPreviewAspect(DEFAULT_ASPECT));
      } else if (key === FOCAL_KEY) {
        stopFocalLoop();
        const clip = latestRef.current.selectedClip;
        handleRelease(
          held.current.t,
          clip
            ? () =>
                latestRef.current.onUpdateFocalPoint({
                  ...clip.focal_point,
                  x: DEFAULT_FOCAL.x,
                  y: DEFAULT_FOCAL.y,
                })
            : null,
        );
      }
    };

    const onBlur = () => {
      held.current.z = newHeld();
      held.current.s = newHeld();
      held.current.a = newHeld();
      held.current.t = newHeld();
      stopFocalLoop();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
    // Empty deps: the effect attaches once. Fresh values come from latestRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
