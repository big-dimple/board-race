# Board Race 开发交接

状态：`T6c complete / queue empty`

更新时间：2026-08-20

## 当前工作包

- Base：`e7e16a51ebe9178495dc783f795657fe4870c3d2`，`main`，起点工作树干净。
- 产品 owner 为 `src/hud/hud.css` 与 `src/hud/hud.ts`。桌面续航动作卡从右上角移到中央上方空域，
  动作标题由 `24px` 放大到 `31px`；续航成功反馈标题由桌面 `23px`、手机 `18px` 分别放大到
  `32px`、`26px`，并略向上收回主视线。
- 横屏手机艇边储备不再固定在 `innerWidth - 205px`。它以车手投影为锚，在右侧保持约 `132px`
  中心距并受视口边界约束；桌面相反侧选择逻辑、右手按键、飞行规则、物理和渲染均未改动。

## 证据与验证

- Fresh before：`shots/hud-main-sightline/before/flight-extension-ready.png`、
  `flight-extension-spool.png`、`flight-ready.png` 及对应 `-mobile` 图。
- After：`shots/hud-main-sightline/after/flight-extension-ready.png`、`flight-extension-spool.png`、
  `flight-ready.png` 及对应 `-mobile` 图；机器记录在同目录 `evidence.json`。
- 桌面动作卡由 `x=992..1422 / y=70..178` 移到 `x=470..970 / y=70..182`，内容无溢出。
  手机储备框由 `x=585..693` 移到 `x=499..607`，与排名、飞行键和漂移键的 DOM 相交均为 false。
- 两端截图已人工检查：动作卡和成功反馈均未覆盖船体、车手、前方门或航线；手机储备仍在船右侧，
  不盖角色且没有挤入右下按键。移动端动作入口继续由现有“续”按钮拥有，没有新增教程层。
- `git diff --check`、`npm run build`、`npm run verify:smoke` 通过。smoke 桌面为
  `174 calls / 325529 triangles / 2025000 pixels / 16.7ms`，手机为
  `194 / 328545 / 2057250 / 16.7ms`。

## Pending 与风险

- T6c 无功能 pending。人工审图覆盖 `1440x900` 与 `844x390`；更窄的横屏设备仍依赖现有视口
  clamp 和旋转阻断，尚未逐尺寸做美术验收。
- `llmwiki` 已包含本次稳定 HUD 合同，无需重复修改。当前 handoff 队列已清空。

## 唯一下一步

等待用户体验当前版本后再建立新的单一工作包；在收到新的明确需求前，不自动启动海面、船体、选手或
其他视觉重做。
