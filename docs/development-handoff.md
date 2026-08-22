# Board Race 开发交接

状态:`Milestone 2 尾翼发光与 markInk 剪枝契约完成并通过验收，准备执行 Milestone 3 赛艇落水水花横向偏向`

更新时间:2026-08-23

## 当前活动工作包

- 赛艇视觉与体验四阶段串行优化主计划（Milestone 1, 2 完成，准备执行 Milestone 3）。
- 严密计划已在 `shots/plans/` 完成多轮审查与闭环：
  1. M1 [已完成]: 车手手肘姿态收拢优化 (`shots/plans/rider_elbow_posture_plan.md`)
  2. M2 [已完成]: 尾翼发光与边缘重构 (`shots/plans/tail_wing_glow_refinement_plan.md`)，唯一负责 `markInk` 剪枝契约与 `six-batch-racing-hydrojet` 稳定合同
  3. M3 [待执行]: 赛艇落水水花横向偏向 (`shots/plans/water_landing_splash_enhancement.md`)
  4. M4 [待执行]: 车手清晰五官与偶像发型实施管线 (`shots/plans/rider_hair_and_face_pipeline_plan.md`)

## Milestone 2 验收记录

- **基线提交**: `e79ef874858167b9a93f5b54d9739273d46e2742` (Milestone 1 Checkpoint)
- **改动代码**:
  - `src/contracts.ts`: 实现并导出标准 `markInk` 递归剪枝契约（`userData.noInk === true` 递归禁用 `LAYER_INK` 并截断后代）
  - `src/game/boat.ts`: 执行尾翼几何迁移（删除 shell 旧脊柱，删除 flight 旧发光条/环/核，新建 `boat-reactor-batch`，设置 `emissiveIntensity: 0.85`、`Layer 0` + `LAYER_ENERGY`、`noInk: true`、`noOutline: true`，更新为 6-batch hydrojet）
  - `src/main.ts`: 注册 `tail-inspection-sun`、`tail-inspection-shade`（含图层与 userData 状态断言）、`tail-inspection-side` 真实检查场景
  - `docs/llmwiki.md`: 补充 `markInk` 剪枝契约与 6-batch 艇体架构稳定文档
- **门禁断言与属性校验**:
  - `boat-reactor-batch`: Layer 0 开启，LAYER_INK 严密禁用，LAYER_ENERGY 开启，`userData.noInk === true`，`userData.noOutline === true` 全部断言通过
- **资源门禁**:
  - Draw Calls: 单艇主 Pass `+1`，Energy Pass `+1`（整帧 <= `+2 calls/boat`）
  - Triangles: 几何净增 < 50 triangles（满足 `<= +150 triangles` 门禁）
- **截图产物**:
  - 桌面: `shots/evidence/m2-desktop/*.png`
  - 移动: `shots/evidence/m2-mobile/*.png`
- `npm run build` 与 `npm run verify:smoke` 保持通过。

## 唯一下一步

- 执行 Milestone 3：在 `src/contracts.ts` 中将 `ISpray.landing` 追加第 8 个参数 `lateralBias?: number`；在 `src/game/boat.ts` 的 `Boat.update()` 中，在 `this.roll` 更新后采样姿态并计算 `lateralBias`，通过 `emitLandingImpact` 传入 `spray.landing()`，并暴露 harness-only `landingDebug()`；在 `src/water/spray.ts` 引入 `aLateralBias` 实例属性并绑定到 `LANDING_VERT`，粒子初速按同一公式应用 `biasMul`，在 `debugState()` 中暴露 7 个统计指标；在 `src/main.ts` 注册 `landing-straight-drop`、`landing-left-drop`、`landing-right-drop` 真实物理测试场景；运行 build, smoke, 截图与数值断言验证，通过后记录 Milestone 3 Checkpoint SHA 并进入 Milestone 4。
