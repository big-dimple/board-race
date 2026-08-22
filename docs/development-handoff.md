# Board Race 开发交接

状态：`flight prompt redesign + rule onboarding + mist corridor / 已发布,待真机验收`

更新时间：2026-08-22

## 基线

- `3b806a5` 已发布:飞行提示卡重做 + 续飞规则引导 + 雾道雾幕。build / verify:smoke
  双端全绿(含新增 spent 卡合同)。

## 本轮改动(飞行提示卡重做 + 规则引导 + 雾道可读性)

1. **提示卡视觉重做**:桌面键帽 88→62px、边框 6→4px、卡片描边与投影收窄;去掉
   copy 的 `text-shadow: 3px 3px 0 var(--ink)`(蓝字黑边重影根因);EN/规则行统一
   `--prompt-color`;桌面规则行 14→18px(续飞字号反馈)。中屏/窄屏/矮屏变体同步收。
2. **按熟练度静默**:HUD 新增 `shouldShowFlightPrompt(mode)` 构造参数,main 接
   `drivingCoach.mastery.launched / extendedFlight`——掌握后对应提示卡永不出现,
   未掌握者教学窗口内照常。
3. **手机端补齐**:`(max-width:900px),(max-height:520px)` 里对 `.hud-flight-prompt`
   的 `display:none` 已移除;触屏横屏改为统一的右侧紧凑卡(起飞/续飞/spent 同形态),
   让出中央航线与门,贴近右侧飞行钮。移动端续飞规则用短文案(完整规则仍在按钮 aria)。
4. **规则讲透**:起飞卡规则改为「起飞耗 1 格 · 空中最多再续 1 次」;续飞卡桌面
   「本飞仅此 1 次续航 · 最多用 2 格(起飞 1 + 续航 1)」;新增 spent 形态——空中
   续航用完后有库存再按起飞键,同卡片提示「本飞续航已用完 · 每飞限续 1 次 · 剩余格
   留给下一飞」(1.6s,中性白,每飞一次)。landing 复盘文案同步。README 已补。
5. **雾道可读性**:走廊边缘带加宽加亮(0.032→0.052,α0.34→0.52)、雾体 panel
   0.095→0.15、流向包络对比加强(0.34/0.66→0.2/0.8);两侧 rail 管 0.07→0.2、
   α0.42→0.85;新增两侧下垂雾幕(静态几何 + 共享 ShaderMaterial,锯齿脉冲指向
   出口,解决追尾视角掠射不可见);门柱发光芯 0.16→0.24、locator α0.72→0.95 加大。
   代价:桌面 draw calls 200→212,triangles +5k,frameMs 不变。
6. **冒烟新合同**:harness 加 `setFlightCharges`;双端断言 spent 卡可见、不溢出、
   规则文案在。extend 卡规则正则仍匹配(文案保持「最多用 2 格(起飞 1 + 续航 1)」结构)。

## 待真机确认

- 提示卡新尺寸/配色手感、spent 卡时机;雾幕+加粗 rails 的动态度(方向脉冲只在运动中可读)。
- 桌面/手机截图(自审):/tmp/shots-review/(d|m)-(launch|extend-corridor|spent).png。

## 下一步

- 用户真机动态验收(见上节清单);无新工作包。
