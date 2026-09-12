# Board Race 开发交接

状态：导弹脱靶爆炸反馈 + 双打 PC 标注已随本提交发版；Tide 线上美术复核仍 pending。

## 上一工作包（已发版 `a912d2e`）

- Tide 五官与全角色开场头脸修正；用户在线上版本复核 Tide 眼神、侧脸及其余五人开场表现（pending）。

## 当前工作包（本提交）

- 导弹被规避（单人凌空/漂移诱爆、双打背刺豁免）在脱靶点水面触发预分配爆炸池（火球+烟团+水面冲击环，`src/game/missileBlast.ts`）并播放 `audio.explosion()` 合成爆炸音；物理冲击仍走 `applyScudNearMiss`，被躲掉的导弹不再静默消失。
- 玩法目录双打入口固定带 `PC 双打` 徽标；触屏主设备（coarse pointer）点双打只提示需要键盘/手柄，不进入左右入座（入座页纯键盘/手柄，手机进入会无设备可坐）。
- Owner：`missileBlast.ts`、`audio.ts`、`singlePlayerMissiles.ts`、`duoInteraction.ts`、`main.ts`、`teamExperience.ts/css`、smoke 与 team 断言。

## 验证与证据

- build / smoke / team / audio 全绿；爆炸池生命周期（出生 1 个 → 寿命后归 0）与 `PC 双打` 文案进 smoke/team 合同。
- 截图：`shots/missile-blast/`（爆炸双端、玩法目录桌面、手机守卫提示）；人工复核 pending。

## 唯一下一步

用户真机听爆炸音效、看脱靶爆炸表现，并复核玩法目录 PC 标注与手机端守卫提示。
