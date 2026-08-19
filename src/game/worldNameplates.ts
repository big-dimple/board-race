/**
 * Retired race-world identity layer.
 *
 * M14 removes the old English labels that floated above boats during a race.
 * The opening showcase owns its own portrait/callsign presentation; this
 * group remains as an explicit zero-instance scene marker until the official
 * SVG identity task supplies the replacement side anchor.
 */
import * as THREE from 'three';
import type { IBoat } from '../contracts';

export interface WorldNameplateTarget {
  readonly boat: IBoat;
  readonly name: string;
}

export class WorldNameplates {
  readonly object: THREE.Group;

  constructor(_camera: THREE.PerspectiveCamera, _targets: readonly WorldNameplateTarget[]) {
    this.object = new THREE.Group();
    this.object.name = 'world-nameplates';
    this.object.visible = false;
    this.object.userData.owner = 'M14-retired-world-nameplates';
    this.object.userData.capacity = 0;
    this.object.userData.visibleLabels = 0;
    this.object.userData.peakVisibleLabels = 0;
    this.object.userData.drawInstances = 0;
    this.object.userData.activeIdentityInstances = 0;
    this.object.userData.reason = 'official-logo-svg-deferred';
  }

  /** The replacement logo task will own the next identity asset contract. */
  setNames(_names: readonly string[]): void {
    // Keep the existing roster update call harmless while the layer is retired.
  }

  /** Keep the scene marker hidden and prove that no identity instances submit. */
  update(_active = false): void {
    this.object.visible = false;
    this.object.userData.visibleLabels = 0;
    this.object.userData.drawInstances = 0;
    this.object.userData.activeIdentityInstances = 0;
  }
}
