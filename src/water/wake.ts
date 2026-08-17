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
 *  - silhouette = TWO close-in split foam lanes that diverge into the wake,
 *    with a short turbulent center churn and open water between the lanes
 *  - interior variation is a continuous low-frequency flow field; no cell
 *    discard, pixel mosaic, or stamped tread bars are allowed in the foam
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
  // emission off (airborne / dead slot): no foam at all
  if (vIntensity < 0.03) discard;

  float lat = abs(vLat);
  float f = vAgeF;

  // far field: one flat center band, no pattern — kills ribbon shimmer
  if (vDist > 180.0) {
    if (lat > 0.45) discard;
    float af = (f < 0.5 ? 0.5 : 0.25) * mix(0.78, 1.0, uVisualScale);
    gl_FragColor = vec4(uColorFoam, af);
    #include <colorspace_fragment>
    return;
  }

  // ---- silhouette, indexed by METERS ASTERN -------------------------------
  // A production wake is layered in coverage, not stamped into cells:
  // one low-opacity body for displaced water, two soft shoulder crests for
  // the readable V, and a short rounded contact pool under the transom.
  float rhythm = 0.5 + 0.5 * sin(vAlong / (uStamp * 2.8) - uTime * 0.45);
  float close = 1.0 - smoothstep(0.0, 10.0, vBehind);
  float railCenter = mix(0.58, 0.34, exp(-vBehind * 0.032));
  float laneWob = 0.045 * sin(vAlong * 0.19 + sin(vAlong * 0.045) * 1.8);
  float lanePulse = 0.92 + 0.08 * rhythm;
  float laneWidth = mix(0.11, 0.23, close) * lanePulse;
  float laneCenter = railCenter + laneWob;
  float laneDistance = abs(lat - laneCenter);
  float shoulder = 1.0 - smoothstep(laneWidth * 0.52, laneWidth * 1.3, laneDistance);
  float shoulderHalo = 1.0 - smoothstep(laneWidth * 0.8, laneWidth * 2.5, laneDistance);
  float lanePresence = 1.0 - smoothstep(28.0, 92.0, vBehind);

  // The body is deliberately wide and quiet. It prevents the wake from
  // reading as three floating rails while keeping the route and hull visible.
  float bodyWidth = mix(0.68, 0.38, smoothstep(0.0, 62.0, vBehind));
  float body = 1.0 - smoothstep(bodyWidth * 0.48, bodyWidth, lat);
  float bodyFade = 1.0 - smoothstep(36.0, 132.0, vBehind);

  // A rounded pool at the contact point gives the stern a believable push of
  // water before the shoulder crests peel away into the V.
  float contact = (1.0 - smoothstep(0.0, 7.5, vBehind)) *
    (1.0 - smoothstep(0.70, 1.0, lat));
  float coverage = max(body * bodyFade, max(shoulder * lanePresence, contact));
  if (coverage < 0.012) discard;

  // Broad, continuous flow modulation replaces cell-discard breakup. It
  // keeps the wake lively while retaining long coherent foam shoulders.
  float flow = 0.5 + 0.5 * sin(vBehind * 0.58 - uTime * 0.9 + sin(vBehind * 0.13) * 1.1 + lat * 2.0);
  float softBreak = mix(0.76, 1.0, smoothstep(0.12, 0.9, flow));
  float ageFade = 1.0 - smoothstep(52.0, 108.0, vBehind);

  // Reconstruct a rounded foam normal from the live ocean normal plus a pair
  // of long, low-amplitude shoulder ripples. The low frequency is deliberate:
  // specular bands stay connected and read as refracted water, never mosaic.
  vec3 waterN = gerstnerNormal(vWorldPos.xz, uTime);
  float ridge = sin(vBehind * 0.78 - uTime * 1.05 + lat * 2.0);
  vec3 foamN = normalize(vec3(ridge * 0.095, 1.0, cos(vBehind * 0.52 + uTime * 0.65) * 0.075));
  vec3 n = normalize(mix(waterN, foamN, 0.56));
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  vec3 lightDir = normalize(vec3(-0.34, 0.86, 0.39));
  float ndl = clamp(dot(n, lightDir) * 0.5 + 0.5, 0.0, 1.0);
  float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 2.0);
  float specular = pow(max(dot(reflect(-lightDir, n), viewDir), 0.0), 30.0);

  float freshness = 1.0 - smoothstep(8.0, 30.0, vBehind);
  vec3 baseFoam = mix(uColorAged, uColorFoam, freshness);
  float crestMix = clamp(0.28 + shoulder * 0.58 + contact * 0.18 + ndl * 0.28 + specular * 0.16 + fresnel * 0.08, 0.0, 1.0);
  vec3 col = mix(uColorWash, baseFoam, crestMix);
  float bodyAlpha = body * bodyFade * (0.052 + 0.065 * freshness + 0.065 * ndl);
  float haloAlpha = shoulderHalo * lanePresence * (0.055 + 0.06 * freshness);
  float crestAlpha = shoulder * lanePresence * (0.25 + 0.30 * freshness + 0.16 * ndl + 0.10 * specular);
  float contactAlpha = contact * (0.10 + 0.18 * freshness + 0.10 * ndl);
  float a = (bodyAlpha + haloAlpha + crestAlpha + contactAlpha) * softBreak * ageFade;
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
