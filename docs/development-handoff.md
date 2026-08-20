# Board Race 开发交接

状态：`tornado-gate-pillars / human-review candidate`

更新时间：2026-08-20

## 当前工作包

- Base：`dd280f4`，本候选将龙卷风收回真实 flight entry boundary。完整执行合同见
  `docs/workstream-launch-pillars.md`。
- 纯视觉龙卷风门柱：launch 两侧各一根，菱形层与 checkpoint 浮标保持不动。
- 本包已获用户授权：AI 自行读桌面与 `844x390` 截图、在预算内调参并自主发布；这是当前
  workstream 的局部交付规则，不改 llmwiki 的稳定美术合同。

## 设计合同（本工作包硬约束）

- 仅改 `course.ts` 门柱视觉和截图 harness；不动碰撞、gate 判定、flight 分支、AI、物理、
  `waves.ts`、菱形层或 checkpoint 浮标。
- 锚点为真实 `def.entryU + entryRight * (±(corridorHalfWidth + .45m))`，即 flight attempt 的
  空门入口边界；不改该入口的判负逻辑。螺旋烟带和实例化烟团总高约 7.4m，用近距成型、远距地标补偿
  保证可读。
  烟体用深色 `PALETTE.ink` / `PALETTE.uiPanel` 与低透明 `PALETTE.cloudShade` 构成；中心是小面积
  暗红核心、两道细轨道与主/分叉 `PALETTE.uiWarn` 电弧。
  常态低亮，约每 2.35 秒一次短闪；全是世界内实体视觉：`depthTest=true`、`depthWrite=false`、
  renderOrder 5/6，不进入 `LAYER_ENERGY`，不改全局光照。
- 远距曲线独立于 deploy：在 140m launch preview 边缘保持 `alpha=.78/scale=1.36` 的可读地标，
  平滑收敛到 `<=32m` 的 `alpha=1/scale=1`；两者都乘 `LaunchGateVisual` 的 deploy。只在
  unarmed/armed 可见，最多一条 active route。
- harness 必须提供 unarmed/armed × 140/80/32m 的真实 Course 定格，不伪造 visual group；验收固定使用
  第二条 launch route，以避开首飞点的 START 门架遮挡。

## 验收与发布

- 已产出入口修订的 desktop + `844x390` armed 32m 定格；用户要求线上亲自审图，当前版本不得宣称
  美术验收通过，也不在本轮继续调参。
- 已通过 `npm run build` 与 `npm run verify:smoke`。Kimi WebBridge 守护进程在 Windows 宿主运行，
  但本 WSL 无法连接其 `127.0.0.1:10086`；未重启它，视觉证据由项目的 Chromium screenshot harness 产出。
- 上一版已完成 `jiepi-clear` 与发布；本修订待重新执行轻量收尾和受检发布。

## Pending 与风险

- 菱形层移除与交通锥定位仍须另开工作包；交通锥只能二选一：视觉击飞触发器或真实障碍。

## 唯一下一步

发布候选供用户亲审；若未通过，下一位执行者从本工作包的入口锚点与烟雾造型继续，不改 flight
判定或碰撞。
