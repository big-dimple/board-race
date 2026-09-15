# Board Race 开发交接

状态：本工作包已验证并推送，待用户实机复核。

## 当前工作包（本提交）

- 目标：第二轮移动端体验修复——删三张骚扰卡、导弹发射画面右上角
  独占、夜晚材质预热移位、热路径分配收敛。
- 删卡（全端，用户裁决）：
  - doomed「⚠️ 偏离起飞区 · 本飞无法过门」提示卡删除，判负信息只走
    共享警示横幅（doomed 横幅保留）+ 电源面板 flight-alert；
    `flightPromptDoomed`/`lastFlightDoomed` 状态与 `.doomed` CSS 一并清除。
  - 第七飞 route-clear「👑 七飞全满贯达成！」卡删除。
  - Final arm「七飞完成 · 航线解除」卡删除（`showFinalReady` 移除）；
    庆祝 beat 由电台七飞认证与勋章/终点仪式接管。
  - 起飞 spool 提示卡按用户澄清保留。
- 导弹 pip 独占右上角：激活时根级加 `missile-pip-on`，艇边仪表
  （hud-driver-power）与起飞提示卡（hud-flight-prompt）CSS 让位，
  任何卡片不再与发射画面重叠。性能审计结论：发射画面已是高性价比
  形态——插画 360×160 canvas 只画一次、点火为纯 CSS 合成器动画、
  锁定锥预分配预热、爆炸池预热，无逐帧重绘，不需要假视频替代。
- 夜晚卡顿：灯塔搜索光束组等夜晚专属材质预热从开局移到终点演出
  （`beginFinalePresentation`）——夜晚只经 `startNextRaceRound` 到来，
  演出数秒停顿吸收编译 burst；开局不再承担。
- 热路径分配：`course.guidanceStatus()` 在每个 fixed step 最多调用一次
  （coach/primer 共用快照），HUD 内每帧一次；`?debug=perf` 帧峰值探针
  保留作后续定位手段。
- Owner：`src/hud/hud.ts`、`src/hud/hud.css`、`src/main.ts`、
  `src/water/lighthouse.ts`、llmwiki、README、本文件。

## 验证与证据

- `npm run build` 通过；`verify:smoke`（桌面 + 844x390）与
  `verify:collision` 通过；桌面/移动截图目检通过。

## 遗留风险

- 偶发卡顿若仍出现：`?debug=perf` 峰值日志（race phase / flightPhase /
  steps 上下文）是最直接的定位手段；当前已消掉夜晚编译 burst 与部分
  每步分配，剩余嫌疑是 governor 热漂移换挡重建（有长冷却防振荡合同约束，
  不动）与系统层 GC。
- iOS 双击缩放抑制与漂移持有兜底（更早工作包）仍待 iPhone 12 实机复核。

## 唯一下一步

用户实机复核：三张卡确实不再弹出、导弹发射时右上角无重叠、进夜晚轮
无卡顿；有问题带 `?debug=perf` 浮层最差三条反馈。
