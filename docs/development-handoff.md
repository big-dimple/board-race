# Board Race 开发交接

状态：用户反馈的手肘外拐纠偏与尾翼小折翼黑团修复已完成；本文件所在提交即该工作包的发布提交。

更新时间：2026-08-23

## 当前活动工作包

- 范围：手肘朝外拐纠偏为直臂/微朝下微曲；修复尾翼端板小折翼黑团问题。
- `prismFromSide()` 新增 `counterClockwiseProfile()` 统一 (Y, Z) 平面绕序，修正侧面封盖 flip 参数与侧四边形绕序，确保端板/立面法线全部朝外。自艇与对手尾翼小折翼在顺光、逆光、侧视下均正常呈现队色与卡通明暗阶，彻底消除全黑团块。
- 车手手臂 IK pole 向量调整：`elbowPoleOut` 设为 `-0.04`（消除侧向外拐，落入肩-把手连线中心平面），`elbowPoleY` 设为 `0.35`，`elbowPoleForward` 设为 `-0.15`。手肘不再朝两侧外张，呈现自然的直臂或微朝下自然垂曲姿态。
- `assertHarnessRiderPose()` 与 `screenshot.mjs` 同步直臂 IK 判定门限（`elbowForward` 范围 `0.14..0.36`，`elbowOut >= 0`）。

## 验证证据

- `npm run build` 与 `npm run verify:smoke`：全部通过。
- 桌面与移动端截图证据：`shots/evidence/after` 与 `shots/evidence/after-mobile`（涵盖 `race-straight`、`race-steer-left`、`tail-inspection-sun`、`tail-inspection-shade`、`tail-inspection-side`）。
- 桌面与 `844x390` 手机视口下人工审图确认：尾翼小折翼队色鲜明清晰，手肘无外拐、直臂姿态自然。

## 唯一下一步

- 当前工作包已完成并验证，执行发布提交并推送。
