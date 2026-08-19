# Board Race 开发交接

状态：`T4 complete / T5 next`

更新时间：2026-08-20

## 当前工作包

- Base：`f5f96f6d1c72dc1020c6a378d24a0552e294f96e`，`main`；起点工作树干净。
- 桌面沿用现有 tokenized flight-extension prompt，在真实可续航窗口说明“本飞最多用 2 格 ·
  起飞 1 + 续航 1”；位置、动作、库存、2.15s token 和 gameplay 均未改变。
- 横屏手机没有恢复 HUD 大卡片；现有“续”按钮保持主字、`x库存`、尺寸和位置，只把副标签改为
  “每飞 1 次”，无障碍说明补全本飞起飞一次、续航一次。
- DrivingCoach 的 extension detail 与选角页进阶规则同步同一事实。没有新增 DOM、overlay、存档状态、
  schema、localStorage、物理或 `MAX_FLIGHT_CHARGES` 分支。

## 证据与验证

- ignored `shots/flight-consumption-lesson/{before,after}/` 保存同一真实 extension-ready 窗口的
  `1440x900` 与 `844x390` 截图及 JSON。before 来自 detached base：桌面旧规则只写单格消耗，
  手机仅写 `EXTEND`；after 桌面公式完整且无溢出，手机副标签完整留在原按钮内，不盖船、航线或触控区。
- 同场景 before / after 均为：桌面 `168 calls / 311897 triangles / 2025000 pixels / 16.7ms`，
  手机 `168 calls / 311899 triangles / 2057250 pixels / 16.7ms`。指标只记录资源量，不替代审图。
- `npm run build`、连续两次 `npm run verify:smoke`、`git diff --check` 均通过。smoke 为桌面
  `174 calls / 325529 triangles / 2025000 pixels / 16.7ms`、手机
  `194 calls / 328545 triangles / 2057250 pixels / 16.7ms`。未改音频或碰撞，专项未运行。
- smoke 只新增长期回归价值：桌面提示可见、规则不溢出；手机副标签与 aria 包含单飞限制且留在按钮内。
  没有新增 harness 文件、产品测试 API、截图门禁或逐字锁死完整文案。

## Pending 与风险

- T4 无功能 pending；Actions / Pages 不作为发布门禁。真机中文字体可能有轻微字宽差异，但按钮内
  nowrap 与 smoke 几何检查限制了拆字和溢出风险。

## 唯一下一步

T5 只把水面偏离主线的 `off_course` 判负时间延长为 15 秒，并用对应玩法诊断确认；不得顺带修改
`wrong_way`、飞行 corridor、门、海面、HUD、船体、车手、电台、音频或碰撞语义。
