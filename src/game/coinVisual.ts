/**
 * coinVisual.ts — minted-metal cel surface + procedural pickup textures.
 *
 * The coin is the one surface in the game that must read as *struck metal*
 * rather than painted plastic, so it cannot use the flat `createToonMaterial`.
 * It keeps every hard cel contract (the same eight-band analytic diffuse, the
 * same baked SUN_DIR, the same hard fresnel step, the same two hard fog bands)
 * and adds three things a flat toon ramp cannot express:
 *
 *   1. MULTI-LOBE SPECULAR — three hard-stepped Blinn lobes instead of one,
 *      so the surface carries a broad sheen, a mid gloss and a hot core.
 *   2. MILLED-EDGE SWEEP — an anisotropic band driven by the angle around the
 *      coin's own mint axis, offset by `uSpin`. As the coin rotates the bright
 *      spokes sweep with it, which is the cue that sells "machined rim".
 *   3. CREAM CHAMFER FRESNEL — the silhouette rim is lit in `foam`/`sunCore`,
 *      not in the body gold. A minted edge catches sky, not body colour.
 *
 * The shadow side mixes toward a saturated deep gold instead of the generic
 * sky-mid tint: metal never goes grey in shadow, it goes deeper in its own hue.
 *
 * Textures are procedural CanvasTextures built once at module scope. Nothing
 * here allocates during the fixed step.
 */
import * as THREE from 'three';
import { PALETTE } from '../core/palette';
import { SUN_DIR } from '../cel/toonMaterial';

export interface CoinSurfaceOptions {
  color: number;
  /** Shadow-side hue. Metal darkens within its own hue rather than greying. */
  deep?: number;
  /** Chamfer colour on the silhouette rim. */
  rimColor?: number;
  rimStrength?: number;
  rimThreshold?: number;
  specColor?: number;
  /** 0 disables the milled sweep; 1 is a full machined rim. */
  milled?: number;
  /** Count of bright spokes travelling around the mint axis. */
  lobes?: number;
  /** Broad / mid / hot specular thresholds. */
  spec1?: number;
  spec2?: number;
  spec3?: number;
  emissive?: number;
  emissiveIntensity?: number;
}

const vertexShader = /* glsl */ `
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
varying vec3 vObjNormal;

void main() {
  vObjNormal = normalize(normal);
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uDeep;
uniform vec3 uRimColor;
uniform float uRimStrength;
uniform float uRimThreshold;
uniform vec3 uSpecColor;
uniform float uSpecPower;
uniform float uSpec1;
uniform float uSpec2;
uniform float uSpec3;
uniform float uMilled;
uniform float uLobes;
uniform float uSpin;
uniform vec3 uEmissive;
uniform float uEmissiveIntensity;
uniform vec3 uSunDir;
uniform vec3 uFogColor;
uniform float uFogBand1;
uniform float uFogBand2;
uniform vec3 uShadowFloor;

varying vec3 vWorldNormal;
varying vec3 vWorldPos;
varying vec3 vObjNormal;

void main() {
  vec3 N = normalize(vWorldNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = uSunDir;

  // ---- DIFFUSE — the same eight authored bands as every other cel surface.
  float ndl = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);
  float band = 0.46
    + step(0.125, ndl) * 0.08
    + step(0.250, ndl) * 0.08
    + step(0.375, ndl) * 0.08
    + step(0.500, ndl) * 0.08
    + step(0.625, ndl) * 0.08
    + step(0.750, ndl) * 0.07
    + step(0.875, ndl) * 0.07;

  // Metal in shade deepens within its own hue instead of drifting to grey.
  vec3 color = mix(uDeep, uColor, band);

  // ---- MULTI-LOBE SPECULAR — three hard steps: sheen, gloss, hot core.
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), uSpecPower);
  float specBand = step(uSpec1, spec) * 0.30
                 + step(uSpec2, spec) * 0.32
                 + step(uSpec3, spec) * 0.38;
  color += uSpecColor * specBand;

  // ---- MILLED-EDGE SWEEP -------------------------------------------------
  // The coin is authored as a disc in XY extruded along local Z, so the rim is
  // exactly where the object normal leaves the axis: rimness peaks at 1 on the
  // milled band and falls to 0 on the flat faces. Within that band the bright
  // spokes are placed by the angle around the mint axis and offset by uSpin,
  // so the highlight travels with the rotation instead of sitting still.
  float axis = abs(normalize(vObjNormal).z);
  float rimness = smoothstep(0.86, 0.995, axis);
  float angle = atan(vObjNormal.y, vObjNormal.x);
  float spokes = pow(max(sin((angle - uSpin) * uLobes * 0.5), 0.0), 18.0);
  float milled = step(0.42, spokes) * 0.55 + step(0.86, spokes) * 0.45;
  color += uSpecColor * milled * rimness * uMilled;

  // ---- CREAM CHAMFER — the silhouette catches sky, not body gold.
  float fresnel = pow(1.0 - max(dot(N, V), 0.0), 2.6);
  color += uRimColor * step(uRimThreshold, fresnel) * uRimStrength;

  color += uEmissive * uEmissiveIntensity;
  color = max(color, uShadowFloor);

  // ---- FOG — the same two hard bands as the rest of the scene.
  float dist = distance(vWorldPos, cameraPosition);
  float fog = (step(uFogBand1, dist) * 0.35 + step(uFogBand2, dist) * 0.45);
  color = mix(color, uFogColor, min(fog, 1.0));

  gl_FragColor = vec4(color, 1.0);
}
`;

function flat(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.NoColorSpace);
}

