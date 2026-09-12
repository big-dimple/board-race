# Board Race 开发交接

状态：手机发热 + 偶发卡顿根治（呈现封顶 / 调速器信号 / 防抖档 / 爆炸池预热）已发版；真机复测 pending。

## 上一工作包（已发版 `486719c`）

- 导弹直击水面爆炸 + 炸飞表现、五声部爆炸音效、iOS 转向 chevron 修复已发版；人工真机复核 pending。

## 当前工作包（本提交）

- 根因：60Hz fixed-step 模拟但每个 rAF tick 都重绘，120Hz 屏（一加 15）GPU 顶着最高 120fps 跑
  三趟场景渲染 + 后处理；调速器以 rAF 间隔（120Hz 下恒 ~8ms）为输入永远判优，分辨率顶着 9/7 提高的
  上限（起步 1.5、AIMD 爬向 2.0），双满载导致发烫。
- 偶发卡顿：换挡时 `applySize()` 重建整套 render target（composer、prepass、energy bloom 链）
  造成单帧尖刺，热节流边界上来回抖档；新加的 `MissileBlastPool` 无开机预热，首次爆炸当场编译 shader。
- 改造：`Loop` 呈现门控——无 sim step 的 tick 不重绘（120Hz 屏约 60fps 呈现，画面逐帧不变）；
  `render()` 改以实测渲染耗时喂调速器；调速器升档冷却 3s / 降档 1.5s、mild 证明窗 0.9s 防抖档；
  `MissileBlastPool.warmup()` 开局离屏预热（模式同导弹本体）。
- Owner：`core/loop.ts`、`main.ts`（render 计时 + 预热调用）、`core/stage.ts`、`game/missileBlast.ts`、
  llmwiki 渲染合同句、handoff。

## 验证与证据

- build / smoke 全绿（governor 合同 soloFloor≥1、goodClimb>start 与爆炸池生命周期用例不变）。
- 截图：`shots/perf-after/`（桌面 + `844x390` 复核画面非空无回归）；真机一加 15 复测 pending。

## 唯一下一步

用户真机复核：一加 15 长局发热是否明显缓解、比赛中是否还有闪现卡顿（可开 `?debug=perf` 看
渲染 ms 与 pr 是否稳定）。
