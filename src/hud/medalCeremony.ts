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
    for (const side of [-1, 1]) {
      const x = side < 0 ? Math.max(22, w * 0.045) : Math.min(w - 22, w * 0.955);
      ctx.strokeStyle = '#ffcf4a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, h * 0.17);
      ctx.lineTo(x, h * 0.78);
      ctx.stroke();
      for (let i = 0; i < 8; i++) {
        const y = h * 0.22 + i * Math.min(34, h * 0.072);
        const pulse = 1 + Math.sin(t * 12 - i * 1.7) * 0.12;
        ctx.save();
        ctx.translate(x + side * (i % 2 ? 8 : -8), y);
        ctx.rotate(side * 0.24);
        ctx.scale(pulse, pulse);
        ctx.fillStyle = '#ff3d7f';
        ctx.strokeStyle = '#14122b';
        ctx.lineWidth = 3;
        ctx.fillRect(-7, -12, 14, 24);
        ctx.strokeRect(-7, -12, 14, 24);
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
    const radius = Math.min(compact ? 61 : 92, w * 0.105, h * (compact ? 0.17 : 0.15));
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

    this.drawFlexedArm(r);
    ctx.restore();
  }

  private drawFlexedArm(radius: number): void {
    const ctx = this.ctx;
    const scale = radius / 100;
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(0, 4);

    ctx.beginPath();
    ctx.moveTo(-62, 43);
    ctx.lineTo(-63, 7);
    ctx.quadraticCurveTo(-61, -4, -48, -5);
    ctx.lineTo(-31, -5);
    ctx.lineTo(-17, -30);
    ctx.quadraticCurveTo(-9, -45, 7, -48);
    ctx.quadraticCurveTo(24, -51, 31, -37);
    ctx.quadraticCurveTo(36, -27, 30, -17);
    ctx.quadraticCurveTo(48, -17, 61, -5);
    ctx.quadraticCurveTo(72, 7, 65, 24);
    ctx.quadraticCurveTo(57, 44, 37, 48);
    ctx.lineTo(3, 49);
    ctx.quadraticCurveTo(-17, 49, -30, 38);
    ctx.lineTo(-47, 45);
    ctx.closePath();
    ctx.fillStyle = '#f4feff';
    ctx.strokeStyle = '#14122b';
    ctx.lineWidth = 10;
    ctx.lineJoin = 'round';
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = '#d39324';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-26, 24);
    ctx.quadraticCurveTo(5, 5, 42, 18);
    ctx.moveTo(-13, -25);
    ctx.quadraticCurveTo(4, -34, 23, -26);
    ctx.moveTo(-47, 7);
    ctx.lineTo(-47, 34);
    ctx.stroke();

    ctx.fillStyle = '#39ff88';
    ctx.strokeStyle = '#14122b';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(-70, 30);
    ctx.lineTo(-42, 30);
    ctx.lineTo(-38, 54);
    ctx.lineTo(-69, 57);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
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
