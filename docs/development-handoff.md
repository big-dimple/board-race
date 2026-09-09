# Board Race 开发交接

状态：主分支当前工作包为 Tide 头脸与动态 bob 原型。

## 当前工作包

- 已完成 Blender Tide 头脸 / 发型 GLB（7,662 三角形，约 368 KB），接入现有 16 骨骼骑手。
- 已完成重力、气流、头肩碰撞、落水脉冲和 120 Hz 有界发丝积分；暂停、换角、重开可重置。
- 已完成 10 秒单人开场正脸近景、三分之四转身和船队回收。
- 已增加 `npm run verify:rider`，覆盖桌面 / 844x390、30/60fps、动态响应和开场无遮挡。

- **低端手机性能救场（Mobile Performance Rescue）**——起因：朋友手机自带浏览器非常卡、操作有延迟。
  1. **根因（file:line 已核实）**：移动端默认 2.5× 渲染（844×390 → ~206 万物理像素，旧 `stage.ts` AUTO_MOBILE_MAX_PIXEL_RATIO），调速器需 ~26s 才降到地板且有 18.2–20ms 死区；全部表现层挂在 fixed step（30fps 时 ×2 放大，越卡越算）；`updateFlightRoute` 每船每步 2048 项全表扫描；每步 30–45 次无条件 DOM 写；触屏转向 slew 8/s + 船体 yawDamp 合成 ~200–400ms 感知延迟。
  2. **移动端默认 performance 档**：`resolveQualityMode(param, preferPerformance)`（`stage.ts` / `main.ts`），coarse pointer / maxTouchPoints / `?mobile` 默认 performance（pixelBudget 1.3M、maxRatio 1.0、energyScale 0.25、ocean 关 FINE_DETAIL、spray 降档）；`?quality=auto|high` 可强制覆盖；performance 档起步 1.5×（旗舰第一印象锐利，弱机 ~2s 内被 severe 路径降到地板），governor 天花板 2.0（受 1.3M 像素预算约束），升档 AIMD：持续 2s 满帧 +0.3、每次降档后升步减半收敛防振荡（弱机永远爬不上来）。移动端渲染像素 2,057,250 → 329,160（6.25×）。
  3. **调速器重构**（`stage.ts updatePerf`）：EMA 0.06→0.12；EMA>19ms 持续 0.6s 降 0.25、>30ms（severe）立即降 0.35、cooldown 1s；升档需 <16.9ms 持续 5s + cooldown 3s 防振荡；performance 档地板 0.5。
  4. **表现层帧级化**：`Loop` 的 step 回调新增 `present`（rAF 路径只有每帧最后一步为 true；`advance()` 每步 true 保 harness 截图确定性）。main.ts racing 分支把 riders/ocean/sky/course.update/wakes/spray/feathers/jetTrail/towers/hud/duoViewportHud/setActionState/showCoach/updateMissilePip/音频连续总线/pipeline.update/updateRaceCamera 聚成帧级表现（dt 用累计值）；物理、输入读取、seatEdges 事件边沿、`flightRouteMiss` 单步标志、corridor 进出档事件、结果/淘汰流转保持每 fixed step。
  5. **样条扫描有界化**（`course.ts updateFlightRoute`）：水面连续移动（水面相位 + 上步水面 + 步长 ≤4m）改用 `sampleSurfaceNear`，其余情况全表——与 `race.track` 的连续性合同一致。
  6. **DOM change-gate**：`mobileControls.setActionState` 全部写入做值缓存（CSS 变量量化 1%）；`hud.ts` 的 boostLabel / finalLapEl / 席位仪表 dataset、CSS 变量、label 仅变化时写。
  7. **触屏转向 slew 8/s→16/s**（满舵 125ms→62ms）；键盘 7/s 与船体 yawDamp 不动，物理真相与 AI 公平性不变。
  8. **`?debug=perf` 浮层**：fps / frameMs / steps-per-frame / pixelRatio / quality / calls / tris，供真机一眼回报数值。
  9. **验证证据**：`npm run build`、`verify:smoke`（桌面+移动）、`verify:team`（调速器合同 solo floor 0.5 / split floor 1.0 保持）、`verify:collision` 全绿；before/after 截图 `shots/perf-baseline/` vs `shots/perf-after/`（桌面 2,025,000px 不变；移动端场景构图、航线、门、描边全部保持，边缘略软为预期取舍）。
- 环境备注：本机 inotify 实例上限 128 曾让 harness 的 vite 起不来（EMFILE）；已 `sysctl -w fs.inotify.max_user_instances=512`（运行时生效，重启失效）。
- 上一工作包“终点站空中过线 + 猛男勋章进度条”的真机验收仍 pending（用户侧）。

## 已验证

- `npm run typecheck` / `npm run build`
- `npm run verify:smoke`（桌面 1440x900 + 移动 844x390）
- `npm run verify:team`（含调速器合同用例）
- `npm run verify:collision`
- 桌面与 844x390 的 race-straight / race-flight before/after 截图人工复核（移动端像素 2.06M→329k，画面可读性保持）

## 遗留风险

- 表现层帧级化后，30fps 设备上骑手弹簧、相机阻尼以 2×dt 积分——视觉上允许轻微差异；若真机发现姿态异常，先查 `present` 分支的 dt 累计。
- 触屏 slew 16/s 是手感变化，需真机确认转向不“贼”；如偏贼可回落 12/s。
- 实体双手柄的真机复核仍 pending（自动化只能模拟 Gamepad API）。
- 荣誉目标为程序化美术；替换素材必须保留稳定 id、碰撞半径与事件池合同。主分支保留的 `teamExpedition` 兼容代码不得重新接回玩法目录。

## 唯一下一步

**朋友真机复测**：用自带浏览器打开游戏（可带 `?debug=perf` 截图回报 fps / pixelRatio / steps），确认：1) 开局即 performance 档、画面流畅；2) 转向跟手延迟明显改善；3) 长玩不降质振荡。顺带验收上一工作包的“空中过线完赛 + 猛男勋章进度条”。
