# Board Race 开发交接

状态：`T1 complete / T2 next`

更新时间：2026-08-20

## 当前工作包

- Base：`2a284c37cfa30f313ad13c77f6afae54ea29f646`，`main`，起点与当时本地
  `origin/main` 引用一致且工作树干净；未执行 fetch 或远端卫生审计。
- T1 只修复空中二次续飞提示的视线回归，不改文案、玩法、海面、波速、船体、车手、路线、
  右侧库存组件、radio、其他通知、速度线或 off-course。

## 已完成

- `77320ed` 引入的全平台右上覆盖已改为两套布局：桌面恢复到船体上方的居中主视线，横屏
  手机独立适度上移并保持居中。提示继续禁用闪白和速度线，原时长与文案不变。
- `844x390` 的右侧漂移 / 飞行储备菱形组件保持原位；`src/hud/hud.ts` 未修改。
- smoke 删除“续飞必须在右上”的回归断言，改为检查中央视线、船体上方垂直带、视口内、
  文本不溢出，以及手机模式按钮和四个动作触区不相交；没有固定像素快照或新 harness。
- `llmwiki` 已同步最终稳定合同；没有重建 knowledge-map。

## 实际证据

- 本任务真实 before：`shots/hud-flight-extension/before/flight-extension-spool.png` 与
  `flight-extension-spool-mobile.png`。两端均为 `165 calls / 306307 triangles`；drawing pixels
  分别为 `2025000` 与 `2057250`。
- 本任务 after：`shots/hud-flight-extension/after/flight-extension-spool.png` 与
  `flight-extension-spool-mobile.png`。两端仍为 `165 calls / 306307 triangles`，drawing pixels
  分别为 `2025000` 与 `2057250`。
- 四张图已逐张检查：提示可见且文案未溢出；桌面与手机均和车手、船体、当前门及航线留有
  间距，手机提示未进入触控区。截图检查是本次执行者的视觉复核，机器指标不证明审美质量。
- `npm run build`：通过。`npm run verify:smoke`：通过；桌面为
  `174 calls / 325529 triangles / 2025000 pixels / 16.7 ms`，手机为
  `194 calls / 328545 triangles / 2057250 pixels / 16.7 ms`。
- `git diff --check`：通过。collision / audio 未运行，因为本任务未改对应域。

## 改动 Owner

- 续飞提示布局与动画锚点：`src/hud/hud.css`。
- 桌面 / 手机 HUD 冒烟结果合同：`harness/screenshot.mjs`。
- 稳定 HUD 合同与当前工作包：`docs/llmwiki.md`、本文。

## 遗留风险

- 证据覆盖桌面 `1440x900` 与 Chromium `844x390` 横屏；刘海安全区和 iOS / Android 真机
  仍未单独验证。最终审美接受仍由玩家截图评审决定。
- 其他短通知的遮船问题和移动端边缘受光 / 速度线粗细均未在 T1 修改。

## 唯一下一步

T2 分成两个明确子项完成同一工作包：先逐类检查并单独调整其他短通知的遮船问题，禁止用
全局偏移；再只减细移动端两侧边缘受光 / 速度线，桌面粗细保持不变。两项都重新生成桌面与
`844x390` before/after 并逐张审图，不混入玩法、海面、船体、角色或 radio 改动。
