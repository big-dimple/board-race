# Board Race 开发交接

状态：`tornado-boundary / human review rejected; restart visual treatment`

更新时间：2026-08-20

## 给下一位 AI 的任务提示

在 `6515383` 的基础上，**从零重做 flight entrance 的黑灰龙卷风视觉**。用户已明确否决此前两个
方案：三段透明锥面读成“倒三角贴纸”；随后两道细螺旋带加稀疏球体又读成“黑色细线/线圈”。
它们都不是灰土烟雾构成的龙卷风，禁止只调现有 opacity、scale、颜色、远距曲线或闪电来假装修好。

目标是一个高而明确、持续旋转的黑灰尘雾柱：近景必须有可辨的体积、遮挡与层次，不能是单张面、
几何轮廓或空心线圈；远景仍能读成两根入口边界。暗红小宇宙核心和偶发急促红色闪电可以保留，但
只能藏在烟雾内部，不能替代烟雾本体或把场景照亮。用户会亲自审线上效果，未获明确认可不得写
“美术已通过”。

## 正确语义与当前缺口

- **唯一正确位置**是实际 flight attempt 的空门入口：`def.entryU`，两侧沿 `entryRight` 放在
  `±(def.corridorHalfWidth + 0.45m)`。不要重新锚到更早的 `flightLaunchCueU`，也不要向前/后偏移。
  这是一条“撞上可能死”的视觉边界，但本任务不能新增物理碰撞或改动既有判负。
- 当前实现在 `src/game/course.ts` 的 `buildLaunchGateVisual` 已把龙卷风放到 `entryU`，但
  `LaunchGateVisual.group` 的生命周期仍只在 `unarmed/armed` 状态显示。玩家从更早的 launch cue
  起飞后进入 `committed`，因此门柱可能在真正入口前消失。下一位必须让**仅门柱视觉**在所需的
  起飞到入口窗口持续存在，同时让 cue 专属投影器/菱形遵守其原有生命周期；不得更改 flight state、
  判定、速度、碰撞或 recovery。
- 现有 `stageLaunchPillars(..., distanceM)` 的 `140/80/32` 也是相对 `launchCueU`，不能证明
  `entryU` 的近中远构图。为入口造型新增或修正真实 Course 定格，保证截图距离的参照就是 entry
  boundary，不能手工伪造 scene group。

## 硬约束

- 只改门柱 private visual tree、必要的真实截图 harness 和本文件；不动碰撞、gate 判定、flight 分支、
  AI、物理、`waves.ts`、菱形层或 checkpoint 浮标。
- 保持 `BoatInput`、60 Hz fixed step 和统一 boat world transform。不新增持续环境噪声、全屏后处理、
  全场提亮或假 collision。
- 烟雾必须是有界且可复用的世界内渲染；避免固定步进分配。可替换当前所有
  `LAUNCH_TORNADO_SMOKE_*` 实验几何，不能因保留旧代码而迁就失败造型。
- 每帧根部继续跟 `waterHeight(x, z, t)`；同一时刻最多一条路线的门柱 active；透明物保持
  `depthTest=true`、`depthWrite=false`，不加入 `LAYER_ENERGY`。

## 验收与发布

- 先做一个真正有体积的烟雾原型，再看 desktop 与 `844x390` 的真实 entry-boundary
  140m / 80m / 32m 状态；每个关键距离至少看常态和闪电瞬间，确认烟雾本体在非闪电帧也成立。
- 截图必须同时确认：两根柱不盖船、航线、首菱形或移动端按钮；起飞 committed 后到入口前不消失；
  黑灰烟雾在蓝天海面上不读成倒锥、贴纸、线圈、路障或一堆漂浮垃圾。
- 通过用户人审后才跑 `npm run build`、`npm run verify:smoke`、`jiepi-clear` 和
  `npm run release:checked -- "feat: rebuild tornado entrance boundary"`。当前 `6515383` 已通过 build/smoke，
  但**美术已被用户驳回**。

## 当前证据与下一步

- 已发布基线：`6515383 feat: align tornadoes to flight entry boundary`。
- 用户结论：当前版本“继续还是一坨屎”，交由下一位 AI 重做；不要在此基础上声称接受或继续做小调参。
- 唯一下一步：下一位 AI 读取 `AGENTS.md`、`docs/llmwiki.md`、本文件及 `docs/art-direction.md`，按上述
  入口语义与人审证据重新实现。
