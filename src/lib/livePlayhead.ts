// Module-level mutable ref shared by usePlayback (writer) and MapView's
// render loop (reader). Bypasses the React state pipeline so the map's
// per-frame loop sees the freshest possible project-time playhead.
// Preview-only — the headless export worker computes its own `t` from
// frame_index / fps and never reads this.
export const livePlayheadMs: { current: number | null } = { current: null };
