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

  // anti-grav nodes
  private flightOsc: OscillatorNode | null = null;
  private flightHarm: OscillatorNode | null = null;
  private flightGain: GainNode | null = null;
  private flightNoiseGain: GainNode | null = null;
  private flightNoiseBp: BiquadFilterNode | null = null;

  // drift carve noise
  private driftGain: GainNode | null = null;
  private driftBp: BiquadFilterNode | null = null;

  // water rush nodes
  private rushBp: BiquadFilterNode | null = null;
  private rushGain: GainNode | null = null;
  private airRushBp: BiquadFilterNode | null = null;
  private airRushGain: GainNode | null = null;
  private airRushPan: StereoPannerNode | null = null;

  // continuous-state mirrors (also used to skip redundant param events)
  private speedNorm = 0;
  private airborne = false;
  private flightActive = false;
  private lastRpm = -1;
  private lastThrottle = -1;
  private lastBoost = false;
  private lastRushGain = -1;
  private lastRushFreq = -1;
  private lastFlightThrust = -1;
  private lastFlightIndex = -1;
  private flightPressure = 0;
  private flightClearance = 0;
  private flightAirBrake = 0;
  private flightSteer = 0;

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
      this.boostGain.gain.setTargetAtTime(boosting ? 0.23 : 0, t, boosting ? 0.018 : 0.11);
      this.applyRush();
      if (boosting) this.boostIgnition();
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

  /** Controlled flight crossfades water into directional pressure and lift layers. */
  setFlight(
    thrust: number,
    active: boolean,
    pressure = 0,
    clearance = 0,
    airBrake = 0,
    steer = 0,
    flightIndex = 0,
  ): void {
    const c = this.ctx;
    if (!c || !this.flightOsc || !this.flightHarm || !this.flightGain || !this.flightNoiseGain || !this.flightNoiseBp) return;
    const t = c.currentTime;
    const n = clamp01(thrust);
    this.flightPressure = clamp01(pressure);
    this.flightClearance = clamp01(clearance / 4.5);
    this.flightAirBrake = clamp01(airBrake);
    this.flightSteer = Math.max(-1, Math.min(1, steer));
    const index = Math.max(0, Math.min(2, Math.floor(flightIndex)));
    if (active !== this.flightActive) {
      this.flightActive = active;
      if (active) this.impactBurst(118, 42, 1, 0.28);
      this.blip(active ? 740 : 420, t, active ? 0.22 : 0.09, active ? 0.19 : 0.08, 'triangle');
    }
    if (Math.abs(n - this.lastFlightThrust) > 0.004 || index !== this.lastFlightIndex) {
      this.lastFlightThrust = n;
      this.lastFlightIndex = index;
      const harmonic = [1, 1.08, 1.15][index];
      this.flightOsc.frequency.setTargetAtTime(92 + n * 78, t, 0.04);
      this.flightHarm.frequency.setTargetAtTime((276 + n * 190) * harmonic, t, 0.04);
      this.flightGain.gain.setTargetAtTime(active ? 0.055 + n * 0.17 : 0, t, active ? 0.025 : 0.16);
    }
    this.flightNoiseGain.gain.setTargetAtTime(active ? 0.025 + n * 0.07 + this.flightPressure * 0.04 : 0, t, active ? 0.018 : 0.14);
    this.flightNoiseBp.frequency.setTargetAtTime(
      (620 + this.flightPressure * 900) * (1 - this.flightAirBrake * 0.16),
      t,
      0.08,
    );
    if (this.engineGain) {
      const engineLevel = (0.1 + 0.3 * Math.max(0, this.lastThrottle)) * (active ? 0.72 : 1);
      this.engineGain.gain.setTargetAtTime(engineLevel, t, 0.12);
    }
    this.applyRush();
  }

  setDrift(intensity: number): void {
    const c = this.ctx;
    if (!c || !this.driftGain || !this.driftBp) return;
    const n = clamp01(intensity);
    const t = c.currentTime;
    this.driftGain.gain.setTargetAtTime(n * 0.13, t, n > 0 ? 0.035 : 0.12);
    this.driftBp.frequency.setTargetAtTime(760 + n * 1250, t, 0.055);
  }

  flightReady(): void {
    const c = this.ctx;
    if (!c) return;
    this.impactBurst(160, 72, 0.5, 0.18);
    this.blip(620, c.currentTime, 0.18, 0.2, 'triangle');
    this.blip(930, c.currentTime + 0.07, 0.25, 0.19, 'triangle');
    this.blip(1395, c.currentTime + 0.14, 0.32, 0.14, 'square');
  }

  flightGate(index: number): void {
    const c = this.ctx;
    if (!c) return;
    this.impactBurst(142 + index * 8, 76, 0.46 + index * 0.12, 0.14);
    this.blip(680 + index * 150, c.currentTime, 0.2, 0.18, 'square');
  }

  routeClear(flightNumber = 1): void {
    const c = this.ctx;
    if (!c) return;
    const step = Math.max(0, Math.min(2, flightNumber - 1));
    this.blip(880 + step * 110, c.currentTime, 0.18, 0.14, 'triangle');
    this.blip(1320 + step * 150, c.currentTime + 0.09, 0.3, 0.16, 'triangle');
  }

  flightMiss(): void {
    const c = this.ctx;
    if (!c) return;
    this.impactBurst(92, 38, 0.62, 0.24);
    this.blip(190, c.currentTime, 0.24, 0.18, 'square');
  }

  raceBattle(kind: 'overtake' | 'lost', count: number, newPlace: number): void {
    const c = this.ctx;
    if (!c) return;
    const positive = kind === 'overtake';
    const strength = positive ? Math.min(1, 0.95 + Math.max(0, count - 1) * 0.05) : 0.58;
    this.impactBurst(positive ? 118 : 82, positive ? 48 : 34, strength, positive ? 0.25 : 0.18);
    const t = c.currentTime;
    this.blip(positive ? 560 : 260, t + 0.025, positive ? 0.16 : 0.2, 0.15 * strength, positive ? 'square' : 'sawtooth');
    if (positive) {
      this.blip(760 + count * 90, t + 0.1, 0.24, 0.14, 'triangle');
      if (newPlace === 1) this.blip(1480, t + 0.18, 0.34, 0.17, 'triangle');
    }
  }

  boostIgnition(): void {
    const c = this.ctx;
    if (!c) return;
    this.impactBurst(155, 58, 0.88, 0.24);
    this.blip(480, c.currentTime + 0.018, 0.18, 0.16, 'sawtooth');
    this.blip(960, c.currentTime + 0.075, 0.25, 0.12, 'square');
  }

  airBrakeSnap(): void {
    const c = this.ctx;
    if (!c) return;
    this.impactBurst(210, 86, 0.42, 0.16);
    this.blip(360, c.currentTime, 0.12, 0.11, 'sawtooth');
  }

  defeat(): void {
    const c = this.ctx;
    if (!c) return;
    this.impactBurst(78, 24, 1, 0.55);
    this.blip(310, c.currentTime + 0.03, 0.42, 0.2, 'sawtooth');
    this.blip(196, c.currentTime + 0.12, 0.52, 0.18, 'square');
  }

  retryLesson(): void {
    const c = this.ctx;
    if (!c) return;
    this.impactBurst(126, 58, 0.34, 0.14);
    this.blip(248, c.currentTime, 0.12, 0.1, 'square');
    this.blip(496, c.currentTime + 0.08, 0.16, 0.08, 'triangle');
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
    const airMix = this.flightActive ? this.flightClearance : this.airborne ? 0.7 : 0;
    const modeGain = 1 - airMix * 0.84;
    const boostGain = this.lastBoost ? 0.3 : 0;
    const g = (0.32 + boostGain) * this.speedNorm * modeGain;
    const f = 500 + 2400 * this.speedNorm + (this.lastBoost ? 850 : 0);
    if (Math.abs(g - this.lastRushGain) > 0.004) {
      this.lastRushGain = g;
      this.rushGain.gain.setTargetAtTime(g, t, 0.12);
    }
    if (Math.abs(f - this.lastRushFreq) > 8) {
      this.lastRushFreq = f;
      this.rushBp.frequency.setTargetAtTime(f, t, 0.15);
    }
    if (this.airRushGain && this.airRushBp && this.airRushPan) {
      const pressureGain = this.flightActive
        ? (0.08 + this.flightPressure * 0.24) * (0.45 + airMix * 0.55) * (1 + this.flightAirBrake * 0.35)
        : 0;
      const pressureFrequency = (760 + this.flightPressure * 2500) * (1 - this.flightAirBrake * 0.18);
      this.airRushGain.gain.setTargetAtTime(pressureGain, t, this.flightActive ? 0.08 : 0.18);
      this.airRushBp.frequency.setTargetAtTime(pressureFrequency, t, 0.1);
      this.airRushPan.pan.setTargetAtTime(-this.flightSteer * this.flightAirBrake * 0.25, t, 0.06);
    }
  }

  private impactBurst(startHz: number, endHz: number, strength: number, duration: number): void {
    const c = this.ctx;
    if (!c || !this.master || !this.noiseBuf) return;
    const s = clamp01(strength);
    const t0 = c.currentTime;
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(startHz, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endHz), t0 + duration);
    const og = c.createGain();
    og.gain.setValueAtTime(0.3 * s, t0);
    og.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    osc.connect(og);
    og.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.03);
    osc.onended = () => {
      osc.disconnect();
      og.disconnect();
    };

    const noise = c.createBufferSource();
    noise.buffer = this.noiseBuf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(900, t0);
    bp.frequency.exponentialRampToValueAtTime(280, t0 + duration);
    bp.Q.value = 0.8;
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.2 * s, t0);
    ng.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    noise.connect(bp);
    bp.connect(ng);
    ng.connect(this.master);
    noise.start(t0);
    noise.stop(t0 + duration + 0.03);
    noise.onended = () => {
      noise.disconnect();
      bp.disconnect();
      ng.disconnect();
    };
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

    // ---- anti-grav: sine fundamental + triangle harmonic → flight gain --------
    const fg = ctx.createGain();
    fg.gain.value = 0;
    fg.connect(master);
    const flight = ctx.createOscillator();
    flight.type = 'sine';
    flight.frequency.value = 92;
    const flightHarm = ctx.createOscillator();
    flightHarm.type = 'triangle';
    flightHarm.frequency.value = 276;
    const flightBaseGain = ctx.createGain();
    flightBaseGain.gain.value = 0.7;
    const flightHarmGain = ctx.createGain();
    flightHarmGain.gain.value = 0.18;
    flight.connect(flightBaseGain);
    flightHarm.connect(flightHarmGain);
    flightBaseGain.connect(fg);
    flightHarmGain.connect(fg);
    flight.start();
    flightHarm.start();
    this.flightOsc = flight;
    this.flightHarm = flightHarm;
    this.flightGain = fg;

    const flightNoise = ctx.createBufferSource();
    flightNoise.buffer = buf;
    flightNoise.loop = true;
    const flightNoiseBp = ctx.createBiquadFilter();
    flightNoiseBp.type = 'bandpass';
    flightNoiseBp.frequency.value = 620;
    flightNoiseBp.Q.value = 0.65;
    const flightNoiseGain = ctx.createGain();
    flightNoiseGain.gain.value = 0;
    flightNoise.connect(flightNoiseBp);
    flightNoiseBp.connect(flightNoiseGain);
    flightNoiseGain.connect(master);
    flightNoise.start();
    this.flightNoiseGain = flightNoiseGain;
    this.flightNoiseBp = flightNoiseBp;

    const driftNoise = ctx.createBufferSource();
    driftNoise.buffer = buf;
    driftNoise.loop = true;
    const driftBp = ctx.createBiquadFilter();
    driftBp.type = 'bandpass';
    driftBp.frequency.value = 760;
    driftBp.Q.value = 1.1;
    const driftGain = ctx.createGain();
    driftGain.gain.value = 0;
    driftNoise.connect(driftBp);
    driftBp.connect(driftGain);
    driftGain.connect(master);
    driftNoise.start();
    this.driftBp = driftBp;
    this.driftGain = driftGain;

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

    // ---- in-air pressure: wider, brighter noise with directional air-brake ----
    const airNoise = ctx.createBufferSource();
    airNoise.buffer = buf;
    airNoise.loop = true;
    const airBp = ctx.createBiquadFilter();
    airBp.type = 'bandpass';
    airBp.frequency.value = 900;
    airBp.Q.value = 0.55;
    const airPan = ctx.createStereoPanner();
    const airGain = ctx.createGain();
    airGain.gain.value = 0;
    airNoise.connect(airBp);
    airBp.connect(airPan);
    airPan.connect(airGain);
    airGain.connect(master);
    airNoise.start();
    this.airRushBp = airBp;
    this.airRushPan = airPan;
    this.airRushGain = airGain;
  }
}
