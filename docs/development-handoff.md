# Board Race 开发交接

状态：`T3 complete / T4 next`

更新时间：2026-08-20

## 当前工作包

- Base：`6a81eed6fc8b13589f1fe2856dc086bc715b2937`，`main`；起点工作树干净，未执行
  fetch 或远端卫生审计。
- `RaceTower` 在 presentation block、flight focus 和非 racing 暂停期间保留同一个 active notice
  的 DOM、revision、`.on` 与动画对象；`.blocked.paused` 只用 `visibility` 暂藏并停住动画，恢复后
  从剩余 `5.65s` 阅读计时继续，不再重跑入场。`RadioDirector` 无需修改。
- fresh GO 读取已有 `drivingCoach.progress.mastery.airBrakedInTurn`：已掌握者只剩 GO 电台，未掌握者
  每个页面会话最多真正显示一次，same run 和新 run 都不会再次入队。
- Gemini 只保留一条短话术；手机广播用头像 / copy / 等宽平衡位三轨，copy 与 body 相对整卡中心
  均只差 `0.5px`，允许自然换行且无溢出，不碰中央航线或触控区。

## 证据与验证

- ignored `shots/radio-human-pass/{before,after}/` 保留同一 `radio-technique` 的 `1440x900`、
  `844x390` 截图和 JSON 证据。逐图确认最终桌面卡片可读且不遮门线；手机短句不拆“先空刹”，
  整卡居中并留在左侧安全区。
- before probe 先把动画定位到 `1250ms`；阻断会移除 `.on`、令 animation count 变为 `0`，恢复后
  回到 `0` 且对象已替换；after 两种阻断均保持 active key、timer、revision 和同一动画对象，display 仍为 grid、
  visibility hidden、play state paused，恢复后 timer 只继续一个 fixed step。
- radio 场景 before / after 均为 `292 calls / 336317 triangles / 16.7ms`；drawing pixels 桌面
  `2025000`、手机 `2057250`。指标仅记录资源量，不替代截图审查。
- `npm run build`、`npm run verify:smoke`、`git diff --check` 均通过；smoke 为桌面
  `174 calls / 325529 triangles / 2025000 pixels / 16.7ms`、手机
  `194 calls / 328545 triangles / 2057250 pixels / 16.7ms`。未改音频和碰撞，相关专项未运行。
- 现有 `radioTechniqueCase` 只保护 once、block / resume、no reentry、mastery gate 和手机几何；
  没有固化整句中文文案，没有新增 harness 文件、测试专用产品 API 或图片像素门禁。

## Pending 与风险

- T3 实现与本地验证无 pending；Actions / Pages 不作为发布门禁。真机刘海安全区和不同移动浏览器
  的中文字体度量未覆盖，残余风险限于设备差异下的排版观感。

## 唯一下一步

T4 只增加一次性轻提示，解释三格库存，但单次飞行最多起飞一次、续航一次，共消耗两格；不得回头
扩写 T3 电台，也不得混入玩法、海面、HUD 其他通知、船体、车手或音频改动。
