# Board Race 开发交接

状态：偶发 0.2s 卡顿现场捕获工具（stall journal）+ 金币爆发池预热补齐完成
（build / smoke 全绿，桌面 + 844x390 通过，浮层实渲染已验证），待提交，
待用户实机回传 stall 数据后做针对性修复。

## 当前工作包

- 目标（用户 2026-09-18 实机裁决）：1+15 旗舰机整局随机 0.2s 卡顿，不固定场景；
  上一版修复未解决；`?debug=perf` 旧浮层只能看最差 3 条瞬时峰值，用户感觉卡再
  截图已过期，抓不到。本轮先把"卡顿瞬间"变成事后可回溯的数据，并按数据修。
- 诊断工具（`src/core/loop.ts`、`src/main.ts`）：
  - loop 记录未 clamp 的原始 rAF 间隔 `gapLastFrame`。
  - `spikeLog` 替换为 24 槽常开 stall journal：原始间隔 ≥60ms / 渲染 ≥22ms /
    sim ≥22ms 记一条；每条含 race 时刻、gap/render/sim/other 四项耗时、
    phase/flightPhase/步数及来源标（`prog+N` 着色器编译、`tex+N` 贴图上传、
    `pr a>b` 调速器换挡、`simcatchup`、hidden、`ctxlost/ctxrestored`）。
  - 浮层改为一行 EMA 摘要 + 最近 6 条 stall（最新在底），每 6 帧刷新；
    事后截图可回溯。console.warn 同步输出；`window.__boardRaceStalls()`
    供桌面远程调试取 JSON。
  - 新增 `webglcontextlost/restored` 监听（preventDefault 保留恢复 attempt），
    事件写入 journal——Android GPU 压力下丢上下文是秒级冻结的经典嫌疑。
- 预热审计 + 加固（`src/game/honors.ts`、`src/main.ts`）：
  - 审计结论：爆炸池/单人导弹（含 tacticalReticle 子树）/灯塔夜航均已有
    warmup；鸭子气球、荣誉目标组开局即在场景内；**金币爆发池（每槽 20 个
    SpriteMaterial + 3 张共享 canvas 贴图）无 warmup，首次拾取金币才编译上传**
    ——正是"比赛中途任何位置随机卡"的候选，已按爆炸池同款模式补
    `HonorTargetSystem.warmup()` 并在 boot 调用。
  - 已知早发项（不修）：spray 液滴/落水体积着色器在首次落水才编译，发生在
    局初数秒；duo 互动池仅双打路径。
- harness（`harness/screenshot.mjs`、`src/main.ts`）：新增 `stallJournalCase`
  注入合成帧断言分类正确（browser-side/prog+/tex+/pr/simcatchup）且健康帧不入 journal，
  挂进 `verify:smoke` 桌面分支。
- Owner：`src/core/loop.ts`、`src/main.ts`、`src/game/honors.ts`、
  `harness/screenshot.mjs`、`docs/llmwiki.md`、本文。

## 验证与证据

- `npm run build`、`npm run verify:smoke`（桌面 + 844x390）全绿
  （首次 mobile tilt 校准步超时一次，重跑通过，属既有偶发）。
- 桌面 headless 实渲染验证（playwright + system Chrome + swiftshader）：
  journal 五条合成 stall 分类正确；真实环境还自抓到首帧编译突发
  （render 1350ms + prog+35 tex+28）与一条 1.55s 浏览器侧停顿
  （gap1550/r8/o1538）——旧工具对后者完全不可见。
- headless soak 三局真实比赛（race-straight/race-flight/race-straight，
  AI 全程跑漂移/飞行/撞标/金币/导弹管线，honorTargetCase 强制触发金币命中）：
  **全程 0 条 prog+/tex+ stall** —— 金币爆发池 warmup 生效，单人管线无漏网
  编译/上传；soak 中的大额 `other` 条目是批量步进的测量伪影（一次 evaluate
  阻塞数秒），真机 rAF 驱动不会产生，不代表设备行为。
- 无像素/玩法/输入/物理改动 → 不需要截图评审与 collision/audio 专项。

## 遗留风险

- 真凶未定：journal 只能把 stall 归因到 编译/上传/调速器/追帧/浏览器侧 五类，
  若回传数据显示 `other` 占主导，需再细分（DOM/音频/输入）。headless soak 无法复现
  真机 GC/热节流/调度抖动，这部分只能实机数据驱动。
- duo 互动池（duoInteraction）预热缺口仍在（仅双打路径，用户当前单人不受影响）。
- journal 常开仅 stall 时写入固定槽位，常态零成本；console.warn 只在 stall 时产生。

## 唯一下一步

用户实机复核：带 `?debug=perf` 正常玩几局，卡顿后（不用抢拍）把浮层上的
`[stall]` 行截图回传；按 `prog+/tex+/pr/simcatchup/other/ctxlost` 分类锁定真凶后
出针对性修复。
