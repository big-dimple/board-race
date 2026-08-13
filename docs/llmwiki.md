# Board Race AI 运行手册

状态：`current / schema-v6`

这份文档给接手代码的 AI 使用，记录容易因上下文压缩而丢失、但又不能靠猜的
稳定事实。面向玩家的操作与行为合同仍在 `README.md`；项目级硬约束在
`AGENTS.md`；有冲突时以当前代码、确定性 harness 和用户最新明确决定为准，
修正事实后必须同步相关文档，不能保留两个都自称现役的版本。

## 一分钟恢复上下文

- Board Race 是横屏优先的 Three.js 街机赛艇游戏，玩家自动前进，只控制转向、
  水面漂移 / 空中空刹，以及主动起飞 / 空中续航。
- 核心循环是 `漂移 -> 松开入库 -> 在青色分支前起飞 -> 穿门`。三次独立飞行
  获得男人勋章，拿到第一升级为优秀男人；七飞后开放 Final Station。
- 首次 READY 与首局不出现新手教程，让熟练玩家直接冲勋章。第一次真实失败后
  才启动情境驾驶提示，而且从出现第一帧起就能继续或关闭。
- `BoatInput` 和 60 Hz fixed-step 是稳定合同。教学只观察状态和成功动作，绝不
  注入输入、改物理、放宽路线判定或创建教程专用比赛规则。
- 任何本地改动都不等于已发布。GitHub Pages 只会在 `main` 推送并通过 workflow 后
  部署；发布与 live verification 必须单独完成和汇报。

## 真实玩法语义

### 漂移、库存与飞行

1. 水面速度超过阈值后按住漂移键才会累积 `boostCharge`。
2. 船边左条的黄色刻度是合格线。达到后松开，才会存入一颗飞行菱形；只按过
   Shift 或进入 `drifting` 不代表已经理解或完成入库。
3. 最多存两颗菱形。每次合格释放只增加一颗，库存已满仍会正常结算水面 BOOST。
4. 继续漂过黄线只会延长释放后的水面 BOOST。它不会改变单格基础飞行时长。
   这是已经确定的现行规则，不得改成“漂得越久飞得越久”。
5. 水面起飞消耗一颗。基础飞行包络固定为 `6.45s`；巡航或下降时可把备用格
   消耗一次，增加 `2.4s`，总包络为 `8.85s`。spool / ascending 阶段的连按
   必须拒绝，一飞最多续航一次。
6. 通过或错过目标门会立即进入下降。未消费的备用格可跨落水和三飞勋章冻结
   保留；全新一局会清空。

权威实现：`src/game/boat.ts`。跨系统只读合同：`src/contracts.ts` 的
`BoatState`。HUD 派生：`src/core/abilityTelemetry.ts`。

### 船边仪表

- 左竖条是上下文动作条：水面漂移蓄力、释放后的 BOOST 剩余，或飞行中的空刹
  介入强度。它不是飞行库存。
- 黄色横线只表示“现在松开足够存一格”。
- 右竖条只在受控飞行中表示本次飞行包络剩余时间，不是高度、速度或库存。
- 两颗菱形才是飞行库存；青色高亮数量必须与 `flightCharges` 一致。
- 空刹不会消耗库存或读条。它降低目标速度，并提高空中转向与回正权限。

### 选手雷达

雷达不是装饰。四项分别真实修正水面加速、水面转向、漂移蓄力速度和空中转向
权限，单项限制在 `+/-6%`。配置在 `src/game/racers.ts`，物理消费在
`src/game/boat.ts#setDriver` 及对应 update 路径。角色气质文案不是额外隐藏技能，
不要从“晚刹”“姿态恢复”等描述擅自发明新物理。

## 输入合同

| 设备 | 转向 | 漂移 / 空刹 | 起飞 / 续航 |
| --- | --- | --- | --- |
| 键盘 | `A/D` 或方向键 | `Shift` | `Space` |
| 标准手柄 | 左摇杆 / D-pad | `X/Square`，肩键也接受 | `A/Cross` |
| 手机 | 固定左拇指区 | 固定右下按钮 | 固定右侧上方按钮 |

