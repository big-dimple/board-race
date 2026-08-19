# Board Race 开发交接

状态：`T2a complete / T2b next`

更新时间：2026-08-20

## 当前工作包

- Base：`8aada8558fac379dd2893e6f2a5fa4540348ad97`，`main`；起点工作树干净且本地
  `HEAD` / `origin/main` 引用一致。未执行 fetch 或远端卫生审计。
- T2a 仅在 `src/hud/hud.css` 为 `flight-launch`、`gate`、`route-clear`、`excellent` 分别设置
  桌面和横屏手机的中央上方锚点；未修改全局 `.hud-impact-copy`。
- `flight-pass` 经审图保持桌面右上、手机隐藏；`flight-extend`、`final-ready`、失败结算
  gate-copy、右侧库存组件及通知行为均未修改。一次性截图 probe 已撤除，`src/main.ts`、
  `src/hud/hud.ts`、`harness/screenshot.mjs` 无 T2a diff，也没有新增生产测试 API。

## 证据与验证

- 本地忽略目录 `shots/hud-short-notices/{before,after}/` 保留五类通知的 `1440x900` 与
  `844x390` 截图，不暂存、不提交。审图确认四类调整项已让出船体、车手、当前门和紧急航线；
  `flight-pass` 原位置安全并保持不改。
- 可重复的 `flight-launch` before / after 均为 `217 calls / 315009 triangles`；drawing pixels
  桌面 `2025000`、手机 `2057250`，指标仅记录渲染资源量。
- `npm run build`、`npm run verify:smoke`、`git diff --check` 均通过；smoke 为桌面
  `174 calls / 325529 triangles / 2025000 pixels / 16.7 ms`、手机
  `194 calls / 328545 triangles / 2057250 pixels / 16.7 ms`。collision / audio 未运行。

## 遗留风险

- 单 gate 航线过门时会同步进入 `passed`，现有 gate 通知可能被 `route-clear` 取代；T2a 未改
  触发、队列或优先级。Chromium 证据也未覆盖刘海安全区及 iOS / Android 真机。

## 唯一下一步

T2b 只减细横屏手机两侧的移动边缘受光 / 速度线，桌面保持不变。重新生成桌面与 `844x390`
before / after 并逐张审图，不混入 HUD 通知、玩法、海面、船体、车手、radio 或库存组件改动。
