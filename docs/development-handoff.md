# Board Race 开发交接

状态：Tide 五官与全角色开场头脸修正已随本提交发版，用户线上美术复核 pending。

## 上一工作包（已发版）

- Base `a8f0c58`，验证齐全：build / smoke / team / audio / rider 全绿。
- Tide 近侧眼形对称投射、缩眼距眉眼距、短鼻尖补下巴侧轮廓；其余五位立绘贴片沿真实头骨 loft 贴合，共用发壳在太阳穴让位。
- Owner：`art/tide/build.py` 及生成 PNG / Blend / GLB、`riderMesh.ts`、`harness/rider.mjs`。
- 证据：`shots/face-rework/before|after|validation`。
- 风险与说明：rider 专项截图超时的根因是 swiftshader 一次性着色器编译（13-25s GPU 积压，非 hang），已在 harness 预热六个车手的 inspection 视角并对 three-quarter 捕获放宽到 60s；真机无此成本。

## 当前工作包

- 导弹脱靶爆炸反馈（炸在脱靶点 + 爆炸音效）与玩法目录双打 PC 标注 —— 进行中，单独提交。

## 唯一下一步

用户在线上版本复核 Tide 眼神、侧脸及其余五人的开场表现。
