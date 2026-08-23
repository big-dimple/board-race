# Board Race 开发交接

状态：路线交通锥归属修复已完成；本文件所在提交即该工作包的发布提交。

更新时间：2026-08-23

## 当前活动工作包

- 基线：`730db37b`。
- 删除第五飞虚拟 chevron 分支外侧的 5 个支架浮标；飞行指引不再生成错位交通锥或碰撞体。
- 删除七个菱形升空入口两侧共 14 个黑色投影器，入口改为复用 checkpoint 的正规白条纹、
  橙色短帽浮锥，统一放在绿色水面主线两侧 7m。
- 16 个 checkpoint 浮锥与 14 个升空入口浮锥均常驻、可碰撞、可撞飞，不随虚拟飞行指引显隐。
- 浮锥诊断显式区分 `checkpoint` 与 `launch`，smoke 和 collision 分别守住数量、常驻与实体归属。

## 验证证据

- `npm run build`、`npm run verify:smoke`、`npm run verify:collision`：通过。
- 桌面截图：`shots/evidence/cones-after-desktop/flight-ready.png`。
- `844x390` 手机截图：`shots/evidence/cones-after-mobile/flight-ready-mobile.png`。
- 两个视口均已人工审图：入口两侧只显示正规条纹浮锥，黑色投影器和分支错位支架不再出现。

## 唯一下一步

- 当前工作包没有待实现项；等待用户复审实际路线画面。
