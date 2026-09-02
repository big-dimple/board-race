import * as THREE from 'three';

export interface TacticalReticleUpdate {
  targetPos: THREE.Vector3;
  targetQuat: THREE.Quaternion;
  distance: number;
  timeRemaining: number;
  isEvadeWindow: boolean;
  isPlayer: boolean;
  state: 'approaching' | 'deflected' | 'hit' | 'idle';
  elapsed: number;
}

/**
 * AAA-Grade Cyber Holographic Tactical Lock-On Hologram.
 * Replaces primitive flat rings with a multi-layered, animated sci-fi
 * targeting array featuring rotating segmented reticles, dynamic snapping
 * diamond brackets, a vertical sky-laser beacon, and live 3D telemetry badge.
 */
export class TacticalReticle {
  readonly object: THREE.Group;
  private readonly outerRing: THREE.LineSegments;
  private readonly innerDiamond: THREE.LineSegments;
  private readonly cornerBrackets: THREE.LineSegments;
  private readonly laserBeam: THREE.Mesh;
  private readonly badgeMesh: THREE.Mesh;
  private readonly badgeCanvas: HTMLCanvasElement;
  private readonly badgeCtx: CanvasRenderingContext2D;
  private readonly badgeTexture: THREE.CanvasTexture;
  private readonly outerMat: THREE.LineBasicMaterial;
  private readonly innerMat: THREE.LineBasicMaterial;
  private readonly cornerMat: THREE.LineBasicMaterial;
  private readonly laserMat: THREE.MeshBasicMaterial;
  private lastBadgeText = '';

