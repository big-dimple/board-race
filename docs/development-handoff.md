# Board Race 开发交接

状态：本工作包已验证并推送，待用户实机复核。

## 当前工作包（本提交）

- 目标：第三轮体验修复——金币卡删除、移动端 HUD 防扎堆、卡顿继续收敛、
  手机海面 AI 感治理。
- 金币猎手提示卡全端删除（`showHonorTargetNotice` 移除）：拾取反馈 = 双音
  音效 + 预分配金币爆发池 + 连击 FOV pop，荣誉照常入帐。双打席位卡片布局
  诊断改用 `showTransientNotice` 作载体；smoke 合同反转：断言 honor-coin
  卡不再出现而命中记录仍在。
- 移动端 HUD 防扎堆：非 critical 弹出跨通道全局间隔 1.2s（冲击卡与
  超车/被超战斗卡共享 `mobileLastPopupAt` 预算，间隔内丢弃或回队）；
  split-delta toast 移动端不弹（名次塔已有差距）。危险横幅与电台不受影响。
- 卡顿收敛（代码层实修，无需用户提供日志）：名次塔 10Hz 刷新全量写入
  style/textContent 改为变更门控（原先每秒 10 次脏化布局）；`Race.trackBattles`
  每步两个临时数组改为复用 scratch；`guidanceStatus()` 每步一次快照。
  审计排除：导弹全预创建+预热（首射无编译无分配高峰）、夜晚材质已在终点
  演出预热。剩余嫌疑：governor 换挡重建（有合同约束）与系统层。
- 美术去 AI 味：定位到 performance 档 `uFoamBreakup=0`（手机海面泡沫不碎化，
  整片平滑白纹 = AI 水彩感），恢复 0.4；桌面 0.5 / high 0.65 不变，物理
  波形不变。截图为证（shots-art）。
- Owner：`src/hud/hud.ts`、`src/hud/raceTower.ts`、`src/game/race.ts`、
  `src/main.ts`、`src/water/ocean.ts`、`harness/screenshot.mjs`、llmwiki、
  art-direction、本文件。

## 验证与证据

- `npm run build` 通过；`verify:smoke`（桌面 + 844x390）、`verify:collision`、
  `verify:team` 通过；桌面/移动截图目检通过。

## 遗留风险

- 偶发卡顿若仍存在：候选只剩 governor 热漂移换挡（受 AIMD/冷却合同约束）
  与浏览器/系统层；`?debug=perf` 峰值日志仍是最终定位手段，但不阻塞体验。
- 美术只做了泡沫碎化一项原型；若用户确认方向，下一轮按同法评估天空渐变、
  霓虹 glow 强度与立绘资产（立绘换新属独立资产生成任务）。

## 唯一下一步

用户实机复核：金币拾取无弹卡、提示不再扎堆、海面白纹碎化效果、卡顿
频率；确认美术方向后再排下一项原型。
