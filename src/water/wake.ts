/**
 * wake.ts — persistent stylized wake ribbon behind a boat.
 *
 * Ring buffer of ~360 deposited stern points (min spacing 0.45 m), rendered
 * as a single triangle strip — one draw call, one preallocated geometry,
 * zero per-frame allocation (attributes are rewritten in place only when a
 * new deposit lands).
 *
 * Look (Wave Race 64 x anime ink), fully procedural — no texture:
 *  - ribbon is 2.5 m wide at the transom and spreads with DISTANCE ASTERN
 *    (fixed geometric V angle, speed-independent), capped by a speed-scaled
 *    max width — slow boats leave a narrow V, fast boats a wide one
 *  - silhouette = one broad aerated stern wash; broken Kelvin shoulders peel
 *    away as secondary detail instead of becoming two continuous rails
 *  - interior variation is a continuous low-frequency flow field; no cell
 *    kill, pixel mosaic, or stamped tread bars are allowed in the foam
 *  - a live Gerstner normal is blended with broad shoulder ripples so the
 *    white water carries one coherent soft highlight instead of flat rails
 *  - dissipation is a smooth distance/freshness envelope, preserving a
 *    readable near-field contact layer and a restrained far-field trace
 *  - intensity 0 (airborne) emits nothing — the strip segment just fades
 *  - Y rides waveHeight(worldXZ, uTime) + lift so the wake sits on the
 *    swell and never clips through waves
 *  - beyond ~180 m the pattern collapses to one flat center band (no shimmer)
 */

import * as THREE from 'three';
import type { IWake } from '../contracts';
import { PALETTE } from '../core/palette';
import { WAVES_GLSL } from './waves';

const MAX_POINTS = 360; // ring capacity -> 720 verts, 718 tris
const MIN_SPACING = 0.45; // meters between deposits; keeps turning shoulders round
const TELEPORT_DIST = 8.0; // jump larger than this -> hard reset, no streak
const INTERACTION_LIFE = 2.35; // only the fresh, energetic part can move a hull
const INTERACTION_SAMPLES = 96; // bounded recent history; older foam is visual only

