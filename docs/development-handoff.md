# Board Race 开发交接

状态：`medal dossier entry / 待人工审图与发布`

更新时间：2026-08-20

## 已完成

- 三门"猛男"勋章仪式新增"神秘资料片"按钮：仪式全程可见，点开 ExpansionGallery 浏览时
  仪式计时暂停，返回后从暂停点继续；不点击则 4.5s 自动倒计时继续本局，与之前一致。
- 勋章截图/分享链路整体删除：medalSave 按钮、`createMedalCapture`、capture.ts 的
  medal 卡片分支、`CaptureKind` 全部移除；七门 finale 截图分享保持不变。
- 修复连带问题：`startResumeCountdown` 现在会 `mobileInput.setOverlayHidden(false)`，
  否则从画廊返回恢复后触控保持隐藏。
- 七门 Final Station、金色 finale、ExpansionGallery 本身均未改。
- 新增 harness 场景 `medal-ceremony`(`npm run shot -- medal-ceremony`，可加 `--mobile`)。

## 改动 owner

- `src/hud/hud.ts` / `hud.css`：medalGallery 按钮替换 medalSave。
- `src/main.ts`：openMedalGallery、画廊 onReturn 按 phase 分支、medal 循环画廊暂停、
  截图状态清理、medal-ceremony 场景。
- `src/core/capture.ts` / `src/hud/capturePreview.ts`：finale-only 化。
- `README.md`：画廊入口描述同步。

## 实际验证

- `npm run build` 通过；`npm run verify:smoke` OK。
- 截图 `shots/medal/medal-ceremony.png` 与 `-mobile.png`:按钮出现、无截图按钮、
  布局正常。移动端仪式中触控件保持可见是既有行为（presentation 相位设计）。

## 遗留风险 / 下一步

- 画廊从勋章仪式打开的实际交互（点击→浏览→返回→倒计时）未在 harness 端到端覆盖，
  依赖人工试玩确认。
- 未发布；确认后走 `npm run release:checked`。
