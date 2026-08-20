# Board Race 开发交接

状态：`tornado-gate-pillars / locally accepted, release ready`

更新时间：2026-08-20

## 当前工作包

- Base：`3d521b0`，`main`。完整执行合同见 `docs/workstream-launch-pillars.md`。
- 纯视觉龙卷风门柱：launch 两侧各一根，菱形层与 checkpoint 浮标保持不动。
- 本包已获用户授权：AI 自行读桌面与 `844x390` 截图、在预算内调参并自主发布；这是当前
  workstream 的局部交付规则，不改 llmwiki 的稳定美术合同。

## 设计合同（本工作包硬约束）

- 仅改 `course.ts` 门柱视觉和截图 harness；不动碰撞、gate 判定、flight 分支、AI、物理、
  `waves.ts`、菱形层或 checkpoint 浮标。
- 锚点为 `launch - launchTangent * 2.4m + right * (±5.2m)`；三层半透明锥裙总高约 4.9m，
  用近距成型、远距地标补偿保证可读。
  裙摆用深色 `PALETTE.ink`；中心是小面积暗红核心、两道细轨道与主/分叉 `PALETTE.uiWarn` 电弧。
  常态低亮，约每 2.35 秒一次短闪；全是世界内实体视觉：`depthTest=true`、`depthWrite=false`、
  renderOrder 5/6，不进入 `LAYER_ENERGY`，不改全局光照。
- 远距曲线独立于 deploy：在 140m launch preview 边缘保持 `alpha=.78/scale=1.36` 的可读地标，
  平滑收敛到 `<=32m` 的 `alpha=1/scale=1`；两者都乘 `LaunchGateVisual` 的 deploy。只在
  unarmed/armed 可见，最多一条 active route。
- harness 必须提供 unarmed/armed × 140/80/32m 的真实 Course 定格，不伪造 visual group；验收固定使用
  第二条 launch route，以避开首飞点的 START 门架遮挡。

## 验收与发布

- 已读完最终 desktop + `844x390` six-state 序列：140m 的暗色双地标可辨、80m 稳定引导、32m 完整
  漏斗不盖船、菱形、航线或 HUD；另对连续实机帧采样，确认短闪是内部红色折线而非全屏提亮。
- 已通过 `npm run build` 与 `npm run verify:smoke`。Kimi WebBridge 守护进程在 Windows 宿主运行，
  但本 WSL 无法连接其 `127.0.0.1:10086`；未重启它，视觉证据由项目的 Chromium screenshot harness 产出。
- 需要执行的发布门禁仅剩 `jiepi-clear` 复核、暂存四个审核文件和
  `npm run release:checked -- "feat: tornado gate pillars at launch entrances"`。

## Pending 与风险

- 菱形层移除与交通锥定位仍须另开工作包；交通锥只能二选一：视觉击飞触发器或真实障碍。

## 唯一下一步

发布当前已验收的四文件；后续美术需求另开工作包。
