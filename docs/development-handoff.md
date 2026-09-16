# Board Race 开发交接

状态：移动端「飞」按钮右移包已验证，待提交推送后用户实机复核。

## 当前工作包（本提交）

- 目标：把移动端「飞」按钮从右下簇的远左上位置右移，与「漂」收成近距离斜线对。
- 起因：用户疑问「飞」是否太靠左、要不要直接做到「漂」正上方，要求先调研竞品再决定。
- 调研结论：QQ飞车手游/元梦之星等中式卡丁车范式是长按主键占最右下角、次级点按键
  沿拇指弧线放在其左上近距离（斜线簇）；垂直堆叠会把「飞」抬进右上 HUD 安全通道
  （艇边仪表、导弹 pip、起飞提示卡）并与"续航反馈避开触控区"合同冲突，否决。
- 方案（纯表现层，仅 `src/core/mobileControls.css`，输入逻辑零改动）：
  - `[data-mobile-action="flight"]` hit box：`left: 2%; width: 47%`（不再与漂 box 重叠，
    消除点飞外圈误注册成漂的月牙区）；
  - flight 面：`left: 88%`，`--control-face-y: 39% → 35%`；
  - 漂移键不动。两面视觉间距 ~18px（844x390 逻辑 px），无重叠，远低于右上 HUD 通道。
- Owner：`src/core/mobileControls.css`、本文件。

## 验证与证据

- `npm run build` 通过；`verify:smoke` 桌面 + 844x390 全绿。
- 前后对比截图：`shots/flight-shift/before|after/flight-ready-mobile.png`。

## 遗留风险

- 无（只碰移动控制层 CSS；hud.ts 教练聚光/紧凑卡为运行时实测位置，自适应）。

## 唯一下一步

用户实机复核：右手拇指在「漂」与「飞」之间的切换距离是否顺手；若嫌仍远/太近，
微调 flight 的 `left`（当前 88%）与 `--control-face-y`（当前 35%）即可。
