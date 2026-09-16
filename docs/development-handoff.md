# Board Race 开发交接

状态：本工作包已验证并推送，待用户实机复核与天空截图评审。

## 当前工作包（本提交）

- 目标：第四轮体验修复——飞弹告警精简、首弹竖向新手引导、电台排行榜
  中文化与美术、偶发卡顿归因加强、白天天空去 AI 味。
- 飞弹告警字多：pip cue 改为短句（锁定「大事不妙」、被炸「稳住不要慌」、
  逼近「🎯 飞弹来袭」）；锁定/命中通知卡同步精简（`updateMissilePip`、
  `singlePlayerMissiles` 通知文案）。状态行与诱爆庆祝文案不动。
- 首弹竖向引导：新增 `coach.knowledge.missileThreat` 持久位（schema 安全，
  旧档默认 false）；飞弹系统新增 `onPlayerTargeted` 回调，main.ts 里置位 +
  `records.saveCoach` + `hud.showMissileTutor()`。HUD 最右缘竖排
  「飞弹专打第一名 / 入弯漂移 · 凌空可诱爆」，随 pip 生命周期出现/退场，
  每档只播一次，solo only。smoke 的 solo-missile 用例新增可见性断言。
- 电台排行榜：`W.H.L // LIVE`→`排名实况`，TEAM 喇叭→`车队`/`电`，
  gap 标签 `GRID/LEADER/FIN`→`排位/领跑/完赛`；新增领跑行高亮
  （rowCache 增 isLeader，10Hz 变更门控内）；头部 LIVE 红点、行/卡
  底色层次微调。尺寸与双打半屏定位不变。
- 卡顿归因：`Loop` 新增 `simMsLastFrame`；`?debug=perf` 峰值 ctx 扩展
  （sim 耗时 / 调速器 pr 换挡 / shader prog+ 编译），sim≥22ms 单独记
  simcatchup；overlay 增显 sim 行。boot 预热 6 张车手立绘解码。
- 天空去 AI 味：palette 白天三段降青提灰；天穹 shader 加静态卷云丝
  （cell hash，无 fwidth，零每帧开销）+ 微抖动去条带；云贴图调扁调碎、
  近云透明度略降、sprite 更横。夜晚路径与日月星辰合同不动。
- Owner：`src/hud/hud.ts`、`src/hud/hud.css`、`src/hud/raceTower.ts`、
  `src/hud/raceTower.css`、`src/game/singlePlayerMissiles.ts`、
  `src/game/drivingCoach.ts`、`src/core/loop.ts`、`src/core/stage.ts`（未改）、
  `src/main.ts`、`src/core/palette.ts`、`src/cel/sky.ts`、
  `harness/screenshot.mjs`、llmwiki、本文件。

## 验证与证据

- `npm run build` 通过；`verify:smoke`、`verify:team` 结果见提交前记录。
- 截图证据（桌面 + 844x390）：天空白天/夜晚、飞弹锁定、命中、首弹引导、
  电台排行榜新样式。

## 遗留风险

- 偶发卡顿：本轮只做归因加强，未根除。用户实机复现时开 `?debug=perf`，
  把浮层最差三条（ms@ctx）截图发回即可定位（sim / pr 换挡 / prog+）。
- 天空属美术主观项：按 art-direction 出一版截图等用户确认，方向确认前
  不继续加码。

## 唯一下一步

用户实机复核：飞弹新文案、首弹竖向引导、电台中文排版、卡顿频率；
确认天空截图方向后再排下一项美术原型。
