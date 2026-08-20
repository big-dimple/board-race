# Board Race 开发交接

状态：`launch-gate-pillars v2 / session 1 skeleton + cone physics`

更新时间：2026-08-20

## 当前工作包

- Base：`448f8d3ba62ff0b60f76f003da17f86454ed04f9`，`main`（handoff 已随 ddaf109 更新）。
- 空道入口门柱 v2（用户 2026-08-20 调整，四个 session）：实体交通锥 + 龙卷风。
  完整计划见 `/tmp/tornado-plan-reviewed.md`。
- 交通锥从 checkpoint（±7m，纯视觉）移到 launch 入口两旁，做成物理实体：
  船撞不穿透，锥被撞飞按抛物线散落，池化零分配，每场 reset。
- 龙卷风门柱每门 2 个，位置比原 projector（±5.2m）适当放前，与锥成同一门柱群。
- 菱形层完整保留；只有龙卷风+锥效果被用户人工确认后，才另开工作包议移除。

## 设计合同（本工作包新增的硬约束）

- 撞锥不新增失败原因：`gate_left/gate_right` 判定与 lateralLimit 照旧先发生，
  撞锥只是同步物理反馈；船不受明显反弹（保竞速手感与 AI 线）。
- 正常水面航线与 AI spline 不得经过锥；只有飞歪 clip 门边缘才扫到。
- 击飞锥在固定步长内推进，状态池化、零分配，reset 还原。
- 龙卷风生命周期挂 `LaunchGateVisual.group`（unarmed/armed 窗口 deploy），
  不构成持续环境噪声；几何/材质 route 间共享，同时最多 1 条 active 路线。
- 验证必须含 `npm run verify:collision` + build + smoke + 双端截图；
  视觉质量人眼评审，机器指标只证明资源/性能。

## Session 1（骨架 + 锥物理）步骤

1. 读 AGENTS.md、docs/llmwiki.md、本文件、docs/art-direction.md。
2. 定位 course.ts `buildGates`（3557+）/ `buildLaunchGateVisual`（3185+）/
   `updateLaunchGateVisuals`（2351+）与 collision.ts 船-船 capsule。
3. 锥移位 + 船-锥碰撞 + 击飞抛物线 + 池化 + reset；`verify:collision` 通过。
4. 龙卷风最小骨架（每门 2 个，锥列前方，y 跟 `waterHeight(x,z,t)`，随 deploy 淡入）。
5. 双端截图：确认 harness 场景能拍 unarmed/armed 门柱与撞锥瞬间，不能则加场景。
6. 提交 `feat: solid knockaway cones and tornado pillar skeleton`。

## Pending 与风险

- checkpoint 移锥后是否补边界视觉：待评审时定，默认不补。
- Session 2/3 评审熔断：连续两轮审美不达标立即停下与用户讨论（art-direction.md）。
- 未人工审图不得写"视觉已改善"；未推送不写已发布。

## 唯一下一步

执行 Session 1（锥物理 + 龙卷风骨架），验证后提交；随后 Session 2（造型与动画）。
