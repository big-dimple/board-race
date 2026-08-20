# Board Race 开发交接

状态：`tornado-gate-pillars / session 1 visual prototype`

更新时间：2026-08-20

## 当前工作包

- Base：`1746d17`，`main`。多会话计划全文见 `docs/workstream-launch-pillars.md`
  （llmwiki「任务交接」允许的临时 workstream handoff；/tmp 副本仅供浏览）。
- 纯视觉龙卷风门柱（四个 session：原型 → 造型 → 打磨 → 发布）。
- 2026-08-20 计划审查否决了"实体交通锥物理"（v2），理由归档在 workstream
  文末：不可穿透与不受扰互斥；defeatFlight 先切 phase、判负后船碰撞不再跑；
  现有碰撞器 Y_SEPARATION=1.45m 会忽略 ≥2.8m 净空的空中门轨迹；先物理后
  原型违反美术熔断。checkpoint 浮漂保持原样。

## 设计合同（本工作包硬约束）

- 纯视觉：不动碰撞、gate 判定、flight 分支、AI、物理、`waves.ts`。
- 生命周期挂 `LaunchGateVisual.group`（unarmed/armed 窗口 deploy），不构成
  持续环境噪声；几何/材质 route 间共享，同时最多 1 条 active 路线。
- **远距衰减必须有**：gate 约 140m 外即 active（course.ts:944），而现有
  farScale 只作用于菱形（course.ts:2374）。龙卷风需独立远距 alpha/scale
  曲线，不得读成天边常驻广告牌。
- 验证：build + smoke + 桌面/844x390 截图，人眼定质量；未审图不写"视觉已改善"。

## Session 1（可见原型）步骤

1. 读 AGENTS.md、docs/llmwiki.md、本文件、docs/art-direction.md。
2. 定位 course.ts `buildLaunchGateVisual`（3185+）/ `updateLaunchGateVisuals`
   （2351+），确认 projector 锚点（±5.2m）与 farScale 覆盖范围。
3. 最小可见原型：每门 2 个小龙卷风（几层半透明锥面），y 跟
   `waterHeight(x,z,t)`，带独立远距 alpha/scale 衰减，可适当前移数米。
4. build + smoke + 双端截图（含 140m→近距序列评估远距衰减），出图给用户审方向。
5. 提交 `feat: tornado gate pillar prototype`。

## Pending 与风险

- 待议（须另开工作包）：菱形层移除；锥体定位（视觉击飞触发器 vs 真实障碍，
  二者不可混写）。
- Session 2/3 评审熔断：连续两轮审美不达标立即停下讨论（art-direction.md:15）。

## 唯一下一步

执行 Session 1（纯视觉原型），出截图等用户审方向后再进 Session 2。
