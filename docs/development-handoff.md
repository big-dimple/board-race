# Board Race 开发交接

状态：`tornado-gate-pillars / session 1 skeleton`

更新时间：2026-08-20

## 当前工作包

- Base：`448f8d3ba62ff0b60f76f003da17f86454ed04f9`，`main`。
- 空道入口龙卷风门柱（四个 session：骨架 → 造型 → 打磨 → 发布），已由用户批准。
  完整分段计划见 `/tmp/tornado-plan-reviewed.md`（审阅修订版）。
- 菱形层完整保留；龙卷风是叠加加强，不动判定、flight 分支、`waves.ts`、AI、物理。
  菱形层移除列为待议，等龙卷风美术被用户确认后另开工作包。

## 设计决定（已对照代码核实）

- 锚点复用 `course.ts` `buildLaunchGateVisual` 的 projector 门柱：launch 点两侧
  ±5.2m（`-launch-projector-left/right`）。龙卷风包裹这两个位置，不另算对称点。
- 生命周期挂 `LaunchGateVisual.group`：只在玩家 unarmed/armed 起飞窗口可见
  （0.35s smoothstep deploy），满足"不加未经评审的持续环境噪声"。
- 性能有界：每门 2 个、同时最多 1 条 active 路线；几何/材质 route 间共享；
  fixed-step 路径零分配。
- 配色用 PALETTE.foam / sunFlare 家族，不整体提亮、不遮挡动作信息。

## Session 1（骨架）步骤

1. 读 AGENTS.md、docs/llmwiki.md、本文件、docs/art-direction.md。
2. 定位 `buildLaunchGateVisual` / `updateLaunchGateVisuals`（course.ts），确认
   projector 锚点、deploy 生命周期、材质复用模式（MeshBasicMaterial + toneMapped:false）。
3. 最小骨架：每个 launch gate 两个 projector 位置各挂一个小龙卷风占位（几层半透明
   锥面即可），y 基座跟 `waterHeight(x,z,t)`，随 `visual.group.visible` 与 deploy 淡入。
4. 验证：`npm run build` + `npm run verify:smoke` + 桌面/844x390 截图。截图前先确认
   harness 现有场景能拍到 unarmed/armed 状态的门柱，不能则加一个定格场景。
5. 提交 `feat: add tornado gate pillar skeleton`。

## Pending 与风险

- Session 2/3 评审熔断：连续两轮审美不达标立即停下与用户讨论（art-direction.md）。
- 视觉质量由人工评审截图决定；未人工审图不得写"视觉已改善"。
- `whitecap-topology` 已结案（上一个工作包），不再推进；其结论归档于 git 历史
  `docs: defer whitecap topology`。

## 唯一下一步

执行 Session 1（骨架），按上述步骤验证后提交；随后 Session 2（造型与动画）。
