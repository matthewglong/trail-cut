// The wobble fix.
//
// maplibre-gl-js's painter snaps the camera to integer pixel coordinates
// when `options.moving` is false, on the assumption that idle frames don't
// need sub-pixel correctness. For an export pipeline driving a deterministic
// camera path with sub-pixel deltas (≪ 1 px per frame on slow pans),
// snap-to-pixel produces visible wobble: the camera position-rounds in
// odd directions on consecutive frames, producing a few-px jitter that's
// invisible at native frame rates but obvious in a 30 fps render.
//
// The fix forces `moving: true` on every painter.render call so the snap
// path is bypassed. We apply it as a wrapper rather than monkey-patching
// the painter prototype because the wrapper is contained per-Map instance
// and cannot leak into other code that imports maplibre-gl.
//
// Lives in its own module so the unit test (Node, jsdom-free) can import
// the same code path the page bundle ships, without dragging in the full
// maplibre-gl bundle. See ../__tests__/painterPatch.test.ts.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Painter = any;

export function applyPainterPatch(painter: Painter): void {
  const orig = painter.render.bind(painter);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  painter.render = function (style: any, options: any) {
    return orig(style, { ...(options ?? {}), moving: true });
  };
}
