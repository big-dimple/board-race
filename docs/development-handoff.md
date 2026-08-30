# Board Race 开发交接

状态：主分支当前工作包是“单人 / 双打”的本地竞速体验。旧的固定分屏工位实验保留在
`archive/team-expedition-it-takes-two`，不属于主分支玩法目录。

## 当前工作包

- **远端白色三角指示箭头彻底清除（Complete Removal of Far-Horizon White Chevrons）**：`Course`（`src/game/course.ts`）全面隐藏并清理了原先在水面远方离散生成的 `surfaceGuideArrows` / `surfaceGuideArrowInk` 实例，彻底拔除了困扰已久的在 30~150m 远景开阔海面上显现的浮动白色孤立三角箭头 Bug，赛道引导完全依托平滑贴浪的动态波浪主线，视野极致纯净。
- **起飞前 3D 机械跃升跳台与立体光翼跃升门（Solid 3D Cyber Launch Jump Pad & Swept Wings）**：`Course`（`src/game/course.ts`）重构 `makeCyberFlightWingGeometry` 与 `buildLaunchGateVisual`。将起飞跳台从平淡的 2D 三角形升级为具备机械厚度与倒角切削的 3D 实心跃空展翼结构（Extruded 3D Aero Wings），并配备两侧双立柱高能光子导引柱（Energy Pylons），沿起飞抛物线 1.4m $\rightarrow$ 4m $\rightarrow$ 6.3m 拔地而起，直观呈现如商业大作般的 3D 冲天发射台心智。
- **3D 黄金金币前置远距磁吸与精准吸收（Long-Range Magnetic Coin Arc & Head Absorption）**：`HonorTargetSystem`（`src/game/honors.ts`）升级磁吸感应区至 18m 远距动态捕捉，并在船只逼近时以 0.32s 优雅贝塞尔抛物线从水面腾空飞跃进驾驶员座舱头顶，金币尺寸放大至 1.05m 直径并配备双层璀璨光晕，判定与动画完全精准解耦，带来强烈的飞跃吸入成就感！
- **清脆晶莹的硬币收集双音音效（Crystal Dual-Tone Coin Chime）**：`AudioSystem`（`src/audio/audio.ts`）全面升级 `coinCollect(streak)`。彻底剔除了原先导致“过头闷响”的 220Hz 低频重音，采用纯净高频双音晶莹铃音（E6 1318.5Hz $\rightarrow$ E7 2637Hz），伴随极短金属清脆敲击瞬态与高频星光余音，连击时按和弦阶梯升调，行云流水如风铃般悦耳！
- **7 条天际雾桥航道永久存在（Persistent Skyways & Cloud Mist Bridges）**：`Course`（`src/game/course.ts`）重构航道渲染可见性，废弃以往单航线排他隐藏策略。群岛上空的 7 道空中雾桥与穿云光门永久驻留于世界之中，未激活航线呈现通透纯净的“天际云轨”环境质感，当前航线则注入耀眼金色能量流。飞跃光门后回头看，浮空天轨依然巍峨伫立，空间纵深与世界观宏大感倍增。
- **AI 飞行 100% 全量合规化（AI 100% Skybound Compliance）**：`AI`（`src/game/ai.ts`）强化起飞意愿与蓄能时机判定，确保所有 AI 艇在起飞跳台 100% 点火升空与玩家在云端咬尾竞技，彻底杜绝以往偶尔在水面空门下方“滑水作弊”导致的露馅出戏感。
- **通关画面按钮极致精简与隐蔽下一轮（Finale Overlay Streamlining & Discreet Fast-Forward）**：`FinaleOverlay`（`src/hud/finaleOverlay.ts` / `src/hud/finaleOverlay.css`）彻底剔除了冗余鸡肋的“截图生成中 / 预览截图”按钮；将老手专用“直接下一轮 ➔”重构成右上角半透明低调实用工具按钮（确保 $\ge 44\text{px}$ 且不抢夺视觉焦点）；主视觉只保留双核大按钮：左侧金色大卡“神秘资料片”（进入 7 大彩蛋画廊）、右侧半透明倒计时大按钮“继续游戏 / 查看高光（5s）”。在横屏手机（844x390）与桌面端呈现端庄大气、对称均衡的清爽视觉。
- **日常漂移中央视线遮挡彻底清理（Clean Drift Horizon）**：`Hud`（`src/hud/hud.ts`）彻底移除了日常水面漂移越过黄线松手时在屏幕正中央触发的 `showTransientNotice`（硬编码 `DUO PLAY` 且阻挡前方赛道航线）；保留船尾爆发脉冲、清脆入库音效、艇边发光菱形与左上角电池计数 `x1`，彻底还给玩家 100% 纯净开阔的前方弯道视野。
- **起飞窗口全程常驻指引与无电教学预警（Persistent Launch Prompt & No-Battery Warning）**：`Hud`（`src/hud/hud.ts`）彻底根治了以往起飞提示在逼近跳台前 2 秒被定时器提前熄灭导致玩家在临界点“误以为直接开过去”的元凶 Bug。只要处于起飞逼近区，`🚀 按 SPACE 起飞`（手柄 `按 A 起飞` / 手机 `点「飞」起飞`）全程坚挺常驻直到穿门；若玩家 0 电池逼近跳台，HUD 立即呈现黄色预警 `⚠️ 飞行电池不足 · 过弯按住漂移 · 越过黄线松手存入电池 ◇`，形成清晰明确的动作-收益闭环。
- **水面漂移转向动力学大幅强化（Apex Cutting & Steering Authority Boost）**：`Boat`（`src/game/boat.ts`）重构了水面漂移时的向心 G 值与角速度动力学。彻底解决了以往水面漂移转不过弯、必须依赖空刹的体验割裂问题。开启水面漂移时，侧向向心 G 权威 `latGMax` 从 11 提升至 `19.5`，最大角速度 `yawRateMax` 提升至 `2.85 rad/s`，漂移阻尼系数 `driftYawDampMul` 恢复至敏捷的 `1.0`。玩家过急弯按住漂移时，船身能够迅速内切咬住弯心（Apex），松手爆发喷射加速，漂移真正成为丝滑爽快的过弯武器。
- **任天堂式《3 步极速上手指南》前置极简卡（Nintendo-Style 3-Step Kickstart Guide Modal）**：新建 `KickstartGuide`（`src/hud/kickstartGuide.ts` / `src/hud/kickstartGuide.css`），在新手首次进入游戏点击“GO · 签约出发”时弹出高对比、无废话的 3 步极速心智卡（1. 全自动前进无需油门；2. 过弯长按漂移过黄线松手存入电池；3. 冲进光门按键点火飞天）。支持一键“懂了 · 签约出发”秒进，首局后自动静默；选人界面 `?` 按钮也可随时重新调出。
- **双人模式手柄/键盘操作模式改回自动前进**：`LocalMultiplayerInput`（`src/core/localMultiplayerInput.ts`）与 `src/main.ts` 去除双人模式下的手柄 Y 轴/十字键上下手动加减速与倒车，全面回归与单人模式一致的 `throttle = 1` 自动前进基线；左摇杆 X 轴与十字键左右负责转向，漂移与起飞按键机制保持不变。HUD 双人操作提示文案与 `harness/team.mjs` 测试断言同步更新。
- **双人模式画面模糊与画质护栏修复**：`Stage`（`src/core/stage.ts`）在桌面端开启 `desktopClarity` 时，首帧直接以最高清晰度预算初始化；双人分屏模式下将桌面分辨率下限提升至 `1.0`（不再因分屏负载与瞬时卡顿降采样至 0.5 导致分屏单侧仅 480px 模糊），并将分屏每帧计算告知 `updatePerf(frameMs, 2)`，避免将正常的双相机渲染误判为 GPU 崩溃。
- **淘汰玩家互动骚扰效果升级**：`DuoInteractionController`（`src/game/duoInteraction.ts`）升级【狂暴追魂鸭】3D 模型与截击逻辑，在幸存者目标船尾动态生成并高速逼近，带怒气冠羽、金色流光尾迹与警示光环，幸存者屏幕触发 🚨 队友背刺预警，命中后带来真实波浪侧推冲击、镜头震动与手柄马达震感。
- **隐藏向右小箭头 Bug 修复**：修复了 `driverSelect.css` 中 `<details>/<summary>` 未清除浏览器原生三角指示器产生的白色右箭头，以及 `teamExperience.css` 模式选择卡片未对齐 `.team-mode-duo` 类名的问题。

