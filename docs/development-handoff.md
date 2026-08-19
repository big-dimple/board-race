# Board Race 开发交接

状态：`T5 complete / T6a next`

更新时间：2026-08-20

## 当前工作包

- Base：`55048cf24cf555c79b3ac24275ace71360183b4b`，`main`；起点工作树干净。
- `src/game/race.ts` 只把水面硬边外 `off_course` 判负持续窗口从 `0.8s` 改为 `15s`。
  `OFF_COURSE_WARN_M` 即时警告、折叠冲突、回线衰减、Final Station 解除、`wrong_way` 的
  `0.7s / 2.4s` 时钟，以及飞行 corridor / landing / no_launch / 门语义均未改。
- 现有浏览器 harness 增加一个桌面固定步合同：正式进入 racing 后把玩家固定在真实水面硬边外，
  只经 `Race.update` 累计到失败；没有导出产品常量、增加公开 debug API 或新建 harness 文件。

## 证据与验证

- before：源码阈值为 `0.8s`；同一诊断在硬边 `42m` 外的 `46.00m` 处于 `0.800s` 判
  `defeated / off_course`，14.9 秒时早已失败。
- after：`46.00m` 固定位置持续 14.9 秒仍为 `racing / off_course`；第 `900` 个 60Hz fixed-step，
  即 `15.000s`，进入 `defeated`，结果 reason 为 `off_course`。
- `npm run build`、`npm run verify:smoke`、`git diff --check` 通过。smoke 仍为桌面
  `174 calls / 325529 triangles / 2025000 pixels / 16.7ms`、手机
  `194 calls / 328545 triangles / 2057250 pixels / 16.7ms`。
- T5 不改像素、碰撞或音频，因此不需要截图，也未运行 collision / audio 专项。

## Pending 与风险

- T5 无功能 pending。Actions / Pages 未检查且不属于发布门禁。
- 固定步合同覆盖持续越界和失败边界；回线衰减与 Final / wrong-way 分支由未改 diff 保持，未增加
  重复场景扩大 smoke。

## 唯一下一步

T6a 只处理船尾流“双连续白线”：以 `src/water/wake.ts` 为首选 owner，把主读形改为断续中央含气水带，
肩浪仅保留微弱、断续的次级信息。先读美术方向并建立桌面 / `844x390` before；不得在同一 session
混入落水水花、开场船体下沉、海面、船体或车手重做。
