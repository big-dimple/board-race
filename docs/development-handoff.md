# Board Race 开发交接

状态：尾翼折板主动气动阻尼摆动物理系统已实现并验证完成；本文件所在提交即该工作包的发布提交。

更新时间：2026-08-23

## 当前活动工作包

- 研发物理学驱动的主动气动折板（Active Aero Flaps）与二阶弹簧阻尼摆动系统：
  - 将尾翼划分为固定于船体的流线双支架底座与左右独立铰接的主动折板总成（含双层真翼型主副折板与 14mm 外倾端板小翼）。
  - **物理与气动力学逻辑建模**：
    1. **动压高速下压力 (Dynamic Pressure & Downforce)**：随车速 $q \propto v^2$ 自然压低尾翼后缘产生稳定下压力（$-2^\circ$ 左右微压）。
    2. **迎角补偿 (Angle of Attack Pitch Trim)**：船头仰起时折板向下切风稳定纵倾，避免失速与翻艇。
    3. **差动副翼防侧倾 (Differential Elevons Cornering)**：过弯转向与横滑时，外侧折板抬升后缘抓风产生下压力咬住水面、内侧折板顺风下沉，形成真实赛车级主动气动差动姿态。
    4. **主动气刹与漂移扰流 (Air-Brake Flare & Drift Stability)**：触发气刹与漂移时折板大幅升起张开（$+7^\circ$ 扰流阻力姿态），飞行时转为高升力滑翔姿态。
    5. **波浪颠簸与重力着水冲击惯性 (Vertical G & Landing Shock)**：遭遇浪尖颠簸与着水冲击时折板受重力惯性向下振荡，配合二阶阻尼弹簧平滑回弹。
    6. **微风湍流呼吸感与泊水微动**：疾驰时产生高频微风颤振，停泊在水面时随海浪起伏微动呼吸。
  - **二阶阻尼谐振求解器**：采用 $\omega = 16.5\text{ rad/s}, \zeta = 0.82$ 欠阻尼/近临界阻尼弹性方程固定步长积分，彻底消除机械突变与生硬折角，动作丝滑、柔和自然、充满机械与空气动力学高级质感。

## 验证证据

- `npm run build`、`npm run verify:smoke`（桌面及 844x390 移动端）、`npm run verify:collision`、`npm run verify:audio`：全部通过。
- 实测截图：`opening-showcase.png`、`tail-inspection-sun.png`、`tail-inspection-side.png` 及对应 `-mobile.png`。

## 唯一下一步

- 当前工作包已完成并发布；等待用户复审。
