import * as THREE from 'three';
import type { Boat } from '../game/boat';
import type { RacerDefinition } from '../contracts';
import { driverProfile } from '../game/racers';
import './openingShowcase.css';

type Echo = {
  readonly root: HTMLDivElement;
  readonly portrait: HTMLImageElement;
  readonly name: HTMLSpanElement;
  readonly badge: HTMLSpanElement;
  readonly selfBadge: HTMLSpanElement;
  readonly model: HTMLSpanElement;
  readonly anchor: THREE.Vector3;
};

const clamp = (value: number, lo: number, hi: number): number =>
  value < lo ? lo : value > hi ? hi : value;

const smooth = (value: number): number => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * A short, input-locked presentation layer for the start grid. It uses the
 * already-loaded portrait URLs as DOM billboards, so the art can be rich
 * without adding persistent WebGL draws to the race.
 */
export class OpeningShowcase {
  readonly root: HTMLDivElement;
  private readonly echoes: Echo[] = [];
  private readonly camera: THREE.PerspectiveCamera;
  private readonly viewport: HTMLElement;
  private readonly boats: readonly Boat[];
  private roster: readonly RacerDefinition[];
  private readonly projectedX: Float32Array;
  private readonly projectedY: Float32Array;
  private readonly smoothX: Float32Array;
  private readonly smoothY: Float32Array;
  private readonly smoothInit: Uint8Array;
  private readonly projectedWidth: Float32Array;
  private readonly projectedHeight: Float32Array;
  private readonly projectedVisible: Uint8Array;
  private elapsed = 0;
  private duration = 0;
  private activeValue = false;

  constructor(
    parent: HTMLElement,
    camera: THREE.PerspectiveCamera,
    viewport: HTMLElement,
    boats: readonly Boat[],
    roster: readonly RacerDefinition[],
  ) {
    this.camera = camera;
    this.viewport = viewport;
    this.boats = boats;
    this.roster = roster;
    this.projectedX = new Float32Array(boats.length);
    this.projectedY = new Float32Array(boats.length);
    this.smoothX = new Float32Array(boats.length);
    this.smoothY = new Float32Array(boats.length);
    this.smoothInit = new Uint8Array(boats.length);
    this.projectedWidth = new Float32Array(boats.length);
    this.projectedHeight = new Float32Array(boats.length);
    this.projectedVisible = new Uint8Array(boats.length);
    this.root = document.createElement('div');
    this.root.className = 'opening-showcase';
    this.root.setAttribute('aria-hidden', 'true');
    parent.appendChild(this.root);

    for (let i = 0; i < boats.length; i++) {
      const echoRoot = document.createElement('div');
      echoRoot.className = 'opening-driver-echo';
      echoRoot.dataset.index = String(i);
      const rail = document.createElement('i');
      rail.className = 'opening-driver-echo-rail';
      const portrait = document.createElement('img');
      portrait.className = 'opening-driver-echo-portrait';
      portrait.alt = '';
      portrait.draggable = false;
      portrait.decoding = 'async';
      const copy = document.createElement('span');
      copy.className = 'opening-driver-echo-copy';
      const name = document.createElement('span');
      name.className = 'opening-driver-echo-name';
      const badge = document.createElement('span');
      badge.className = 'opening-driver-echo-badge';
      badge.textContent = '女将';
      const selfBadge = document.createElement('span');
      selfBadge.className = 'opening-driver-echo-self';
      selfBadge.textContent = '本人出击';
      const model = document.createElement('span');
      model.className = 'opening-driver-echo-model';
      const headline = document.createElement('span');
      headline.className = 'opening-driver-echo-headline';
      headline.append(name, selfBadge, badge);
      copy.append(headline, model);
      const sparkContainer = document.createElement('div');
      sparkContainer.className = 'opening-driver-spark-container';
      const sparkHead = document.createElement('span');
      sparkHead.className = 'opening-driver-spark-dot head';
      const sparkTrail1 = document.createElement('span');
      sparkTrail1.className = 'opening-driver-spark-dot trail-1';
      const sparkTrail2 = document.createElement('span');
      sparkTrail2.className = 'opening-driver-spark-dot trail-2';
      const sparkTrail3 = document.createElement('span');
      sparkTrail3.className = 'opening-driver-spark-dot trail-3';
      sparkContainer.append(sparkHead, sparkTrail1, sparkTrail2, sparkTrail3);
      echoRoot.append(sparkContainer, rail, portrait, copy);
      this.root.appendChild(echoRoot);
      this.echoes.push({ root: echoRoot, portrait, name, badge, selfBadge, model, anchor: new THREE.Vector3() });
    }
    this.setRoster(roster);
  }

