/**
 * audio.ts — streamed rock score plus a restrained synthesized vehicle layer.
 *
 * Graph (built lazily on first resume(), i.e. first user gesture):
 *
 *   engine:  saw(−7¢) ─┐
 *            saw(+6¢) ─┼─► waveshaper(light grit) ─► lowpass ─► engineGain ──┐
 *            sine(sub)─┤   ▲                                                  │
 *            saw(+1oct)─► boostGain ──────────────────────────────────────────┤
 *   score:   HTMLAudioElement ─► media source ─► music bus ───────────────────┤
 *   rush:    noise loop ─► bandpass ─► rushGain ──────────────────────────────┤
 *   music / ambience / vehicle / event buses ─► master ─► limiter ─► destination
 *
 * All continuous params move via setTargetAtTime (no zipper noise), and the
 * set* hot paths allocate nothing — every node there is built once in build().
 * One-shots allocate their short-lived nodes per call and self-disconnect.
 * Every method is a harmless no-op until resume() has built the context.
 */
import rockOgg from '../assets/audio/board-race-rock.ogg?url';
import rockMp3 from '../assets/audio/board-race-rock.mp3?url';
import goMaleOgg from '../assets/audio/countdown-go-male.ogg?url';
import goMaleMp3 from '../assets/audio/countdown-go-male.mp3?url';
import goFemaleOgg from '../assets/audio/countdown-go-female.ogg?url';
import goFemaleMp3 from '../assets/audio/countdown-go-female.mp3?url';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const AUDIO_STORAGE_KEY = 'board-race.audio.v1';
const SAFETY_HIGHPASS_HZ = 48;
const LIMITER_THRESHOLD_DB = -14;
const LIMITER_RATIO = 16;

export type GameAudioScene =
  | 'ready'
  | 'countdown'
  | 'racing'
  | 'flight'
  | 'medal'
  | 'defeat'
  | 'lesson'
  | 'hidden';

export interface AudioSettings {
  master: number;
  music: number;
  sfx: number;
  ambience: number;
  muted: boolean;
}

const DEFAULT_SETTINGS: AudioSettings = {
  master: 0.7,
  music: 0.78,
  sfx: 0.65,
  ambience: 0.12,
  muted: false,
};

