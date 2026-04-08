// Single source of truth for keyboard shortcut bindings.
// Adding a new shortcut: add an entry here, then wire it up in useEditorShortcuts.
// Renaming a key: change it here. Call sites read via keyOf(id).

export type ShortcutCategory = 'playback' | 'nav' | 'edit';

export interface ShortcutDef {
  /** Single character (lowercased) or a named key like 'Space', 'ArrowLeft'. */
  key: string;
  /** Human-readable label, suitable for a future help overlay. */
  label: string;
  category: ShortcutCategory;
  /** If the shortcut supports double-tap-to-reset, label for that action. */
  resetLabel?: string;
}

export const SHORTCUTS = {
  togglePlay:  { key: 'Space',      label: 'Play / Pause',                category: 'playback' },
  prevClip:    { key: 'ArrowLeft',  label: 'Previous clip',               category: 'nav' },
  nextClip:    { key: 'ArrowRight', label: 'Next clip',                   category: 'nav' },
  zoomHold:    { key: 'z',          label: 'Adjust zoom (hold + ↑↓)',     category: 'edit', resetLabel: 'Reset zoom' },
  speedHold:   { key: 's',          label: 'Adjust speed (hold + ↑↓)',    category: 'edit', resetLabel: 'Reset speed' },
  aspectHold:  { key: 'a',          label: 'Cycle aspect (hold + ↑↓)',    category: 'edit', resetLabel: 'Reset aspect ratio' },
  focalHold:   { key: 't',          label: 'Move focal point (hold + ←↑↓→)', category: 'edit', resetLabel: 'Center focal point' },
  cropToggle:  { key: 'c',          label: 'Toggle crop preview',         category: 'edit' },
} as const satisfies Record<string, ShortcutDef>;

export type ShortcutId = keyof typeof SHORTCUTS;

export const keyOf = (id: ShortcutId): string => SHORTCUTS[id].key;

// Fail loudly at startup if two shortcuts share the same key. Cheap insurance
// against the most likely future bug: silently shadowing an existing binding.
(function assertNoDuplicateKeys() {
  const seen = new Map<string, ShortcutId>();
  for (const [id, def] of Object.entries(SHORTCUTS) as [ShortcutId, ShortcutDef][]) {
    const norm = def.key.toLowerCase();
    const prior = seen.get(norm);
    if (prior) {
      throw new Error(
        `Shortcut catalog: key "${def.key}" is bound to both "${prior}" and "${id}". ` +
        `Each key may only be used once.`,
      );
    }
    seen.set(norm, id);
  }
})();
