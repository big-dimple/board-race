# Board Race 开发交接

状态：第五飞入口扩边包已验证，待提交推送后用户实机复核。

## 当前工作包（本提交）

- 目标：放宽第五飞（flight-5）空道入口左侧（弯外）的判负尺度，让外围绕入
  进入口成为合法航线，同时不松动整条空道与门前漏斗。
- 起因：用户实机反馈——入口左侧稍微超出即判负，但玩家明明可以从外部绕一下
  进入口。实测 geometry：中心线在 mouth 后飞快右抛（u=0.645 已偏右 12m），
  沿主线自然直线飞 44m 即 instant fail；mouth 左侧 22m 触硬边界、>7m 停留
  1.8s 判负，绕入弧线根本来不及完成。
- 方案：按航路配置的入口扩边（方案 A，未采纳整条 corridorHalfWidth 加宽的方案 B）。
  - `src/contracts.ts`：`FlightRouteDefinition` 新增可选
    `corridorEntranceFlareM` / `corridorEntranceFlareToU`。
  - `src/game/course.ts`：新增 `flightCorridorHalfWidthAt(def, u)` helper
    （线性淡出）；flight-5 配置 `+8m → 0.66`（mouth 有效半宽 15m，0.66 在
    横向峰值 0.661、counterTurn 0.672、门 0.69875 之前）；四处判定消费
    （危险模型 / 尝试 latch / `computeLaunchJudgment` / 右席镜像），
    判定、物理、表现仍共用同一条危险曲线；视觉 ribbon 不动。
  - 数值效果：mouth 15m 内零危险，立即判负边界 21→29m；直线不转弯仍
    ~46-48m 判负（纪律保留）；门 5.775/5.5、corridor 7 全部不变。
- Owner：`src/contracts.ts`、`src/game/course.ts`、`src/main.ts`、
  `harness/collision.mjs`、`docs/llmwiki.md`、本文件。

## 验证与证据

- `npm run build` 通过；`verify:smoke` 桌面 + 844x390 通过；`verify:team` 通过。
- `verify:collision` 通过，新增两个确定性用例：
  - `route5-entrance-flare`：mouth 左侧 12m 巡航保持 3s——保持 `active` 无判负；
  - `route5-entrance-limit`：mouth 左侧 20m 同保持——第 109 步（≈1.82s）按
    `corridor` 判负，证明边界与 1.8s 尺度仍在。

## 遗留风险

- 无（本包只碰入口段判定；其它六飞与全局硬边界/时长常量未动）。

## 唯一下一步

用户实机复核：第五飞从弯外大角度绕入入口是否不再被快速判负；顺带确认入口
放宽后中段与穿门手感没有变松。若入口空间仍嫌不足，优先微调
`corridorEntranceFlareM`（当前 8）与淡出位置 `corridorEntranceFlareToU`
（当前 0.66），不要动全局常量。
