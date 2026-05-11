// Two-layer design token system.
// `brand` is the raw palette and is intentionally NOT exported — components
// must consume the `semantic` aliases below so a palette swap stays surgical.
// `colors` is preserved for existing call sites; new code should import
// `semantic` directly.

const brand = {
  canvas:     '#0e1416',
  surface1:   '#141b1d',
  surface2:   '#1a2122',
  surface3:   '#232c2d',
  surface4:   '#2c3738',
  granite:    '#4c5b5c',
  coral:      '#ff715b',
  pollen:     '#f9cb40',
  chartreuse: '#bced09',
  azure:      '#2f52e0',
  text:       '#e6ecec',
  textMid:    '#8a9697',
  textDim:    '#5a6868',
  textFaint:  '#34403f',
  wire:       '#2c3738',
  wireMid:    '#4c5b5c',
} as const;

export const semantic = {
  bg:              brand.canvas,
  surface:         brand.surface1,
  surfaceRaised:   brand.surface2,
  surfaceDeep:     brand.surface3,
  surfacePressed:  brand.surface4,

  border:          brand.wire,
  borderStrong:    brand.wireMid,
  borderSoft:      'rgba(76, 91, 92, 0.22)',

  fg:              brand.text,
  fgMuted:         brand.textMid,
  fgDim:           brand.textDim,
  fgFaint:         brand.textFaint,

  accent:          brand.chartreuse,
  accentCold:      brand.azure,
  accentWarm:      brand.coral,
  accentSoft:      brand.pollen,
  accentTint:      'rgba(188, 237, 9, 0.10)',
  accentGlow:      'rgba(188, 237, 9, 0.18)',
  coldTint:        'rgba(47, 82, 224, 0.10)',
  warmTint:        'rgba(255, 113, 91, 0.08)',

  overlay:         'rgba(8, 12, 13, 0.78)',
} as const;

export const fonts = {
  mono: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
  sans: "'Manrope', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif",
} as const;

export const radii = {
  sm: 2,
  base: 3,
  lg: 6,
} as const;

export const space = {
  s1: 4,
  s2: 8,
  s3: 12,
  s4: 16,
  s5: 20,
  s6: 28,
  s7: 40,
  s8: 64,
} as const;

export const typeScale = {
  eyebrow: 10.5,
  meta:    11,
  body:    13.5,
  label:   12.5,
} as const;

// Legacy aliases — retargeted at the new palette so existing call sites pick
// up the cohesive look without a sweep-rename. New code: use `semantic`.
export const colors = {
  bg:          semantic.bg,
  bgElevated:  semantic.surface,
  bgSurface:   semantic.surfaceRaised,
  border:      semantic.border,
  borderLight: semantic.borderStrong,
  text:        semantic.fg,
  textMuted:   semantic.fgMuted,
  textDim:     semantic.fgDim,
  danger:      '#cc3333',
  dangerLight: '#ff5555',
  errorBg:     '#5c1a1a',
  errorText:   '#ff8888',
  overlay:     semantic.overlay,
  accent:      semantic.accent,
  accent2:     semantic.accentSoft,
};
