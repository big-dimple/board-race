/**
 * palette.ts — the committed, game-wide color palette.
 *
 * Art direction: bright anime midday, high saturation, warm sun.
 * Every surface in the game pulls from these values and nothing else.
 * Hex ints are for THREE.Color, CSS strings are for the HUD.
 */

export const PALETTE = {
  // Ink — deep indigo, never pure black. Used for outlines, edge lines, UI strokes.
  ink: 0x14122b,
  inkCss: '#14122b',

  // Sky
  skyZenith: 0x2e6df6,
  skyMid: 0x43b6ff,
  skyHorizon: 0xaef4ff,
  sunCore: 0xfff3b0,
  sunFlare: 0xffd23f,
  cloudBody: 0xffffff,
  cloudShade: 0xb8e0f5,
  cloudRim: 0xffd9a0,

  // Water — banded: deep / mid / crest / foam
  waterDeep: 0x0a2a6b,
  waterMid: 0x0f5cc9,
  waterCrest: 0x22d3e2,
  foam: 0xf4feff,
  sparkle: 0xfffde7,

  // Gameplay
  racingLine: 0x39ff88,
  boost: 0x7CFC00,

  // Racer hull colors: player, REEF (aggressive), KAI (clean), JINX (erratic)
  hullPlayer: 0xff3d7f,
  hullReef: 0xff7847,
  hullKai: 0xffd23f,
  hullJinx: 0x8a5cff,

  // UI
  uiPanel: 0x10173a,
  uiPanelCss: 'rgba(16, 23, 58, 0.82)',
  uiText: 0xf4feff,
  uiTextCss: '#f4feff',
  uiAccent: 0x39ff88,
  uiAccentCss: '#39ff88',
  uiWarn: 0xff3d7f,
  uiWarnCss: '#ff3d7f',
  /** Direction TOWARD the sun (normalize before use). Shared by sky, toon lighting, water spec. */
  sunDir: [0.5, 0.55, 0.55] as readonly number[],
} as const;

export const RACER_COLORS = [
  PALETTE.hullPlayer,
  PALETTE.hullReef,
  PALETTE.hullKai,
  PALETTE.hullJinx,
];

export const RACER_NAMES = ['YOU', 'REEF', 'KAI', 'JINX'];