  constructor() {
    this.object = new THREE.Group();
    this.object.visible = false;

    // 1. Outer Segmented Reticle Ring (4 arcs with gaps)
    const outerGeo = new THREE.BufferGeometry();
    const outerPositions: number[] = [];
    const segments = 48;
    const radius = 2.8;
    for (let i = 0; i < segments; i++) {
      const quad = i % (segments / 4);
      if (quad < 2 || quad > (segments / 4) - 2) continue; // Gap
      const a1 = (i / segments) * Math.PI * 2;
      const a2 = ((i + 1) / segments) * Math.PI * 2;
      outerPositions.push(Math.cos(a1) * radius, 0, Math.sin(a1) * radius);
      outerPositions.push(Math.cos(a2) * radius, 0, Math.sin(a2) * radius);
    }
    outerGeo.setAttribute('position', new THREE.Float32BufferAttribute(outerPositions, 3));
    this.outerMat = new THREE.LineBasicMaterial({
      color: 0xff0055,
      transparent: true,
      opacity: 0.9,
      linewidth: 2,
      toneMapped: false,
    });
    this.outerRing = new THREE.LineSegments(outerGeo, this.outerMat);
    this.object.add(this.outerRing);

    // 2. Corner Target Brackets (L-shaped crosshair markers)
    const cornerGeo = new THREE.BufferGeometry();
    const cornerPositions: number[] = [];
    const cSize = 3.6;
    const arm = 0.8;
    // Top-Right
    cornerPositions.push(cSize - arm, 0, cSize, cSize, 0, cSize);
    cornerPositions.push(cSize, 0, cSize, cSize, 0, cSize - arm);
    // Top-Left
    cornerPositions.push(-cSize + arm, 0, cSize, -cSize, 0, cSize);
    cornerPositions.push(-cSize, 0, cSize, -cSize, 0, cSize - arm);
    // Bottom-Right
    cornerPositions.push(cSize - arm, 0, -cSize, cSize, 0, -cSize);
    cornerPositions.push(cSize, 0, -cSize, cSize, 0, -cSize + arm);
    // Bottom-Left
    cornerPositions.push(-cSize + arm, 0, -cSize, -cSize, 0, -cSize);
    cornerPositions.push(-cSize, 0, -cSize, -cSize, 0, -cSize + arm);

    cornerGeo.setAttribute('position', new THREE.Float32BufferAttribute(cornerPositions, 3));
    this.cornerMat = new THREE.LineBasicMaterial({
      color: 0xffd000,
      transparent: true,
      opacity: 0.95,
      linewidth: 2,
      toneMapped: false,
    });
    this.cornerBrackets = new THREE.LineSegments(cornerGeo, this.cornerMat);
    this.object.add(this.cornerBrackets);

    // 3. Inner Snapping Diamond
    const diamondGeo = new THREE.BufferGeometry();
    const dSize = 1.6;
    const diamondPositions = [
      0, 0, dSize, dSize, 0, 0,
      dSize, 0, 0, 0, 0, -dSize,
      0, 0, -dSize, -dSize, 0, 0,
      -dSize, 0, 0, 0, 0, dSize,
    ];
    diamondGeo.setAttribute('position', new THREE.Float32BufferAttribute(diamondPositions, 3));
    this.innerMat = new THREE.LineBasicMaterial({
      color: 0xff0055,
      transparent: true,
      opacity: 0.95,
      linewidth: 2,
      toneMapped: false,
    });
    this.innerDiamond = new THREE.LineSegments(diamondGeo, this.innerMat);
    this.object.add(this.innerDiamond);

    // 4. Vertical Holographic Laser Sky-Beacon (descending from heavens)
    const laserGeo = new THREE.CylinderGeometry(0.12, 0.6, 9.0, 8, 1, true);
    laserGeo.translate(0, 4.5, 0);
    this.laserMat = new THREE.MeshBasicMaterial({
      color: 0xff0055,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    });
    this.laserBeam = new THREE.Mesh(laserGeo, this.laserMat);
    this.object.add(this.laserBeam);

    // 5. 3D Floating Telemetry Billboard Badge
    this.badgeCanvas = document.createElement('canvas');
    this.badgeCanvas.width = 512;
    this.badgeCanvas.height = 160;
    const ctx = this.badgeCanvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2d context for reticle badge');
    this.badgeCtx = ctx;
    this.badgeTexture = new THREE.CanvasTexture(this.badgeCanvas);
    this.badgeTexture.minFilter = THREE.LinearFilter;
    this.badgeTexture.magFilter = THREE.LinearFilter;

    const badgeMat = new THREE.MeshBasicMaterial({
      map: this.badgeTexture,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    });
    const badgeGeo = new THREE.PlaneGeometry(3.6, 1.12);
    badgeGeo.translate(0, 2.6, 0);
    this.badgeMesh = new THREE.Mesh(badgeGeo, badgeMat);
    this.object.add(this.badgeMesh);
  }

  public setVisible(visible: boolean): void {
    this.object.visible = visible;
  }

  public update(info: TacticalReticleUpdate, camera: THREE.Camera): void {
    if (!this.object.visible) return;

    this.object.position.copy(info.targetPos);
    this.object.position.y += 0.35; // Hover just above water level
    this.object.quaternion.copy(info.targetQuat);

    // Billboarding for badge so text always faces player camera
    this.badgeMesh.quaternion.copy(camera.quaternion);

    // Rotation & animation
    const rotSpeed = info.isEvadeWindow ? 5.2 : 2.4;
    this.outerRing.rotation.y = info.elapsed * rotSpeed;
    this.cornerBrackets.rotation.y = -info.elapsed * (rotSpeed * 0.5);

    // Inner diamond dynamic contraction as missile gets closer
    const pulseFactor = Math.sin(info.elapsed * (info.isEvadeWindow ? 18 : 8)) * 0.15;
    const snapScale = THREE.MathUtils.clamp(info.distance / 30, 0.75, 1.4) + pulseFactor;
    this.innerDiamond.scale.set(snapScale, 1, snapScale);
    this.innerDiamond.rotation.y = info.elapsed * rotSpeed * 1.5;

    // Dynamic Color Transition
    let primaryHex = 0xff0055;
    let secondaryHex = 0xffd000;
    let laserAlpha = 0.35;

    if (info.state === 'deflected') {
      primaryHex = 0x00ff88;
      secondaryHex = 0x55e7ff;
      laserAlpha = 0.5;
    } else if (info.isEvadeWindow) {
      // Blinking warning pulse
      const blink = Math.sin(info.elapsed * 24) > 0;
      primaryHex = blink ? 0xff0033 : 0xffd000;
      secondaryHex = blink ? 0xffd000 : 0xff0033;
      laserAlpha = blink ? 0.6 : 0.25;
    } else {
      primaryHex = 0xff0055;
      secondaryHex = 0xffcf4a;
      laserAlpha = 0.3;
    }

    this.outerMat.color.setHex(primaryHex);
    this.innerMat.color.setHex(secondaryHex);
    this.cornerMat.color.setHex(secondaryHex);
    this.laserMat.color.setHex(primaryHex);
    this.laserMat.opacity = laserAlpha;

    // Redraw badge canvas
    this.renderBadge(info);
  }

