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
      const model = document.createElement('span');
      model.className = 'opening-driver-echo-model';
      const headline = document.createElement('span');
      headline.className = 'opening-driver-echo-headline';
      headline.append(name, badge);
      copy.append(headline, model);
      echoRoot.append(rail, portrait, copy);
      this.root.appendChild(echoRoot);
      this.echoes.push({ root: echoRoot, portrait, name, badge, model, anchor: new THREE.Vector3() });
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
      echo.root.classList.toggle('female', female);
      echo.root.dataset.pronouns = profile.pronouns;
      echo.badge.hidden = !female;
      echo.model.textContent = `${profile.name} // ${profile.specialty}`;
    }
  }

  start(duration = 3.6): void {
    this.duration = Math.max(0.1, duration);
    this.elapsed = 0;
    this.activeValue = true;
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
    this.root.classList.remove('on');
    this.root.dataset.beat = 'settled';
    for (const echo of this.echoes) echo.root.classList.remove('visible');
  }

  update(dt: number): void {
    if (!this.activeValue) return;
    this.elapsed = Math.min(this.duration, this.elapsed + Math.max(0, dt));
    const progress = this.duration > 0 ? this.elapsed / this.duration : 1;
    this.root.dataset.beat = progress < 0.2 ? 'intro' : progress < 0.7 ? 'orbit' : 'lock';
    this.camera.updateMatrixWorld();
    const rect = this.viewport.getBoundingClientRect();
    const width = Math.max(1, rect.width || window.innerWidth);
    const height = Math.max(1, rect.height || window.innerHeight);
    for (let i = 0; i < this.echoes.length; i++) {
      const echo = this.echoes[i];
      const boat = this.boats[i];
      const racer = this.roster[i];
      if (!boat || !racer) continue;
      const reveal = smooth((this.elapsed - i * 0.08) / 0.58);
      const outro = smooth((progress - 0.73) / 0.27);
      boat.riderMount.getWorldPosition(echo.anchor);
      echo.anchor.y += 2.05 + Math.sin(this.elapsed * 3.4 + i * 0.75) * 0.08;
      echo.anchor.project(this.camera);
      const visible = echo.anchor.z > -1 && echo.anchor.z < 1 && reveal > 0.01 && outro < 0.99;
      echo.root.classList.toggle('visible', visible);
      this.projectedVisible[i] = visible ? 1 : 0;
      if (!visible) continue;
      const cardWidth = Math.max(144, echo.root.offsetWidth);
      const cardHeight = Math.max(44, echo.root.offsetHeight);
      const halfWidth = cardWidth * 0.5;
      this.projectedWidth[i] = cardWidth;
      this.projectedHeight[i] = cardHeight;
      this.projectedX[i] = clamp((echo.anchor.x * 0.5 + 0.5) * width, halfWidth + 10, width - halfWidth - 10);
      this.projectedY[i] = clamp(
        (1 - (echo.anchor.y * 0.5 + 0.5)) * height,
        cardHeight + 24,
        height - 18,
      );
      echo.root.style.setProperty('--echo-progress', String(reveal * (1 - outro)));
    }

    // Boats can bunch together on the start grid. Keep the identity plates
    // readable by lifting later plates in screen space; world transforms and
    // the boats themselves remain untouched.
    for (let i = 0; i < this.echoes.length; i++) {
      if (!this.projectedVisible[i]) continue;
      let x = this.projectedX[i];
      let y = this.projectedY[i];
      const widthI = this.projectedWidth[i];
      const heightI = this.projectedHeight[i];
      for (let j = 0; j < i; j++) {
        if (!this.projectedVisible[j]) continue;
        const horizontal = Math.abs(x - this.projectedX[j]) < (widthI + this.projectedWidth[j]) * 0.5 + 8;
        const vertical = Math.abs(y - this.projectedY[j]) < (heightI + this.projectedHeight[j]) * 0.5 + 8;
        if (!horizontal || !vertical) continue;
        y = clamp(y - heightI - 10, heightI + 24, height - 18);
        if (Math.abs(y - this.projectedY[j]) < (heightI + this.projectedHeight[j]) * 0.5 + 8) {
          x = clamp(x + widthI * 0.62, widthI * 0.5 + 10, width - widthI * 0.5 - 10);
        }
      }
      this.projectedX[i] = x;
      this.projectedY[i] = y;
      this.echoes[i].root.style.setProperty('--echo-x', `${x}px`);
      this.echoes[i].root.style.setProperty('--echo-y', `${y}px`);
    }
  }
}
