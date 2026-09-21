export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  xxxl: 40,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  pill: 999,
} as const;

export const typography = {
  largeTitle: { fontSize: 32, fontWeight: '700' as const, letterSpacing: -0.6 },
  title: { fontSize: 22, fontWeight: '700' as const, letterSpacing: -0.4 },
  headline: { fontSize: 17, fontWeight: '600' as const, letterSpacing: -0.2 },
  body: { fontSize: 15, fontWeight: '400' as const, letterSpacing: -0.1 },
  bodyStrong: { fontSize: 15, fontWeight: '600' as const, letterSpacing: -0.1 },
  callout: { fontSize: 14, fontWeight: '400' as const },
  caption: { fontSize: 13, fontWeight: '400' as const },
  captionStrong: { fontSize: 13, fontWeight: '600' as const },
  micro: { fontSize: 11, fontWeight: '600' as const, letterSpacing: 0.3 },
} as const;
