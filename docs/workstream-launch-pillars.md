# 龙卷风计划 v3：纯视觉龙卷风门柱原型（锥体物理移出本工作包）

用户 2026-08-20 计划审查结论：删掉"实体交通锥物理"，先做纯视觉龙卷风门柱
原型，保留菱形层和原 checkpoint 浮标。审图通过后再单独决定锥体定位。
v2 中锥体碰撞/击飞内容全部移除，理由归档见文末。

## 设计决定

### A. 龙卷风门柱（本工作包唯一改动）
- 锚点：launch 点两侧 projector 位置（course.ts:3250-3266，±5.2m）附近，
  可适当前移数米；Session 1 原型截图定。
- 生命周期挂 `LaunchGateVisual.group`：只在 unarmed/armed 窗口可见，
  0.35s smoothstep deploy。**不得直接用 deploy 曲线做远距表现**：
  launch gate 从约 140m 外就 active（course.ts:944），而现有远距缩放
  只作用于菱形（farScale，course.ts:2374），不作用于 projector。龙卷风
  必须有自己的远距 alpha/scale 衰减曲线（例如近了才完全显现），否则会
  变成天边常驻广告牌。这是 v3 新增的硬要求。
- 几何/材质 route 间共享；每门 2 个、同时最多 1 条 active 路线，有界。
- 纯视觉：不动碰撞、判定、flight 分支、AI、物理、`waves.ts`。

### B. 锥体与菱形层（全部待议，不在本包）
- 原 checkpoint 浮漂对（±7m）保留原样不动。
- 菱形层完整保留；龙卷风效果被用户人工确认后另开工作包议移除。
- "实体交通锥"另开工作包，且必须先回答定位问题：**视觉击飞触发器
  （船可穿过，锥按脚本飞出）还是真实障碍（允许位置修正，需明确修正
  预算与对 lateralLimit 过门结果的影响）**。二者不可混写。

## Sessions

### Session 1 — 可见原型（美术熔断合规：最便宜的可见物先行）
1. 读 AGENTS.md、docs/llmwiki.md、docs/development-handoff.md、docs/art-direction.md。
2. 定位 `buildLaunchGateVisual`（course.ts:3185+）/ `updateLaunchGateVisuals`
   （2351+）；确认 projector 锚点、deploy、farScale 只覆盖菱形的事实。
3. 最小可见原型：每门 2 个小龙卷风（几层半透明锥面即可），y 基座跟
   `waterHeight(x,z,t)`，带独立远距 alpha/scale 衰减。
4. 验证：build + smoke + 双端截图。确认 harness 场景能拍 unarmed/armed
   与 140m→近距序列（评估远距衰减），不能则加场景。
5. 提交 `feat: tornado gate pillar prototype`。**出截图给用户审方向。**

### Session 2 — 造型与动画
1. 螺旋层叠裙摆、顶部收窄、底部飞沫环；慢自转+呼吸缩放，左右反向；
   配色 PALETTE.foam/sunFlare 家族，不整体提亮。
2. 验证：双端截图 + smoke。**熔断：连续两轮审美不达标停下讨论。**
3. 提交 `feat: sculpt tornado pillars`。

### Session 3 — 打磨与评审
1. 远/中/近可读性实测；门柱 framing 是否成立、是否被误读为危险物；
   远距不得读成常驻广告牌。
2. 人工评审截图。提交 `feat: polish tornado gate pillars`。

### Session 4 — 发布
1. jiepi-clear 轻量预提交。
2. `npm run release:checked -- "feat: tornado gate pillars at launch entrances"`。
3. 更新 handoff：待议项 = 菱形层移除、锥体定位（触发器 vs 障碍）。

## 关键文件
- `src/game/course.ts` — buildLaunchGateVisual(3185+)、updateLaunchGateVisuals(2351+)
- `harness/` — unarmed/armed + 远距序列截图场景
- `docs/development-handoff.md` — 各 session 更新

## v2 锥体方案被否的归档理由
1. "不可穿透"与"船不受扰"互斥，不可同时当硬承诺。
2. 帧序上 defeatFlight 先把 phase 切 defeated，船碰撞只在 racing 跑——
   "判负后锥同步炸飞"在现有顺序下不会触发。
3. 现有 BoatCollisionSystem 只处理 IBoat 对且 |Δy|>1.45m 跳过，而门判定
   净空 ≥2.8m：最想撞锥的空中轨迹恰好被忽略；锥不能伪装成第七条船。
4. 先做昂贵的碰撞/抛物线/池化再塞美术骨架，违反 art-direction.md:15
   "先做一项可见原型、确认方向后再扩展"。
