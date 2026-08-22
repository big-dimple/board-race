# Board Race 开发交接

状态:`Milestone 1 车手手肘收拢完成并通过验收，准备执行 Milestone 2 尾翼发光与边缘重构`

更新时间:2026-08-23

## 当前活动工作包

- 赛艇视觉与体验四阶段串行优化主计划（Milestone 1 完成，准备执行 Milestone 2）。
- 严密计划已在 `shots/plans/` 完成多轮审查与闭环：
  1. M1 [已完成]: 车手手肘姿态收拢优化 (`shots/plans/rider_elbow_posture_plan.md`)
  2. M2 [待执行]: 尾翼发光与边缘重构 (`shots/plans/tail_wing_glow_refinement_plan.md`)，唯一负责 `markInk` 剪枝契约
  3. M3 [待执行]: 赛艇落水水花横向偏向 (`shots/plans/water_landing_splash_enhancement.md`)
  4. M4 [待执行]: 车手清晰五官与偶像发型实施管线 (`shots/plans/rider_hair_and_face_pipeline_plan.md`)

## Milestone 1 验收记录

- **基线提交 (HEAD)**: `434574e348954e2c731887df35777e00af53b64e`
- **改动代码**:
  - `src/game/rider.ts`: `TUNING` (`elbowPoleOut: 0.22`, `elbowPoleForward: 0.36`, `elbowPoleY: 0.38`)
  - `src/main.ts`: 引入共用 `harnessCameraOverride`，注册 4 个真实比赛 harness 场景 (`race-straight`, `race-steer-left`, `race-flight`, `race-landing-recovery`)
- **数值与门禁对比**:
  - `handGrip`: 左右手均为 `0.0000m <= 0.025m` (双手紧固车把，无脱手)
  - `elbowOut`: 直行 `0.1746m / 0.1756m <= 0.26m`；左转 `0.2318m / 0.1230m <= 0.26m`；`elbowPoleOut` 参数降幅 56% (>= 45%)
  - `elbowForward`: 稳定前探在 `[0.18m, 0.27m]`
  - `elbowAngle`: 弧度范围 `[0.893, 1.949] rad`，无反折或异常
- **资源门禁**:
  - Draw Calls: `+0` (Desktop 225, Mobile 254)
  - Triangles: `+0` (Desktop 337575, Mobile 340723)
- **截图产物**:
  - 桌面: `shots/evidence/m1-desktop/*.png`
  - 移动: `shots/evidence/m1-mobile/*.png`
- `npm run build` 与 `npm run verify:smoke` 保持通过。

## 唯一下一步

- 执行 Milestone 2：在 `src/contracts.ts` 落地 `markInk` 递归剪枝契约；在 `src/game/boat.ts` 执行尾翼几何迁移（删除 shell 旧脊柱、删除 flight 旧发光条/环/核，新建 `boat-reactor-batch`，配置 toon 材质 emissiveIntensity 0.85，设置 Layer 0 + LAYER_ENERGY, noInk, noOutline）；在 `src/main.ts` 注册 `tail-inspection-sun/shade/side` 检查场景与断言；执行 build, smoke, A/B 截图，确认整帧 Calls <= +2, Triangles <= +150，更新 `docs/llmwiki.md` 并记录 Milestone 2 Checkpoint SHA。
