import {
  CaptureService,
  type CaptureExportAction,
  type CaptureExportOutcome,
} from '../core/capture';
import './capturePreview.css';

interface CaptureRequest {
  blob: Blob;
  filename: string;
}

type CapturePlatform = 'desktop' | 'android' | 'ios';

export class CapturePreview {
  private readonly root: HTMLDivElement;
  private readonly image: HTMLImageElement;
  private readonly title: HTMLHeadingElement;
  private readonly hint: HTMLParagraphElement;
  private readonly status: HTMLDivElement;
  private readonly primary: HTMLButtonElement;
  private readonly secondary: HTMLButtonElement;
  private readonly returnButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private request: CaptureRequest | null = null;
  private objectUrl = '';
  private primaryAction: CaptureExportAction = 'download';
  private secondaryAction: CaptureExportAction | null = null;
  private busy = false;
  private restoreFocus: HTMLElement | null = null;

  constructor(
    parent: HTMLElement,
    private readonly service: CaptureService,
    private readonly onOutcome: (action: CaptureExportAction, outcome: CaptureExportOutcome) => void,
    private readonly onVisibilityChange: (visible: boolean) => void = () => {},
    private readonly onDismissGesture: () => void = () => {},
  ) {
    const root = document.createElement('div');
    root.className = 'capture-preview';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'capture-preview-title');
    root.innerHTML = `
      <div class="capture-preview-panel">
        <button class="capture-preview-close" type="button" aria-label="关闭截图预览" title="关闭">×</button>
        <div class="capture-preview-media"><img alt=""></div>
        <div class="capture-preview-copy">
          <div class="capture-preview-kicker">BOARD RACE · PNG</div>
          <h2 id="capture-preview-title">截图预览</h2>
          <p class="capture-preview-hint"></p>
          <div class="capture-preview-actions">
            <button class="capture-preview-primary" type="button"></button>
            <button class="capture-preview-secondary" type="button"></button>
            <button class="capture-preview-return" type="button">回到游戏</button>
          </div>
          <div class="capture-preview-status" role="status" aria-live="polite"></div>
        </div>
      </div>`;
    parent.appendChild(root);
    this.root = root;
    this.image = root.querySelector('img')!;
    this.title = root.querySelector('h2')!;
    this.hint = root.querySelector('.capture-preview-hint')!;
    this.status = root.querySelector('.capture-preview-status')!;
    this.primary = root.querySelector('.capture-preview-primary')!;
    this.secondary = root.querySelector('.capture-preview-secondary')!;
    this.returnButton = root.querySelector('.capture-preview-return')!;
    this.closeButton = root.querySelector('.capture-preview-close')!;
    this.primary.addEventListener('click', () => void this.run(this.primaryAction));
    this.secondary.addEventListener('click', () => {
      if (this.secondaryAction) void this.run(this.secondaryAction);
    });
    this.returnButton.addEventListener('click', () => {
      // Keep the fullscreen request on the same trusted gesture that dismisses
      // the preview. Waiting until after hide loses browser activation.
      this.dismissFromGesture();
    });
    this.closeButton.addEventListener('click', () => {
      // Keep the fullscreen request on the same trusted gesture that dismisses
      // the preview. Waiting until after hide loses browser activation.
      this.dismissFromGesture();
    });
    root.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        this.hide();
      }
    });
  }

  show(blob: Blob, filename: string): void {
    this.hide(false);
    this.restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.request = { blob, filename };
    this.objectUrl = URL.createObjectURL(blob);
    this.image.src = this.objectUrl;
    this.image.alt = '七飞认证截图预览';
    this.title.textContent = 'Final 截图';
    this.status.textContent = '';
    this.configureActions(detectPlatform(), blob, filename);
    this.onVisibilityChange(true);
    this.root.classList.add('on');
    this.primary.focus({ preventScroll: true });
  }

  hide(restore = true): void {
    if (!this.root.classList.contains('on')) return;
    this.root.classList.remove('on');
    this.onVisibilityChange(false);
    this.request = null;
    this.busy = false;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = '';
    this.image.removeAttribute('src');
    if (restore && this.restoreFocus?.isConnected) this.restoreFocus.focus({ preventScroll: true });
    this.restoreFocus = null;
  }

  visible(): boolean { return this.root.classList.contains('on'); }

  private dismissFromGesture(): void {
    this.onDismissGesture();
    this.hide();
  }

  private configureActions(platform: CapturePlatform, blob: Blob, filename: string): void {
    if (platform === 'android') {
      this.primaryAction = 'download';
      this.primary.textContent = '下载 PNG';
      this.hint.textContent = '文件将进入系统“下载”目录，可在文件管理中查看。';
      this.setSecondary(this.service.supports('share', blob, filename) ? 'share' : null, '分享');
      return;
    }
    if (platform === 'ios') {
      const canShare = this.service.supports('share', blob, filename);
      this.primaryAction = canShare ? 'share' : 'download';
      this.primary.textContent = canShare ? '存储 / 分享' : '下载到“文件”';
      this.hint.textContent = canShare
        ? '在系统面板选择“存储图像”可保存到照片。'
        : 'Safari 会将 PNG 保存到“文件”的下载目录。';
      this.setSecondary(canShare ? 'download' : null, '下载到“文件”');
      return;
    }
    const canSave = this.service.supports('save');
    this.primaryAction = canSave ? 'save' : 'download';
    this.primary.textContent = canSave ? '保存 PNG' : '下载 PNG';
    this.hint.textContent = canSave ? '选择文件名和保存位置。' : 'PNG 将保存到浏览器下载目录。';
    this.setSecondary(this.service.supports('copy') ? 'copy' : null, '复制图片');
  }

  private setSecondary(action: CaptureExportAction | null, label: string): void {
    this.secondaryAction = action;
    this.secondary.hidden = action === null;
    this.secondary.textContent = label;
  }

  private async run(action: CaptureExportAction): Promise<void> {
    if (!this.request || this.busy) return;
    const request = this.request;
    this.busy = true;
    this.primary.disabled = true;
    this.secondary.disabled = true;
    this.status.textContent = action === 'copy' ? '正在复制…' : action === 'share' ? '正在打开系统面板…' : '正在导出…';
    try {
      const outcome = await this.service.export(action, request.blob, request.filename);
      this.status.textContent = outcomeCopy(outcome);
      this.onOutcome(action, outcome);
    } catch {
      this.status.textContent = '导出失败 · 可改用下载 PNG';
      this.onOutcome(action, 'failed');
    } finally {
      this.busy = false;
      this.primary.disabled = false;
      this.secondary.disabled = false;
    }
  }
}

function detectPlatform(): CapturePlatform {
  const ua = navigator.userAgent;
  const ipad = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/i.test(ua) || ipad) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}

function outcomeCopy(outcome: CaptureExportOutcome): string {
  if (outcome === 'saved') return 'PNG 已保存';
  if (outcome === 'downloaded') return '下载已开始 · 请到系统“下载”查看';
  if (outcome === 'copied') return '图片已复制到剪贴板';
  if (outcome === 'share-opened') return '已交给系统面板 · 保存位置由所选操作决定';
  if (outcome === 'cancelled') return '已取消，截图仍保留在这里';
  if (outcome === 'failed') return '导出失败 · 可改用下载 PNG';
  return '当前浏览器不支持此操作';
}
