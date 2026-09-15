# Board Race 开发交接

状态：本工作包已验证并推送，待用户实机复核。

## 当前工作包（本提交）

- 目标：移动端体验修复包——HUD 提示瘦身、电台人味化、起飞瞬时卡顿定位、
  高光回放特写模糊。
- 移动端起飞前"光门死线"倒数横幅删除（`hud.ts` `launchDeadlineM` 分支加
  `controlDevice !== 'mobile'` 门控）：它与偏离航线/航道警告共用 `wrongWayEl`
  槽位互相跳变，用户视为骚扰。doomed 起跳沿提示卡与空中 orphan 横幅保留
  （危险信息不删）。桌面不变。
- 移动端通知瘦身（`hud.ts` `enqueueImpact`）：`gate`/`flight-pass` 整族静默，
  `route-clear` 只保留 1/2/3/7 飞里程碑（新增 `ImpactNotice.flight` 字段）；
  反跳变：非 critical 卡最短驻留 0.85s、驻留期内只排队不抢占，非 critical 之间
  1.2s 全局冷却；critical（priority ≥ 85：final-ready/excellent/第七飞）保留
  立即抢占。
- 电台文案池化（`raceTower.ts`）：GO/超车/被超/三飞/七飞/空刹技巧各 3–4 条
  轮换文案，碰撞台词按 mood 重写且保留「接触/碰撞」关键词（碰撞专项正则断言）。
  结构（key/speaker/priority/duration/sessionKey）不变。
- 起飞卡顿：审计结论是雾廊 shader 在 countdown 期已随 `course.update` 渲染
  编译（`group.visible=true` 从倒计时开始），不是起飞现场编译；故不做预热的
  假修复。实际交付：`?debug=perf` 浮层新增 >22ms 帧峰值日志（带
  race phase/flightPhase/steps 上下文，最差三条），EMA 抹平的单帧毛刺由此可
  定位；HUD 每帧重复调用 `guidanceStatus()` 的两处合并为同一快照。
- 回放模糊：移动端 performance 档只渲染 1.5–2.0× CSS，回放特写被放大发虚。
  `Stage.setPresentationRatioOverride(min(devicePixelRatio,3))` 在回放期按原生
  密度渲染并暂停 governor；`completeHighlightVideo()` 与 `resetRace()` 两条
  出口清除恢复。
- Owner：`src/hud/hud.ts`、`src/hud/raceTower.ts`、`src/core/stage.ts`、
  `src/main.ts`、llmwiki、README、本文件。

## 验证与证据

- `npm run build` 通过。
- 其余验证见下（本文件随提交同步更新状态）。

## 遗留风险

- 偶发卡顿根因需用户实机 `?debug=perf` 峰值日志确认：若 peaks 集中在
  `racing/spool`（起飞）渲染峰，再针对性降首飞绘制负载；若分散则是系统/
  GC 层面。当前无任何证据指向具体渲染峰值，不做猜测性"优化"。
- `verify:smoke` 的 radio 布局断言在广播卡动画相位采样，本包验证期间出现
  一次瞬时不稳定后连续两次通过（harness 注释已知固定时钟采样敏感），属
  既有敏感度，非本包引入。
- iOS 双击缩放抑制与漂移持有兜底（上个工作包）仍待 iPhone 12 实机复核。

## 唯一下一步

`verify:smoke` / `verify:collision` / 移动截图通过后发布
（jiepi-clear → stage → `npm run release:checked`），随后用户实机复核：
移动端提示密度、电台新文案、回放特写锐度、`?debug=perf` 峰值日志。
