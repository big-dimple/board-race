# Board Race 开发交接

状态:`Milestone 1-4 四阶段赛艇视觉与体验优化全量完成并通过验收，准备发布`

更新时间:2026-08-23

## 当前活动工作包

- 赛艇视觉与体验四阶段串行优化主计划（Milestone 1, 2, 3, 4 全部完成）。
- 严密计划已在 `shots/plans/` 完成全流程审查、实施与闭环：
  1. M1 [已完成]: 车手手肘姿态收拢优化 (`shots/plans/rider_elbow_posture_plan.md`)
  2. M2 [已完成]: 尾翼发光与边缘重构 (`shots/plans/tail_wing_glow_refinement_plan.md`)，唯一负责 `markInk` 剪枝契约与 `six-batch-racing-hydrojet` 稳定合同
  3. M3 [已完成]: 赛艇落水水花横向偏向 (`shots/plans/water_landing_splash_enhancement.md`)
  4. M4 [已完成]: 车手清晰五官与偶像发型实施管线 (`shots/plans/rider_hair_and_face_pipeline_plan.md`)

## Milestone 4 验收记录

- **基线提交**: `4afd735b9e283336a96ce01d34517ba3e0b35c1f` (Milestone 3 Checkpoint)
- **改动代码**:
  - `src/game/racers.ts`: 为全部六名车手 look 补齐 `driverId: string` ('axle', 'tide', 'sol', 'reef', 'kai', 'jinx')
  - `src/game/riderMesh.ts`:
    - 删除旧 cap 与面部 3 椭球几何
    - 实现 ~294° 开前额 Fitted Skull Loft 与曲面 Face Patch (70 triangles, depthWrite: false, renderOrder: 1, Layer 0, CanvasTexture 全局缓存)
    - 领口矩阵由 head 空间换算重绑定至 chest
    - 为 Sol 落地 5 节长马尾与 4 簇刘海 + 2 侧鬓偶像发型
  - `src/game/rider.ts`: 暴露 `faceDebug(): { hasFaceMesh: boolean }`
  - `src/main.ts`: 暴露 `faceState()`，注册 `rider-inspection-{front,three-quarter,side,back,chase}` 真实检查场景
- **数值与门禁对比**:
  - `faceState()`: `active = 6`, `withFaceMesh = 6`, `cacheSize = 6`，全部车手均正确挂载 Face Patch 与独立材质贴图缓存
  - Draw Calls: 单车手主 Pass `+1` (桌面整帧 243 calls，满足 `<= +1/rider` 预算)
  - Triangles: 桌面 338387 triangles (净减少，满足 `<= +350/rider` 预算)
- **截图产物**:
  - 桌面: `shots/evidence/m4-desktop/*.png`
  - 移动: `shots/evidence/m4-mobile/*.png`
- `npm run build` 与 `npm run verify:smoke` 保持通过。

## 唯一下一步

- 运行 release 流程将 M4 提交并推送到远端 `origin main`。