function smooth01(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

const VERT = /* glsl */ `
uniform float uTime;
uniform float uLife;      // seconds to full age / final fade step
uniform float uWidth0;    // half-width at the transom (m)
uniform float uSpread;    // half-width growth per meter astern (tan of arm angle)
uniform float uWidthMin;  // half-width cap at zero speed (m)
uniform float uWidthMax;  // half-width cap at full speed (m)
uniform float uLift;      // ride height above the wave surface (m)
uniform float uHeadAlong; // aAlong of the newest deposit (m)
uniform float uVisualScale; // per-boat clutter scale (player 1, rivals slightly lower)

attribute vec2 aPerp;       // unit lateral direction at deposit time
attribute float aSide;      // -1 / +1 ribbon edge
attribute float aBirth;     // deposit time (s)
attribute float aIntensity; // 0..1 at deposit time
attribute float aAlong;     // meters along the ribbon from the tail

varying float vLat;
varying float vAgeF;
varying float vIntensity;
varying float vAlong;
varying float vHalfW;
varying float vDist;
varying float vBehind;
varying vec3 vWorldPos;

${WAVES_GLSL}

void main() {
  float age = uTime - aBirth;
  float f = clamp(age / uLife, 0.0, 1.0);
  float behind = max(uHeadAlong - aAlong, 0.0);

  // the V shape: geometric spread with distance astern, capped by a
  // speed-scaled max width (foam density/width scale with speed)
  float wCap = mix(uWidthMin, uWidthMax, aIntensity);
  float halfW = min(uWidth0 + uSpread * behind, wCap) * uVisualScale;

  vec2 wxz = position.xz + aPerp * (aSide * halfW);

  // ride the swell, never clip through it
  float y = waveHeight(wxz, uTime) + uLift;

  vLat = aSide;
  vAgeF = f;
  // dead slots (never written / expired) emit nothing
  vIntensity = (age >= uLife || age < 0.0) ? 0.0 : aIntensity;
  vAlong = aAlong;
  vHalfW = halfW;
  vBehind = behind;

  vec4 mv = modelViewMatrix * vec4(wxz.x, y, wxz.y, 1.0);
  vWorldPos = (modelMatrix * vec4(wxz.x, y, wxz.y, 1.0)).xyz;
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColorFoam;
uniform vec3 uColorWash; // mid-age foam: one tone step between fresh and aged
uniform vec3 uColorAged; // aged foam: stepped toward the water tone (interior variation)
uniform float uTime;
uniform float uStamp; // broad rhythm scale for the continuous flow field
uniform float uVisualScale;

varying float vLat;
varying float vAgeF;
varying float vIntensity;
varying float vAlong;
varying float vHalfW;
varying float vDist;
varying float vBehind;
varying vec3 vWorldPos;

${WAVES_GLSL}

void main() {
  float lat = abs(vLat);
  float f = vAgeF;
  float emitted = step(0.03, vIntensity);
  float farField = step(180.0, vDist);
  float farVisible = 1.0 - farField * step(0.45, lat);

  // far field: one flat center band, no pattern — kills ribbon shimmer
  if (farField > 0.5) {
    float af = (f < 0.5 ? 0.5 : 0.25) * mix(0.78, 1.0, uVisualScale);
    gl_FragColor = vec4(uColorFoam, af * emitted * farVisible);
    #include <colorspace_fragment>
    return;
  }

  // ---- silhouette, indexed by METERS ASTERN -------------------------------
  // The center wash owns the silhouette. Its smooth, overlapping wave beats
  // imply entrained air without stamped cells or a filled road-shaped core.
  float centerWidth = mix(0.58, 0.28, smoothstep(0.0, 78.0, vBehind));
  float center = 1.0 - smoothstep(centerWidth * 0.34, centerWidth, lat);
  float centerFade = 1.0 - smoothstep(54.0, 138.0, vBehind);
  float longFlow = 0.5 + 0.28 * sin(vBehind * 0.47 - uTime * 1.35) +
    0.14 * sin(vBehind * 0.19 + lat * 4.2 + uTime * 0.62) +
    0.08 * sin(vBehind * 0.91 - lat * 2.7 - uTime * 1.8);
  float crossFlow = 0.5 + 0.32 * sin(vBehind * 0.31 + lat * 5.1 - uTime * 1.0) +
    0.18 * sin(vBehind * 0.73 - lat * 3.4 + uTime * 1.55);
  // Longitudinal peaks open and close whole foam pockets; the cross field
  // only roughens their edges. Multiplying two hard masks leaves isolated
  // pinholes, while a continuous baseline turns the ribbon back into a road.
  float pocket = smoothstep(0.52, 0.71, longFlow);
  float edgeTurbulence = smoothstep(0.38, 0.68, crossFlow);
  float churn = pocket * mix(0.48, 1.0, edgeTurbulence);

  // Broken Kelvin shoulders are readable up close but never form continuous
  // bright rails. Alternating broad beats leave open-water gaps along the V.
  float shoulderCenter = mix(0.72, 0.55, smoothstep(0.0, 62.0, vBehind));
  shoulderCenter += 0.035 * sin(vBehind * 0.16 + sin(vBehind * 0.045) * 1.4);
  float shoulderDistance = abs(lat - shoulderCenter);
  float shoulderWidth = mix(0.18, 0.095, smoothstep(0.0, 46.0, vBehind));
  float shoulderShape = 1.0 - smoothstep(shoulderWidth * 0.42, shoulderWidth, shoulderDistance);
  float shoulderBeat = 0.5 + 0.32 * sin(vBehind * 0.41 - uTime * 1.1) +
    0.18 * sin(vBehind * 0.17 + uTime * 0.46);
  float shoulderBreak = smoothstep(0.46, 0.68, shoulderBeat);
  float shoulder = shoulderShape * shoulderBreak * (1.0 - smoothstep(34.0, 104.0, vBehind));

  // Rounded transom churn joins both sides only at the actual stern. It must
  // end before it can become a long translucent road under the broken wash.
  float contactBeat = 0.5 + 0.34 * sin(vBehind * 1.18 - uTime * 1.7 + lat * 3.2) +
    0.16 * sin(vBehind * 2.3 + uTime * 1.1 - lat * 4.6);
  float contact = (1.0 - smoothstep(0.4, 4.2, vBehind)) *
    (1.0 - smoothstep(0.52, 0.92, lat)) * smoothstep(0.34, 0.62, contactBeat);
  float body = center * centerFade * churn;
  float coverage = max(body, max(shoulder, contact));
  float coverageMask = smoothstep(0.12, 0.32, coverage);

  float ageFade = (1.0 - smoothstep(64.0, 142.0, vBehind)) *
    (1.0 - smoothstep(0.62, 1.0, f));

  // Reconstruct a rounded foam normal from the live ocean normal plus a pair
  // of long, low-amplitude shoulder ripples. The low frequency is deliberate:
  // specular bands stay connected and read as refracted water, never mosaic.
  vec3 waterN = gerstnerNormal(vWorldPos.xz, uTime);
  float ridge = sin(vBehind * 0.62 - uTime * 1.15 + lat * 2.4);
  vec3 foamN = normalize(vec3(ridge * 0.075, 1.0, cos(vBehind * 0.38 + uTime * 0.72) * 0.065));
  vec3 n = normalize(mix(waterN, foamN, 0.52));
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  vec3 lightDir = normalize(vec3(-0.34, 0.86, 0.39));
  float ndl = clamp(dot(n, lightDir) * 0.5 + 0.5, 0.0, 1.0);
  float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 2.0);
  float specular = pow(max(dot(reflect(-lightDir, n), viewDir), 0.0), 30.0);

  float freshness = 1.0 - smoothstep(8.0, 30.0, vBehind);
  vec3 baseFoam = mix(uColorAged, uColorFoam, freshness);
  float innerFroth = body * (1.0 - smoothstep(centerWidth * 0.18, centerWidth * 0.62, lat));
  float crestMix = clamp(0.28 + body * 0.18 + shoulder * 0.28 + contact * 0.2 +
    innerFroth * 0.34 + ndl * 0.26 + specular * 0.14 + fresnel * 0.08, 0.0, 1.0);
  vec3 col = mix(uColorWash, baseFoam, crestMix);
  col = mix(col, uColorFoam, innerFroth * 0.24);
  float bodyAlpha = body * (0.29 + 0.32 * freshness + 0.11 * ndl) + innerFroth * 0.1;
  float crestAlpha = shoulder * (0.03 + 0.05 * freshness + 0.02 * ndl + 0.015 * specular);
  float contactAlpha = contact * (0.16 + 0.18 * freshness + 0.08 * ndl);
  float a = (bodyAlpha + crestAlpha + contactAlpha) * ageFade * coverageMask * emitted;
  a *= (vIntensity > 0.5 ? 1.0 : 0.82) * mix(0.78, 1.0, uVisualScale);
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

export class WakeRibbon implements IWake {
  readonly object: THREE.Object3D;

  private readonly uniforms: Record<string, THREE.IUniform>;

  // deposit ring buffer (slot data)
  private readonly cx = new Float32Array(MAX_POINTS);
  private readonly cz = new Float32Array(MAX_POINTS);
  private readonly px = new Float32Array(MAX_POINTS);
  private readonly pz = new Float32Array(MAX_POINTS);
  private readonly birth = new Float32Array(MAX_POINTS);
  private readonly inten = new Float32Array(MAX_POINTS);
  private readonly along = new Float32Array(MAX_POINTS);

  // geometry attribute backing arrays (2 verts per deposit)
  private readonly aPos = new Float32Array(MAX_POINTS * 2 * 3);
  private readonly aPerp = new Float32Array(MAX_POINTS * 2 * 2);
  private readonly aSide = new Float32Array(MAX_POINTS * 2);
  private readonly aBirth = new Float32Array(MAX_POINTS * 2);
  private readonly aInten = new Float32Array(MAX_POINTS * 2);
  private readonly aAlong = new Float32Array(MAX_POINTS * 2);
  private readonly attrPos: THREE.BufferAttribute;
  private readonly attrPerp: THREE.BufferAttribute;
  private readonly attrSide: THREE.BufferAttribute;
  private readonly attrBirth: THREE.BufferAttribute;
  private readonly attrInten: THREE.BufferAttribute;
  private readonly attrAlong: THREE.BufferAttribute;

  private readonly geometry: THREE.BufferGeometry;
  private cursor = 0;
  private count = 0;
  private lastX = 0;
  private lastZ = 0;
  private lastAlong = 0;
  private hasLast = false;
  private time = 0;
  private dirty = true;

  constructor() {
    const geometry = new THREE.BufferGeometry();
    this.geometry = geometry;

    const dyn = THREE.DynamicDrawUsage;
    this.attrPos = new THREE.BufferAttribute(this.aPos, 3).setUsage(dyn);
    this.attrPerp = new THREE.BufferAttribute(this.aPerp, 2).setUsage(dyn);
    this.attrSide = new THREE.BufferAttribute(this.aSide, 1).setUsage(dyn);
    this.attrBirth = new THREE.BufferAttribute(this.aBirth, 1).setUsage(dyn);
    this.attrInten = new THREE.BufferAttribute(this.aInten, 1).setUsage(dyn);
    this.attrAlong = new THREE.BufferAttribute(this.aAlong, 1).setUsage(dyn);
    // dead slots: birth far in the past -> shader alpha 0
    this.aBirth.fill(-1e9);
    geometry.setAttribute('position', this.attrPos);
    geometry.setAttribute('aPerp', this.attrPerp);
    geometry.setAttribute('aSide', this.attrSide);
    geometry.setAttribute('aBirth', this.attrBirth);
    geometry.setAttribute('aIntensity', this.attrInten);
    geometry.setAttribute('aAlong', this.attrAlong);

    // static strip indices over the ordered (oldest -> newest) vertex pairs
    const indices: number[] = [];
    for (let i = 0; i < MAX_POINTS - 1; i++) {
      const v = i * 2;
      indices.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    }
    geometry.setIndex(indices);
    geometry.setDrawRange(0, 0);

    this.uniforms = {
      uTime: { value: 0 },
      uLife: { value: 5.2 },
      uWidth0: { value: 0.78 },
      uSpread: { value: 0.13 },
      uWidthMin: { value: 1.35 },
      uWidthMax: { value: 2.35 },
      uLift: { value: 0.14 },
      uHeadAlong: { value: 0 },
      uVisualScale: { value: 1 },
      uStamp: { value: 2.4 },
      uColorFoam: { value: new THREE.Color(PALETTE.foam) },
      uColorWash: {
        value: new THREE.Color(PALETTE.foam).lerp(new THREE.Color(PALETTE.waterMid), 0.34),
      },
      uColorAged: {
        value: new THREE.Color(PALETTE.foam).lerp(new THREE.Color(PALETTE.waterMid), 0.58),
      },
    };

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;

    this.object = mesh;
  }

  setVisualScale(scale: number): void {
    this.uniforms.uVisualScale.value = Math.min(1, Math.max(0.75, scale));
  }

  push(pos: THREE.Vector3, dirX: number, dirZ: number, intensity: number): void {
    const dx = pos.x - this.lastX;
    const dz = pos.z - this.lastZ;
    if (this.hasLast) {
      const d2 = dx * dx + dz * dz;
      if (d2 < MIN_SPACING * MIN_SPACING) return; // too soon, keep last deposit
      if (d2 > TELEPORT_DIST * TELEPORT_DIST) this.clear(); // respawn: no streak
    }
    const i = this.cursor;
    const dist = this.hasLast ? Math.sqrt(dx * dx + dz * dz) : 0;
    this.lastAlong += dist;

    this.cx[i] = pos.x;
    this.cz[i] = pos.z;
    // lateral = perpendicular of the boat forward dir (V-spread direction)
    this.px[i] = -dirZ;
    this.pz[i] = dirX;
    this.birth[i] = this.time;
    this.inten[i] = Math.min(1, Math.max(0, intensity));
    this.along[i] = this.lastAlong;

    this.cursor = (this.cursor + 1) % MAX_POINTS;
    if (this.count < MAX_POINTS) this.count++;
    this.lastX = pos.x;
    this.lastZ = pos.z;
    this.hasLast = true;
    this.dirty = true;
  }

  /**
   * Return the live crest of this wake at one hull probe.
   *
   * The renderer keeps a much longer ribbon, but only the newest samples are
   * energetic enough to move another boat. The result is packed into a caller
   * supplied vector: x = lift (m), y = signed cross-wake side, z = strength.
   */
  sampleInteraction(x: number, z: number, t: number, out: THREE.Vector3): void {
    let lift = 0;
    let side = 0;
    let strength = 0;
    const samples = Math.min(this.count, INTERACTION_SAMPLES);
    for (let n = 0; n < samples; n++) {
      const slot = (this.cursor - 1 - n + MAX_POINTS) % MAX_POINTS;
      const age = t - this.birth[slot];
      if (age < 0 || age > INTERACTION_LIFE) continue;

      const dx = x - this.cx[slot];
      const dz = z - this.cz[slot];
      // px/pz is the stored cross-wake direction. Recover the forward vector
      // used when the stern point was deposited; only the astern side carries
      // the wake crest.
      const forwardX = this.pz[slot];
      const forwardZ = -this.px[slot];
      const behind = -(dx * forwardX + dz * forwardZ);
      if (behind < -1.8 || behind > 22) continue;

      const cross = dx * this.px[slot] + dz * this.pz[slot];
      const radius = 1.25 + this.inten[slot] * 0.9 + Math.min(0.75, Math.max(behind, 0) * 0.035);
      const corridor = 1 - smooth01(Math.abs(cross) / radius);
      if (corridor <= 0) continue;
      const fresh = 1 - smooth01(age / INTERACTION_LIFE);
      const distanceFade = 1 - smooth01(Math.max(behind, 0) / 22);
      const hit = corridor * fresh * distanceFade * this.inten[slot];
      if (hit <= 0) continue;

      // Two alternating crest beats make a boat rise and settle instead of
      // receiving a constant lift. This is deliberately restrained arcade
      // coupling, not a second buoyancy solver.
      const crest = 0.5 + 0.5 * Math.sin(Math.max(behind, 0) * 0.62 - t * 1.65 + slot * 0.17);
      const crestLift = hit * (0.08 + crest * 0.22);
      lift = Math.min(0.42, lift + crestLift);
      side += (cross / Math.max(radius, 0.001)) * hit;
      strength = Math.min(1, strength + hit * 0.72);
    }
    out.set(lift, Math.max(-1, Math.min(1, side)), strength);
  }

  update(dt: number, t: number): void {
    void dt; // age is driven by absolute time (aBirth), not integration
    this.time = t;
    this.uniforms.uTime.value = t;
    this.uniforms.uHeadAlong.value = this.lastAlong;
    if (!this.dirty) return;
    this.dirty = false;

    // rewrite the strip oldest -> newest from the ring, in place
    const n = this.count;
    for (let i = 0; i < n; i++) {
      const slot = (this.cursor - n + i + MAX_POINTS) % MAX_POINTS;
      const v = i * 2;
      this.aPos[v * 3] = this.cx[slot];
      this.aPos[v * 3 + 1] = 0;
      this.aPos[v * 3 + 2] = this.cz[slot];
      this.aPos[v * 3 + 3] = this.cx[slot];
      this.aPos[v * 3 + 4] = 0;
      this.aPos[v * 3 + 5] = this.cz[slot];
      this.aPerp[v * 2] = this.px[slot];
      this.aPerp[v * 2 + 1] = this.pz[slot];
      this.aPerp[v * 2 + 2] = this.px[slot];
      this.aPerp[v * 2 + 3] = this.pz[slot];
      this.aSide[v] = -1;
      this.aSide[v + 1] = 1;
      this.aBirth[v] = this.birth[slot];
      this.aBirth[v + 1] = this.birth[slot];
      this.aInten[v] = this.inten[slot];
      this.aInten[v + 1] = this.inten[slot];
      this.aAlong[v] = this.along[slot];
      this.aAlong[v + 1] = this.along[slot];
    }
    this.attrPos.needsUpdate = true;
    this.attrPerp.needsUpdate = true;
    this.attrSide.needsUpdate = true;
    this.attrBirth.needsUpdate = true;
    this.attrInten.needsUpdate = true;
    this.attrAlong.needsUpdate = true;
    this.geometry.setDrawRange(0, n >= 2 ? (n - 1) * 6 : 0);
  }

  clear(): void {
    this.count = 0;
    this.cursor = 0;
    this.hasLast = false;
    this.lastAlong = 0;
    this.dirty = true;
  }
}