  private renderBadge(info: TacticalReticleUpdate): void {
    const key = `${info.isPlayer}-${info.isEvadeWindow}-${info.distance.toFixed(0)}-${info.state}-${Math.floor(info.elapsed * 6)}`;
    if (key === this.lastBadgeText) return;
    this.lastBadgeText = key;

    const ctx = this.badgeCtx;
    const w = this.badgeCanvas.width;
    const h = this.badgeCanvas.height;
    ctx.clearRect(0, 0, w, h);

    const isDeflected = info.state === 'deflected';
    const isRedAlert = info.isEvadeWindow && !isDeflected;

    // Cyber Tactical Box
    ctx.fillStyle = isDeflected
      ? 'rgba(0, 24, 18, 0.88)'
      : isRedAlert
        ? 'rgba(36, 4, 12, 0.92)'
        : 'rgba(10, 16, 36, 0.88)';
    ctx.strokeStyle = isDeflected
      ? '#00ff88'
      : isRedAlert
        ? '#ff0055'
        : '#ffd000';
    ctx.lineWidth = 4;

    ctx.beginPath();
    ctx.roundRect(8, 8, w - 16, h - 16, 12);
    ctx.fill();
    ctx.stroke();

    // Top Header
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 24px system-ui, sans-serif';
    ctx.fillStyle = isDeflected ? '#00ff88' : isRedAlert ? '#ff3366' : '#ffd000';

    if (isDeflected) {
      ctx.fillText('✨ DEFLECTED // 诱爆脱锁成功', w / 2, 42);
    } else if (info.isPlayer) {
      ctx.fillText(isRedAlert ? '⚠ MISSILE LOCK-ON // 极度危险' : '⚡ MISSILE TRACKING // 飞弹锁定中', w / 2, 42);
    } else {
      ctx.fillText('🎯 TARGET ACQUIRED // 敌舰锁定中', w / 2, 42);
    }

    // Subtitle & Action Telemetry
    ctx.font = '950 32px system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';

    if (isDeflected) {
      ctx.fillText('👑 技术超群 · 获得涡轮冲刺！', w / 2, 98);
    } else if (info.isPlayer) {
      if (isRedAlert) {
        ctx.fillStyle = '#ffe600';
        ctx.fillText(`距离: ${info.distance.toFixed(1)}m · 立即漂移诱爆!`, w / 2, 98);
      } else {
        ctx.fillText(`距离: ${info.distance.toFixed(1)}m · 准备进弯`, w / 2, 98);
      }
    } else {
      ctx.fillStyle = '#ff8899';
      ctx.fillText(`💥 走位借刀 · 炮灰预定！[ ${info.distance.toFixed(1)}m ]`, w / 2, 98);
    }

    this.badgeTexture.needsUpdate = true;
  }
}
