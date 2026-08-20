# Board Race 开发交接

状态：`mobile-hud-and-glint-rollback released`

更新时间：2026-08-20

## 当前工作包

- Base：`6a30ccf565c6d8b9c630a003fb5c29a6ec6ff5cc`，`main`。
- 产品 owner：`src/core/mobileControls.css`、`src/hud/hud.css`、`src/water/ocean.ts`、
  `src/cel/toonMaterial.ts`、`src/main.ts`。
- 横屏手机右转的可见圆面向右移 20px，命中区和左右拇指所有权不变；续航完成反馈提升为主标题层级。
- 用户否决本轮四芒星/反射门控重构。`ocean.ts` 已精确回退到此前已发布的短促闪烁实现，不保留
  新的反射走廊、常亮脉冲或像素封顶逻辑；天空日盘和短丁达尔束不受影响。

## 证据与验证

- 已完成桌面与 `844x390` 横屏截图人工检查：转向圆面间距更清楚；续航反馈清晰且未遮住飞行航线；
  海面没有本轮被否决的 glint 残留。
- `git diff --check`、`npm run build`、`npm run verify:smoke` 通过。smoke：桌面 `172 calls /
  325477 triangles / 2025000 pixels / 16.7ms`；手机 `192 / 328493 / 2057250 / 16.7ms`。
- `llmwiki` 的稳定合同已同步更新。

## Pending 与风险

- 用户明确要求白色大浪花继续提升，但本轮先不改它。当前 whitecap 是多个浪形阈值相乘后直接混入
  单一白色，并由独立相位切块，因此没有被浪脊托起的厚度。后续应作为独立美术工作包，以同一波形
  驱动波前亮唇、气泡主体和背风湿边三层，并在桌面与 `844x390` 真实截图评审；不要以加白或加噪声
  代替体积。

## 唯一下一步

开启 `whitecap-volume` 时，先做一项只依附现有波形的三层泡沫可见原型，按桌面与 `844x390` 截图让
用户确认方向后再扩展；不要重新尝试四芒星/反射门控改造，除非用户给出新方向。
