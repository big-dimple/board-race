# Board Race 开发交接

状态:`Milestone 3 赛艇落水水花横向偏向完成并通过验收，准备执行 Milestone 4 车手清晰五官与偶像发型管线`

更新时间:2026-08-23

## 当前活动工作包

- 赛艇视觉与体验四阶段串行优化主计划（Milestone 1, 2, 3 完成，准备执行 Milestone 4）。
- 严密计划已在 `shots/plans/` 完成多轮审查与闭环：
  1. M1 [已完成]: 车手手肘姿态收拢优化 (`shots/plans/rider_elbow_posture_plan.md`)
  2. M2 [已完成]: 尾翼发光与边缘重构 (`shots/plans/tail_wing_glow_refinement_plan.md`)，唯一负责 `markInk` 剪枝契约与 `six-batch-racing-hydrojet` 稳定合同
  3. M3 [已完成]: 赛艇落水水花横向偏向 (`shots/plans/water_landing_splash_enhancement.md`)
  4. M4 [待执行]: 车手清晰五官与偶像发型实施管线 (`shots/plans/rider_hair_and_face_pipeline_plan.md`)

## Milestone 3 验收记录

- **基线提交**: `d2eeda5ef08bfcc4ef33f6e7e699671620f0559f` (Milestone 2 Checkpoint)
- **改动代码**:
  - `src/contracts.ts`: `ISpray.landing` 追加第 8 参数 `lateralBias?: number`
  - `src/game/boat.ts`: `Boat.update()` 在 `this.roll` 更新后采样计算 `lateralBias`，通过 `emitLandingImpact` 传入 `spray.landing()`，新增 `landingDebug()`
  - `src/water/spray.ts`: 新增 `aLateralBias` 实例属性绑定到 `LANDING_VERT`，粒子初速统一应用 `biasMul`，在 `debugState()` 中暴露 7 项偏向统计指标
  - `src/main.ts`: 暴露 `sprayState()`，注册 `landing-straight-drop`、`landing-left-drop`、`landing-right-drop` 真实飞行触水场景
- **数值与门禁对比**:
  - 公式精度: 各测试事件中回传 `lateralBias` 与解析值误差 `<= 1e-4`，倍率均落在 `[0.70, 1.40]` 范围
  - 直行触水: 左右水花粒子数平衡 (Port: 14, Starboard: 14，0% 偏差 <= 15%)
  - 左转触水: `lateralG > 0`，`lateralBias = +0.3031`，Port 倍率 1.3031 > Starboard 倍率 0.7000，左侧初速显著放大
  - 右转触水: `lateralG < 0`，`lateralBias = -0.3225`，Starboard 倍率 1.3225 > Port 倍率 0.7000，右侧初速显著放大
- **资源门禁**:
  - Draw Calls: `+0` (Desktop 237, Mobile 266)
  - Triangles: `+0` (Desktop 340547, Mobile 343695)
- **截图产物**:
  - 桌面: `shots/evidence/m3-desktop/*.png`
  - 移动: `shots/evidence/m3-mobile/*.png`
- `npm run build` 与 `npm run verify:smoke` 保持通过。

## 唯一下一步

- 执行 Milestone 4：在 `src/game/racers.ts` 中为全部六名车手 look 补齐 `driverId: string`；在 `src/game/riderMesh.ts` 中删除旧 cap 与面部 3 椭球，实现 ~294° 开前额 Fitted Skull Loft 与曲面 Face Patch (70 triangles, depthWrite: false, renderOrder: 1, Layer 0, CanvasTexture 全局缓存)，将领口矩阵从 head 换算绑定至 chest，为 Sol 落地 5 节长马尾与 4 簇刘海 + 2 侧鬓；在 `src/game/rider.ts` 暴露 `faceDebug()`；在 `src/main.ts` 暴露 `faceState()` 并注册 `rider-inspection-{front,three-quarter,side,back,chase}` 场景；执行 build, smoke, 截图验收，确认整帧 Calls <= +1/rider, Triangles <= +350/rider，通过后记录 Milestone 4 Checkpoint SHA。
