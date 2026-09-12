# Board Race 开发交接

状态：头部轻量化封闭头盔改造——验证全绿，人工评审 pending，待发版。

## 上一工作包（已发版 `3adc909`）

- 手机发热 + 偶发卡顿根治（呈现封顶 / 调速器实测渲染耗时 / 防抖档 / 爆炸池预热）已发版；真机复测 pending。

## 当前工作包（本提交）

- 目标：废弃 3D 面部与发型骨骼方案（H5 表情/发型骨骼开销大、面部效果不达标），六名车手统一
  改为封闭头盔：纯外壳 + 反光面罩，刚性硬绑定 `head` 骨骼（不走蒙皮、零每帧头饰计算）。
- 六款轮廓按 `driverId`：axle 圆润 / tide 尾翼导流 / sol 越野帽檐 / reef 棱角科技 /
  kai 空力尾椎 / jinx 非对称双鳍；高饱和队色主漆 + 高对比沫白（后脑脊柱条纹 + 侧条纹 +
  盔顶），面罩为壳体前弧段的共形平行面（统一膨胀 1.05×）+ 烟熏渐变 + 共享材质低阈值高光带。
- 共享资源：盔壳/面罩两份模块级共享 toon 材质（顶点色涂装通道），几何按 driver 缓存；
  壳体带预留规范化 UV0（u=环向、v=纵向）供未来图集合批；无任何运行时贴图。
- 删除：Face Patch（立绘裁切 + Canvas 贴图）、发型蒙皮附件（fringe/刀片/附加骨）、
  `tideHead.ts` + `tide.glb` + `art/tide/` + `@pixiv/three-vrm-springbone` 依赖。
- Owner：`game/helmet.ts`（新）、`game/riderMesh.ts`、`game/rider.ts`、`game/racers.ts`、
  `main.ts`（harness 接口）、`harness/rider.mjs`、`harness/screenshot.mjs`、llmwiki 渲染/车手
  合同句、art-direction 2026-09-12 拍板、handoff。

## 验证与证据

- `npm run typecheck` / `npm run build` / `verify:rider` / `verify:smoke` 全绿
  （smoke 一次移动端正时 flake 已复跑确认通过，与本改动无关）。
- 基线对比（`shots/helmet-review/baseline.txt` → `after.txt`，同机 swiftshader）：
  race-straight 382→381 calls、364,115→341,091 tris（−6.3%）；
  rider-inspection 99→98、311,019→289,807；tail-drift-left 817→812、440,527→422,769。
  draw call 不升，三角面约 −6%，另省每骑手 1~6 根发型骨骼矩阵 + Tide 8 关节 120Hz 弹簧步进。
- 六骑手 helmetState 全 rigid/visible、六款几何 uuid 互异；截图
  `shots/helmet-review/validation/`（桌面 + 844x390：六车手 inspection 三 quarter/侧视、
  opening、race-straight、tail-drift）。

## 唯一下一步

用户人工评审 `shots/helmet-review/validation/` 截图：六款头盔轮廓区分度、涂装辨识度、
面罩高光观感；确认后走 `release:checked` 发版（或按评审意见调整盔形/涂装）。
