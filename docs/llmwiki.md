# Board Race AI 运行手册

状态：`current / schema-v8`

这份文档给接手代码的 AI 使用，记录容易因上下文压缩而丢失、但又不能靠猜的
稳定事实。面向玩家的操作与行为合同仍在 `README.md`；项目级硬约束在
`AGENTS.md`；有冲突时以当前代码、确定性 harness 和用户最新明确决定为准，
修正事实后必须同步相关文档，不能保留两个都自称现役的版本。

## 一分钟恢复上下文

- Board Race 是横屏优先的 Three.js 街机赛艇游戏，玩家自动前进，只控制转向、
  水面漂移 / 空中空刹，以及主动起飞 / 空中续航。
- 核心循环是 `漂移 -> 松开入库 -> 在青色分支前起飞 -> 穿门`。三次独立飞行
  获得男人勋章，拿到第一升级为优秀男人；七飞后开放 Final Station。
- 首次 READY 与首局不出现新手教程，让熟练玩家直接冲勋章。仅全新 v8 存档的
  第一次真实失败会出现一次邀请；接受后才在下一局启动聚光式逐步标注。
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

### 穿门后的惯性与路线交接

- 穿门只完成计分并进入下降，不会清除 `x/z` 位置、水平速度、船头或 yaw。现行物理
  保留真实惯性；禁止用 teleport、snap、重置速度或隐藏的自动驾驶把船拉回主线。
- `flightRouteState='passed'` 不等于路线所有权已经回到 surface。当前 flight branch
  必须继续负责下降、触水和门后的 authored recovery tail；落水本身也不是交接点。
- 交接条件是船已回到水面，并越过该分支的 exit 平面、处于出口横向 `24m` 内、真实
  水平速度没有逆着出口切线。按门到出口距离与路线目标速度计算的 `2.5-4s` 上限只
  是防逃线兜底；它不能改变船体运动。
- `Course.sample()` 收到显式 flight route hint 时必须把该分支视为权威，不能因为离
  分支较远就偷偷回退到全局最近的 surface 段。branch -> surface 交接时 `Race` 只
  重建采样基线并保留连续比赛进度，不能把投影差误当倒退。
- recovery 期间不累计 surface off-course / wrong-way timer。交接后，偏离路线按离
  surface 线的距离判断；真逆行要求船在引导附近、真实水平速度和连续进度都反向。
  HUD 必须分别显示“偏离航线”和“方向反了”，不能共用含糊的 `WRONG WAY!`。
- 视觉语法固定为 `青色门前轨道 -> 绿色软回收漏斗/间断箭头 -> 绿色水面主线`。
  门后提前露出主线并保持 `16m` 交叠；世界中仍然最多一个 active branch。回收提示
  只是可视导航，不是碰撞墙，也不改变判定范围。

权威状态在 `src/game/course.ts`，连续进度和 surface 警告在 `src/game/race.ts`。
任何调整必须覆盖第 4-7 飞完整的 gate -> descent -> water -> handoff，不得只测门口。

### 失败快照语义

- `no_launch / corridor / landing / exit / teleport` 是路线级失败，`targetGate=null`；
  `ChallengeResult.gate=0`。不能为了结果页方便伪造“第 1 门”。
- `gate / gate_left / gate_right / late` 才是门级失败，保留真实 `targetGate`；左右擦门
  还要保留横向偏差与门心限制，结果页据此说清从哪侧超了多少。
- `off_course / wrong_way` 是水面域。前者保留离绿色主线距离，后者只表示连续逆行；
  两者都没有门号、门心偏差或飞行通道数据。教学必须先按 reason 分域再读字段。
- 水面已经离主线达到 `SURFACE_ROUTE_FAIL_DISTANCE_M` 时，即使 U 投影越过飞行门也
  不能报 `no_launch`；active flight 已进入 descending 时则报 `landing`，不能被同帧
  通道偏差覆盖。两条优先级都有确定性 harness，修改顺序时必须同步。
