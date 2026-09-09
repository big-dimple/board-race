/** Rasterise once; the compositor animates this isolated launch illustration. */
export function missileLaunchArt(parent: HTMLElement): void {
  const canvas = document.createElement('canvas');
  canvas.width = 360;
  canvas.height = 160;
  canvas.className = 'hud-missile-art';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', '拦截导弹点火升空');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.translate(170, 88);
  ctx.rotate(-0.28);
  const polygon = (points: number[], fill: string | CanvasGradient) => {
    ctx.beginPath();
    ctx.moveTo(points[0], points[1]);
    for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  const exhaust = ctx.createLinearGradient(-145, 0, -65, 0);
  exhaust.addColorStop(0, 'rgba(255,105,40,0)');
  exhaust.addColorStop(0.7, '#ff9d42');
  exhaust.addColorStop(1, '#fff4c0');
  polygon([-150, 0, -67, -11, -67, 11], exhaust);
  polygon([-108, 0, -67, -5, -67, 5], '#fffbed');
  polygon([-63, -8, -79, -36, -48, -17, -30, -8], '#718a80');
  polygon([-63, 8, -79, 36, -48, 17, -30, 8], '#354c46');
  const metal = ctx.createLinearGradient(0, -13, 0, 13);
  metal.addColorStop(0, '#b6c7be');
  metal.addColorStop(0.32, '#f0eee1');
  metal.addColorStop(0.55, '#7c9789');
  metal.addColorStop(1, '#304b43');
  polygon([-69, -12, 64, -12, 67, 12, -69, 12], metal);
  polygon([63, -12, 102, 0, 63, 12], '#d9544d');
  ctx.fillStyle = '#f3c862';
  ctx.fillRect(40, -12, 8, 24);
  ctx.fillStyle = '#202a2c';
  ctx.fillRect(-73, -9, 7, 18);
  ctx.fillRect(-20, -3, 30, 3);
  polygon([24, -10, 8, -26, 38, -11], '#6b8579');
  polygon([24, 10, 8, 26, 38, 11], '#3e5a50');
  parent.appendChild(canvas);
}
