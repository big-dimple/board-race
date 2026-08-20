# 龙卷风门柱 v4：自主视觉交付

## 目标

将纯视觉龙卷风门柱挂入 launch entrance。用户授权 AI 自行读取截图、持续调参直到达标并
发布；这一局部授权不扩大为稳定美术合同。实体交通锥、菱形移除和 checkpoint 浮标改动全部不在
本包内。

## 不可变合同

- 只改 `src/game/course.ts` 的 private visual tree 与 `harness/` / `main.ts` 的定格入口。
  不碰碰撞、判定、flight 分支、AI、物理、`waves.ts`、菱形层和 checkpoint 浮标。
- 每个 launch gate 两根柱：锚点为 `launch - launchTangent * 2.4m + right * (±5.2m)`。
  root y 每帧取 `waterHeight(x, z, t)`。
- 每根柱三层开口锥裙，总高约 4.9m、最大半径 1.45m；漏斗从水线收束向上展开，shared geometry/material。
  裙摆为深色 `PALETTE.ink`。中段仅有一个小型暗红核心、两道细轨道和主/分叉
  `PALETTE.uiWarn` 电弧，常态低亮、约每 2.35 秒短闪一次；它提供内部的旋转层次，不得扩展成
  粒子雨、全屏后处理或持续环境噪声。全部 `depthTest=true`、`depthWrite=false`、DoubleSide、
  renderOrder 5/6，绝不加入 `LAYER_ENERGY` 或改动全局光照。
- 生命周期复用 `LaunchGateVisual.group` 的 unarmed/armed deploy。远距曲线不能复用 deploy：
  `nearness = 1 - smoothstep(32m, 140m, launchDistanceM)`；alpha = base alpha ×
  `lerp(.78, 1, nearness)` × deploy，scale = `lerp(1.36, 1, nearness)` × deploy。140m 边缘仍是
  可辨地标，32m 内全显。
- 最多一个 route active。可有慢速反向自转与不超过 3.5% 的呼吸缩放；无粒子、无持续环境噪声、
  不整体提亮。

## Harness 与审图

- `window.__harness.stageLaunchPillars(armed, distanceM)` 只接受 `140 | 80 | 32`，通过真实 Course
  的第二条 launch route state 建立定格（避开首飞的 START 门架遮挡），并返回 launch state/distance。对应场景为
  `launch-pillars-{unarmed|armed}-{140|80|32}`。
- 每轮输出 desktop 与 `844x390` 的 six-state 序列。AI 逐张检查：
  140m 两根柱可辨但不抢航线；80m 稳定引导；32m 两根柱可读且不遮船、首个菱形、航线或 HUD；
  所有图不得有透明排序脏块、闪白或全场增亮。
- 未通过时只允许调锚点、尺寸、fade 或透明度，并在每次调整后重跑双端序列；通过后才能保留慢转、
  呼吸和底部飞沫环的最终形态。

## 交付顺序

1. 实现 shared geometry/material、门柱 root、远距曲线和根部随波；为 Course private type 增加
   tornado roots，不扩展 gameplay API。
2. 增加受控 harness 定格和六个命名场景，运行 build、smoke 与双端截图。
3. AI 读取序列并在需要时做有界调参；每次重跑全部截图。
4. 通过后执行 build、smoke、最终截图与 jiepi-clear；暂存审核过的文件，运行
   `npm run release:checked -- "feat: tornado gate pillars at launch entrances"`。
5. handoff 只记录实际证据、发布 commit 和 pending：菱形层移除、交通锥定位。

## 交通锥决策记录

v2 的实体交通锥被移出：不可穿透与船不受扰互斥；现有失败顺序会在碰撞前离开 racing；
船-船碰撞还会忽略空中门轨迹。后续工作包必须在视觉击飞触发器与真实障碍之间二选一。