- 双打艇边仪表已按席位各建一套（"每席一套表现层"第 5 步）：`.hud-driver-power` 由单节点改成两个
  `data-seat` 节点，`updateSeatDriverPower()` 用 `setDuoSeatCameras(teamLeftCamera, teamRightCamera)`
  给的席相机投影，并把 NDC 映射和左右钳制都收进本席那半屏（`viewLeft` / `viewWidth`）。原来双打是
  CSS 直接 `visibility: hidden` 把整块藏掉，右席看不到自己的漂移蓄力槽和飞行菱形；即使放出来，
  投影用的也是全屏主相机，位置必然错。回归用例 `duoDriverPowerCase` 已进 `verify:team`：断言两个
  仪表都在、各自可见、各自落在自己半屏、各自显示本席的电池数（左 1 右 3）。反向验证：把隐藏规则
  加回来报 `visibility: hidden`。单人不变（第二套 `hidden`，`.hud-driver-stock` 计数改按可见仪表统计）。
- 双打提示卡已真正按席位发牌（"每席一套表现层"第 4 步）：飞行边沿（起跳 / 续航 / 过门 / 航线通过）
  从"只跟镜头焦点（主玩家）"改成双打跑两遍（`hud.updateSeatFlightNotices(race, boat, lane, seat)`），
  飞过几飞 / 七飞认证 / 三飞资格按挣到的席位路由；双打互动提示（支援 / 追踪鸭 / 浪花命中）改投
  **被影响的目标席**，只有"互动被拒绝"回到按键那一席。根因是 `showTransientNotice` 没有 `lane` 参数，
  `slotForLane(undefined)` 恒取左槽 → 右屏永远没字，浪花打右席也把警告画到左屏，于是观感变成
  "只有左席一直被骚扰"。回归用例 `duoNoticeCase` 已进 `verify:team`：撤回修复时右席过门
  `afterRightGate: []`、互动提示落到 `slot a`。

