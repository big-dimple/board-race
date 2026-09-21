# Board Race 开发交接

状态：Final 终点线「碰撞修正吞掉跨越」修复完成（build + smoke 双端 + collision 全绿），
待提交。

## 当前工作包

- 目标（用户 2026-09-21 报告）：小概率出现已过终点站（Final portal）但没有激活通关
  画面、无任何效果的情况。
- 根因：主循环单步顺序为 船体物理 → `race.update` 的 swept 平面跨越测试 → 艇艇/门柱
  碰撞位置修正 → `syncCollisionCorrections` 重定追踪。跨越测试之后的位置修正会把已资格
  船推过终点平面，随后 `previousWorld` 被覆写到远侧，跨越永久丢失——船停在对侧、portal
  仍 armed、finale 永不触发。
- 已完成：
  - `src/game/race.ts`：`update()` 记录 `lastTrackDt`；
    `syncCollisionCorrections()` 覆写 `previousWorld` 之前，对 armed+qualified+未
    finished/eliminated 的船用同一 `crossFinalStation` swept 合同（步长上限/横向半宽
    不变）补测修正线段，命中即 `finishAtFinal`。
  - `src/main.ts`：新增确定性用例 `runFinalCorrectionCrossingCase`（修正越线必 finish、
    未越线修正不 finish、>4m 传送跳越线仍不 finish 三向断言），挂入 `__harness`。
  - `harness/screenshot.mjs`：verify:smoke 桌面+移动双端接入新断言。
  - `docs/llmwiki.md`：「失败与 Final」补跨越判定覆盖碰撞修正步的稳定合同。
- Owner：`src/game/race.ts`、`src/main.ts`、`harness/screenshot.mjs`、`docs/llmwiki.md`、本文。

## 验证与证据

- 修复前新用例红灯复现：`{"crossingFinished":false,"crossingPhase":"racing",...}`
  （修正推过门线后未结算）。
- 修复后 `desktop-1440x900 final correction crossing: corrected=true short=false teleport=false`。
- `npm run build` ✅；`npm run verify:smoke` ✅（`smoke contract: OK`，桌面+844x390）；
  `npm run verify:collision` ✅。未放宽任何阈值。

## 遗留风险

- 用例以 0.4m 门柱级修正模拟；真实艇艇挤碰的组合更多，但几何合同相同，行为可推。
- portal 半宽 7.15m 窄于格子带（±7.5m）/门楼开口（±8.5m）的观感差未改动（能量柱
  即门宽，视觉=判定）；若玩家反馈「从柱外过线没反应」，再议是否扩宽。

## 唯一下一步

jiepi-clear 预检 + 暂存已审文件 + `npm run release:checked` 提交推送；
用户实机复核终点冲线结算稳定性。
