# Board Race 开发交接

状态：四阶段计划的发布后复核与纠偏已完成；本文件所在提交即该工作包的发布提交。

更新时间：2026-08-23

## 当前活动工作包

- 基线：`673a8df5eda573c8cf95c600c3b885553c53f018`（原 M4 发布提交）。
- 范围：复核 `shots/plans/` 四阶段实现、数值合同和桌面/`844x390` 证据；修复发现后重新发布。
- M1：原 `0.22/0.36/0.38` pole 参数没有达到声称的 45% 收拢。最终参数为
  `out=0.15, forward=0.50, y=0.18`；直行最大 `elbowOut` 从 `0.22323m` 降至
  `0.08623m`（约 61.4%），左转从 `0.24108m` 降至 `0.11156m`（约 53.7%）。
- M1 计划原 `elbowForward >= 0.32m` 与约 `0.323m` 的上臂总长冲突；120 组参数搜索没有
  同时满足该下限、收拢和角度门的解。最终四态范围为 `0.2405..0.3102m`，握把误差
  `<= 1.9e-15m`，角度 `0.893..1.828rad`；施工图已按实测更正为 `0.23..0.32m`。
- M2：保留 reactor/`markInk` 生产合同；顺光、逆光场景会等待真实波相露出反应堆，避免
  连续截图时被局部浪峰遮挡。逆光仍能读出青色核心，图层断言保持通过。
- M3：原场景只完成漂移蓄能，没有发出 flight edge，采到的是普通浪跳。现在明确走
  `drift release -> flight edge -> descending -> 新 landing event`，route miss 只在 dev harness
  中跳过结算冻结。Boat/Spray 的最新事件编号与 bias 必须一致。
- M3：droplet 横向幅度按左右成对采样；直落两侧均值差约 0.5%，左落倍率为 `1.4/0.7`，
  右落为 `0.7/1.4`，同时保留其余位置、高度和寿命随机性。
- M4：检查场景回到 READY，并以真实 head anchor 使用计划机位。修正 curved-lock 绕序、
  crown 缺口、刘海遮眼和马尾被座椅吞没；Sol 近景可读眼/眉/鼻/嘴，背面马尾在肩外越过颈线。
- 截图工具会对空白 WebGL 帧重试并最终失败，不再写出可被误当成证据的空白 PNG。

## 验证证据

- `npm run build`：通过。
- `npm run verify:smoke`：桌面 `243 calls / 338887 triangles`；移动端
  `272 calls / 342035 triangles`；两端非空渲染和 HUD 合同通过。
- 同机 `start/auto` 三组配对各取 120 帧中位数，`Delta frameMs` 为
  `-0.20ms / +0.10ms / -0.10ms`，配对中位 `-0.10ms`；资源 A/B 为 `+0 calls`，
  auto/performance `+502 triangles`（约 `84/rider`），high `+876`（约 `146/rider`）。
- M1-M4 桌面与移动端最终截图：`shots/evidence/m1-*` 至 `shots/evidence/m4-*`。
- M3 最终接触样本：straight `bias=-0.00250`；left `bias=+0.84664`；right
  `bias=-0.84588`。三场景 `boat.event === spray.playerLandingEvents`。
- M4 `faceState()`：`active=6, withFaceMesh=6, cacheSize=6`；Sol 含
  `braid-tie` 与 `braid-1..4`。

## 唯一下一步

- 当前工作包没有待实现项。下一次开发从 `origin/main` 新建活动工作包；除非人工试玩提出
  新问题，不继续修改这四阶段的稳定合同。