- 成功结算改成不打断的自动流程（用户拍板，只见于单人；双打沿用同一套定时合同）：七飞认证可读后
  启动 5 秒倒计时自己进高光，荣誉墙结算后再 5 秒倒计时自己回同一场比赛，两个倒计时都把剩余秒数
  写在按钮上。"神秘资料片"和"预览截图"冻结并**重置**认证页倒计时（主动阅读不能偷走窗口）。
  认证页的"查看高光 / 继续游戏"从大金块改成右下角低调工具条（44 px 高、无填充），并新增
  "直接下一轮"——老手一键跳过资料片与高光。荣誉墙按进入方式分岔：倒计时推上台时只留
  "游戏尚未结束"（`HonorReviewPayload.autoEntered`），`再来一局` / `玩法目录` 必须隐藏；
  玩家自己点进来的和失败结算仍保留两个出口。回归用例 `finaleAutoFlowCase` 已进 `verify:smoke`，
  覆盖"什么都不点 -> 只留下一轮按钮 -> 回到同一场比赛"、"直接下一轮"和"手动确认仍保留两个出口"，
  外加桌面 / `844x390` 的工具条三键不重叠、不出屏、不低于 44 px。反向验证：把倒计时改成
  999 秒报"认证页没自己走进高光"；把 `autoOnly` 钉成 `false` 报"自动进入的高光墙还在卖再来一局"。
- 用户实测两轮冲线后名次稳定第一，先前反馈的"冲线后掉到 6/6"本轮不复现，未改动排名代码。
  **注意**：继续比赛后排名回到纯进度排名，若某局玩家是靠 `finalContender` 闩锁拿到的冲线第一，
  物理里程仍落后时 HUD 会显示真实里程名次——若再复现，正解是把"已冲线"也做成闩锁
  （已过线者优先于未过线者），而不是冻结进度。
