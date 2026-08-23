# Board Race 开发交接

状态：开场手臂 IK 初始解算、选手发型丰富化与空气动力学尾翼折板重构已完成；本文件所在提交即该工作包的发布提交。

更新时间：2026-08-23

## 当前活动工作包

- 彻底排查并修复开场肘部朝向问题：在 `Rider` 构造函数中前置应用姿态并即时解算两臂 IK（帧 0 即就绪）；在 `main.ts` 的 `ready`（含 `OpeningShowcase`）与 `countdown` 阶段每帧驱动 `riders[i].update()`，并在切角色时即时同步。此前首次进游戏未在开场调用 update 导致骨骼停留在零旋转初始位（肘部反拐），而死后第二把复用已解算的持久化实例才正常。
- 解决全员“像戴头盔”问题：在 `riderMesh.ts` 中为全员增加额前修容刘海、鬓角与差异化发型几何。蓬蓬头（Kai）赋予蓬松层叠乱发与碎刘海，杨植麟（Reef）赋予前冲竞技冠刺与利落刘海，梁圣梁子（Jinx）赋予斜刘海与凌厉侧发，唐老杰（Axle）赋予分头短发，奥特曼（Tide）与美国豆包（Sol）增加修容刘海，告别光面圆帽感。
- 重构尾翼折板（“有厚有薄”与流线折板美感）：废弃原有 9cm 等厚方木板结构，新增 `prismFromTaperedFoldedPlan` 实现前缘 26mm 结构梁平滑渐变到后缘 6mm 刀锋薄板的真翼型流线截面；引入双层折板（主翼板 + 抬高带风隙的副翼板）、流线后掠刀片支架以及 14mm 阶梯端板小翼与导流拉花。

## 验证证据

- `npm run build`、`npm run verify:smoke`、`npm run verify:collision`、`npm run verify:audio`：全部通过。
- 桌面及移动端实测截图：`opening-showcase.png`（开场全体肘部自然入座、握把正确）、`tail-inspection-sun.png` 与 `tail-inspection-side.png`（尾翼刀锋渐变、双层风隙、流线支架与端板）、`rider-inspection-front.png` 与 `rider-inspection-back.png`。

## 唯一下一步

- 当前工作包已完成并发布；等待用户复审。