- 一帧内出现多个条件时由 `Course` 的固定优先级给出唯一不可变快照。失败复盘和
  教学只能消费 `ChallengeResult.failure`，不能稍后从已被 reset 的 live state 猜原因。

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
- 第一次真实失败完成成绩、勋章和失败快照结算后，展示聚焦本次错误的复盘，给出
  `带标注再冲 / 不用引导`。两个选择从第一帧可用，结束只回 READY，不会直接开局
  或缓冲 Space；超时默认接受并回 READY。
- 只有 `automaticEligible=true` 的存档可自动从 `dormant` 进入 `active`，该资格
  一经失败、主动启用、关闭、完成或 expert 就永久消费。旧档和 import 默认是回访；
  唯一例外是下面记录的 v7/v6 rollout repair。
- 下一局只显示一个当前可执行提示，并把聚光框落在真实控件或船边仪表：桌面第一步
  必须明确框住 `SHIFT` 键帽；按下后框住左条，再按成功状态边沿推进到库存和起飞。
- 危险警告、碰撞冲击、勋章和 Final 表现优先，guide 暂停而非叠层。可见
  `跳过引导`、键盘 `Esc`、手柄 `View / Back` 可立即关闭并持久化为 `disabled`；
  READY `?` 可按需重开。三飞前已证明水平的玩家标记为 `expert`。

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
- 三飞勋章属于同一局内的 presentation freeze：物理上持续按住的转向和漂移 / 空刹
  必须保留到 resume countdown 与 racing；手机在 presentation 期间仍可新按住左 / 右
  和漂移，但飞行区不可命中。起飞始终是边沿动作，绝不能因预按或恢复自动触发。
- 页面切后台、横竖屏阻断和 interruption gate 会冻结模拟。coach 的计时与提示
  同步暂停，恢复后续读。
- 飞行引导始终归玩家所有，世界中最多一条 active branch；教学不能生成第二条路线。

## 存档合同

- 当前 key 是 `board-race:challenge:v8`，模型在 `src/game/records.ts`。
- v8 持久化 guide 的 `status`、`automaticEligible`、逐项 `mastery` 和机制
  `knowledge`，并参与 JSON 导入 / 导出和恶意值清洗。
- v2-v5 迁移不能用 `runs` 猜历史失败，因为它只表示按过 GO。旧档若
  `bestFlights >= 3` 或已经解锁勋章，迁为 `expert`；其他旧档保持 `dormant`，但
  `automaticEligible=false`，只能由玩家从 READY `?` 主动启用。v8 对错误发布的 v7
  做一次定向修复：只把结构完整、仍为 `dormant`、未三飞且未主动关闭的玩家重新
  设为 eligible，仍要等下一次真实失败才出现。v6 的完整 novice coach 也沿同一修复
  迁移；`disabled / complete / expert`、坏数据和 import 永不自动。
- `bestFlights >= 1` 可以证明玩家做过入库、起飞和过门，但不能证明理解固定飞行
  时长、空刹、两格策略或续航；不要把这些知识位一并猜成完成。
- localStorage 写入失败不能阻塞当前游戏。导入时必须保持 live coach 引用同步，
  不能只替换序列化对象。

## 视觉与可访问性边界

- 支持桌面和横屏手机；竖屏保持阻断式旋转提示，不设计第二套竖屏玩法。
- 同一时刻最多一个教育提示。guide 不能遮挡船边仪表、右拇指技能区、急弯警告、
  medal、Final 或 interruption gate。
- 提示标题先写动作，副行写结果；每次只讲一个当前有意义的概念。READY `?` 默认
  只解释逐步标注，黄线、左右条、备用格和雷达放在玩家主动展开的“进阶规则”。
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

飞行回收的最低回归集：

- `flightRecoveryCase(routeCursor)` 只允许在起飞前 staging 一次；穿门后逐帧跑到
  route handoff，再继续至少 `2.5s`，中间不得 reset、teleport 或调用下一飞 helper。