- 双打先按键入座，再各自选角；左、右设备和屏幕席位在整局保持固定。两名玩家与四名 AI 共用
  `Race`、`Boat`、`Course` 和六艇排名，左右 50/50 画面各自追拍自己的活跃玩家。
- 双打每席读取独立 `BoatInput`。手柄左摇杆 X 轴转向、Y 轴前进 / 制动倒车，中立回到自动前进；
  RT/LT 不承担油门。键盘左席使用 `W/A/S/D`，右席使用方向键。手柄入座支持左上 / 左下为左、
  右上 / 右下为右。
- 一席飞行失败只淘汰该席，幸存者继续比赛并接管全局路线、Final、镜头和危险反馈；淘汰设备保留
  带冷却 / 库存的支援与追踪鸭互动。淘汰侧的分屏窗口跟随幸存者，确保路线和互动物件仍可见。
- 飞行路线的物理检测只有一套，双打仅复制右席的视觉状态到独立 Three.js layer；碰撞、进度、
  recovery 和 Final 仍由同一条 world transform 判定。每个分屏相机只启用当前窗口所属的路线层。
- 水面荣誉目标只生成六枚实体浮标式金币，带浮筒、泡沫、桅杆和实心徽记；金币避开起终点缓冲区，
  命中只记录 `center` / `edge` 荣誉，不回收飞行格、不触发 BOOST、不改变主线。旧的两只鸭子荣誉道具已删除
  （开场 u≈0.045 那只一撞边上就弹 `鸭鸭爆点 +120`，与 checkpoint 浮漂弹飞的真实鸭子气球重复）；
  `target.duck` 降为历史迁移 id，`HonorTargetKind` 只剩 `coin`。金币的锯齿边、双层轮缘、
  罗盘压印和固定池环形碎片反馈是当前视觉工作包；拾取荣誉卡固定在顶部安全带，移动端避开四个触控热区，
  双打按席位分栏。旧海铃、星标、王冠、彗星及 `target.ring` / `target.center` 只作为历史迁移 id 保留。
- 七飞后的名次回归已修：清掉第八门（第二轮第一个空道）不再把领跑者打成第六。根因是 `Race` 把
  `hasFinalQualification()` 这一个瞬时判定同时用在“能否穿过 Final portal”和“名次保护”上——
  `flightsCleared` 一变成 8，`% routeCount === 0` 翻假，名次保护消失；同时 Final 激活期间主玩家的
  `contU` / `progress` 被钉在激活那一刻，于是被全队的多跑圈数瞬间挤到末位。现在拆成两个判定：
  冲线仍用瞬时集合边界判定，名次保护改用闩锁的 `finalContender`（完成过一整套就不再撤销），
  且激活期间危险计时与门 / 圈记账照旧暂停、距离照旧累计。回归用例 `postSetRankCase` 已进
  `verify:smoke`：撤回修复时它报 `place 1 -> 6`、进度 628 纹丝不动。
- 触觉已按席位路由：`Haptics` 新增可选的 `rumbleSeat` 下发口，双打为右席建一个独立协调器
  （`hapticsRight`，震 `duoDevices[1]`），每帧反馈里的 9 个 cue 全部走本席协调器，不再只震主玩家。
  `Haptics.status()` 新增 `cueRequests`（请求数，与 `cueCount` 已播放数分开，键盘席位也能验路由）。
  `verify:team` 增断言：右席自己的事件必须 `rightCueDelta >= 1` 且 `leftCueDelta === 0`。
  反向验证（路由回主玩家）报 `rightCueDelta: 0, leftCueDelta: 1`。
