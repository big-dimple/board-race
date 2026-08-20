# Board Race 开发交接

状态：`ocean-sparkle complete / pending release`

更新时间：2026-08-20

## 当前工作包

- Base：`eb97e83e22d31a04afbda7284860d8a0adc8b24a`，`main`。
- 产品 owner 为 `src/water/ocean.ts`、`src/cel/sky.ts`、`src/water/seaDecor.ts`、`src/main.ts`。
  海面太阳闪光按真实海面参考图重做并通过人工评审（多轮截图迭代：点阵 → 软斑 → 星芒收小定型）。
- `ocean.ts` glint 为四层 hash cell 星芒碎斑（7.5m / 2.3m / 0.75m / 0.30m，各层旋转角、
  twinkle 速度、距离带不同），格内抖动 + 每格随机相位消点阵；碎斑为核心光点剖面
  （无平顶圆盘）+ 四芒星刺（每格随机 0°/22.5°/45°，刺长随 twinkle 脉冲）+ 弱光晕；沿太阳
  方位各向异性拉伸成远场 glitter 光路；按像素足迹逐层退场防 shimmer。cell 距离场抗锯齿用
  解析像素足迹（`uPixelScale`），禁止 `fwidth`（格界虚线框事故已修复）。whitecap 在
  30–390m 中带加 hash cell 破碎（`uFoamBreakup` perf 0 / auto 0.5 / high 0.65）。
- `sky.ts` 太阳呈现升级：真四刺镜头十字 + 水平变形长眩光 + 双组慢旋转丁达尔光束扇，
  朝向太阳方位时增强（追光读法），共享光照方向不变。
- `seaDecor.ts` 实例闪片已删除（22 片 2.4m 长条 + 每帧 CPU 循环），帆与鸟不动。
- `main.ts` `scenario()` 新增 `ocean-near` / `ocean-near-t2`（近场碎斑与 twinkle 帧间对比）、
  `ocean-sunpath`（转向对准太阳验证光路/十字/光束扇）；`setResolution` 扩展 fov 计算
  `uPixelScale`。
- 性能：draw calls 与三角形数与改动前一致；performance 档密度/层数不变，纯 GPU 像素计算。

## 证据与验证

- Fresh before：`shots/ocean-sparkle/before/`（start、drift-charge 双端）。
- After：`shots/ocean-sparkle/after/`（start、drift-charge、ocean-near、ocean-near-t2、
  ocean-sunpath 双端），机器记录在同目录 `evidence.json`。
- 人工评审结论：机械点阵与远场纸片白斑消除；星芒碎斑方向确认后经尺寸/剖面调优通过；
  追光丁达尔光束扇与四刺十字确认。静态截图会放大碎斑观感，动态闪烁以实机为准。
- `git diff --check`、`npm run build`、`npm run verify:smoke` 通过。smoke 桌面
  `172 calls / 325477 triangles / 2025000 pixels / 16.7ms`，手机
  `192 / 328493 / 2057250 / 16.7ms`。
- `llmwiki` 海面闪光与天空太阳呈现的稳定合同已同步更新。

## Pending 与风险

- 无功能 pending。碎斑大小/密度/刺长/光束强度均为 `ocean.uniforms` / sky 常量可调；
  更窄横屏设备未逐尺寸验收。

## 唯一下一步

`npm run release:checked` 发布本工作包，然后队列清空。