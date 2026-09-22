# Board Race 开发交接

状态：终点漏扫兜底 + GO 启动体验修复完成并已推送（7526d8f，build + smoke 双端 + collision + team 全绿）。

## 当前工作包

- 目标（用户 2026-09-22 报告两件）：
  1. 已过 Final 终点站（从门内通过）仍无通关画面、毫无反应——用户感知「近期概率变高」。
  2. 未先点 READY 全屏按钮、直接 GO 进全屏时，Chrome「如何退出全屏」提示条期间无法开始、
     毫无反馈；用户否决「GO 按钮贴最底部/挪右侧」的方案。
- 已完成：
  - `src/game/course.ts`：新增 `finalPortalBeyondGate`（漏扫兜底几何证明：两端连续在门面
    近侧 ≤6m 且门内 ⇒ 必穿门；步长上限不变）；常量 `FINAL_PORTAL_MISSED_MAX_M = 6`。
  - `src/game/race.ts`：`track()` 在 swept 跨越未命中时对 armed+资格船跑兜底，命中即
    `finishAtFinal` 并 `console.warn` 留证（不把船留在对侧干等；传送级跳跃仍不结算）。
  - `src/main.ts`：`runFinalMissedCrossingCase`（近端必兜底 / 传送跳不兜底 / 门外侧不兜底
    三向断言）入 `__harness.finalMissedCrossingCase` 并接入 verify:smoke；
    `harnessFinalArm=1` 参数允许 harness 全程真实 arming（默认 endless 行为不变，
    端到端 finale 浸泡的唯一 headless 入口）。
  - `src/contracts.ts`：`ICourse` 补 `finalPortalBeyondGate`。
  - `src/core/immersiveMode.ts`：全屏请求 promise 永不 settle 时 5s 超时按 `rejected`
    放行开始流程（此前 `goStartReady()` 永久 false = 真·无法 GO 开始）。
  - `src/hud/driverSelect.ts` + css：GO 点击后到倒计时开始前显示非交互状态丸「即将出发…」
    （launch-pending 期间 READY 隐层、状态丸浮于开场演出之上，倒计时接管即消失）。
  - `docs/llmwiki.md`：「失败与 Final」补漏扫兜底稳定合同。
- Owner：`src/game/race.ts`、`src/game/course.ts`、`src/contracts.ts`、`src/core/immersiveMode.ts`、
  `src/hud/driverSelect.ts`、`src/hud/driverSelect.css`、`src/main.ts`、`harness/screenshot.mjs`、
  `docs/llmwiki.md`、本文。

## 验证与证据

- 全程真实管线 AI 比赛（`harnessFinalArm=1` 临时浸泡）：7 飞真实计数 → arming →
  过门 → `phase=finished`（t=91.8s），含完整六艇/碰撞/金币管线。
- 临时横向冲线扫描（真实物理 -8..+8m）：全部完赛——门柱径向推离 + 修正补测会把擦柱船
  funnel 过线，水面几何不产生「过门无反应」；该探针已完成使命未保留。
- `finalMissedCrossingCase`：near=true / teleport=false / wide=false，warn 留证。
- GO 流程端到端（真实点击：玩法目录→单人→选人→GO→新手指南确认）：状态丸可见、
  fullscreenElement=true、倒计时出现、不再依赖第二次点击。
- `npm run build` ✅；`npm run verify:smoke` ✅（含新兜底断言，桌面+844x390）；
  `npm run verify:collision` ✅（contract OK）；`npm run verify:team` ✅（contract OK）。
  未放宽任何阈值。

## 遗留风险

- 兜底兜底的是「swept 漏记」类残余；若线上再遇「过门无反应」，浏览器 console 的
  `[race] Final portal seatbelt` warn 是定位前置条件的直接证据，请用户反馈是否出现。
- 用户侧可能性最高的是浏览器缓存了 933e18b 之前的 bundle（该旧版 exactly 是本症状）；
  已建议硬刷新验证。
- 横向扫描证明 ±8m 内水面必完赛；空中半宽 12m 未在真实飞行走廊上扫（走廊居中，风险低）。

## 唯一下一步

用户实机硬刷新后复核终点冲线与 GO 启动反馈；若再遇「过门无反应」，取浏览器 console
的 `[race] Final portal seatbelt` warn。
