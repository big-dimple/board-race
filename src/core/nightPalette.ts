/**
 * nightPalette.ts — committed night-mode color palette.
 *
 * Art direction: cyberpunk night atmosphere, rich deep blues, high readability,
 * sharp crescent moon, silver-blue celestial starfield, and bioluminescent ocean foam.
 *
 * Hex ints for THREE.Color, CSS strings for UI.
 */

export const NIGHT_PALETTE = {
  // Ink
  ink: 0x070b16,
  inkCss: '#070b16',

  // Sky - deep cosmic gradient
  skyZenith: 0x050c1e,
  skyMid: 0x0a1835,
  skyHorizon: 0x12244a,

  // Celestial Moon & Stars
  moonCore: 0xe8f4ff,
  moonHalo: 0x4f7ba8,
  moonCorona: 0x2d4870,
  moonSpike: 0xc8e0ff,
  starCross: 0xe8f4ff,
  starGlow: 0x72a5d8,

  // Night Clouds - deep dark blue silhouette with silver-blue rim
  cloudShade: 0x081326,
  cloudRim: 0x3d648c,
  cloudNear: 0x223654,
  cloudFar: 0x182845,

  // Ocean / Water - rich translucent deep blues with clear depth contrast
  waterDeep: 0x071526,
  oceanDeep: 0x071526,
  waterMid: 0x0c253d,
  oceanMid: 0x0c253d,
  waterCrest: 0x184c68,
  oceanCrest: 0x184c68,
  foam: 0x64e8d8,
  oceanFoam: 0x64e8d8,
  sparkle: 0x8ae8ff,

  // Moon water reflection path & fog horizon tint
  sunWarm: 0x6f9ec4, // moon reflection lane on water (silver-blue moon road)
  fogHorizon: 0x10203e,

  // Fixed sea landmark in night mode
  lighthouseIvory: 0xa6b2c4,
  lighthouseTeal: 0x1d4d5e,
  lighthouseNavy: 0x0d1822,
  lighthouseLens: 0x9fe8ff,

  // Moonlight direction: upper left of forward track heading
  moonDir: [-0.35, 0.16, 0.85] as readonly number[],
} as const;