- 合格席不再被锁死（用户拍板）：清完一整套 `flightRoutes` 后，该艇**保留正常航道、起飞提示与起跳判定，
  想飞就飞、想冲门就冲门**。改动是 ① `hasFinalQualification` 从瞬时集合边界
  （`cleared % routeCount === 0`）改成成就（`cleared >= routeCount`），否则清掉第八门就把刚到手的门关死；
  ② 删掉 `finalQualifiedIdle` 与两席的 `finalApproach`，它们会在合格后抽走航道并挡住所有起飞；
  ③ `no_launch` 惩罚只对未合格船保留，合格船在水面开过起飞区却没电池不再被判失败——
  它保留的是"主动起飞的自由"，不是"被强制塞进航线"。
  `verify:team` 已把原来的"合格席不许再进航线"断言换成两条：合格席**不会**被强塞航线，
  且给一格电池后**能**正常起飞并保留航道。
- 冲线后继续比赛掉名次已修：`Race.track()` 的"Final 激活期"分支把**门 / 圈记账整个跳过**了。终点门就
  在起终点线上，玩家越过它时圈窗口照常推进却没有门数记录 → 该圈作废 → 继续比赛时进度凭空少一整圈。
  现在该分支只挂起危险计时与失败判定，门与圈的记账照常运行。回归用例 `finalContinueRankCase` 已进
  `verify:smoke`：修复前 `place 1 -> 6`、进度 2511 -> 500（对手 2960）；修复后 `place 1 -> 1`、
  进度 2511 -> 3010。反向验证：把跳过记账的分支加回来，用例立刻红。
- 双打提示卡已按席位分槽（"每席一套表现层"第 3 步）：`hud.ts` 的单槽提示卡改成两个 `ImpactSlot`
  （各自 DOM / 计时器 / 队列），双打按 `lane` 路由到本席那一槽，一席的高优先级提示不再顶掉另一席的。
  CSS 让每个槽按半屏宽度渲染（`.hud.duo-split .hud-impact{width:50%}`、`[data-slot='b']{left:50%}`），
  于是卡内所有既定百分比自动落在该席半屏内，不再压分屏中缝，闪光也不会盖住另一席画面。
  回归用例 `duoImpactCase` 已进 `verify:team`：反向验证（共用一个槽）只剩一张卡、右席顶掉左席。
- 双打每帧事件反馈已按席位各跑一遍（"每席一套表现层"第 2 步）：9 个"上一帧状态"标量合并成按席位的
  `seatEdges`，事件边（漂移入库 / 飞行库存 / 续航 / BOOST / 起飞 / 空刹 / 过门 / 航线通过或失败 /
  转向预警）双打跑两遍；镜头冲击与后处理脉冲改走该席的 `teamLeft/RightCameraRig`、
  `teamLeft/RightPipeline`。连续总线（引擎 / 音乐 / 水声）按 llmwiki 合同保持居中，未动。
  回归用例 `duoFeedbackCase` 已进 `verify:team`：反向验证（只跑主玩家）报 `before:7 → after:7`，
  右席一声不响。**遗留**：触觉 `haptics` 仍只跟主玩家设备，按席位震动待办。
- 双打名次塔已按席位拆分（"每席一套表现层"第 1 步）：`RaceTower` 新增 `side`（solo/left/right）与
  `setSeat`；双打实例化两座塔，各钉在自己半屏（CSS `[data-side="right"]` 走右边缘），各自高亮本席、
  各自持有独立 `RadioDirector`。原来 `tower.update()` 拿左席的 `flightPhase` 当 flightFocus，
  左席一进飞行就把两席的名次列表和电台一起掐掉，现在按席位各自判定。`verify:team` 已加断言：
  必须存在两座塔且各自落在自己半屏内。下一步（第 2 步）是每帧事件反馈与音效按席位各跑一遍。
- 双打雾道的不对称已修：`updatePlayerGuidance`（引导席）的 `committedSlot` 补上"空中回退到
  `flightRouteIndex`"的兜底，`finalApproach` 补上 `committedSlot < 0 && !flightActive` 守卫，
  与右席 `updateSecondaryGuidance`（course.ts:2975-2981）已验证的写法对齐。原因是 Final 是**共享**
  单一标志，任一席第 7 飞就置位，原来引导席会在空中整条瞎掉而另一席不会。
  注意：`finalArmed` 置位后，凡是 `flightsCleared >= 7` 的席位都会被切成 Final 接近引导、且不能再起飞
  （`finalQualifiedIdle`，course.ts:2507）——这是**设计行为**，只有冲过 Final 或重开才解除，
  用户反馈的"雾道整段消失"大头来自这里；未合格席不受影响。要不要放开合格席继续飞，待用户拍板。
