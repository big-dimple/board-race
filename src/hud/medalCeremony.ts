type MedalTier = 'ordinary' | 'excellent';

const TAU = Math.PI * 2;
const COLORS = ['#ffcf4a', '#55e7ff', '#ff3d7f', '#39ff88', '#f4feff'];

/** One low-resolution canvas for the entire medal ceremony. */
export class MedalCeremonyCanvas {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private width = 0;
  private height = 0;
  private ratio = 1;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'hud-medal-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    parent.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Medal ceremony requires Canvas2D');
    this.ctx = ctx;
  }

  render(elapsed: number, duration: number, tier: MedalTier): void {
    this.resize();
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!this.reducedMotion) {
      this.drawFireworks(elapsed, w, h);
      this.drawConfetti(elapsed, w, h);
      this.drawFirecrackerChains(elapsed, w, h);
    } else {
      this.drawStaticLaurel(w, h);
    }
    this.drawMedal(elapsed, w, h, tier);

    if (!this.reducedMotion && elapsed > duration - 0.8) {
      const fade = Math.max(0, (elapsed - (duration - 0.8)) / 0.8);
      ctx.fillStyle = `rgba(4,7,20,${fade * 0.24})`;
      ctx.fillRect(0, 0, w, h);
    }
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const ratio = Math.min(devicePixelRatio || 1, 1.25);
    if (width === this.width && height === this.height && ratio === this.ratio) return;
    this.width = width;
    this.height = height;
    this.ratio = ratio;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
  }

  private drawFireworks(t: number, w: number, h: number): void {
    const ctx = this.ctx;
    const centers = [
      [w * 0.16, h * 0.23, 0.05],
      [w * 0.84, h * 0.19, 0.32],
      [w * 0.08, h * 0.58, 0.62],
      [w * 0.92, h * 0.55, 0.88],
    ] as const;
    for (let burst = 0; burst < centers.length; burst++) {
      const [cx, cy, delay] = centers[burst];
      const age = Math.max(0, (t - delay) % 1.45);
      if (age > 1.05) continue;
      const expansion = Math.min(1, age / 0.48);
      const alpha = Math.max(0, 1 - age / 1.05);
      for (let i = 0; i < 18; i++) {
        const angle = (i / 18) * TAU + burst * 0.31;
        const radius = (28 + (i % 4) * 9) * expansion;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius + age * age * 16;
        ctx.strokeStyle = colorAlpha(COLORS[(i + burst) % COLORS.length], alpha);
        ctx.lineWidth = i % 3 === 0 ? 3 : 2;
        ctx.beginPath();
        ctx.moveTo(x - Math.cos(angle) * 8, y - Math.sin(angle) * 8);
        ctx.lineTo(x + Math.cos(angle) * 5, y + Math.sin(angle) * 5);
        ctx.stroke();
      }
    }
  }

  private drawConfetti(t: number, w: number, h: number): void {
    const ctx = this.ctx;
    const count = w < 900 ? 78 : 150;
    for (let i = 0; i < count; i++) {
      const seed = fract(Math.sin(i * 91.17) * 43758.5453);
      const side = i % 2 === 0 ? 1 : -1;
      const lane = fract(seed * 7.13 + i * 0.37);
      const x0 = side < 0 ? w * (0.03 + lane * 0.27) : w * (0.70 + lane * 0.27);
      const speed = 50 + seed * 92;
      const y = ((seed * h + t * speed) % (h + 50)) - 25;
      const sway = Math.sin(t * (2.4 + seed * 2) + i) * (9 + seed * 15);
      const x = x0 + sway;
      const rot = t * (2.2 + seed * 5) + i;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.fillStyle = colorAlpha(COLORS[i % COLORS.length], 0.82);
      if (i % 5 === 0) {
        ctx.beginPath();
        ctx.ellipse(0, 0, 3, 8, 0, 0, TAU);
        ctx.fill();
      } else {
        ctx.fillRect(-2, -6, 4, 12);
      }
      ctx.restore();
    }
  }

  private drawFirecrackerChains(t: number, w: number, h: number): void {
    const ctx = this.ctx;
    const compact = w < 900;
    // The vertical chains frame a phone naturally, but at desktop width they
    // read like two rulers. Fireworks and confetti already fill that space.
    if (!compact) return;
    for (const side of [-1, 1]) {
      const x = side < 0
        ? Math.max(22, w * 0.045)
        : Math.min(w - 22, w * 0.955);
      const top = h * 0.17;
      const bottom = h * 0.78;
      ctx.strokeStyle = '#ffcf4a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      const count = 8;
      for (let i = 0; i < count; i++) {
        const y = top + (i + 0.65) * (bottom - top) / count;
        const pulse = 1 + Math.sin(t * 12 - i * 1.7) * 0.12;
        ctx.save();
        ctx.translate(x + side * (i % 2 ? 10 : -10), y);
        ctx.rotate(side * 0.24);
        ctx.scale(pulse, pulse);
        ctx.fillStyle = '#ff3d7f';
        ctx.strokeStyle = '#14122b';
        ctx.lineWidth = 3;
        const halfW = 7;
        const halfH = 12;
        ctx.fillRect(-halfW, -halfH, halfW * 2, halfH * 2);
        ctx.strokeRect(-halfW, -halfH, halfW * 2, halfH * 2);
        ctx.restore();
      }
    }
  }

  private drawStaticLaurel(w: number, h: number): void {
    const ctx = this.ctx;
    const cy = h * (h < 520 ? 0.3 : 0.34);
    ctx.fillStyle = '#39ff88';
    for (const side of [-1, 1]) {
      for (let i = 0; i < 7; i++) {
        const angle = -0.75 + i * 0.24;
        const x = w * 0.5 + side * (90 + i * 8);
        const y = cy + 44 - Math.sin(angle + 1) * 82;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(side * angle);
        ctx.beginPath();
        ctx.ellipse(0, 0, 5, 13, 0, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  private drawMedal(t: number, w: number, h: number, tier: MedalTier): void {
    const ctx = this.ctx;
    const compact = h < 520;
    const radius = Math.min(compact ? 61 : 108, w * 0.105, h * (compact ? 0.17 : 0.17));
    const cx = w * 0.5;
    const cy = h * (compact ? 0.28 : 0.31);
    const reveal = this.reducedMotion ? 1 : easeOutBack(Math.min(1, t / 0.52));
    const pulse = this.reducedMotion ? 1 : 1 + Math.sin(Math.max(0, t - 0.48) * 5) * 0.018;
    const r = radius * reveal * pulse;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.reducedMotion ? 0 : (1 - Math.min(1, t / 0.45)) * -0.24);

    ctx.strokeStyle = '#14122b';
    ctx.lineWidth = Math.max(5, r * 0.1);
    ctx.fillStyle = tier === 'excellent' ? '#ffcf4a' : '#f1b93d';
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = '#f4feff';
    ctx.lineWidth = Math.max(2, r * 0.035);
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.78, 0, TAU);
    ctx.stroke();

    const spikes = 20;
    ctx.strokeStyle = '#55e7ff';
    ctx.lineWidth = Math.max(2, r * 0.025);
    for (let i = 0; i < spikes; i++) {
      const a = (i / spikes) * TAU;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r * 1.12, Math.sin(a) * r * 1.12);
      ctx.lineTo(Math.cos(a) * r * 1.32, Math.sin(a) * r * 1.32);
      ctx.stroke();
    }

    this.drawMuscleChampion(r);
    ctx.restore();
  }

  private drawMuscleChampion(radius: number): void {
    const ctx = this.ctx;
    const scale = radius / 100;
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(0, 9);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const skin = ctx.createLinearGradient(0, -62, 0, 60);
    skin.addColorStop(0, '#ffd0a6');
    skin.addColorStop(0.56, '#e99468');
    skin.addColorStop(1, '#b85d49');

    // Front double-biceps pose. Fists sit above the shoulders and the peaks
    // are deliberately oversized so the pose survives at phone size.
    const drawArm = (side: -1 | 1): void => {
      ctx.save();
      ctx.scale(side, 1);
      ctx.beginPath();
      ctx.moveTo(30, -16);
      ctx.bezierCurveTo(42, -31, 55, -32, 62, -21);
      ctx.bezierCurveTo(66, -16, 68, -23, 65, -31);
      ctx.lineTo(61, -42);
      ctx.bezierCurveTo(56, -48, 58, -57, 65, -62);
      ctx.bezierCurveTo(71, -66, 79, -62, 80, -55);
      ctx.bezierCurveTo(82, -48, 77, -43, 73, -40);
      ctx.bezierCurveTo(81, -24, 83, -11, 76, 0);
      ctx.bezierCurveTo(69, 12, 57, 15, 47, 8);
      ctx.bezierCurveTo(40, 4, 34, 3, 29, 2);
      ctx.closePath();
      ctx.fillStyle = skin;
      ctx.strokeStyle = '#171329';
      ctx.lineWidth = 7;
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = '#9d5144';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(44, -21); ctx.quadraticCurveTo(54, -12, 64, -20);
      ctx.moveTo(52, 0); ctx.quadraticCurveTo(64, 5, 73, -5);
      ctx.moveTo(65, -31); ctx.quadraticCurveTo(72, -36, 73, -45);
      ctx.moveTo(62, -57); ctx.lineTo(74, -54);
      ctx.stroke();
      ctx.restore();
    };
    drawArm(-1);
    drawArm(1);

    // Large pec shelf and narrow waist make this a bodybuilder silhouette,
    // not a generic flexed-arm icon.
    ctx.beginPath();
    ctx.moveTo(-14, -31);
    ctx.bezierCurveTo(-20, -25, -33, -23, -39, -11);
    ctx.bezierCurveTo(-45, 2, -41, 18, -32, 30);
    ctx.lineTo(-24, 57);
    ctx.quadraticCurveTo(0, 64, 24, 57);
    ctx.lineTo(32, 30);
    ctx.bezierCurveTo(41, 18, 45, 2, 39, -11);
    ctx.bezierCurveTo(33, -23, 20, -25, 14, -31);
    ctx.closePath();
    ctx.fillStyle = skin;
    ctx.strokeStyle = '#171329';
    ctx.lineWidth = 7;
    ctx.fill();
    ctx.stroke();

    // Separate neck, face and hair keep the champion unmistakably human.
    ctx.fillStyle = '#d77c5d';
    ctx.fillRect(-10, -38, 20, 16);
    ctx.beginPath();
    ctx.moveTo(-17, -59);
    ctx.quadraticCurveTo(-16, -72, 0, -76);
    ctx.quadraticCurveTo(16, -72, 17, -59);
    ctx.lineTo(14, -42);
    ctx.quadraticCurveTo(0, -32, -14, -42);
    ctx.closePath();
    ctx.fillStyle = '#efad83';
    ctx.strokeStyle = '#171329';
    ctx.lineWidth = 6;
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#171329';
    ctx.beginPath();
    ctx.moveTo(-16, -59);
    ctx.quadraticCurveTo(-11, -77, 0, -73);
    ctx.quadraticCurveTo(11, -78, 17, -59);
    ctx.lineTo(9, -64);
    ctx.lineTo(4, -58);
    ctx.lineTo(-2, -65);
    ctx.lineTo(-8, -58);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#5a302e';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(-9, -52); ctx.lineTo(-3, -53);
    ctx.moveTo(3, -53); ctx.lineTo(9, -52);
    ctx.moveTo(-6, -43); ctx.quadraticCurveTo(0, -39, 6, -43);
    ctx.stroke();

    // Graphic pec and six-pack planes stay visible at compact scale.
    ctx.strokeStyle = '#93483f';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(0, -23); ctx.lineTo(0, 44);
    ctx.moveTo(-34, -8); ctx.quadraticCurveTo(-18, -20, -2, -11);
    ctx.moveTo(34, -8); ctx.quadraticCurveTo(18, -20, 2, -11);
    ctx.moveTo(-28, 5); ctx.quadraticCurveTo(-14, 12, -5, 9);
    ctx.moveTo(28, 5); ctx.quadraticCurveTo(14, 12, 5, 9);
    ctx.moveTo(-20, 20); ctx.lineTo(-5, 20);
    ctx.moveTo(20, 20); ctx.lineTo(5, 20);
    ctx.moveTo(-18, 34); ctx.lineTo(-5, 34);
    ctx.moveTo(18, 34); ctx.lineTo(5, 34);
    ctx.stroke();

    // Racing trunks anchor the body and echo the cyan flight system.
    ctx.fillStyle = '#55e7ff';
    ctx.strokeStyle = '#14122b';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(-25, 45);
    ctx.quadraticCurveTo(0, 51, 25, 45);
    ctx.lineTo(22, 61);
    ctx.lineTo(-22, 61);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Three flight trails make the achievement readable without relying on text.
    ctx.strokeStyle = '#f4feff';
    ctx.lineWidth = 4;
    for (const x of [-11, 0, 11]) {
      ctx.beginPath();
      ctx.moveTo(x, 59);
      ctx.lineTo(x * 1.5, 75);
      ctx.stroke();
    }
    ctx.restore();
  }
}

const fract = (value: number): number => value - Math.floor(value);

const colorAlpha = (hex: string, alpha: number): string => {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
};

const easeOutBack = (x: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};
