# Board Race 开发交接

状态：落水后再飞误算续飞修复 + 竖屏提示强化（含微信小字）+ 雷达对比度与 READY
全屏引导按钮完成（build / smoke 桌面+844x390 / collision / audio 全绿），待提交。

## 当前工作包

- 目标（用户 2026-09-21 裁决）：
  1. 已经掉水面后马上再飞被按续飞计算 —— 修掉；
  2. 手机首次打开竖屏提示不明显，用户不知道只能横屏，需小字提示微信浏览器不支持横屏；
  3. 首次打开雷达图菱形基本看不见；用户提议做按钮引导点击全屏。
- 根因：`boat.ts` `updateFlight` 下降段触水后 `flightPhase` 保持 `'descending'`
  直到 `flightElapsed >= total`；该窗口内 `canExtendFlight()` 为真，起飞键落入
  续航分支（扣一格 + `flightExtended` + 「续航 +2.4 秒」表现）。
- 已完成：
  - `src/game/boat.ts`：触水后起飞键走 fresh-flight 分支
    （`flightPhase === 'surface' || flightWaterContact`）；
    `canExtendFlight()` 追加 `!flightWaterContact` 纵深防御。未触发时下降段
    仍按原计划跑到 total，速度/动量不清。
  - `src/main.ts` + `harness/screenshot.mjs`：新增 `water-contact-reflight`
    场景（真实触水帧 landImpulse 捕获 → 窗口内再按飞 → 断言 spool +
    未用续航 + 恰扣 1 格），挂进 verify:smoke 双端。负向验证：stash 修复后
    场景报 "relaunch phase cruise"，证明断言有牙。
  - 竖屏提示（`mobileControls.ts/css`）：主标题改「本游戏仅支持横屏」，
    副行「请旋转手机，横屏后开始游戏」，新增微信小字
    「点右上角 ··· → 在浏览器打开」；手机图标加横屏摇摆引导动画
    （reduced-motion 下静止横置）。
  - 雷达（`driverSelect.ts/css`）：双绘制路径网格/轴线/菱形统一提对比
    （外环 .8、内环 .30、轴 .32、填充 A6、描边 6px + 队色柔辉光）；
    移动端背板 .4→.66。桌面与 844x390 截图确认菱形清晰。
  - READY 全屏按钮（`immersiveMode.ts` 新增 `requestFromReadyGesture()` +
    `onReadyAvailability`；`driverSelect.ts` footer 「⛶ 全屏体验」；
    main.ts 接线）：真实 click 手势请求 fullscreen，未获得/不支持/已全屏时
    自隐。iPhone/微信不支持保持浏览器托管形态，不伪造全屏。
- Owner：`src/game/boat.ts`、`src/main.ts`、`harness/screenshot.mjs`、
  `src/core/immersiveMode.ts`、`src/core/mobileControls.ts/css`、
  `src/hud/driverSelect.ts/css`、`docs/llmwiki.md`、本文。
- 合同同步（llmwiki）：Fullscreen 来源增加 READY 全屏按钮（含自隐条款）；
  「漂移、库存与飞行」补触水后再飞 = 新一飞。

## 验证与证据

- `npm run build` ✅；`npm run verify:smoke` 桌面 + 844x390 双绿
  （含新增 water-contact-reflight 断言；首轮 mobile tilt 校准步超时一次，
  重跑通过，属既有偶发）。
- `npm run verify:collision` ✅、`npm run verify:audio` ✅。
- 截图自审：`shots/radar-review/ready.png`（桌面雷达 + 全屏按钮）、
  `ready-mobile.png`（844x390 雷达背板）、
  `shots/portrait-review/portrait-prompt.png`（390x844 竖屏提示，微信小字在列）。
  移动 READY 截图中全屏按钮隐藏属正确行为：该流程已先行 GO 进入全屏。
- 续飞既有 smoke 断言（flight-extension-spool / spent）保持绿色，真续航未误伤。

## 遗留风险

- 过门后 passed-recovery 窗口内立即再接新一飞，course 的 certifiedHandoff
  可能走 timeout 后备路径（视觉分支回收稍晚），与"落地瞬间再起飞"序列同源，
  当前 smoke 未见异常。
- 微信内 requestFullscreen 被拒后 READY 按钮保持自隐（与移动端无恢复按钮的
  既有形态一致）；微信用户靠竖屏小字引导到系统浏览器获得全屏。

## 唯一下一步

提交并推送（jiepi-clear 预检 + release:checked）；用户实机复核竖屏提示文案、
雷达观感与全屏按钮在真机浏览器/微信内的显隐。
