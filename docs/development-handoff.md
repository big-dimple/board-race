# Board Race 开发交接

状态：`T6b complete / T6c next`

更新时间：2026-08-20

## 当前工作包

- Base：`e4306724192b0a3ca0a77ac9216acd90b76d0a1e`，`main`。
- 唯一产品 owner 是 `src/water/spray.ts`。修正了水滴 billboard 基向量的反向绕序；此前材质使用
  `FrontSide`，28 个活跃水滴实际被背面剔除。落水体积改为船后半冠泡沫和两条短窄舷侧水花，
  水滴同步缩小并拉长，替代宽透明幕布和塑料片观感。
- 真实触水事件、实例池容量、退场生命周期、海面、波形、尾流和船体物理均未改动。

## 证据与验证

- Before：`shots/landing-splash/before/desktop-context-contact.png`、
  `shots/landing-splash/before/mobile-context-contact.png`。
- After：`shots/landing-splash/after-final/desktop-context-age-100.png`、
  `shots/landing-splash/after-final/mobile-context-age-100.png`；完整机器证据在同目录 `evidence.json`。
- 桌面和 `844x390` 的正常追尾机位均已人工检查：首次真实落水可见短水滴和紧凑弧形泡沫，
  没有长条透明幕布；约 `0.9s` 后活跃水滴和体积都归零。
- 事件激活 `28 droplets + 1 landing volume`。隔离帧由退场后的
  `64 calls / 264635 triangles` 增至 `66 / 264955`，即 `+2 calls / +320 triangles`。
  正常机位桌面为 `144 calls / 304801 triangles / 2025000 pixels / 16.7ms`，手机为
  `154 / 306309 / 2057250 / 16.7ms`。
- `git diff --check`、`npm run build`、`npm run verify:smoke` 和
  `npm run verify:collision` 通过。smoke 仍为桌面 `174 calls / 325529 triangles`、手机
  `194 / 328545`，均为 `16.7ms`。

## Pending 与风险

- T6b 无功能 pending。人工画面结论覆盖第一条真实飞行路线约 `130km/h` 的一次落水；共享水滴
  绕序修复也恢复起飞和碰撞水滴，碰撞诊断已通过，但尚未逐个做所有喷溅场景的美术验收。
- 续飞提示字号与位置、移动端漂移储备位置都未在 T6b 修改，仍是下一 task，不能写成已完成。

## 唯一下一步

T6c 只处理 HUD 主视线可读性：先建立 fresh desktop / `844x390` before，再检查实际 DOM/CSS。
续飞提示必须明显放大并回到船体上方的主视线内，不得留在右上角，也不得覆盖船体、航线或门柱；
移动端漂移/飞行储备组件保留在右侧，只向船体适度靠近，并避开角色、排名和右手按键，不移到左侧。
完成后提供两端 after 截图、人工重叠检查、至少一项渲染或帧时指标，并运行 build 与 smoke。
