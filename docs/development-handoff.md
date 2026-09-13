# Board Race 开发交接

状态：本工作包已验证并推送（`af53132`），待用户 iPhone 12 实机复核。

## 当前工作包（本提交）

- 目标：修复 iPhone 12 Chrome 两个比赛触控问题——右下角双击触发页面放大、
  漂移按钮突然失效。
- 双击放大根因：现有防缩放只监听 iOS `gesturestart/gesturechange`（捏合），
  而 iOS WebKit 的双击缩放不产生 gesture 事件，控制层快速点两次即放大页面。
- 修复（`src/core/mobileControls.ts`）：控制层新增 `touchstart/touchend`
  双击抑制——`shouldSuppressPageGesture()` 同一套作用域门控（启用+横屏+
  activation ready+phase 非 inactive+未 overlay-hidden）下，400ms 窗口内
  的第二次轻点取消默认行为（touchstart 计入 gestureSuppressions），
  touchend 按 touch identifier 配对补取消。PointerEvent 全程不受影响，
  被抑制轻点本身的按下/抬起和同时按住中的转向/漂移指针照常工作。
- 漂移失效根因之一：iOS 判定双击缩放接管手势时会给活动触摸发 pointercancel，
  按住漂移时另一只手快速点「飞」会把漂移静默掐掉；双击抑制堵住该接管路径。
- 漂移失效根因之二：`setPointerCapture` 被 WebView 拒绝后，手指滑出按钮抬起
  没有元素级 `pointerup`，持有表残留条目导致漂移卡死。新增 window 级
  `pointerup/pointercancel` 兜底（`releasePointerAtWindow`），只在指针真正
  结束时删除对应 slot，不影响物理仍按住的持有。
- 范围外：不加 viewport 锁、全局 touchmove 取消、缩放重置、伪全屏（llmwiki 契约）；
  选角/资料片/截图预览保持浏览器手势所有权。
- Owner：`src/core/mobileControls.ts`、`harness/screenshot.mjs`、README、llmwiki、
  本文件。

## 验证与证据

- `npm run build` / `verify:smoke`（桌面 + 844x390 移动）通过。
- `harness/screenshot.mjs` 新增断言：选角期两次快速轻点均不被取消、计数不增；
  racing 期首点不取消、次点 touchstart/touchend 均被取消、计数 +2（含
  gesturestart 捏合守卫回归断言）、pageScale 恒为 1；合成 pointerdown 标记
  held 后，window 级 pointerup 正确释放（捕获拒绝兜底）。
- 无视觉改动，不需要截图。

## 遗留风险

- Chromium harness 无法复现真实 iOS WebKit 手势；双击缩放抑制与 pointercancel
  风暴需 iPhone 12 Chrome 实机复核：按住漂移时快速连点「飞」、快速连点「漂」
  各自不应放大页面、不应丢漂移。

## 唯一下一步

发布（jiepi-clear 轻量预提交 → stage → `npm run release:checked`），随后用户
实机复核上述两个场景。
