# Board Race 开发交接

状态：撞柱顺势不判负 + 「身残志坚」字幕包已验证（build / smoke / collision / audio /
team 全绿 + 桌面/844x390 截图自审通过），待提交推送后用户实机复核。

## 当前工作包（本提交）

- 目标：空中撞真实门柱时，内柱接触或反弹出不了白雾航道的接触不判负——损失本次飞行
  尝试、船顺势翻滚落地继续比赛，打出「身残志坚」逐字喜剧字幕；深撞被弹出航道才维持
  原淘汰流程。
- 判定（`src/game/course.ts` 柱体接触分支）：`gateBendInnerSide` 用门位局部弯曲方向
  （±0.004u 窗口切线转角，阈值 0.018rad）定内柱；反弹后速度横向投影 0.5s 不超出
  航道半宽 + 硬边界（14m）记「出不了赛道」；任一成立 → `FlightFailureSnapshot.spared`。
  门框横穿失守分支不放宽（「错失光门」语义不变）。
- 行为：`boat.applyFlightRouteMiss` 对 spared 跳过弹球倒摔（保留动量反弹+翻滚+减速
  +强制下降）；`main.ts` 对人类席跳过 `defeatFlight`/`eliminateDuoSeat`，触发
  `hud.showGritBeat(side)` + `audio.pillarBrush()`，落水后走 AI 同款
  `recoverFailedFlightRoute` 下一圈重试。真实判负路径零改动。
- 表现：`hud-grit` 逐字 pop（stagger 0.16s，总 2.9s，太阳黄 + 墨描边硬投影）；
  字体 = 自托管 Ma Shan Zheng 4 字形子集（`src/assets/fonts/grit-brush.woff2`，
  随 CSS 内联）+ 系统楷体栈回落；桌面身残在电台卡下方、志坚在右侧仪表上方，移动端
  身残在电台卡下列、志坚在「飞」键上方，双打 `data-side` 半屏归位；
  结果层/勋章/复盘/finale/高光抑制，reduced-motion 静态同显。
- Owner：`src/contracts.ts`、`src/game/course.ts`、`src/game/boat.ts`、`src/main.ts`、
  `src/hud/hud.ts`、`src/hud/hud.css`、`src/audio/audio.ts`、`docs/*`。

## 验证与证据

- `npm run build` 通过；`verify:smoke`（桌面+移动）、`verify:collision`、
  `verify:audio`、`verify:team` 全绿。
- 截图证据：`shots/grit-beat/grit-pillar.png`（桌面）、
  `shots/grit-beat/grit-pillar-mobile.png`（844x390）、
  `shots/grit-beat/font-compare.png`（毛笔子集 vs 黑体对照）。
- 场景 `case 'grit-pillar'`：预测舵控把门平面横向伺服到柱环（7.25m），确定性轻擦内沿
  → 断言 `spared`；末尾重放 beat 并冻结定格（同 freezeFlightExtensionImpact 手法）。

## 遗留风险

- 真实淘汰路径（深撞弹出航道）无自动化用例断言淘汰本身，依赖原 smoke 合成快照路径
  与人工试玩复核。
- 字幕动态（逐字节奏）静帧只能验证排版，节奏以实机观感为准。

## 唯一下一步

用户实机复核：飞行中轻擦门柱是否稳定触发「身残志坚」且不淘汰；深撞是否仍淘汰；
字幕位置在实机上是否顺眼（尤其移动端不遮触控）。
