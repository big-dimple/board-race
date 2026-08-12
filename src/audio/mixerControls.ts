import type { AudioSettings, GameAudio } from './audio';
import './mixerControls.css';

const ROWS: ReadonlyArray<{ key: keyof Pick<AudioSettings, 'master' | 'music' | 'sfx' | 'ambience'>; label: string }> = [
  { key: 'master', label: '总音量' },
  { key: 'music', label: '摇滚' },
  { key: 'sfx', label: '音效' },
  { key: 'ambience', label: '海浪 / 狂风' },
];

export class MixerControls {
  private readonly root: HTMLDivElement;
  private readonly toggle: HTMLButtonElement;
  private readonly mute: HTMLButtonElement;
  private readonly inputs = new Map<string, HTMLInputElement>();

  constructor(parent: HTMLElement, private readonly audio: GameAudio) {
    const root = document.createElement('div');
    root.className = 'audio-mixer';
    root.innerHTML = '<button class="audio-mixer-toggle" type="button" aria-label="声音设置">SOUND</button>';
    this.root = root;
    this.toggle = root.querySelector<HTMLButtonElement>('.audio-mixer-toggle')!;
    const panel = document.createElement('div');
    panel.className = 'audio-mixer-panel';
    panel.setAttribute('aria-label', '声音设置');
    root.appendChild(panel);

    const settings = audio.getSettings();
    for (const row of ROWS) {
      const label = document.createElement('label');
      label.className = 'audio-mixer-row';
      const text = document.createElement('span');
      text.textContent = row.label;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = '100';
      input.step = '1';
      input.value = String(Math.round(settings[row.key] * 100));
      input.setAttribute('aria-label', row.label);
      input.addEventListener('input', () => audio.setSettings({ [row.key]: Number(input.value) / 100 }));
      label.append(text, input);
      panel.appendChild(label);
      this.inputs.set(row.key, input);
    }

    this.mute = document.createElement('button');
    this.mute.className = 'audio-mixer-mute';
    this.mute.type = 'button';
    this.mute.addEventListener('click', () => {
      audio.resume();
      audio.toggleMute();
      this.sync();
    });
    panel.appendChild(this.mute);

    this.toggle.addEventListener('click', () => {
      audio.resume();
      root.classList.toggle('open');
      this.toggle.setAttribute('aria-expanded', String(root.classList.contains('open')));
    });
    this.toggle.setAttribute('aria-expanded', 'false');
    parent.appendChild(root);
    this.sync();
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('visible', visible);
    if (!visible) {
      this.root.classList.remove('open');
      this.toggle.setAttribute('aria-expanded', 'false');
    }
  }

  sync(): void {
    const settings = this.audio.getSettings();
    this.mute.textContent = settings.muted ? '开启声音' : '静音';
    this.mute.classList.toggle('muted', settings.muted);
    for (const row of ROWS) {
      const input = this.inputs.get(row.key);
      if (input && document.activeElement !== input) input.value = String(Math.round(settings[row.key] * 100));
    }
  }
}