- 三类设备最终只合并为一个 `BoatInput`，不得为教程增加第二套控制路径。
- 手机切换倾斜 / 触控转向只允许改变左拇指区；右侧漂移与飞行位置不能移动。
- 教学文案使用最近真实活动的设备，不以“浏览器支持触控”或“有手柄连接”猜测。
- 未知手柄映射继续走 READY 校准。涉及手柄的任何改动都要覆盖首次边沿、多手柄、
  未知映射、断连释放和有界震动。

## 首败后驾驶提示

### 产品原则

- 首局是裸考，不在选手页或倒计时前强塞控制总图。
- 第一次真实失败完成成绩、勋章和失败快照结算后，展示一张聚焦本次错误的复盘。
  `再冲一次` 从第一帧可用，结束只回 READY，不会直接开局或缓冲 Space。
- 非专家玩家在该失败后把 coach 从 `dormant` 置为 `active`。下一局只显示一个
  当前可执行提示；危险警告、碰撞冲击、勋章和 Final 表现优先，coach 暂停而非叠层。
- `x`、键盘 `Esc`、手柄 `View / Back` 可立即关闭并持久化为 `disabled`；READY
  的 `?` 可按需重开。三飞前已经证明水平的玩家标记为 `expert`，不进入基础课。

### 最小课程与掌握证据

| 知识 | 何时出现 | 可靠完成证据 |
| --- | --- | --- |
| 自动油门 / 转向 | 确实没有有效转向时 | 有速度时产生显著 steer |
| 漂移到黄线并松开 | 未成功入库且库存未满 | 先达到 `driftReleaseReady`，随后库存上升 |
| 黄线、库存与固定飞行规则 | 第一次真实入库后的短反馈 | 反馈被安排后写入 knowledge；不是按过 Shift |
| 起飞并跟青线穿门 | 有库存且当前分支展开 | surface -> spool 且库存下降；route passed |
| 急弯空刹 | 第二飞以后进入真实急弯警告 | 警告中空刹介入并转向，随后过门 |
| 备用格续航 | 真实出现可续航窗口时 | `flightExtended` 成功脉冲 |

教学状态机在 `src/game/drivingCoach.ts`，只消费 `BoatState`、合并后的玩家输入、
路线指引和危险警告。表现层在 `src/hud/hud.ts/.css`；READY 帮助和雷达说明在
`src/hud/driverSelect.ts/.css`；生命周期与单槽仲裁在 `src/main.ts`。

## 生命周期与所有权

```text
DriverSelect / READY
  -> fresh countdown
  -> racing
  -> medal freeze -> resume countdown -> same run
  -> seven-flight Final Station -> frozen finale / dossier
  -> defeated -> 0.35s impact freeze -> focused review -> READY
```

- `Race` 负责确定性竞速 phase、倒计时、失败和结果；coach 不是 `RacePhase`，它是
  integration shell 上的表现状态，不能侵入竞速状态机。
- `resetRace()` 必须清输入边沿、世界表现和当前局状态，再回 READY。失败复盘、
  coach close、后台恢复都不能把同一个按键边沿带入下一局。
- 页面切后台、横竖屏阻断和 interruption gate 会冻结模拟。coach 的计时与提示
  同步暂停，恢复后续读。
- 飞行引导始终归玩家所有，世界中最多一条 active branch；教学不能生成第二条路线。

## 存档合同

- 当前 key 是 `board-race:challenge:v6`，模型在 `src/game/records.ts`。
- v6 持久化 coach 的 `status`、逐项 `mastery` 和机制 `knowledge`，并参与 JSON
  导入 / 导出和恶意值清洗。
- v2-v5 迁移不能用 `runs` 猜历史失败，因为它只表示按过 GO。旧档若
  `bestFlights >= 3` 或已经解锁勋章，迁为 `expert`；其他旧档等下一次真实失败
  再获得一次可关闭提示。
