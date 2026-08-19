import './finaleCelebration.css';

export type FinaleVisualPhase = 'idle' | 'impact' | 'crown' | 'hero' | 'settled';

export interface FinaleVisualState {
  phase: FinaleVisualPhase;
  progress: number;
  flash: number;
  crown: number;
  impact: number;
  actionsVisible: boolean;
}

interface Spark {
  angle: number;
  distance: number;
  length: number;
  speed: number;
  size: number;
  phase: number;
}

const SPARKS: readonly Spark[] = Array.from({ length: 52 }, (_, index) => ({
  angle: index * 2.399963 + (index % 3) * 0.12,
  distance: 0.14 + (index % 9) * 0.073,
  length: 0.04 + (index % 5) * 0.014,
  speed: 0.42 + (index % 7) * 0.055,
  size: 1.5 + (index % 4) * 0.8,
  phase: (index * 0.173) % 1,
}));

export class FinaleCelebrationCanvas {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly reducedMotion: boolean;
  private state: FinaleVisualState = {
    phase: 'idle', progress: 0, flash: 0, crown: 0, impact: 0, actionsVisible: false,
  };

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'finale-celebration-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    parent.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Finale celebration canvas is unavailable');
    this.ctx = ctx;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.resize();
    window.addEventListener('resize', () => this.resize(), { passive: true });
  }

  reset(): void {
    this.state = { phase: 'idle', progress: 0, flash: 0, crown: 0, impact: 0, actionsVisible: false };
    this.clear();
  }

  render(elapsed: number, actionsVisible: boolean): FinaleVisualState {
    const progress = Math.max(0, Math.min(1, elapsed / 2.4));
    const phase: FinaleVisualPhase = elapsed < 0.22 ? 'impact'
      : elapsed < 0.7 ? 'crown'
      : elapsed < 1.65 ? 'hero'
      : 'settled';
    const flash = this.reducedMotion ? (elapsed > 0 ? 0.16 : 0) : Math.max(0, 1 - Math.abs(elapsed - 0.1) / 0.16);
    const crown = this.reducedMotion ? 0.72 : Math.min(1, Math.max(0, (elapsed - 0.08) / 0.48));
    const impact = this.reducedMotion ? 0 : Math.max(0, 1 - elapsed / 0.52);
    this.state = { phase, progress, flash, crown, impact, actionsVisible };
    this.clear();
    if (elapsed <= 0) return this.state;
    const width = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    const scale = Math.min(width, height);
    const cx = width * 0.5;
    const cy = height * 0.42;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (flash > 0) {
      ctx.fillStyle = `rgba(255,248,198,${flash * 0.52})`;
      ctx.fillRect(0, 0, width, height);
    }
    const radius = scale * (0.08 + crown * 0.16);
    const crownAlpha = 0.25 + crown * 0.7;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 1.5);
    gradient.addColorStop(0, `rgba(255,250,197,${crownAlpha * 0.8})`);
    gradient.addColorStop(0.4, `rgba(255,207,74,${crownAlpha * 0.28})`);
    gradient.addColorStop(1, 'rgba(255,207,74,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.lineCap = 'round';
    ctx.strokeStyle = `rgba(255,239,141,${crownAlpha})`;
    ctx.lineWidth = Math.max(2.2, scale * 0.004);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, Math.PI * 0.12, Math.PI * 0.88);
    ctx.stroke();
    ctx.strokeStyle = `rgba(255,255,232,${crownAlpha * 0.78})`;
    ctx.lineWidth *= 0.42;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.92, Math.PI * 0.18, Math.PI * 0.82);
    ctx.stroke();

    const points = 7;
    for (let i = 0; i < points; i++) {
      const a = Math.PI * 0.18 + (i / (points - 1)) * Math.PI * 0.64;
      const inner = radius * 0.56;
      const outer = radius * (1.16 + (i % 2) * 0.16);
      const x1 = cx + Math.cos(a) * inner;
      const y1 = cy - Math.sin(a) * inner * 0.72;
      const x2 = cx + Math.cos(a) * outer;
      const y2 = cy - Math.sin(a) * outer * 0.72;
      ctx.strokeStyle = `rgba(255,207,74,${crownAlpha * (0.68 + (i % 2) * 0.22)})`;
      ctx.lineWidth = Math.max(2, scale * 0.0032);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    const sparkProgress = this.reducedMotion ? 0.35 : Math.min(1, elapsed / 1.15);
    for (const spark of SPARKS) {
      const distance = scale * spark.distance * sparkProgress;
      const x = cx + Math.cos(spark.angle) * distance;
      const y = cy + Math.sin(spark.angle) * distance * 0.58;
      const tail = scale * spark.length * (0.4 + sparkProgress * 0.8);
      const tx = x - Math.cos(spark.angle) * tail;
      const ty = y - Math.sin(spark.angle) * tail * 0.58;
      const alpha = Math.max(0, 1 - Math.max(0, elapsed - 0.15 - spark.phase * 0.55) / 1.5);
      ctx.strokeStyle = `rgba(255,218,91,${alpha * 0.86})`;
      ctx.lineWidth = Math.max(1.2, spark.size * (0.55 + impact * 0.7));
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    ctx.restore();
    return this.state;
  }

  visualState(): FinaleVisualState { return this.state; }

  private resize(): void {
    const width = Math.max(1, Math.floor(this.canvas.clientWidth || window.innerWidth));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight || window.innerHeight));
    const dpr = Math.min(1.25, window.devicePixelRatio || 1);
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.clientWidth || window.innerWidth, this.canvas.clientHeight || window.innerHeight);
  }
}