- 冲线定格的招手欢呼已删除：`Rider.update()` 不再接收 `celebrating`，车手全程双手握把，
  胜利情绪交给镜头与 HUD。连带清掉庆祝弹簧 `celS`、手臂泵动 / 点头分支、`TUNING` 里的庆祝参数段，
  以及 `updateHairAccessory()` 的 `celebration` 形参（`riderMesh.ts`）。并肩挑衅的转头
  （`taunt`）与 Final 火花特效不在本次范围内，保留。
- 失败结算先展示带撞柱 / 偏离米数 / 起飞高度与建议的失败回顾，再进入高光墙；成功结算先展示
  Final 认证，再展示高光墙。高光墙的“游戏尚未结束”是默认焦点，5 秒倒计时自动回到赛道并保留七飞进度；
  “再来一局”才重置整场比赛。桌面与 `844x390` 横屏移动端都必须保持按钮、文字和安全区可读。

## 已验证

- `npm run typecheck`
- `npm run build`
- `npm run verify:smoke`
- `npm run verify:team`（键盘双席、两只标准手柄、斜向摇杆、RT/LT 隔离、独立飞行路线、淘汰接管、
  支援 / 追踪鸭、断连冻结 / 新确认恢复、跨席 Final 仍保留右侧航道、双屏非空）
- `npm run verify:collision`
- `npm run verify:audio`
- 桌面 1440x900 与横屏 844x390 的启动、荣誉目标和高光墙截图已人工复核。

## 遗留风险

- 本轮金币视觉、连击拾取、拾取卡与金属音效已完成并通过桌面 / `844x390` 截图、`verify:smoke`、
  `verify:audio`、`verify:team`、`verify:collision` 回归；连击在 `COIN_STREAK_WINDOW` 秒内累计，
  分值、音阶和相机让位同步升级；金币依然不回收飞行格、不触发 BOOST、不改变主线。
- 自动化只能模拟 Gamepad API；发布前仍需两名玩家使用实体手柄确认不同浏览器的摇杆回中、斜向入座、
  起飞边沿、暂停和震动反馈。
- 荣誉目标目前是程序化美术。替换素材时必须保留目标稳定 id、碰撞半径、`center` / `edge` 精度和
  事件池合同，不得重新引入水面充能环或隐藏资源奖励。鸭子荣誉道具已删除，`HonorTargetKind` 只剩
  `coin`；不得再把第二个鸭子标记放回水面，鸭子的戏剧性只由 checkpoint 浮漂的真实气球承担。
- 开场附近不再有任何 `鸭鸭爆点` 提示来源；`target.duck` 只在历史存档读取时出现，当前布局不再产生。
- 主分支仍保留少量 `teamExpedition` 兼容代码供封存分支读取，不得把它重新接回玩法目录。

## 唯一下一步

**真机验收新的成功结算节奏（单人一次完整七飞冲线）**：
1. 认证页约 3.2 秒后按钮出现，"查看高光 · 5 秒"开始自己倒数；全程不碰任何东西，会自己进高光、
   再自己回到同一场比赛（七飞进度还在），高光墙底部只有"游戏尚未结束"一个按钮。
2. 中途点"神秘资料片"：倒计时停住，返回后从 5 秒重新开始；"预览截图"同理。
3. 点"直接下一轮"：不进高光、不进资料片，直接进下一轮倒计时。
4. 手动点"查看高光"进墙时，"再来一局"和"玩法目录"两个按钮都还在。

验收时顺带确认：右下角三个工具键在手机横屏不挤成两行重叠，"查看高光"低调但不至于看不见。
若第 1 条的 5 秒窗口让人来不及伸手点资料片，把 `FINALE_AUTO_ADVANCE_S` 提到 8 秒即可。