/**
 * Every coin surface shares the spin uniform, so one write per frame sweeps
 * the milled highlight across the whole marker in lockstep.
 */
const coinMaterials: THREE.ShaderMaterial[] = [];

export function setCoinSpin(spin: number): void {
  for (const material of coinMaterials) material.uniforms.uSpin.value = spin;
}

export function createCoinMaterial(opts: CoinSurfaceOptions): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    name: 'CoinMetal',
    uniforms: {
      uColor: { value: flat(opts.color) },
      uDeep: { value: flat(opts.deep ?? PALETTE.sunFlare) },
      uRimColor: { value: flat(opts.rimColor ?? PALETTE.sunCore) },
      uRimStrength: { value: opts.rimStrength ?? 0.34 },
      uRimThreshold: { value: opts.rimThreshold ?? 0.62 },
      uSpecColor: { value: flat(opts.specColor ?? PALETTE.sparkle) },
      uSpecPower: { value: 96.0 },
      uSpec1: { value: opts.spec1 ?? 0.90 },
      uSpec2: { value: opts.spec2 ?? 0.975 },
      uSpec3: { value: opts.spec3 ?? 0.996 },
      uMilled: { value: opts.milled ?? 0 },
      uLobes: { value: opts.lobes ?? 28 },
      uSpin: { value: 0 },
      uEmissive: { value: flat(opts.emissive ?? 0x000000) },
      uEmissiveIntensity: { value: opts.emissiveIntensity ?? 1.0 },
      uSunDir: { value: SUN_DIR },
      uFogColor: { value: flat(PALETTE.skyHorizon) },
      uFogBand1: { value: 260.0 },
      uFogBand2: { value: 760.0 },
      uShadowFloor: { value: flat(0x3a2a08) },
    },
    vertexShader,
    fragmentShader,
  });
  coinMaterials.push(material);
  return material;
}

// ---------------------------------------------------------------------------
// Procedural pickup textures. Built once, shared by every burst slot.
// ---------------------------------------------------------------------------

function canvas2d(size: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas.getContext('2d')!;
}

function finish(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** Soft radial glow with faint four-point streaks — flash and sparks. */
function buildSpark(): THREE.CanvasTexture {
  const size = 128;
  const ctx = canvas2d(size);
  const half = size / 2;
  const glow = ctx.createRadialGradient(half, half, 0, half, half, half);
  glow.addColorStop(0, 'rgba(255,255,255,1)');
  glow.addColorStop(0.16, 'rgba(255,250,214,0.92)');
  glow.addColorStop(0.42, 'rgba(255,210,63,0.34)');
  glow.addColorStop(1, 'rgba(255,210,63,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);
  // Four thin streaks turn a plain blob into a struck highlight.
  ctx.globalCompositeOperation = 'lighter';
  const streak = ctx.createLinearGradient(0, half, size, half);
  streak.addColorStop(0, 'rgba(255,210,63,0)');
  streak.addColorStop(0.5, 'rgba(255,253,231,0.75)');
  streak.addColorStop(1, 'rgba(255,210,63,0)');
  ctx.fillStyle = streak;
  ctx.fillRect(0, half - 2, size, 4);
  ctx.save();
  ctx.translate(half, half);
  ctx.rotate(Math.PI / 2);
  ctx.translate(-half, -half);
  ctx.fillRect(0, half - 2, size, 4);
  ctx.restore();
  return finish(ctx.canvas);
}

/** Soft annulus — the expanding pickup ring. */
function buildRing(): THREE.CanvasTexture {
  const size = 256;
  const ctx = canvas2d(size);
  const half = size / 2;
  const image = ctx.createImageData(size, size);
  const data = image.data;
  const outer = half;
  const inner = half * 0.52;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - half + 0.5;
      const dy = y - half + 0.5;
      const r = Math.hypot(dx, dy);
      // Two-sided falloff: the annulus fades on both the inner and outer lip,
      // so the ring reads as a pressure wave instead of a hard torus tube.
      const band = 1 - Math.min(1, Math.abs(r - (inner + outer) / 2) / ((outer - inner) / 2));
      const alpha = Math.pow(Math.max(0, band), 1.7);
      const index = (y * size + x) * 4;
      data[index] = 255;
      data[index + 1] = 243;
      data[index + 2] = 176;
      data[index + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
  return finish(ctx.canvas);
}

/** Angled metal chip with a hot leading edge — the shards. */
function buildShard(): THREE.CanvasTexture {
  const size = 64;
  const ctx = canvas2d(size);
  ctx.clearRect(0, 0, size, size);
  ctx.beginPath();
  ctx.moveTo(8, 18);
  ctx.lineTo(52, 6);
  ctx.lineTo(58, 40);
  ctx.lineTo(20, 56);
  ctx.closePath();
  const body = ctx.createLinearGradient(8, 18, 58, 40);
  body.addColorStop(0, 'rgba(255,253,231,0.98)');
  body.addColorStop(0.45, 'rgba(255,210,63,0.92)');
  body.addColorStop(1, 'rgba(196,132,16,0.75)');
  ctx.fillStyle = body;
  ctx.fill();
  // The leading edge is where a torn flake catches the light.
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(8, 18);
  ctx.lineTo(52, 6);
  ctx.stroke();
  return finish(ctx.canvas);
}

interface CoinTextureSet {
  spark: THREE.CanvasTexture;
  ring: THREE.CanvasTexture;
  shard: THREE.CanvasTexture;
}

let textures: CoinTextureSet | null = null;

export function coinTextures(): CoinTextureSet {
  if (!textures) textures = { spark: buildSpark(), ring: buildRing(), shard: buildShard() };
  return textures;
}
