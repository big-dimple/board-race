# Board Race 开发交接

状态：`ocean relief + low-sun set / 待真机动态确认`

更新时间：2026-08-22

## 已完成

- 诊断：浪"有高度却视觉上低"的主因在呈现而非波高——相机与船刚性随浪抵消一阶运动证据；
  材质用坡度幅值打光导致向阳/背阳面同亮；Fresnel 被压 0.22 且反射色 82% 是水色；
  闪点全屏散布把海面读成平地。
- 相机（`chaseCamera.ts`):heave anchor 慢滤波锚点(τ=0.9s,只跟随 30% 瞬时起伏),
  船体在画面内真实随浪起伏;flightBlend 飞行段与 reducedMotion 恢复全跟随。
- 海面（`ocean.ts`):faceLight 改太阳方位有向坡度驱动(`uSunSlopeLight`)+背阳自遮蔽;
  Fresnel 0.22→0.45、上限 0.5、反射色贴近真实天色;朝日暖光路(`uColorSunWarm`,
  只随视线方位、不随涌浪法线)+雾色向太阳转暖;闪点收进朝日带、星芒只在 18m 外。
- 天空（`sky.ts` + `toonMaterial.ts`):可见太阳降至 ~12.7° 仰角,日盘与光晕加大,
  地平线朝日暖雾洗色,光晕改淡暖白消绿边,删死 uniform `uSunFlare`。
  采用 NFS 式低日高 key 方案;GT 式黄昏逆光已否决(压暗场景、埋 HUD)。
- toon 材质光照仍用高位 `SUN_DIR`,合同未动;波形谱未动。

## 实际验证

- `npm run build` 通过;`verify:smoke` 桌面+844x390 OK(初跑失败系 hud.css 所致,见下)。
- 美术总监截图自审通过:`shots/v5`(ocean-sunpath/start)与 `shots/v5-mobile`——
  中远场涌浪明暗 facet、近深远浅明度梯度、朝日暖光路均成立。
- 物理谱未改,`verify:collision` 不需要。

## 遗留风险

- `src/hud/hud.css` 存在未提交的用户改动(飞行提示卡 coarse-pointer media query 重构),
  它使桌面冒烟 extension prompt `fits` 失败(HEAD 与该文件二选一均可定位)。
  本次发版仅含海/天/相机与文档,该文件原样保留在工作区,待用户决定修复或放弃。
- heave 强度、光路宽度与暖度为静帧调参,待真机动态观感确认。

## 下一步

- 用户真机体验动态效果;若认可方向,做波形原型 2:crest 谐波 0.12-0.16→0.3+
  (尖峰宽谷)、谱重排补 4-8m 船身尺度 chop、浪群包络。均改 `waves.ts` 单一真相表,
  届时需 `verify:collision`。
