# Board Race 开发交接

状态：新工作包已验证完毕，待发布（base `6ef26df`）。

## 当前工作包（本提交）

- 目标：两项音频修复——爆炸声空间门控（远处 / 画面外爆炸不再送达玩家，
  除非就在身后）+ iPhone 12 突然全静音自愈。
- 爆炸空间门控（`src/audio/audio.ts`）：新增双席位听者槽（x/z/fx/fz），
  `setListener(seat, ...)` 每帧由 `updateRaceCamera` 用本席相机位置与
  水平面前向喂养（单人喂 seat 0；双打喂 team 左 / 右相机）。`explosion(x, z, seat)`
  经 `blastLevel` 门控：32m 近身半径任意方向可闻（覆盖"就在身后"）或视锥
  半角 ±58° 且 150m 内按 `clamp01(1-d/150)^1.35` 衰减，其余返回 0 整段静默；
  五声部峰值乘 level，新增 StereoPanner（横向偏移 ±0.8）插在声部与 eventBus 之间。
- 爆点接线：`singlePlayerMissiles.ts` 的 `onMissileAudio` 回调扩为
  `(kind, x?, z?)`，near-miss 用 blastX/blastZ、impact 用 hitX/hitZ；
  `main.ts` 单人 impact/near-miss 用返回的 level 门控配套 splash 与
  stormKick/shake（远处 AI 吃弹不再白震镜头）；双打 prank-impact/miss 以
  目标席为听者（爆点本就在目标船边 → 满级，行为不变）。爆炸视效池不受门控。
- iOS 静音自愈（`src/audio/audio.ts`）：`resume()` 对非 running 态统一尝试
  （覆盖 iOS 第三态 `interrupted`）；2.5s 看门狗释放永不 settle 的 resume
  守卫（`resumeTimeouts` 计数）；`update(dt)` 在页面可见、非刻意静音、
  非 running、无 pending 时每 2s 自愈重试；`expectSilentUntilResume` 仅由
  隐藏路径置位，保住"前台保持静音直到显式 resume"契约。
- 范围外：飞弹发射警报保持全场景广播（llmwiki 明文设计，用户未投诉）。
- Owner：`src/audio/audio.ts`、`src/game/singlePlayerMissiles.ts`、`src/main.ts`、
  `harness/audio.mjs`、README、llmwiki、本文件。

## 验证与证据

- `npm run build` / `verify:audio` / `verify:smoke` 全部通过。
- `harness/audio.mjs` 新增断言：身后 20m 有声且 level>0.5、正前 60m 有声且
  0<level<1、正前 200m 与 75° 偏轴 40m 全静默、双打 seat1 近爆点满级；
  interrupted 态每次手势都尝试 resume、reject 后守卫可重试、永不 settle
  时看门狗释放守卫（2.7s 实等）、可见自愈重试 1 次、隐藏契约不自愈。
- 无视觉改动，不需要截图。

## 唯一下一步

发布（jiepi-clear 轻量预提交 → stage → `npm run release:checked`），随后用户
实机复核：iPhone 12 打断场景（来电 / Siri / 切App）后声音是否自愈；
远离第一名时画面外爆炸是否安静、身后近爆是否保留。