  get active(): boolean {
    return this.activeValue;
  }

  get finished(): boolean {
    return !this.activeValue || this.elapsed >= this.duration;
  }

  setRoster(roster: readonly RacerDefinition[]): void {
    this.roster = roster;
    for (let i = 0; i < this.echoes.length; i++) {
      const echo = this.echoes[i];
      const racer = roster[i];
      if (!racer) {
        echo.root.hidden = true;
        continue;
      }
      const profile = driverProfile(racer.profileId);
      echo.root.hidden = false;
      echo.root.style.setProperty('--echo-color', `#${profile.color.toString(16).padStart(6, '0')}`);
      echo.portrait.src = profile.portraitUrl;
      echo.portrait.style.objectPosition = profile.portraitPosition;
      echo.name.textContent = profile.callsign;
      const female = profile.pronouns === '她';
      const isPlayer = Boolean(racer.isPlayer);
      echo.root.classList.toggle('female', female);
      echo.root.classList.toggle('is-player', isPlayer);
      echo.root.dataset.pronouns = profile.pronouns;
      echo.badge.hidden = !female;
      echo.selfBadge.hidden = !isPlayer;
      echo.model.textContent = `${profile.name} // ${profile.specialty}`;
    }
  }

  start(duration = 5.6): void {
    this.duration = Math.max(0.1, duration);
    this.elapsed = 0;
    this.activeValue = true;
    this.smoothInit.fill(0);
    this.root.classList.add('on');
    this.root.dataset.beat = 'intro';
    for (const echo of this.echoes) {
      echo.root.classList.remove('visible');
      echo.root.style.setProperty('--echo-progress', '0');
      echo.root.style.removeProperty('--echo-x');
      echo.root.style.removeProperty('--echo-y');
    }
  }

  stop(): void {
    this.activeValue = false;
    this.elapsed = 0;
    this.smoothInit.fill(0);
    this.root.classList.remove('on');
    this.root.dataset.beat = 'settled';
    for (const echo of this.echoes) echo.root.classList.remove('visible');
  }

  update(dt: number): void {
    if (!this.activeValue) return;
    this.elapsed = Math.min(this.duration, this.elapsed + Math.max(0, dt));
    const progress = this.duration > 0 ? this.elapsed / this.duration : 1;
    this.root.dataset.beat = progress < 0.2 ? 'intro' : progress < 0.75 ? 'orbit' : 'lock';
    this.camera.updateMatrixWorld();
    const rect = this.viewport.getBoundingClientRect();
    const width = Math.max(1, rect.width || window.innerWidth);
    const height = Math.max(1, rect.height || window.innerHeight);

    for (let i = 0; i < this.echoes.length; i++) {
      const echo = this.echoes[i];
      const boat = this.boats[i];
      const racer = this.roster[i];
      if (!boat || !racer) continue;
      const reveal = smooth((this.elapsed - i * 0.12) / 0.65);
      const outro = smooth((progress - 0.78) / 0.22);
      boat.riderMount.getWorldPosition(echo.anchor);
      echo.anchor.y += 2.2 + (i % 2 === 1 ? 0.35 : 0);
      echo.anchor.project(this.camera);
      const visible = echo.anchor.z > -1 && echo.anchor.z < 1 && reveal > 0.01 && outro < 0.99;
      echo.root.classList.toggle('visible', visible);
      this.projectedVisible[i] = visible ? 1 : 0;
      if (!visible) continue;

      const cardWidth = Math.max(140, echo.root.offsetWidth || 160);
      const cardHeight = Math.max(44, echo.root.offsetHeight || 56);
      const halfWidth = cardWidth * 0.5;
      this.projectedWidth[i] = cardWidth;
      this.projectedHeight[i] = cardHeight;

      const targetX = clamp((echo.anchor.x * 0.5 + 0.5) * width, halfWidth + 12, width - halfWidth - 12);
      const targetY = clamp((1 - (echo.anchor.y * 0.5 + 0.5)) * height, cardHeight + 16, height - 16);

      if (!this.smoothInit[i]) {
        this.smoothX[i] = targetX;
        this.smoothY[i] = targetY;
        this.smoothInit[i] = 1;
      } else {
        const lerpK = 1 - Math.exp(-14 * dt);
        this.smoothX[i] += (targetX - this.smoothX[i]) * lerpK;
        this.smoothY[i] += (targetY - this.smoothY[i]) * lerpK;
      }

      echo.root.style.setProperty('--echo-x', `${this.smoothX[i].toFixed(1)}px`);
      echo.root.style.setProperty('--echo-y', `${this.smoothY[i].toFixed(1)}px`);
      echo.root.style.setProperty('--echo-progress', String(reveal * (1 - outro)));
    }
  }
}
