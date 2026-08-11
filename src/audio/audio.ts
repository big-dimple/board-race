/**
 * audio.ts — fully synthesized game audio. Zero assets, Web Audio API only.
 *
 * Graph (built lazily on first resume(), i.e. first user gesture):
 *
 *   engine:  saw(−7¢) ─┐
 *            saw(+6¢) ─┼─► waveshaper(light grit) ─► lowpass ─► engineGain ──┐
 *            sine(sub)─┤   ▲                                                  │
 *            saw(+1oct)─► boostGain ──────────────────────────────────────────┤
 *   rush:    noise loop ─► bandpass ─► rushGain ──────────────────────────────┤
 *   one-shots: thud / splash / beep / horn / sting ───────────────────────────┤
 *                                          master(0.5) ─► compressor ─► destination
 *
 * All continuous params move via setTargetAtTime (no zipper noise), and the
 * set* hot paths allocate nothing — every node there is built once in build().
 * One-shots allocate their short-lived nodes per call and self-disconnect.
 * Every method is a harmless no-op until resume() has built the context.
 */

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Light grit: soft asymmetric-ish saturation curve for the engine shaper. */
const makeGritCurve = (): Float32Array<ArrayBuffer> => {
  const n = 256;
  const curve = new Float32Array(n);
  const k = 2.2;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
};

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;

  // engine nodes
  private saw1: OscillatorNode | null = null;
  private saw2: OscillatorNode | null = null;
  private sub: OscillatorNode | null = null;
  private boostOsc: OscillatorNode | null = null;
  private boostGain: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private engineLp: BiquadFilterNode | null = null;

  // water rush nodes
  private rushBp: BiquadFilterNode | null = null;
  private rushGain: GainNode | null = null;

  // continuous-state mirrors (also used to skip redundant param events)
  private speedNorm = 0;
  private airborne = false;
  private lastRpm = -1;
  private lastThrottle = -1;
  private lastBoost = false;
  private lastRushGain = -1;
  private lastRushFreq = -1;

  constructor() {
    // deliberately empty: nothing audible exists until resume()
  }

  /** Call on first user gesture. Safe to call repeatedly. */
  resume(): void {
    if (!this.ctx) {
      try {
        this.build();
      } catch {
        this.ctx = null; // audio unavailable — every call stays a no-op
        return;
      }
    }
    const c = this.ctx;
    if (c && c.state === 'suspended') void c.resume();
  }

  /** All continuous smoothing rides on setTargetAtTime; nothing to do per frame. */
  update(_dt: number): void {}

  /** rpm 0..1, throttle 0..1, boosting adds a bright octave layer. */
  setEngine(rpm: number, throttle: number, boosting: boolean): void {
    const c = this.ctx;
    if (!c || !this.saw1 || !this.saw2 || !this.sub || !this.boostOsc || !this.boostGain || !this.engineGain || !this.engineLp) {
      return;
    }
    const t = c.currentTime;

    const r = clamp01(rpm);
    if (Math.abs(r - this.lastRpm) > 0.002) {
      this.lastRpm = r;
      const f = 55 + (210 - 55) * r;
      this.saw1.frequency.setTargetAtTime(f, t, 0.04);
      this.saw2.frequency.setTargetAtTime(f, t, 0.04);
      this.sub.frequency.setTargetAtTime(f * 0.5, t, 0.04);
      this.boostOsc.frequency.setTargetAtTime(f * 2, t, 0.04);
      this.engineLp.frequency.setTargetAtTime(350 + 2000 * r, t, 0.06);
    }

    const th = clamp01(throttle);
    if (Math.abs(th - this.lastThrottle) > 0.004) {
      this.lastThrottle = th;
      // idle purr at 0.10, swells to 0.40 with throttle
      this.engineGain.gain.setTargetAtTime(0.1 + 0.3 * th, t, 0.07);
    }

    if (boosting !== this.lastBoost) {
      this.lastBoost = boosting;
      this.boostGain.gain.setTargetAtTime(boosting ? 0.16 : 0, t, boosting ? 0.025 : 0.09);
    }
  }

  /** 0..1 normalized boat speed → bandpass sweep 500→2400 Hz, gain 0→0.35. */
  setWaterRush(speedNorm: number): void {
    this.speedNorm = clamp01(speedNorm);
    this.applyRush();
  }

  /** Airborne ducks the water rush by ~70%. */
  setAirborne(on: boolean): void {
    if (on === this.airborne) return;
    this.airborne = on;
    this.applyRush();
  }

  /** Landing slam: sine 130→42 Hz pitch drop + lowpassed noise burst. */
  thud(strength: number): void {
    const c = this.ctx;
    if (!c || !this.master || !this.noiseBuf) return;
    const s = clamp01(strength);
    if (s <= 0.001) return;
    const t0 = c.currentTime;

    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(130, t0);
    o.frequency.exponentialRampToValueAtTime(42, t0 + 0.18);
    const og = c.createGain();
    og.gain.setValueAtTime(0, t0);
    og.gain.linearRampToValueAtTime(0.5 * s, t0 + 0.008);
    og.gain.exponentialRampToValueAtTime(0.001, t0 + 0.28);
    o.connect(og);
    og.connect(this.master);
    o.start(t0);
    o.stop(t0 + 0.3);
    o.onended = () => {
      o.disconnect();
      og.disconnect();
    };

    const n = c.createBufferSource();
    n.buffer = this.noiseBuf;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 320;
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.35 * s, t0);
    ng.gain.exponentialRampToValueAtTime(0.001, t0 + 0.14);
    n.connect(lp);
    lp.connect(ng);
    ng.connect(this.master);
    n.start(t0);
    n.stop(t0 + 0.16);
    n.onended = () => {
      n.disconnect();
      lp.disconnect();
      ng.disconnect();
    };
  }

  /** Highpass noise burst, filter sweeping down over ~0.3s. */
  splash(strength: number): void {
    const c = this.ctx;
    if (!c || !this.master || !this.noiseBuf) return;
    const s = clamp01(strength);
    if (s <= 0.001) return;
    const t0 = c.currentTime;

    const n = c.createBufferSource();
    n.buffer = this.noiseBuf;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.Q.value = 0.7;
    hp.frequency.setValueAtTime(3000, t0);
    hp.frequency.exponentialRampToValueAtTime(500, t0 + 0.3);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.4 * s, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.32);
    n.connect(hp);
    hp.connect(g);
    g.connect(this.master);
    n.start(t0);
    n.stop(t0 + 0.35);
    n.onended = () => {
      n.disconnect();
      hp.disconnect();
      g.disconnect();
    };
  }

  /** Countdown tick: 880 Hz square, 0.12s. GO: 1320 Hz, 0.4s. */
  countdownBeep(isGo: boolean): void {
    const c = this.ctx;
    if (!c) return;
    this.blip(isGo ? 1320 : 880, c.currentTime, isGo ? 0.4 : 0.12, 0.22, 'square');
  }

  /** Race-start horn: stacked A-major triad (220/277/330 Hz) saws, 1.2s, punchy. */
  horn(): void {
    const c = this.ctx;
    if (!c || !this.master) return;
    const t0 = c.currentTime;

    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.3, t0 + 0.025);
    g.gain.setValueAtTime(0.3, t0 + 0.85);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 1.2);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1600;
    g.connect(lp);
    lp.connect(this.master);

    const freqs = [220, 277, 330];
    let last: OscillatorNode | null = null;
    for (let i = 0; i < freqs.length; i++) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freqs[i];
      o.detune.value = (i - 1) * 5;
      o.connect(g);
      o.start(t0);
      o.stop(t0 + 1.25);
      o.onended = () => o.disconnect();
      last = o;
    }
    if (last) {
      const done = last;
      done.onended = () => {
        done.disconnect();
        g.disconnect();
        lp.disconnect();
      };
    }
  }

  /** Finish sting: quick rising 4-note arpeggio (C5 E5 G5 C6). */
  finishSting(): void {
    const c = this.ctx;
    if (!c) return;
    const t0 = c.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    for (let i = 0; i < notes.length; i++) {
      this.blip(notes[i], t0 + i * 0.09, i === notes.length - 1 ? 0.45 : 0.14, 0.2, 'triangle');
    }
  }

  // ------------------------------------------------------------------ internals ----

  private applyRush(): void {
    const c = this.ctx;
    if (!c || !this.rushGain || !this.rushBp) return;
    const t = c.currentTime;
    const g = 0.35 * this.speedNorm * (this.airborne ? 0.3 : 1);
    const f = 500 + 1900 * this.speedNorm;
    if (Math.abs(g - this.lastRushGain) > 0.004) {
      this.lastRushGain = g;
      this.rushGain.gain.setTargetAtTime(g, t, 0.12);
    }
    if (Math.abs(f - this.lastRushFreq) > 8) {
      this.lastRushFreq = f;
      this.rushBp.frequency.setTargetAtTime(f, t, 0.15);
    }
  }

  /** Shared short-envelope osc helper for beeps and the sting. */
  private blip(freq: number, t0: number, dur: number, peak: number, type: OscillatorType): void {
    const c = this.ctx;
    if (!c || !this.master) return;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g);
    g.connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
    o.onended = () => {
      o.disconnect();
      g.disconnect();
    };
  }

  /** Build the whole graph. Called once, from resume(). */
  private build(): void {
    const ctx = new AudioContext();
    this.ctx = ctx;

    // master: gain 0.5 → limiter-ish compressor → destination
    const master = ctx.createGain();
    master.gain.value = 0.5;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 18;
    comp.ratio.value = 12;
    comp.attack.value = 0.003;
    comp.release.value = 0.22;
    master.connect(comp);
    comp.connect(ctx.destination);
    this.master = master;

    // shared 2s white-noise buffer (rush loop + thud/splash bursts)
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    // ---- engine: 2 detuned saws + sub sine → shaper → lowpass → level --------
    const shaper = ctx.createWaveShaper();
    shaper.curve = makeGritCurve();
    shaper.oversample = '2x';
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500;
    lp.Q.value = 0.8;
    const eng = ctx.createGain();
    eng.gain.value = 0;
    shaper.connect(lp);
    lp.connect(eng);
    eng.connect(master);
    this.engineLp = lp;
    this.engineGain = eng;

    const mkOsc = (type: OscillatorType, freq: number, detune: number, gain: number): OscillatorNode => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g);
      g.connect(shaper);
      o.start();
      return o;
    };
    this.saw1 = mkOsc('sawtooth', 55, -7, 0.4);
    this.saw2 = mkOsc('sawtooth', 55, 6, 0.4);
    this.sub = mkOsc('sine', 27.5, 0, 0.55);
    // bright octave layer, gated by boostGain
    const bg = ctx.createGain();
    bg.gain.value = 0;
    const bosc = ctx.createOscillator();
    bosc.type = 'sawtooth';
    bosc.frequency.value = 110;
    bosc.detune.value = 4;
    bosc.connect(bg);
    bg.connect(shaper);
    bosc.start();
    this.boostOsc = bosc;
    this.boostGain = bg;

    // ---- water rush: looping noise → bandpass → level -------------------------
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 500;
    bp.Q.value = 0.7;
    const rg = ctx.createGain();
    rg.gain.value = 0;
    noise.connect(bp);
    bp.connect(rg);
    rg.connect(master);
    noise.start();
    this.rushBp = bp;
    this.rushGain = rg;
  }
}