const gainCurve = (value: number): number => clamp01(value) ** 1.5;

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
  private musicBus: GainNode | null = null;
  private musicFilter: BiquadFilterNode | null = null;
  private ambienceBus: GainNode | null = null;
  private vehicleBus: GainNode | null = null;
  private eventBus: GainNode | null = null;
  private musicElement: HTMLAudioElement | null = null;
  private musicSource: MediaElementAudioSourceNode | null = null;
  private musicReady = false;
  private musicFailed = false;
  private scoreArmed = false;
  private musicPreview = false;
  private musicPreviewToken = 0;
  private musicPreviewStopTimer = 0;
  private ambiencePreviewToken = 0;
  private ambiencePreview = false;
  private countdownStageValue = 3;
  private countdownVoice: 'male' | 'female' = 'male';
  private countdownVoiceBuffers: Partial<Record<'male' | 'female', AudioBuffer>> = {};
  private countdownVoiceData: Promise<Partial<Record<'male' | 'female', ArrayBuffer>>>;
  private countdownVoiceFormat: 'ogg' | 'mp3';
  private countdownVoiceFailed = false;
  private countdownVoiceEvents = 0;
  private raceScoreElapsed = 0;
  private lastFlowStep = -1;
  private lastDriftTier = 0;
  private musicDuckUntil = 0;
  private musicDuckMultiplier = 1;
  private noiseBuf: AudioBuffer | null = null;
  private settings: AudioSettings = loadAudioSettings();
  private scene: GameAudioScene = 'ready';
  private sceneBeforeHidden: GameAudioScene = 'ready';
  private retryVariation = 0;
  private lastFailureAt = -Infinity;
  private activeOneShots = 0;
  private flightExtendEvents = 0;
  private lastDriverSelectAt = -Infinity;
  private driverSelectEvents = 0;
  private lastDriverSelectIndex = -1;

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
    const probe = document.createElement('audio');
    this.countdownVoiceFormat = probe.canPlayType('audio/ogg; codecs="vorbis"') ? 'ogg' : 'mp3';
    const urls = this.countdownVoiceFormat === 'ogg'
      ? { male: goMaleOgg, female: goFemaleOgg }
      : { male: goMaleMp3, female: goFemaleMp3 };
    // Fetch before the first gesture. Mobile browsers only allow AudioContext
    // creation from that gesture, but the local bytes can already be warm.
    this.countdownVoiceData = this.preloadCountdownVoiceData(urls);
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
    if (c && !document.hidden) {
      if (c.state === 'suspended') {
        void c.resume().then(() => {
          this.applyMix(0.28);
          if (this.scoreArmed || this.musicPreview) this.ensureMusicPlaying();
        });
      } else if (c.state === 'running') {
        // A very short app switch can restore visibility before the delayed
        // suspend runs. The next explicit gesture must still restore the mix.
        this.applyMix(0.28);
        if (this.scoreArmed || this.musicPreview) this.ensureMusicPlaying();
      }
    }
  }

  update(dt: number): void {
    if (this.ctx && this.musicDuckMultiplier < 1 && this.ctx.currentTime >= this.musicDuckUntil) {
      this.musicDuckMultiplier = 1;
      this.applyMix(0.06);
    }
    if (!this.scoreArmed || (this.scene !== 'racing' && this.scene !== 'flight')) return;
    this.raceScoreElapsed += dt;
    const flowStep = Math.floor(this.raceScoreElapsed * 4);
    if (flowStep !== this.lastFlowStep) {
      this.lastFlowStep = flowStep;
      this.applyMix(0.42);
    }
  }

  getSettings(): AudioSettings {
    return { ...this.settings };
  }

  setSettings(next: Partial<AudioSettings>): void {
    this.settings = {
      master: clamp01(next.master ?? this.settings.master),
      music: clamp01(next.music ?? this.settings.music),
      sfx: clamp01(next.sfx ?? this.settings.sfx),
      ambience: clamp01(next.ambience ?? this.settings.ambience),
      muted: next.muted ?? this.settings.muted,
    };
    saveAudioSettings(this.settings);
    this.applyMix(0.06);
  }

  toggleMute(): boolean {
    this.setSettings({ muted: !this.settings.muted });
    return this.settings.muted;
  }

  setScene(scene: GameAudioScene): void {
    if (scene === this.scene) return;
    this.scene = scene;
    if (scene === 'ready') {
      this.musicPreview = false;
      this.musicPreviewToken++;
      // Before the first GO, READY is silent. Once a session has started, the
      // full song keeps its media position through results and later runs.
      if (!this.scoreArmed) this.musicElement?.pause();
      if (!this.scoreArmed && this.ctx && this.musicBus) {
        this.musicBus.gain.cancelScheduledValues(this.ctx.currentTime);
        this.musicBus.gain.value = 0;
      }
    }
    this.applyMix(scene === 'defeat' || scene === 'lesson' ? 0.08 : 0.14);
    if (scene !== 'hidden' && (this.scoreArmed || this.musicPreview)) this.ensureMusicPlaying();
  }

  /** Arm the formal score from an explicit GO. READY gestures only unlock Web Audio. */
  startRaceScore(fresh: boolean): void {
    this.resume();
    const firstStart = !this.scoreArmed;
    this.scoreArmed = true;
    this.musicPreview = false;
    this.musicPreviewToken++;
    this.countdownStageValue = 3;
    if (fresh && firstStart) {
      this.raceScoreElapsed = 0;
      this.lastFlowStep = -1;
      if (this.musicElement) {
        try {
          this.musicElement.currentTime = 0;
        } catch {
          // Metadata may still be loading. Playback starts from the browser's
          // initial position until the next fresh run.
        }
      }
    }
    this.applyMix(0.12);
    this.ensureMusicPlaying();
  }

  /** Alternate one announcer per countdown. The two voices never stack. */
  prepareCountdownAnnouncer(run: number): void {
    this.countdownVoice = Math.max(1, Math.floor(run)) % 2 === 0 ? 'female' : 'male';
  }

  /** Open the score one layer at a time behind the 3/2/1 count. */
  countdownStage(n: number): void {
    this.countdownStageValue = Math.max(1, Math.min(3, Math.round(n)));
    this.applyMix(0.075);
  }

  /** A single semantic callout at GO; 3/2/1 stay clean ticks and lights. */
  countdownGoVoice(): boolean {
    const c = this.ctx;
    const bus = this.eventBus;
    const buffer = this.countdownVoiceBuffers[this.countdownVoice];
    if (!c || !bus || !buffer) return false;
    const source = c.createBufferSource();
    source.buffer = buffer;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 90;
    const gain = c.createGain();
    const t = c.currentTime;
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(0.58, t + 0.012);
    gain.gain.setValueAtTime(0.58, Math.max(t + 0.02, t + buffer.duration - 0.09));
    gain.gain.exponentialRampToValueAtTime(0.001, t + buffer.duration);
    source.connect(hp);
    hp.connect(gain);
    gain.connect(bus);
    this.countdownVoiceEvents++;
    this.duckMusic(0.58, Math.max(0.3, buffer.duration));
    this.trackOneShot(source, [hp, gain], t, t + buffer.duration + 0.01);
    return true;
  }

  debugState(): Record<string, number | string | boolean> {
    return {
      scene: this.scene,
      contextState: this.ctx?.state ?? 'unavailable',
      muted: this.settings.muted,
      master: this.settings.master,
      music: this.settings.music,
      sfx: this.settings.sfx,
      ambience: this.settings.ambience,
      activeOneShots: this.activeOneShots,
      flightExtendEvents: this.flightExtendEvents,
      driverSelectEvents: this.driverSelectEvents,
      lastDriverSelectIndex: this.lastDriverSelectIndex,
      outputGain: this.master?.gain.value ?? 0,
      musicBusGain: this.musicBus?.gain.value ?? 0,
      musicFilterHz: this.musicFilter?.frequency.value ?? 0,
      ambienceBusGain: this.ambienceBus?.gain.value ?? 0,
      vehicleBusGain: this.vehicleBus?.gain.value ?? 0,
      eventBusGain: this.eventBus?.gain.value ?? 0,
      musicReady: this.musicReady,
      musicFailed: this.musicFailed,
      musicPlaying: this.musicElement ? !this.musicElement.paused : false,
      musicTime: this.musicElement?.currentTime ?? 0,
      musicDuration: Number.isFinite(this.musicElement?.duration) ? this.musicElement?.duration ?? 0 : 0,
      musicLoop: this.musicElement?.loop ?? false,
      scoreArmed: this.scoreArmed,
      musicPreview: this.musicPreview,
      countdownStage: this.countdownStageValue,
      countdownVoice: this.countdownVoice,
      countdownVoiceFormat: this.countdownVoiceFormat,
      countdownVoiceReady: Boolean(this.countdownVoiceBuffers.male && this.countdownVoiceBuffers.female),
      countdownVoiceFailed: this.countdownVoiceFailed,
      countdownVoiceEvents: this.countdownVoiceEvents,
      scoreElapsed: this.raceScoreElapsed,
      driftTier: this.lastDriftTier,
      musicDuck: this.musicDuckMultiplier,
      scorePreroll: 0,
      safetyHighpassHz: SAFETY_HIGHPASS_HZ,
      limiterThresholdDb: LIMITER_THRESHOLD_DB,
      limiterRatio: LIMITER_RATIO,
    };
  }

  /** Immediately silence background tabs; an explicit gesture restores audio. */
  setVisibility(hidden: boolean): void {
    const c = this.ctx;
    if (!c) return;
    if (hidden) {
      if (this.scene !== 'hidden') {
        this.sceneBeforeHidden = this.scene;
        this.scene = 'hidden';
      }
      this.applyMix(0.04);
      if (this.master) {
        this.master.gain.cancelScheduledValues(c.currentTime);
        this.master.gain.value = 0;
      }
      this.musicElement?.pause();
      window.setTimeout(() => {
        if ((document.hidden || this.scene === 'hidden') && c.state === 'running') void c.suspend();
      }, 90);
      return;
    }
    if (this.scene === 'hidden') this.scene = this.sceneBeforeHidden;
    // Browser autoplay policies intentionally leave the output at zero until
    // the resume GO gesture calls resume().
  }

  /** Mixer preview. Every preview is short and routed through the selected bus. */
  audition(kind: 'master' | 'music' | 'sfx' | 'ambience'): void {
    this.resume();
    if (kind === 'music') {
      if (this.scoreArmed) {
        this.musicPreview = false;
        this.applyMix(0.06);
        this.ensureMusicPlaying();
        return;
      }
      const token = ++this.musicPreviewToken;
      this.musicPreview = true;
      this.applyMix(0.06);
      this.ensureMusicPlaying();
      const startStopTimer = (): void => {
        if (token !== this.musicPreviewToken || !this.musicPreview) return;
        window.clearTimeout(this.musicPreviewStopTimer);
        this.musicPreviewStopTimer = window.setTimeout(() => this.stopMusicPreview(token), 1400);
      };
      if (this.musicElement?.readyState && this.musicElement.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        startStopTimer();
      } else {
        this.musicElement?.addEventListener('playing', startStopTimer, { once: true });
        this.musicPreviewStopTimer = window.setTimeout(() => this.stopMusicPreview(token), 5000);
      }
      return;
    }
    const c = this.ctx;
    const target = kind === 'ambience' ? this.ambienceBus : kind === 'sfx' ? this.eventBus : this.eventBus;
    if (!c || !target) return;
    if (kind === 'ambience' && this.noiseBuf) {
      const token = ++this.ambiencePreviewToken;
      if (this.scene === 'ready') {
        this.ambiencePreview = true;
        this.ambienceBus?.gain.cancelScheduledValues(c.currentTime);
        this.ambienceBus?.gain.setValueAtTime(gainCurve(this.settings.ambience) * 0.35, c.currentTime);
      }
      const source = c.createBufferSource();
      source.buffer = this.noiseBuf;
      const hp = c.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 900;
      const gain = c.createGain();
      gain.gain.setValueAtTime(0.045, c.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.32);
      source.connect(hp);
      hp.connect(gain);
      gain.connect(target);
      this.trackOneShot(source, [hp, gain], c.currentTime, c.currentTime + 0.35);
      window.setTimeout(() => {
        if (token !== this.ambiencePreviewToken) return;
        this.ambiencePreview = false;
        this.applyMix(0.08);
      }, 420);
      return;
    }
    this.blip(kind === 'master' ? 720 : 960, c.currentTime, 0.22, 0.11, 'triangle');
  }

  collision(strength: number): void {
    const c = this.ctx;
    if (!c) return;
    const n = clamp01(strength / 18);
    this.impactBurst(118 - n * 34, 44 - n * 12, 0.38 + n * 0.52, 0.13 + n * 0.14);
    this.blip(210 - n * 70, c.currentTime, 0.12, 0.08 + n * 0.08, 'square');
    this.duckMusic(0.72 - n * 0.18, 0.12 + n * 0.1);
  }

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
      if (active) {
        this.impactBurst(118, 42, 1, 0.28);
        this.duckMusic(0.64, 0.24);
      }
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
    const tier = n >= 0.88 ? 3 : n >= 0.58 ? 2 : n >= 0.28 ? 1 : 0;
    if (tier > this.lastDriftTier) {
      this.lastDriftTier = tier;
      this.blip(620 + tier * 210, t, 0.075 + tier * 0.012, 0.045 + tier * 0.012, 'triangle');
    } else if (n < 0.06) {
      this.lastDriftTier = 0;
    }
  }

  flightReady(charges = 1): void {
    const c = this.ctx;
    if (!c) return;
    this.impactBurst(160, 72, 0.5, 0.18);
    const lift = charges >= 2 ? 1.16 : 1;
    this.blip(620 * lift, c.currentTime, 0.18, 0.2, 'triangle');
    this.blip(930 * lift, c.currentTime + 0.07, 0.25, 0.19, 'triangle');
    this.blip(1395 * lift, c.currentTime + 0.14, 0.32, 0.14, 'square');
  }

  flightExtend(): void {
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime;
    this.flightExtendEvents++;
    // A clean rising confirmation that cuts through the score without adding
    // another low-frequency impact to small phone speakers.
    this.blip(720, t, 0.13, 0.11, 'triangle');
    this.blip(1080, t + 0.055, 0.2, 0.12, 'triangle');
    this.blip(1440, t + 0.12, 0.28, 0.1, 'square');
    this.duckMusic(0.8, 0.16);
  }

  driverSelected(index: number, direction: -1 | 1): void {
    const c = this.ctx;
    if (!c) return;
    if (c.currentTime - this.lastDriverSelectAt < 0.055) return;
    this.lastDriverSelectAt = c.currentTime;
    this.driverSelectEvents++;
    this.lastDriverSelectIndex = index;
    const notes = [392, 440, 494, 587, 659, 784];
    const root = notes[Math.max(0, Math.min(notes.length - 1, index))];
    const t = c.currentTime;
    if (this.noiseBuf && this.eventBus) {
      const snap = c.createBufferSource();
      snap.buffer = this.noiseBuf;
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1800 + index * 140;
      bp.Q.value = 1.35;
      const pan = c.createStereoPanner();
      pan.pan.value = direction * 0.12;
      const gain = c.createGain();
      gain.gain.setValueAtTime(0.075, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      snap.connect(bp);
      bp.connect(pan);
      pan.connect(gain);
      gain.connect(this.eventBus);
      this.trackOneShot(snap, [bp, pan, gain], t, t + 0.18);
    }
    this.blip(root * (direction > 0 ? 1 : 0.94), t, 0.16, 0.09, 'triangle');
    this.blip(root * 1.5, t + 0.055, 0.22, 0.085, 'square');
    this.blip(root * 2, t + 0.12, 0.24, 0.07, 'triangle');
  }

  driftReleaseReady(): void {
    const c = this.ctx;
    if (!c) return;
    this.blip(760, c.currentTime, 0.08, 0.075, 'triangle');
    this.blip(1140, c.currentTime + 0.045, 0.11, 0.06, 'triangle');
  }

  flightGate(index: number): void {
    const c = this.ctx;
    if (!c) return;
    this.impactBurst(142 + index * 8, 76, 0.46 + index * 0.12, 0.14);
    this.blip(680 + index * 150, c.currentTime, 0.2, 0.18, 'square');
    this.duckMusic(0.72, 0.14);
  }

  routeClear(flightNumber = 1): void {
    const c = this.ctx;
    if (!c) return;
    const step = Math.max(0, Math.min(2, flightNumber - 1));
    this.blip(880 + step * 110, c.currentTime, 0.18, 0.14, 'triangle');
    this.blip(1320 + step * 150, c.currentTime + 0.09, 0.3, 0.16, 'triangle');
    this.duckMusic(0.72, 0.2);
  }

  flightMiss(): void {
    const c = this.ctx;
    if (!c) return;
    if (c.currentTime - this.lastFailureAt < 0.18) return;
    this.lastFailureAt = c.currentTime;
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
    this.duckMusic(positive ? 0.66 : 0.8, positive ? 0.2 : 0.13);
  }

  boostIgnition(): void {
    const c = this.ctx;
    if (!c) return;
    this.impactBurst(155, 58, 0.88, 0.24);
    this.blip(480, c.currentTime + 0.018, 0.18, 0.16, 'sawtooth');
    this.blip(960, c.currentTime + 0.075, 0.25, 0.12, 'square');
    this.duckMusic(0.69, 0.18);
  }

  airBrakeSnap(): void {
    const c = this.ctx;
    if (!c) return;
    this.impactBurst(210, 86, 0.42, 0.16);
    this.blip(360, c.currentTime, 0.12, 0.11, 'sawtooth');
    this.duckMusic(0.78, 0.11);
  }

  defeat(): void {
    const c = this.ctx;
    if (!c) return;
    this.lastFailureAt = c.currentTime;
    this.impactBurst(78, 24, 1, 0.55);
    this.blip(310, c.currentTime + 0.03, 0.42, 0.2, 'sawtooth');
    this.blip(196, c.currentTime + 0.12, 0.52, 0.18, 'square');
  }

  retryLesson(): void {
    const c = this.ctx;
    if (!c) return;
    const roots = [220, 247, 196, 262];
    const root = roots[this.retryVariation++ % roots.length];
    this.impactBurst(126, 58, 0.34, 0.14);
    this.blip(root, c.currentTime, 0.12, 0.1, 'square');
    this.blip(root * 2, c.currentTime + 0.08, 0.18, 0.1, 'triangle');
  }

  playMedalCeremony(): void {
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime;
    const notes = [164.81, 196, 246.94, 329.63, 392, 493.88, 659.25];
    for (let i = 0; i < notes.length; i++) {
      this.blip(notes[i], t + i * 0.1, i === notes.length - 1 ? 0.9 : 0.22, 0.16, i < 3 ? 'sawtooth' : 'triangle');
    }
    for (let i = 0; i < 7; i++) this.firework(t + 0.4 + i * 0.49, i);
  }

  /** Landing slam: sine 130→42 Hz pitch drop + lowpassed noise burst. */
  thud(strength: number): void {
    const c = this.ctx;
    if (!c || !this.eventBus || !this.noiseBuf) return;
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
    og.connect(this.eventBus);
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
    ng.connect(this.eventBus);
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
    if (!c || !this.eventBus || !this.noiseBuf) return;
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
    g.connect(this.eventBus);
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
  horn(delay = 0): void {
    const c = this.ctx;
    if (!c || !this.eventBus) return;
    const t0 = c.currentTime + Math.max(0, delay);

    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.3, t0 + 0.025);
    g.gain.setValueAtTime(0.3, t0 + 0.85);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 1.2);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1600;
    g.connect(lp);
    lp.connect(this.eventBus);

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

  private applyMix(timeConstant = 0.08): void {
    const c = this.ctx;
    if (!c || !this.master || !this.musicBus || !this.musicFilter || !this.ambienceBus || !this.vehicleBus || !this.eventBus) return;
    const t = c.currentTime;
    const muted = this.settings.muted || this.scene === 'hidden';
    const master = muted ? 0 : gainCurve(this.settings.master);
    const sceneMusic = this.sceneMusicLevel();
    if (t >= this.musicDuckUntil) this.musicDuckMultiplier = 1;
    const duck = t < this.musicDuckUntil ? this.musicDuckMultiplier : 1;
    const sceneVehicle = this.scene === 'medal' ? 0.25
      : this.scene === 'lesson' || this.scene === 'defeat' || this.scene === 'ready' ? 0
        : this.scene === 'countdown' ? 0.18
          : 1;
    const sceneAmbience = this.scene === 'ready' ? (this.ambiencePreview ? 0.35 : 0)
      : this.scene === 'medal' ? 0.18
        : this.scene === 'lesson' || this.scene === 'defeat' ? 0.12
          : 0.62;
    this.master.gain.setTargetAtTime(master, t, timeConstant);
    const musicBase = gainCurve(this.settings.music) * sceneMusic;
    this.musicBus.gain.cancelScheduledValues(t);
    this.musicBus.gain.setTargetAtTime(musicBase * duck, t, timeConstant);
    if (duck < 1) this.musicBus.gain.setTargetAtTime(musicBase, this.musicDuckUntil, 0.08);
    this.ambienceBus.gain.setTargetAtTime(gainCurve(this.settings.ambience) * sceneAmbience, t, timeConstant);
    this.vehicleBus.gain.setTargetAtTime(gainCurve(this.settings.sfx) * sceneVehicle, t, timeConstant);
    this.eventBus.gain.setTargetAtTime(gainCurve(this.settings.sfx), t, timeConstant);
    this.musicFilter.frequency.setTargetAtTime(
      this.scene === 'lesson' || this.scene === 'defeat' ? 1500
        : this.scene === 'ready' && this.musicPreview ? 6000
          : this.scene === 'countdown' ? (this.countdownStageValue === 3 ? 850 : this.countdownStageValue === 2 ? 1800 : 4200)
            : 11000,
      t,
      timeConstant,
    );
  }

  private sceneMusicLevel(): number {
    const countdownMusic = this.countdownStageValue === 3 ? 0.08
      : this.countdownStageValue === 2 ? 0.18
        : 0.34;
    const flow = clamp01(this.raceScoreElapsed / 14);
    switch (this.scene) {
      case 'ready': return this.scoreArmed ? 0.28 : this.musicPreview ? 0.42 : 0;
      case 'lesson': return 0.18;
      case 'defeat': return 0.22;
      case 'medal': return 0.38;
      case 'countdown': return countdownMusic;
      case 'flight': return 0.62 + flow * 0.26;
      case 'racing': return 0.52 + flow * 0.24;
      case 'hidden': return 0;
    }
  }

  private duckMusic(multiplier: number, duration: number): void {
    const c = this.ctx;
    const bus = this.musicBus;
    if (!c || !bus) return;
    const t = c.currentTime;
    const base = gainCurve(this.settings.music) * this.sceneMusicLevel();
    const active = t < this.musicDuckUntil;
    this.musicDuckMultiplier = active ? Math.min(this.musicDuckMultiplier, multiplier) : multiplier;
    this.musicDuckUntil = Math.max(active ? this.musicDuckUntil : 0, t + duration);
    bus.gain.cancelScheduledValues(t);
    bus.gain.setTargetAtTime(base * this.musicDuckMultiplier, t, 0.018);
    bus.gain.setTargetAtTime(base, this.musicDuckUntil, 0.08);
  }

  private firework(time: number, index: number): void {
    const c = this.ctx;
    const bus = this.eventBus;
    if (!c || !bus || !this.noiseBuf) return;
    const noise = c.createBufferSource();
    noise.buffer = this.noiseBuf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700 + (index % 4) * 420;
    bp.Q.value = 0.7;
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.13, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.24);
    noise.connect(bp);
    bp.connect(gain);
    gain.connect(bus);
    this.trackOneShot(noise, [bp, gain], time, time + 0.27);
  }

  private trackOneShot(source: AudioScheduledSourceNode, nodes: AudioNode[], start: number, stop: number): void {
    this.activeOneShots++;
    source.start(start);
    source.stop(stop);
    source.onended = () => {
      source.disconnect();
      for (const node of nodes) node.disconnect();
      this.activeOneShots = Math.max(0, this.activeOneShots - 1);
    };
  }

  private async preloadCountdownVoiceData(
    urls: Record<'male' | 'female', string>,
  ): Promise<Partial<Record<'male' | 'female', ArrayBuffer>>> {
    try {
      const [male, female] = await Promise.all((['male', 'female'] as const).map(async (voice) => {
        const response = await fetch(urls[voice]);
        if (!response.ok) throw new Error(`${voice} countdown voice ${response.status}`);
        return response.arrayBuffer();
      }));
      return { male, female };
    } catch {
      return {};
    }
  }

  private async loadCountdownVoices(): Promise<void> {
    const c = this.ctx;
    if (!c || this.countdownVoiceBuffers.male || this.countdownVoiceFailed) return;
    try {
      let data = await this.countdownVoiceData;
      let maleData = data.male;
      let femaleData = data.female;
      if ((!maleData || !femaleData) && this.countdownVoiceFormat === 'ogg') {
        this.countdownVoiceFormat = 'mp3';
        data = await this.preloadCountdownVoiceData({ male: goMaleMp3, female: goFemaleMp3 });
        maleData = data.male;
        femaleData = data.female;
      }
      if (!maleData || !femaleData) throw new Error('countdown voice preload failed');
      let male: AudioBuffer;
      let female: AudioBuffer;
      try {
        [male, female] = await Promise.all([
          c.decodeAudioData(maleData.slice(0)),
          c.decodeAudioData(femaleData.slice(0)),
        ]);
      } catch {
        // canPlayType is advisory. If a browser overstates Vorbis support,
        // retry the universally-supported MP3 pair before falling back to a beep.
        if (this.countdownVoiceFormat !== 'ogg') throw new Error('MP3 countdown voice decode failed');
        this.countdownVoiceFormat = 'mp3';
        data = await this.preloadCountdownVoiceData({ male: goMaleMp3, female: goFemaleMp3 });
        maleData = data.male;
        femaleData = data.female;
        if (!maleData || !femaleData) throw new Error('MP3 countdown voice preload failed');
        [male, female] = await Promise.all([
          c.decodeAudioData(maleData.slice(0)),
          c.decodeAudioData(femaleData.slice(0)),
        ]);
      }
      this.countdownVoiceBuffers.male = male;
      this.countdownVoiceBuffers.female = female;
    } catch {
      // The existing GO hit and horn remain a complete fallback.
      this.countdownVoiceFailed = true;
    }
  }

  private applyRush(): void {
    const c = this.ctx;
    if (!c || !this.rushGain || !this.rushBp) return;
    const t = c.currentTime;
    const airMix = this.flightActive ? this.flightClearance : this.airborne ? 0.7 : 0;
    const modeGain = 1 - airMix * 0.84;
    const boostGain = this.lastBoost ? 0.3 : 0;
    const g = (0.11 + boostGain * 0.35) * this.speedNorm * modeGain;
    const f = 760 + 2200 * this.speedNorm + (this.lastBoost ? 650 : 0);
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
        ? (0.035 + this.flightPressure * 0.12) * (0.4 + airMix * 0.6) * (1 + this.flightAirBrake * 0.35)
        : 0;
      const pressureFrequency = (760 + this.flightPressure * 2500) * (1 - this.flightAirBrake * 0.18);
      this.airRushGain.gain.setTargetAtTime(pressureGain, t, this.flightActive ? 0.08 : 0.18);
      this.airRushBp.frequency.setTargetAtTime(pressureFrequency, t, 0.1);
      this.airRushPan.pan.setTargetAtTime(-this.flightSteer * this.flightAirBrake * 0.25, t, 0.06);
    }
  }

  private ensureMusicPlaying(): void {
    const media = this.musicElement;
    if (!media || (!this.scoreArmed && !this.musicPreview) || this.musicFailed || document.hidden || this.scene === 'hidden' || this.settings.muted) return;
    void media.play().catch(() => {
      // Autoplay refusal is expected until the next explicit pointer/key gesture.
    });
  }

  private stopMusicPreview(token: number): void {
    if (token !== this.musicPreviewToken || !this.musicPreview || this.scoreArmed || this.scene !== 'ready') return;
    this.musicPreview = false;
    this.musicElement?.pause();
    if (this.ctx && this.musicBus) {
      this.musicBus.gain.cancelScheduledValues(this.ctx.currentTime);
      this.musicBus.gain.value = 0;
    }
    this.applyMix(0.1);
  }

  private impactBurst(startHz: number, endHz: number, strength: number, duration: number): void {
    const c = this.ctx;
    if (!c || !this.eventBus || !this.noiseBuf) return;
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
    og.connect(this.eventBus);
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
    ng.connect(this.eventBus);
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
    if (!c || !this.eventBus) return;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g);
    g.connect(this.eventBus);
    this.activeOneShots++;
    o.start(t0);
    o.stop(t0 + dur + 0.05);
    o.onended = () => {
      o.disconnect();
      g.disconnect();
      this.activeOneShots = Math.max(0, this.activeOneShots - 1);
    };
  }

  /** Build the whole graph. Called once, from resume(). */
  private build(): void {
    const ctx = new AudioContext();
    this.ctx = ctx;

    // Four independently duckable buses feed a phone-safe high-pass and limiter.
    const master = ctx.createGain();
    master.gain.value = 0;
    const safetyHp = ctx.createBiquadFilter();
    safetyHp.type = 'highpass';
    safetyHp.frequency.value = SAFETY_HIGHPASS_HZ;
    safetyHp.Q.value = 0.6;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = LIMITER_THRESHOLD_DB;
    comp.knee.value = 10;
    comp.ratio.value = LIMITER_RATIO;
    comp.attack.value = 0.002;
    comp.release.value = 0.18;
    master.connect(safetyHp);
    safetyHp.connect(comp);
    comp.connect(ctx.destination);
    this.master = master;

    const musicBus = ctx.createGain();
    musicBus.gain.value = 0;
    const musicFilter = ctx.createBiquadFilter();
    musicFilter.type = 'lowpass';
    musicFilter.frequency.value = 9000;
    musicBus.connect(musicFilter);
    musicFilter.connect(master);
    this.musicBus = musicBus;
    this.musicFilter = musicFilter;

    const ambienceBus = ctx.createGain();
    const vehicleBus = ctx.createGain();
    const eventBus = ctx.createGain();
    ambienceBus.gain.value = 0;
    vehicleBus.gain.value = 0;
    eventBus.gain.value = 0;
    ambienceBus.connect(master);
    vehicleBus.connect(master);
    eventBus.connect(master);
    this.ambienceBus = ambienceBus;
    this.vehicleBus = vehicleBus;
    this.eventBus = eventBus;

    const music = new Audio();
    // The track remains silent until GO, but decoding the local song ahead
    // of time prevents the first mixer preview from reporting "playing" while
    // the media clock is still waiting on data.
    music.preload = 'auto';
    // Loop only after the complete song ends. New runs never seek or restart it.
    music.loop = true;
    music.crossOrigin = 'anonymous';
    music.src = music.canPlayType('audio/ogg; codecs="vorbis"') ? rockOgg : rockMp3;
    music.addEventListener('canplay', () => {
      this.musicReady = true;
      if (this.scoreArmed || this.musicPreview) this.ensureMusicPlaying();
    }, { once: true });
    music.addEventListener('error', () => { this.musicFailed = true; }, { once: true });
    const musicSource = ctx.createMediaElementSource(music);
    musicSource.connect(musicBus);
    this.musicElement = music;
    this.musicSource = musicSource;

    // shared 2s white-noise buffer (rush loop + thud/splash bursts)
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    void this.loadCountdownVoices();

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
    eng.connect(vehicleBus);
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
    this.sub = mkOsc('sine', 41, 0, 0.18);
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
    fg.connect(vehicleBus);
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
    flightNoiseGain.connect(vehicleBus);
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
    driftGain.connect(vehicleBus);
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
    rg.connect(ambienceBus);
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
    airGain.connect(ambienceBus);
    airNoise.start();
    this.airRushBp = airBp;
    this.airRushPan = airPan;
    this.airRushGain = airGain;

    this.applyMix(0.02);
  }
}

function loadAudioSettings(): AudioSettings {
  try {
    const raw = localStorage.getItem(AUDIO_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AudioSettings>;
    const savedAmbience = typeof parsed.ambience === 'number' ? clamp01(parsed.ambience) : DEFAULT_SETTINGS.ambience;
    return {
      master: typeof parsed.master === 'number' ? clamp01(parsed.master) : DEFAULT_SETTINGS.master,
      music: typeof parsed.music === 'number' ? clamp01(parsed.music) : DEFAULT_SETTINGS.music,
      sfx: typeof parsed.sfx === 'number' ? clamp01(parsed.sfx) : DEFAULT_SETTINGS.sfx,
      // Migrate the old shipped 22% default without overwriting values users
      // actually customized in the mixer.
      ambience: Math.abs(savedAmbience - 0.22) < 1e-6 ? DEFAULT_SETTINGS.ambience : savedAmbience,
      muted: parsed.muted === true,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveAudioSettings(settings: AudioSettings): void {
  try {
    localStorage.setItem(AUDIO_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Audio preferences are optional; sound remains usable for this session.
  }
}