- 第 4-7 飞必须分别证明 pass 只增加一次、fail 为零、全程最多一条分支、没有警告
  预累计、没有位置跳跃或水平速度归零，且连续进度不会因路线投影切换明显倒退。
- `flight-recovery-air` 与 `flight-recovery-surface` 覆盖桌面和紧凑横屏视觉；落水
  前后始终要有一条指向出口的导航，绿色箭头不得遮挡右拇指固定技能区。
- 旧的 `passFlight()` 会在每飞前 staging，适合门判定和计数等局部合同，不得把它
  当作冲门后惯性或 route handoff 的端到端证据。

教学相关的最低回归集：

- 全新存档首局 guide 为 dormant、`automaticEligible=true` 且无提示。
- 首次真实失败才激活；复盘第一帧可继续 / 关闭；退出只回 READY。
- 关闭后刷新不复活，READY `?` 可重开，三飞后变 expert。
- 漂移掌握以真实入库为准；launch、route、air-brake、extension 也使用成功状态边沿。
- 键盘、移动、标准 / 自定义 / 多手柄及运行中换设备显示正确 glyph。
- 手机 coach 卡片与船边仪表、固定右拇指区不重叠，聚光框必须圈住真实按钮；
  portrait / background 冻结安全。
- v2-v8 迁移、v7 rollout repair、坏存档清洗与 JSON import 后的 live guide 一致。

确定性浏览器入口是 `?harness=1`；`harness/screenshot.mjs` 负责玩法、输入、移动端
和视觉几何，`harness/systems.mjs` 负责记录迁移与长跑合同。

## 倒计时播报合同

- 浏览器禁止无手势自动播放，因此真正的冷打开仍静音；READY 上第一次键盘或指针
  手势必须启动完整 BGM。之后 GO、比赛、勋章和重回 READY 只改变混音，不重启媒体
  时间轴。整局始终只有一个 BGM media source，不按场景叠歌。
- `3/2/1` 只使用三格递减起步灯、数字和短促 tick：`3灯 -> 2灯 -> 1灯 -> GO全灭`，
  不播数字人声。
- `GO` 正常路径只播放一个本地人声；男声用于奇数 fresh run，女声用于偶数 fresh
  run。两段人声绝不同时连接。人声走独立 announcement bus，BGM 与载具声先 duck，
  合成冲击按实际 clip 时长延后约 `0.28-0.46s`，不能再用固定延迟盖住尾音。
- 男/女与 Ogg/MP3 四份小文件在页面加载时独立预取；首个手势创建或恢复
  AudioContext 后，优先解码本局选中的 voice，再后台准备另一位。一个性别或格式
  失败不能阻塞另一个；瞬时 fetch/decode 失败允许下次 fresh GO 重试。
- GO 只在 `buffer ready && context running && 未静音` 时宣称已播人声。否则必须在
  同一 GO 帧播放一次电子 hit 并记录 `not_ready / decode_failed /
  context_suspended / muted`；资源后来就绪也绝不迟播人声。
- medal、Final 和 interruption 的 resume countdown 属于同一 run，保持当前播报者，
  不额外翻转男女。手机 harness 必须从真实 `.driver-select-go` 点击开始、不预等
  voice ready，覆盖 MP3、未使用性别延迟、全部 voice 慢于倒计时、exactly-one
  fallback 和 no-late-speech；只数 synthetic 事件不算冷启动证据。

音频拓扑是一个循环 BGM media source 加 ambience / vehicle / event / announcement
四类 Web Audio 总线，最后统一经过 master high-pass 和 limiter。它不是多首 BGM 互相
抢占。当前 owner master 测得约 `-15.9 LUFS / -6.6 dBTP`，已有事件叠加余量；没有
可听见的持续噪声证据时不要做破坏高频和瞬态的全曲降噪，先从总线 duck 与 EQ 解决。

本轮音频、失败文案、输入 presentation 和选角立绘调整不改变 records 结构，不升
schema，也不触发存档迁移。

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
