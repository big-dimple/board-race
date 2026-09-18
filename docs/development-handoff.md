# Board Race 开发交接

状态：撞柱撞击物理恢复 + spared 收紧 + 「身残志坚」底部字幕卡 v3 完成
（build / smoke / collision 全绿，桌面 + 844x390 截图自审通过），已提交推送，
待用户实机复核。

## 当前工作包（本提交）

- 目标（用户 2026-09-18 实机裁决两轮）：
  1. 撞柱的翻滚撞飞物理不许阉割——上一版 spared 只有软反弹，撞击感全丢；
  2. 撞柱"全部不判负"是 bug——大难不死必须回到低概率；
  3. 字幕卡中央仍挡视线 → 挪正下方；「撞柱」两字要炸裂；印章别压「坚」。
- 物理（`src/game/boat.ts`、`src/game/course.ts`）：
  - 所有真实柱体接触恢复翻滚 + 上抛 + 水花：spared 轻档（vy 6.5、
    tumbleSpin 1.0s、yaw 侧踢 1.4、24 粒水花，不反转速度），深撞维持原
    弹球倒摔（vy 9.5、1.25s、速度反转 + 侧弹）+ 淘汰。
  - spared 收紧：`innerHit || (staysInside && bounceSpeed <= SPARED_MAX_BOUNCE_SPEED=24)`。
    门洞进近 42-50 m/s、反弹 0.72x（30-36），普通撞击回淘汰；内柱轻擦与
    真弱反弹才大难不死。
  - `Boat.tumbleSpinRemaining` getter（harness 断言用）；
    `Course.debugGateBendInnerSide()`（harness 瞄准用）。
- 表现（`src/hud/hud.css`、`src/hud/hud.ts`）：
  - 字幕卡挪底部中央：桌面 bottom 10%（FLIGHT/BANK 条之上），移动端 26%
    且 max-width 40vw 不遮触控簇；双打仍按席半屏中轴。
  - kicker 重构：朱红渐变毛笔「撞柱」主字（毛笔子集扩为 6 字形，含撞柱）
    + 米白「大难不死」副题；「命硬」印章改为题字行 flex 尾项（不再压坚）。
  - 炸裂加强：逐字重砸配 ::after 墨爆闪光（animation-delay: inherit 同步），
    整卡 hud-grit-shake 冲击震颤（jolt 对齐四次砸落）。
- harness（`src/main.ts` grit-pillar 场景）：自动选第一条门在弯上的航线，
  微扰探向符号 + 双速率伺服（全偏转逼近 + 细伺服保持接触缝）瞄准内柱环；
  断言 spared + `tumbleSpinRemaining > 0`（翻滚撞击回归锁死）。
- Owner：`src/game/boat.ts`、`src/game/course.ts`、`src/hud/hud.css`、
  `src/hud/hud.ts`、`src/main.ts`、`src/assets/fonts/grit-brush.woff2`、`docs/*`。

## 验证与证据

- `npm run build`、`verify:smoke`（桌面 + 844x390）、`verify:collision` 全绿。
- 截图证据：`shots/grit-beat-v3/grit-pillar.png`（桌面，翻滚落水 + 底部字幕卡）、
  `shots/grit-beat-v3/grit-pillar-mobile.png`（844x390，柱后视角，字幕卡不遮键位）。

## 遗留风险

- 深撞淘汰路径无自动化用例断言淘汰本身（沿用手工/旧 smoke 路径）。
- 撞柱「猛 vs 弱」的实感分界（24 m/s 阈）以实机为准，必要时只调该常量。
- 字幕卡底部布局在极端宽高比实机上的观感未实测。

## 唯一下一步

用户实机复核：猛撞是否回淘汰+撞飞翻滚；内柱轻擦是否大难不死+字幕卡气势；
底部字幕是否不挡视线与按键；移动端观感。
