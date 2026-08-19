# Board Race 开发交接

状态：`T6a complete / T6b next`

更新时间：2026-08-20

## 当前工作包

- Base：`517379b8a3bacacb5bc8cda7cf9e0b96d00c383a`，`main`，起点工作树干净。
- 唯一产品 owner 是 `src/water/wake.ts`。原中央 body、contact、coverage、几何、沉积、寿命、
  贴浪、airborne 和 interaction 逻辑保持不变；只把 Kelvin shoulder 改为左右错相、窄、短程、
  大段开放水面的次级碎浪，并避免肩浪叠亮中央 body。
- 保持每艘 wake 单 Mesh / 单 draw、`MAX_POINTS=360`、预分配 `BufferGeometry` 和 push/update
  原位 typed-array 更新；未增加产品测试 API 或长期 harness。

## 证据与验证

- 在隔离 racing line、surface guide、jet FX 和对手 wake 的相同固定机位，桌面与 `844x390`
  各两个相隔 `0.8s` 的 fresh before/after 已人工验收：中央原有破碎洗流保留，连续双肩轨迹退为
  短程、错相、带开水间隔的次级信息；没有 filled road、横条或圆饼纹理。
- 隔离帧为 `65 calls`；wake-0 保持一 Mesh / 一 draw、最多 `718 triangles`。全帧在两个时刻为
  `264847 / 264921 triangles`、`16.7ms`；桌面 `2025000 drawingPixels`，手机
  `2057250 drawingPixels`。
- `git diff --check`、`npm run build`、`npm run verify:smoke` 通过。smoke 为桌面
  `174 calls / 325529 triangles / 2025000 pixels / 16.7ms`，手机
  `194 calls / 328545 triangles / 2057250 pixels / 16.7ms`。未改碰撞、音频或物理，不运行
  collision / audio 专项，也不保留 isolation probe。

## Pending 与风险

- T6a 无功能 pending。截图人工结论只覆盖正常直线高速的两个时刻；极端连续急转中的 ribbon
  自交仍是既有透明带风险，但本次未改几何、沉积节奏或转弯行为。
- Actions / Pages 不属于本次发布门禁。T6b 尚未开始。

## 唯一下一步

T6b 只处理真实接触水花可见性：建立 fresh desktop / `844x390` before，追踪真实触水事件到
spray 激活、渲染和退场归零，修复正常接触水花不可见。不得混入 wake、ocean / waves、船体物理、
开场船体下沉或其他美术重做。
