# Board Race 开发交接

状态：路线锥体与女性选手辨识修复已完成；本文件所在提交即该工作包的发布提交。

更新时间：2026-08-23

## 当前活动工作包

- 基线：`1078cf7`。
- 删除七个菱形升空入口两侧共 14 个额外浮锥；飞行入口与飞行分支都不再生成锥体或碰撞体，
  只保留绿色水面正规路线上的 8 对 checkpoint 实体浮锥。
- ChatGPT 的 3D bob 增加青色发梢，Gemini 的高马尾加粗、加长并增加暖金尾梢；开场身份牌
  放大立绘，并为两位女选手明确显示“女将”。
- READY 选角标题更新为最终文案 `别懵逼，选最强`；smoke 同时守住文案、两位女将标签和
  仅 16 个 checkpoint 实体浮锥的合同。

## 验证证据

- `npm run build`、`npm run verify:smoke`、`npm run verify:collision`：通过。
- 桌面证据：`shots/evidence/route-women-after-desktop/ready.png`、`opening-showcase.png`、
  `rider-inspection-back.png`、`flight-ready.png`；Gemini 高马尾证据在
  `shots/evidence/sol-after-desktop/rider-inspection-back.png`。
- `844x390` 对应证据位于 `shots/evidence/route-women-after-mobile/` 与
  `shots/evidence/sol-after-mobile/`；逐张人工审图确认标题、身份牌、发型均无重叠，飞行入口
  下方不再有额外锥体。

## 唯一下一步

- 当前工作包没有待实现项；等待用户复审实际游戏画面。
