# Board Race 开发交接

状态：首轮昼夜随玩家本地时间完成（build + smoke 双端 + team 全绿，双端昼夜截图已审）。

## 当前工作包

- 目标（用户 2026-09-27 两件）：
  1. 答复「过终点无事件激活是否为手机 Chrome 缓存」——是头号嫌疑而非定论；两个真实 bug
     （933e18b 修正吞线、7526d8f 漏扫兜底）已在 origin/main，代码库无 service worker，
     缓存面只剩 HTTP 缓存的旧 index.html 或挂起未重载的标签页。确认方法：硬刷新后复打；
     仍复现则看 console 有无 `[race] Final portal seatbelt` warn（有=旧 bundle；
     无且无 finale=前置条件类新 bug，需 console 证据）。
  2. 首轮白天/黑夜由玩家本地时间决定——已实现。
- 已完成：
  - `src/core/timeOfDay.ts`：新增 `localTimeSeed()`（18:00–05:59 本地 → night）与构造函数
    `seed` 参数；交替改为 `(round + parity) % 2`，`reset()` 保留 seed；`?tod=` 覆盖不变。
  - `src/main.ts`：非 harness 下以 `localTimeSeed()` 播种首轮；harness 固定白天 seed 保截图
    确定性；夜晚首轮（seed 或 `?tod=night`）在 boot 离屏 `lighthouse.warmup()`，白天首轮
    维持 finale 演出内预热；新增 `night-start` 场景与 `__harness.todSeedProbe()`。
  - `harness/screenshot.mjs`：smoke 双端断言 seed 窗口（5/6/12/18/23 时）与 harness
    首轮恒白天。
  - `docs/llmwiki.md`：昼夜合同更新为首轮本地时间播种 + 逐轮交替；灯塔光束预热跟随 seed。
- Owner：`src/core/timeOfDay.ts`、`src/main.ts`、`harness/screenshot.mjs`、`docs/llmwiki.md`、本文。

## 验证与证据

- `npm run build` ✅；`npm run verify:smoke` ✅（含 todSeedProbe 窗口断言，桌面+844x390）；
  `npm run verify:team` ✅。
- 截图（`shots/tod-seed/`）：`start` / `night-start` × 桌面 / 844x390 四张——夜晚首轮月牙、
  四芒星、赛道自发光与 HUD 完整，白天首轮无回归。
- smoke 期间电台「radio copy overflows its column」断言曾间歇失败：base 连跑 3 次全过、
  分支连跑 5 次全过，判定为既有计时 flaky（`waitForFunction` 超时兜底直接测量），与本次
  改动无关（harness 下昼夜代码路径逐字节等价）。

## 遗留风险

- 现实夜晚首轮时，READY 页与开场演出也是夜空——已属预期表现，未单独截图评审 READY 夜景。
- 问题 1 仍待用户实机硬刷新复核；若复发取 console warn 分界定位。

## 唯一下一步

用户复核：夜间时段（18:00–06:00）首局应为夜晚；终点冲线问题按上文 console warn 分界反馈。
