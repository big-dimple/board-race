# Board Race 开发交接

状态：base `463548a`（头盔工作包已发版）。当前工作包未提交，改动已验证、待发版。

## 当前工作包（本提交）

- 目标：四项玩家体验修正——起终点门柱实体化、HUD 字幕瘦身、手机转向 UI 竞品式重设计、
  起飞判负规则可视化。
- 起终点门柱实体：`course.applyStartGantryHits()`（course.ts，紧随 applyBuoyHits）双柱
  圆测试 + 径向推出 + `applyCollisionResponse`（朝柱速度反弹，慢速贴柱只分离）；门楼保持
  非 knockable（浮漂恒 16）；main.ts 单/双打与团队循环接入 `presentBuoyHits` 反馈管并
  在位置修正时走 `race.syncCollisionCorrections()` 重投影；harness 新增
  `start-gantry-solid` 用例（collision.mjs）。
- 字幕瘦身：桌面紧凑电台卡 252→320px 治换行；单人超车不再双份播报（双打席位电台保留）；
  金币拾取卡优先级 70→44（排队不抢占过门/航线卡）；被顶通知取消 0.35s 回放；GO 3.0s /
  三飞七飞认证 3.4s / 撞柱 3.4s / final-ready 2.6s。
- 手机转向 UI（竞品摩托艇式）：转向垫 84-92px、底色加深、border 画法 chevron 居中放大
  （58-80px），移除可见 LEFT/RIGHT 文字（aria-label 保留）；hit 区与 pointer 映射零改动；
  README 描述同步。
- 起飞判负可视化（判定不变，只加表现）：水面引导线起飞窗口变色带（尽头对齐
  `gateUs[0]−FLIGHT_GATE_BYPASS_U` 死线，替代原 exitU+8 压暗）；`computeLaunchJudgment`
  每步输出 launchDeadlineM / flightOrphan / flightDoomed（guidance + 双打副席同算，
  早飞可达性按 22 m/s 巡航 floor 规划）；HUD 复用 wrong-way 横幅槽（corridor >
  launchJudgment > wrong_way > off_course），doomed 起跳沿触发一次性提示卡
  `.hud-flight-prompt.doomed` + flight-alert；harness 新增 launch-deadline /
  launch-doomed 截图场景。
- Owner：`game/course.ts`、`contracts.ts`、`main.ts`、`hud/hud.ts`、`hud/hud.css`、
  `hud/raceTower.*`、`core/mobileControls.*`、`harness/collision.mjs`、README、llmwiki、本文件。

## 验证与证据

- `npm run build` / `verify:smoke` / `verify:team` / `verify:collision` 全部通过
  （smoke 曾暴露 extension 场景被 doomed 卡抢占，已通过巡航速度 floor + 新动作窗口
  清除 doomed 卡修复并复跑确认）。
- 截图：`shots/launch-judgment/`（launch-deadline 桌面、launch-doomed 桌面、
  flight-ready 桌面）、`shots/launch-judgment-mobile/`（launch-deadline 844x390）、
  `shots/steer-redesign/`（手机转向垫，子代理已自查）。

## 唯一下一步

用户人工评审上述截图：门柱弹回手感（实机）、字幕节奏与宽度、手机转向垫观感、
起飞窗口色带与死线/doomed 提示的读感；确认后走 `release:checked` 发版。