- `bestFlights >= 1` 可以证明玩家做过入库、起飞和过门，但不能证明理解固定飞行
  时长、空刹、两格策略或续航；不要把这些知识位一并猜成完成。
- localStorage 写入失败不能阻塞当前游戏。导入时必须保持 live coach 引用同步，
  不能只替换序列化对象。

## 视觉与可访问性边界

- 支持桌面和横屏手机；竖屏保持阻断式旋转提示，不设计第二套竖屏玩法。
- 同一时刻最多一个教育提示。coach 不能遮挡船边仪表、右拇指技能区、急弯警告、
  medal、Final 或 interruption gate。
- 提示标题先写动作，副行写结果；每次只讲一个当前有意义的概念。隐藏知识放在
  READY `?`，不把完整说明塞进首败 modal。
- 控制 glyph 必须跟随最近活动设备和自定义手柄映射，不能硬编码 Shift 给所有人。
- 教学帮助不降低物理难度、不影响勋章资格，也不自动驾驶。

## 验证与 harness

常用命令：

```bash
npm run build
npm run verify:flight
npm run verify:mobile
npm run verify:systems
npm run verify:release
```

`npm run verify:release` 是本地交付门禁，包含 gameplay、mobile、collision、audio、
systems、endurance 和 performance。物理、生命周期、音频、记录或渲染有改动时，
必须更新对应 harness 合同，不能为了通过而放宽阈值。

教学相关的最低回归集：

- 全新存档首局 coach 为 dormant 且无提示。
- 首次真实失败才激活；复盘第一帧可继续 / 关闭；退出只回 READY。
- 关闭后刷新不复活，READY `?` 可重开，三飞后变 expert。
- 漂移掌握以真实入库为准；launch、route、air-brake、extension 也使用成功状态边沿。
- 键盘、移动、标准 / 自定义 / 多手柄及运行中换设备显示正确 glyph。
- 手机 coach 与船边仪表、固定右拇指区不重叠；portrait / background 冻结安全。
- v2-v6 迁移、坏存档清洗与 JSON import 后的 live coach 一致。

确定性浏览器入口是 `?harness=1`；`harness/screenshot.mjs` 负责玩法、输入、移动端
和视觉几何，`harness/systems.mjs` 负责记录迁移与长跑合同。

## 开发、端口与收尾纪律

- `npm run dev` 使用严格端口 `5173`。若被占用，先用 `ss -ltnp` / `ps` /
  `/proc/<pid>/cwd` 确认归属；不要凭端口号杀进程，也不要让 Vite 静默漂到 5174。
- 确需并行服务时显式运行 `npm run dev -- --port <port>`，记录 PID 或工具 session；
  验收结束必须停止该精确进程并复查监听端口。
- `dist/` 和 `shots/` 是 ignored 生成产物。不要把“ignored”误当成“可随手删除”；
  先确认是否仍是视觉验收凭证，再按清场流程列候选。
- 图像生成 working directory、一次性计划、旧副本和临时脚本不属于项目真相。
  先确认正式资产已入库、没有未合并或独有成果、没有进程占用，再列删除候选。
- 用户要求 GitHub push、PR、Release、Pages 或其他仓库变更时，先启用
  `github-operator` skill；本地实现请求不隐含发布授权。
- 用户要求洁癖 / 收尾时启用 `neat-freak`：代码、运行态、文档、规则、记忆和
  工作区逐面标状态。清场删除必须在完整汇报之后获得用户再次明确确认，不能先删
  后报。Codex 生成记忆没有明确控制面时只读，不手改。

## 发布状态不要混写

```text
implemented -> locally verified -> pushed / PR -> CI passed -> merged
-> deployed -> live verified -> knowledge closed -> cleanup approved -> cleaned
```

当前工作只到哪一步，就明确写到哪一步。`git status` 干净不代表部署完成，PR
merged 也不代表用户已经看到新版本。本项目 GitHub Pages workflow 位于
`.github/workflows/deploy.yml`，推送 `main` 后运行全部门禁并部署 `dist/`。
