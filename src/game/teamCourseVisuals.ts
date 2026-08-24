import * as THREE from 'three';
import type { Course } from './course';
import { waterHeight } from '../water/waves';
import { LAYER_ENERGY, LAYER_INK, markInk } from '../contracts';

export interface TeamVisualState {
  stageIndex: number;
  anchorUs: readonly number[];
  relayU: number;
  rendezvousU: number;
  anchorsCleared: number;
  relayOpen: boolean;
  wingCleared: boolean;
}

const CYAN = 0x2de4e0;
const LIME = 0xc5f33b;
const CORAL = 0xff536e;
const INK = 0x080b18;

/** Authored world markers for the linked wake, relay, route lock, and reunion. */
export class TeamCourseVisuals {
  readonly object = new THREE.Group();
  private readonly anchors: THREE.Group[] = [];
  private readonly relay: THREE.Group;
  private readonly rendezvous: THREE.Group;
  private readonly lock: THREE.Group;
  private readonly scratch = new THREE.Vector3();
  private state: TeamVisualState | null = null;

  constructor(private readonly course: Course) {
    this.object.name = 'team-course-visuals';
    for (let i = 0; i < 3; i++) {
      const marker = surfaceMarker(CYAN, 2.7 + i * 0.25);
      marker.name = `team-wake-anchor-${i + 1}`;
      this.anchors.push(marker);
      this.object.add(marker);
    }
    this.relay = relayMarker();
    this.relay.name = 'team-surface-relay';
    this.object.add(this.relay);
    this.lock = routeLockMarker();
    this.lock.name = 'team-route-lock';
    this.object.add(this.lock);
    this.rendezvous = reunionMarker();
    this.rendezvous.name = 'team-rendezvous';
    this.object.add(this.rendezvous);
    this.object.visible = false;
  }

  setState(state: TeamVisualState): void {
    this.state = state;
    this.object.visible = true;
  }

  hide(): void {
    this.object.visible = false;
    this.state = null;
  }

  update(t: number): void {
    const state = this.state;
    if (!state || !this.object.visible) return;
    for (let i = 0; i < this.anchors.length; i++) {
      const marker = this.anchors[i];
      placeOnSurface(this.course, marker, state.anchorUs[i], t, this.scratch, 0.22);
      const cleared = i < state.anchorsCleared;
      marker.visible = !cleared;
      marker.rotation.y = t * (0.55 + i * 0.08);
      marker.scale.setScalar(1 + Math.sin(t * 4 + i) * 0.08);
    }
    placeOnSurface(this.course, this.relay, state.relayU, t, this.scratch, 2.5);
    this.relay.rotation.y = Math.sin(t * 0.8) * 0.08;
    tintMarker(this.relay, state.relayOpen ? LIME : CORAL);
    const route = this.course.flightRoutes[state.stageIndex];
    this.course.routePointAt(route.id, route.gateUs[0], this.scratch);
    this.lock.position.set(
      this.scratch.x,
      waterHeight(this.scratch.x, this.scratch.z, t) + 5.2,
      this.scratch.z,
    );
    this.lock.visible = !state.relayOpen;
    this.lock.rotation.y = t * 0.7;
    placeOnSurface(this.course, this.rendezvous, state.rendezvousU, t, this.scratch, 1.3);
    this.rendezvous.visible = state.wingCleared;
    this.rendezvous.rotation.y = -t * 0.35;
  }
}

function surfaceMarker(color: number, radius: number): THREE.Group {
  const group = new THREE.Group();
  const disc = new THREE.Mesh(
    new THREE.RingGeometry(radius * 0.55, radius, 20),
    energyMaterial(color, 0.8),
  );
  disc.rotation.x = -Math.PI / 2;
  disc.layers.enable(LAYER_ENERGY);
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.8, 4), energyMaterial(color, 0.95));
  arrow.position.y = 1.1;
  arrow.rotation.x = Math.PI;
  arrow.layers.enable(LAYER_ENERGY);
  group.add(disc, arrow);
  return group;
}

function relayMarker(): THREE.Group {
  const group = new THREE.Group();
  const posts = new THREE.Mesh(
    new THREE.BoxGeometry(5.8, 4.8, 0.34),
    energyMaterial(CORAL, 0.86),
  );
  posts.layers.enable(LAYER_ENERGY);
  const cutout = new THREE.Mesh(
    new THREE.BoxGeometry(3.8, 3.4, 0.5),
    new THREE.MeshBasicMaterial({ color: INK, toneMapped: false }),
  );
  cutout.position.y = -0.35;
  markInk(cutout);
  group.add(posts, cutout);
  return group;
}

function routeLockMarker(): THREE.Group {
  const group = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(7.4 - i * 1.1, 0.24, 0.24),
      energyMaterial(CORAL, 0.9),
    );
    bar.position.y = (i - 1) * 1.4;
    bar.rotation.z = (i % 2 ? -1 : 1) * 0.34;
    bar.layers.enable(LAYER_ENERGY);
    group.add(bar);
  }
  return group;
}

function reunionMarker(): THREE.Group {
  const group = new THREE.Group();
  const left = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.18, 7, 28), energyMaterial(CYAN, 0.86));
  const right = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.18, 7, 28), energyMaterial(LIME, 0.86));
  left.position.x = -1.55;
  right.position.x = 1.55;
  left.rotation.x = right.rotation.x = Math.PI / 2;
  left.layers.enable(LAYER_ENERGY);
  right.layers.enable(LAYER_ENERGY);
  group.add(left, right);
  return group;
}

function placeOnSurface(
  course: Course,
  object: THREE.Object3D,
  u: number,
  t: number,
  scratch: THREE.Vector3,
  lift: number,
): void {
  course.pointAt(u, scratch);
  object.position.set(scratch.x, waterHeight(scratch.x, scratch.z, t) + lift, scratch.z);
  course.tangentAt(u, scratch);
  object.rotation.y = Math.atan2(scratch.x, scratch.z);
}

function energyMaterial(color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
}

function tintMarker(group: THREE.Group, color: number): void {
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshBasicMaterial)) return;
    if (object.material.color.getHex() === INK) return;
    object.material.color.setHex(color, THREE.NoColorSpace);
  });
}
