# Board Race AI 运行手册

状态：`current / schema-v12`

本文只记录接手代码必须知道的稳定结构和行为合同。每个任务都要完整读取本文、根目录
`AGENTS.md` 和 [`development-handoff.md`](development-handoff.md)。当前进度不写在本文；
玩家说明归 `README.md`；美术目标归 [`art-direction.md`](art-direction.md)。代码与用户最新
明确决定高于文档，发现冲突时先按真实实现修正文档。

## 一分钟恢复上下文

- Board Race 是横屏 Three.js 街机赛艇游戏。主分支玩法目录只有“单人”和“双打”两项；
  未来资料片可以继续注册新条目。旧的固定分屏工位实验保留在
  `archive/team-expedition-it-takes-two`，不属于当前主分支入口。
- 单人自动前进，玩家控制转向、水面漂移 / 空中空刹，以及起飞 / 一次空中续航。
  双打复用同一条六艇竞速规则，由两名玩家各驾一艇、四名 AI 共同排名；双打仍允许用同一根
  手柄左摇杆同时给出转向和前进 / 制动方向。
- 核心循环是 `漂移到黄线 -> 松开入库 -> 在白雾入口起飞 -> 穿门 -> 落水回线`。
- 三飞完成基础资格；第七飞通过并完成 recovery 后，进入可双向穿越的 Final Station。
- `BoatInput`、60 Hz fixed-step、唯一 flight branch 和统一 boat transform 是最重要的跨模块合同。
- 双打在选角前固定左右席位：设备、屏幕侧与船 id 在入座后保持不变；每席消费完整且独立的
  `BoatInput`，镜头跟随当前仍存活的玩家。玩家淘汰不会自动结束另一席，淘汰席转入独立互动边沿。
- 本地修改、已推送、Actions 成功和 Pages 已更新是不同状态。常规发布只负责构建、冒烟、
  提交和普通推送，不等待或比对远端 SHA。

## 事实归属

| 事实 | 权威位置 |
| --- | --- |
| 玩家控制与可见玩法 | `README.md` |
| 跨模块类型和状态 | `src/contracts.ts` |
| 船与飞行物理 | `src/game/boat.ts` |
| 路线、门和视觉分支 | `src/game/course.ts` |
| 比赛生命周期、失败、排名与玩家淘汰 | `src/game/race.ts` |
| 双打淘汰后的支援 / 浪花互动 | `src/game/duoInteraction.ts` |
| 荣誉目标、账本与稳定 id | `src/game/honors.ts` |
| 本地设备入座与双席输入 | `src/core/localMultiplayerInput.ts` |
| 玩法目录、双打选角与 HUD | `src/hud/teamExperience.ts`、`src/hud/honorHighlights.ts`、`src/hud/duoViewportHud.ts` |
| 存档、荣誉统计和迁移 | `src/game/records.ts` |
| 当前任务进度 | `docs/development-handoff.md` |
| 稳定美术方向 | `docs/art-direction.md` |

不要再维护一份重复正文的 knowledge map。摘要文档只指向 owner，不复制参数和当前状态。

## 核心玩法合同

### 漂移、库存与飞行

1. 水面达到速度门槛后按住漂移才累积 `boostCharge`；达到黄线后松开才存入飞行格。
2. 库存上限只由 `MAX_FLIGHT_CHARGES` 定义，Boat、HUD、提示、音频和测试共同消费它。
3. 满仓仍结算正常水面 BOOST。起飞消耗一格；每次飞行最多再消耗一格续航一次。
4. 穿门只计分并进入下降，不清位置、水平速度、船头或 yaw。
5. 普通落水同帧把仍按住的空刹交给水面漂移，只从该帧开始蓄力。Final arm 后 Shift
   是不蓄力的回港刹车，这是唯一例外。

### 路线所有权

- 视觉语法是绿色水面主线、升空入口、白雾飞行分支、白雾 recovery、再交回绿色主线。
- 同一时刻最多一个 active flight branch。通过门、下降和首次触水都不自动转交所有权；
  authored recovery 完成后才交回 surface。
- 玩家用保留库存接受下一飞时，新分支可在同一 fixed-step 原子接管；旧分支必须退场，
  但不得移动船或清速度。
- 连续水面运动围绕上一帧接受的 spline 区域投影，不能在折返赛道跳到空间上更近的另一段。
- 飞行端到端验证必须从过门跑到下降、落水和 handoff，不能用 teleport 冒充恢复。

### 失败与 Final

- `gate / gate_left / gate_right` 都向玩家显示“撞柱”；左右偏差只作为次级数字证据。
- `corridor`、`landing`、`no_launch`、`off_course` 和 `wrong_way` 保持各自语义，不能伪造门号。
- 飞行 corridor 不是即死线：越界深度与持续时间合成连续 danger（0..1），同一数值驱动
  雾道撕裂、风推离航道、姿态扰动、失速下沉与警报；danger 到 1 才判负。贴边有回正窗口，
  深度越过硬边界立即判负；判定、物理和表现共用这一条危险曲线。
- 水面越过主线硬边后立即显示 `off_course` 警告，只有持续 15 秒未回线才判负；回线衰减、
  Final Station 解除和 `wrong_way` 的独立警告 / 判负时钟保持原语义。
- 第七飞计分后路线失败永久退休，但该飞 recovery 仍完整播放。`冲线资格` 与 `排名资格` 是两个判定，
  不可混用：
  - **冲线资格是成就**：一艇只要完整清过一整套 `flightRoutes`（`flightsCleared >= routeCount`），
    就拿到穿过 swept Final portal 的资格，之后**随时可冲，也允许继续飞**——不再要求停在
    `flightsCleared % routeCount === 0` 的集合边界上（那样清掉第八门就会把刚到手的门关死）。
    物理门线本身不授予未合格船终局资格。
  - **排名资格是闩锁**：一旦某艇达成了上面那条，`Race` 就把它记为 Final contender，本局不再撤销；
    名次比较用的是这个闩锁，不是瞬时状态。Final 激活后，尚未冲线的 contender 优先于未合格但
    已多跑圈的对手，避免等待 Final 时名次被错误挤掉。
- **合格不等于被锁死**。清完一整套后，该艇保留正常的飞行航道、起飞提示与起跳判定，想飞就飞、
  想冲门就冲门；只是不再被强制塞进航线——它在水面开过起飞区却没电池时，不再吃 `no_launch`
  失败（`Course` 只对未合格船保留这条惩罚）。
- Final 激活期间主玩家只暂停危险计时与失败判定，**门与圈的记账照常运行**。跳过记账会让圈窗口
  在没有门数记录的情况下关闭、整圈作废，玩家冲线第一却在继续比赛后凭空少一整圈掉到末位；
  距离也照常随船累计，名次保护交给上面的 contender 闩锁，不靠冻结进度。合格选手仍使用
  亚帧 crossing time 排名，已完赛车手继续保留实体和碰撞。
- Final 回港刹车不能触发漂移、BOOST、飞行库存变化、倒车或额外反馈。

### 双打

- 双打运行同一个 `Race`、`Boat`、`Course` 和 AI 管线：六名实体竞速者中前两名是玩家、后四名是 AI。
  不另造一套“合作进度”或虚假的分屏排名；所有进度、碰撞、飞行和 Final 结算仍来自同一条 world transform。
- 选角前先入座。`keyboard-left` / `keyboard-right` 与 `gamepad:index` 是独立设备；一旦声明左 / 右，
  `PlayerSeat` 的 `side`、`deviceId`、`racerId` 和 `driverId` 在本局保持不变。
- 每席完整读取 `BoatInput`。双打水面默认自动前进；方向向量中的 X 轴转向、Y 轴前进 / 制动倒车，
  中立向量回到前进基线。空中仍使用同一席的漂移键空刹和独立起飞 edge。
- 任一席达到三飞资格时，双打只记录该席资格并继续同一场竞速，不启动单人使用的全局 medal freeze；
  单人资格仪式保持原有行为，避免一名玩家的进度暂停另一名玩家。
- 若一名玩家飞行失败，`Race.eliminatePlayer()` 只标记该席并把 guidance、镜头和 Final 责任提升给幸存者。
  两名玩家都淘汰才进入 `defeated`。淘汰席的分屏镜头改为追拍幸存者，因此仍能看见自己的道具和对方的反制；
  同时通过 `DuoInteractionController` 获得三格、带冷却的支援 / 浪花边沿；
  支援只在幸存者处于水面安全窗口且未满仓时补一格飞行库存，绝不注入前进速度；浪花先发射可见的追踪鸭，
  幸存者有预警和躲避时间，命中只在安全水面施加有上限的侧向冲量，不反向、不锁输入、不影响飞行门。
- 左右席各有一套完整的表现层：左右 50/50 画面各自追拍本席，每侧各有自己的名次塔（含六人排名与本席
  高亮）、自己的电台槽、自己的提示卡（渲染在自己的半屏内），以及自己那条独立的飞行航道。共享的只有
  同一场比赛：赛道、四个 AI、六人排名与 Final 这一个开关。表现层不许再靠"主玩家是谁"的单槽分发。
  本席的航道在任何时候都归本席：即使另一席已经激活 Final，本席正在飞的分支和 recovery 也必须完整保留。
  手柄断连会冻结双打 fixed-step，重连后必须由已入座设备产生新的确认边沿才恢复。
- 每帧的事件反馈（过门、入库、续航、空刹、落水、撞浮漂、转向预警等）按席位各跑一遍，音效与镜头冲击
  各归本席；连续总线（引擎、音乐、水声）按合同保持居中。触觉目前仍只跟主玩家设备。
- 互动、目标命中、超车、飞行通过、逆风回航和清洁航线都写入 `HonorLedger`。赛后
  `HonorHighlights` 先播放一项 `PLAY OF THE RUN`，再展示最多四张荣誉卡、六人名次与总分；
  `RaceResultEnvelope` 使用 `board-race-race-result/v1`，可直接作为未来联网结算 DTO。
- 旧 `TeamExpedition` 工位流程只作为兼容代码留在封存分支 `archive/team-expedition-it-takes-two`，
  主分支入口、排名和记录不再依赖它。

## 输入、浏览器与生命周期

```text
玩法目录 -> 单人 -> READY -> opening -> countdown -> racing
       -> medal freeze -> resume countdown -> same run
       -> defeated -> focused failure review -> high-light review -> retry / READY
       -> Final Station -> frozen finale -> explicit honor review -> next-round countdown / retry / 玩法目录

玩法目录 -> 双打 -> 按键入座 -> 双席选角 -> opening -> countdown -> racing
       -> one-seat eliminated -> surviving-seat guidance + interaction edges
       -> both eliminated -> focused failure review -> high-light review -> same lineup retry / 玩法目录
```

- 键盘、手柄和移动输入最终合并为一个 `BoatInput`。一次性动作只接受首个 keydown；
  steering/drift 等持续动作允许 repeat 恢复 held state。
- 双打不合并设备。`keyboard-left`、`keyboard-right` 和每个 `gamepad:index` 都是独立设备；
  入座时按左 / 右声明席位。左区使用 `W/S + A/D + Left Shift + Space`，淘汰后 `Q/E`；右区使用
  `ArrowUp/Down/Left/Right + RightShift + NumpadEnter`，淘汰后 `U/O`。手柄左摇杆 X 轴负责转向、
  Y 轴负责前进 / 制动倒车，斜向同时生效；十字键上下作为数字输入备用，不读取 RT/LT。A、B、Y、Start
  分别承担确认 / 起飞、返回 / 支援、浪花互动和暂停。菜单边沿与物理 hold 分开，repeat 不造飞行 edge。
- 双打采用左右 50/50 独立追拍：左屏只跟左席、右屏只跟右席；每侧保留自己的船、路线和状态读数。
  一席淘汰后该侧保留 OUT / 互动提示，幸存者仍在另一侧继续比赛。手机保留单人触控方案，
  不强迫小屏同时管理两套方向键。暂停、页面隐藏或已占座设备断开时，fixed-step 和计时一起冻结，
  恢复时清边沿；结算层保留结果，确认重开同一席位配置，返回才退出到玩法目录。
- 页面隐藏、旋转阻断和系统 UI 冻结模拟。恢复时清边沿，但不能让物理仍按住的 Shift 永久失效。
- 手机默认触控转向；体感模式只有玩家主动选择后才请求权限。体感刻度明确标出“左 / 回中 / 右”，
  只反映倾斜转向状态，不是额外方向盘或物理道具；右手漂移和飞行触区不可移动。
- READY 选角页的雷达标题为“选手能力对比”，副说明明确它只影响本局手感，不承担输入。
- Safari 缩放抑制只在横屏活跃游戏控制层生效，不加 viewport 锁、全局 touchmove 取消或缩放重置。
- Fullscreen 只由真实 GO 或后续真实控制手势请求。iPhone 不支持时保持浏览器托管形态，
  不伪造全屏。截图预览、结算和 dossier 必须隐藏并释放移动控制。
- READY 的桌面与移动选角是两套布局；桌面相机冻结，移动端竖屏由旋转提示完全接管。

## 教学、存档和反馈

- 首局 PC 提示只观察成功状态：按住 Shift、达到黄线、松开入库、到入口后 Space。
  移动端不显示这条 PC console。第一次真实失败可邀请完整聚光教学。
- 教学不能注入输入、改物理、降低难度、增加第二条路线或用提示覆盖危险信息。
- 当前存档 key 为 `board-race:challenge:v9`。迁移和导入必须清洗坏数据，localStorage
  写入失败不能阻塞当前比赛。
- 倒计时为 `3 -> 2 -> 1 -> GO`，GO 使用一次非语音合成信号。未审核的持续水声和空气
  白噪声保持关闭；碰撞、落水和触觉按真实事件、设备所有权与优先级处理。
- 双打淘汰、支援和浪花短事件按所属设备提供轻量反馈；音乐、发动机和其他连续总线保持居中。
- 强敌只能通过真实 `AIController -> BoatInput -> Boat.update` 追赶、漂移和 BOOST；禁止
  传送、假进度、碰撞免疫、玩家减速或脱离状态的循环特效。
- 正规水面路线上的 8 对 checkpoint 门浮标是基础实体障碍：水面船体接触会损失 20% 速度，
  把浮标撞飞并弹出旋转后爆开的鸭子气球；浮标落水后延迟归位，不判负、不触发碰撞电台/镜头冲击；飞行相位与
  足够高度的浪跳不触发。菱形升空入口和飞行分支 chevron 只作导航，不生成锥体、浮标或碰撞体。
- 另外六个大型荣誉目标（六枚金币）由 `HonorTargetSystem` 负责
  视觉和 fixed-step 接触采样；每个目标都是水面实体浮标，根节点贴着实时浪高，由浮筒、泡沫圈、
  信号桅杆和实心徽记组成。金币使用锯齿外轮廓、双层轮缘、双面罗盘压印和局部铸造高光，
  绝不伪装成升空菱形或隐藏资源站；只放在离开起终点缓冲区的中段水面扇区。它们不直接改写 Boat 的世界变换、
  飞行库存或路线真相。命中半径内再区分 `center` / `edge`，两种精度都只写入对应稳定荣誉 id；
  每个目标对每名赛车手只记一次，事件进入预分配的金币爆发池。人类命中再触发一次金币音效
  （非谐分音 struck-metal，带通扫频噪声瞬态）和短正向 FOV pop；AI 命中只播世界特效，不抢玩家音频焦点。
  玩家在 `COIN_STREAK_WINDOW` 秒内连续拾取金币会进入 `target.coin` 的连击阶梯，基础分值
  `+` 连击步长 × `COIN_STREAK_BONUS`，上限 `COIN_STREAK_MAX` 步；音效分音按大三度/步升调，
  HUD 拾取卡 `COIN COMBO ×N` 切换，相机让位随连击步长增强。连击不影响飞行库存、BOOST 或路线。
  HUD 只显示专属金色拾取卡：桌面位于顶部安全带，移动端进一步上移并避开四个触控热区，
  双打按左 / 右席位分栏；拾取反馈不改变速度、飞行库存或路线。鸭子荣誉道具已删除——checkpoint
  浮漂已经会弹出真实鸭子气球，第二个鸭子标记只会让 `鸭鸭爆点` 提示来源含混；`target.duck` 降为历史 id。
  历史 ledger 仍保留
  `target.duck` / `target.ring` / `target.center` / `target.bell` / `target.star` / `target.crown` / `target.comet`
  旧 id 供迁移读取，但当前布局只产生 `target.coin`。

## HUD 与电台

- READY 选角标题固定为 `别懵逼，选最强`。模式目录只显示 `单人` 和 `双打`；双打先显示
  左右入座，再显示两张大幅选手卡。开场身份牌显示中文玩梗名；两位女选手还显示
  `女将` 标签，3D 追拍分别以青色发梢 bob 和高马尾维持与立绘一致的远景辨识。
- Race radio 是一个 `RadioDirector` 单槽，危险和动作指导优先。高优先级出现时阅读时钟暂停，
  active notice 的 DOM、revision、`.on` 和 CSS 动画位置保持不变，仅隐藏并暂停；解除阻断后
  继续同一次呈现和剩余阅读时间，不能重跑入场或叠多个 timer。
- 只有尚未掌握 `drivingCoach.progress.mastery.airBrakedInTurn` 的玩家会收到 Gemini 空刹技巧，
  且一次页面会话中最多真正显示一次；retry 或新回合不重播，掌握后 fresh GO 不再入队。
  移动广播使用头像与右侧等宽平衡轨，让 copy / body 几何中心对齐整张卡片；正文允许自然换行、
  不溢出，并避开中央航线和全部触控热区。
- 艇边飞行库存和计时轨不能盖住车手。桌面根据车手投影选择相反一侧；横屏手机使用固定
  的右上安全通道，并避开右下控制。
- 空中续航反馈不显示全屏闪白或速度线。桌面在船体上方的主视线中居中；横屏手机使用独立
  规则适度上移但仍留在主视线内，并避开船体、车手、门、紧急飞行航线和触控区，不能复用
  艇边库存的右上安全通道。
- 起飞 / 续航动作窗口复用同一张一次性提示卡，不新增教程层：桌面提示明确本飞最多使用两格，
  即起飞一格、续航一格；横屏手机使用右侧紧凑卡与短规则文案，完整规则仍在“续”按钮的无障碍
  说明。提示卡按 `drivingCoach.mastery` 静默——`launched` / `extendedFlight` 掌握后对应提示
  不再出现。空中续航用完后再次按起飞键会弹出同卡片的 spent 形态，明示“每飞限续 1 次”，
  不能让玩家读成按键失灵。
- 比赛短通知按 `data-kind` 分别避让中央动作区：起飞、过门、路线完成和优秀锁定留在船体、车手、
  门与紧急航线上方，`flight-pass` 保持桌面右上且紧凑移动端隐藏；禁止用全局偏移统一搬动。
- 语义冲击的两侧受光条带由 HUD CSS 所有；横屏粗指针端只使用更细条带，桌面宽度及颜色、数量、
  覆盖、透明度、动画和触发节奏保持不变。后处理 polar wind streak 与 air-brake bands 是独立效果。
- 同一时刻只允许一个教育提示；碰撞、路线危险、勋章和 Final 表现拥有更高优先级。
- 赛后结果是严格串行的冻结层：失败先由 HUD 失败回顾显示具体原因、米数 / 高度证据和下一次建议，
  确认“看高光”后才挂载 `HonorHighlights`；成功结果先由 `FinaleOverlay` 播放七飞认证，玩家确认
  “查看高光”后才挂载 `HonorHighlights`。两层不会同时可见，荣誉计时也不会
  在终点演出期间偷跑。两个结果阶段都隐藏比赛 HUD、名次塔、混音与移动控制；荣誉墙使用不透底舞台，
  不让比赛画面与赛后信息混层。荣誉墙再播放一项 `PLAY OF THE RUN` 聚光，切入最多四张可选荣誉卡、
  六人名次条、本局总分与累计 `honorScore`。成功结果默认聚焦“游戏尚未结束”，结算后启动 5 秒可见倒计时并
  自动调用继续回调，玩家也可立即确认；继续动作调用 `Race.startFinalContinueCountdown()` 保留已完成飞行进度，再清理本轮荣誉账本和目标库存；“再来一局”
  才走完整 `resetRace()`，退出回到玩法目录。最终冲线在 `HonorLedger` 写入稳定 id `finale.captain`，
  并由 `RecordsStore.recordHonors()` 同步到历史 `honors` 与 `honorScore`。

## 渲染与美术合同

- 单人由主 `PostPipeline` 出屏；双打由左右各自的 `PostPipeline` 渲染后，再经
  `SplitScreenRenderer` 合成 50/50 画面。每侧的深度纹理、分辨率、天空与海面相机值都必须先切到该侧相机。
  旧 `TeamExpedition` 仍只在封存分支维护，不得重新接回主分支入口。
- 海面深度纹理、分辨率、天空与海面相机跟随值必须在渲染每一侧前切到该侧相机，不能让
  右侧预通道覆盖左侧已经使用的泡沫 / 深度真相。

- `waves.ts` 是海面唯一真相：CPU 浮力与 GPU 使用同一组八向二阶高度波（128 m 涌浪 +
  48/27/15 m 能带各拆 ±15-20° 双分量形成短峰海 + 8.5 m 船身尺度碎浪），水面保持
  `y = f(worldXZ, time)`，不再存在只由 GPU 横向位移而 CPU 无法采样的近似。近场使用完整
  波谱，短波在进入稀疏地平线网格前连续退场，远场只保留主涌浪，质量档不得改物理结果。
  相位实现是游戏手感的一部分：改动谱或相位后必须验证起步窗口（GO 后 ~5 s）不出现
  重碰撞（strength>10 会抢开场广播）。
- `ocean.ts` 仍是一张 opaque/depth-writing 海面 draw。颜色、蓝色天空反射和白帽由共享高度、
  坡度、垂直速度与曲率驱动；禁止让长涌浪法线生成缓慢移动的宽白太阳斑。浪面体积感来自太阳
  方位有向坡度（`sunSlope`）的明暗对比、背阳自遮蔽和掠射天空反射，不用坡度幅值打光（两面
  同亮会抹平波形）。朝日暖光路和雾色转暖只随视线方位锚定，永不随涌浪法线调制。阳光水闪由
  多层旋转 hash cell 碎片构成，在 `SUN_DIR` 的 Blinn 微表面包络下随机短促闪烁，并收进朝日
  光路带内（全屏散布会把海面读成平地）；它只属材质表现，不改变波形或浮力。cell 距离场不
  连续，抗锯齿必须用解析像素足迹，禁止对其使用 `fwidth`（会在格界
  画出虚线格框）。禁止用绿色、加亮、连续白轨或脱离物理波峰的 shader 噪声伪装"更汹涌"。
- `VISIBLE_SUN_DIR` 是天空日盘和朝日镜头的低位可见光源；船、赛道和海面材质继续使用 `SUN_DIR`。
  太阳的可见呈现归 `sky.ts` 天空穹顶：暖色硬核、柔冠和局部眩光，以及仅向下到地平线收束、可被
  云层遮断的短丁达尔束；不改变共享光照方向，也不在海面之外另造光源或全屏放射线。
- 每艘船的尾流保持单 Mesh / 单 draw、预分配带状几何和原位 typed-array 更新。中央含气洗流承担
  主读形；左右 Kelvin 肩浪只用错相的短程断续节拍补充，不能叠亮中央或读成连续双轨。
  落水水花必须来自真实接触事件并在退场后归零。
- 船体、车手、路线和特效不能制造第二套 world transform。当前六材质批船体（shell、safety、mechanical、flight、reactor、decals）、16 骨骼
  SkinnedMesh 车手、共享材质、实例化和 typed-array 池是已知性能基线，不是禁止重构的美术规格。
- 左右主动尾翼是船体子节点上的纯表现层，不改变 `BoatInput`、操控或碰撞。它必须读取当前固定步的
  实际转向值，漂移和飞行空刹分别提供夸张但不穿模的共模抬升与左右差动，松手由欠阻尼二阶弹簧回摆；
  `teleport()` / 重开必须同时清零翼面角度、速度和目标。动态验收必须走真实漂移、飞行空刹与转向
  输入，静态尾部截图不能代替动作证据。
- `LighthouseLandmark` 是固定在 `(110, 0, 190)` 的纯视觉海上地标：34 m 象牙白塔身、低饱和海蓝分段、
  深蓝灯室与日光下熄灭的冷灰灯具。当前世界只有明亮日间，因此不生成体积光或水面扫光。它不注册路线、
  AI 或碰撞所有权；低矮岩礁只承担轮廓落点，不能扩成岛屿或港口。
- 固体描边预渲染通过 `markInk(root)` 管理：递归遍历遇 `userData.noInk === true` 节点对该子树统一 `disable(LAYER_INK)` 并剪枝返回；
  排除墨水预渲染的对象（如发光反应堆批次、Face Patch、贴纸等）需前置声明 `userData.noInk = true`、`userData.noOutline = true` 并确保 `layers.set(0)`。
- 车手发型是独立的、按选手风格替换的骨骼蒙皮附件；切换 bob / ponytail 时必须替换
  对应骨架和轮廓，不能被初始短发网格或圆帽式头部覆盖。
- Sobel 内部描边是近场设备:按视深淡出(远处剪影归反壳描边),法线阈值只放行硬折边,
  平滑小圆柱(四肢、细件)不得整体吃墨——远景小物体被内部描边整涂曾把车手压成黑团。
- 同 transform 且同生命周期的静态件优先按材质合并；重复几何优先实例化。独立动画、蒙皮、
  透明排序、剔除和显隐所有权确有需要时保持独立。
- 固定步进中避免无界分配。短命效果复用池，退场后活跃实例归零；不得删除真实动作信息换预算。
- 视觉质量由桌面与 `844x390` 截图和人工评审决定。draw call、活跃实例、像素和帧时只证明
  资源/性能，不证明“好看”；也不使用 shader 字符串或固定像素差作为审美门禁。

## 验证与发布

常规改动：

```bash
npm run build
npm run verify:smoke
npm run verify:team
```

`verify:smoke` 检查单人桌面和横屏手机能启动、画面非空，以及 Gemini、艇边库存、续航提示和
撞柱文案的关键布局。截图使用 `npm run shot -- <scenario...>`；可加 `--mobile` 和
`--out <directory>`。

`verify:team` 现在覆盖主分支单人 / 双打目录：左右入座、角色互斥、六艇（两名玩家加四名 AI）、
键盘和双标准手柄、左摇杆斜向同时转弯 / 推进、RT/LT 不参与移动、淘汰后的幸存者接管、支援 / 浪花互动、
荣誉墙和非空渲染。实体双手柄仍需实机复核；旧工位流程只在封存分支验证。

碰撞与音频改动分别按需运行：

```bash
npm run verify:collision
npm run verify:audio
```

这些是专项诊断，不是每次提交都重复的发布审计。相关改动仍不得通过放宽阈值掩盖回归。

暂存已审阅文件后发布：

```bash
npm run release:checked -- --no-wait-pages "type: message"
```

脚本只执行 staged diff 检查、build、smoke、commit 和普通 `git push origin main`。它不 fetch、
不做远端卫生、远端 SHA 比对、Pages 等待或大版本审计。普通 push 自身会拒绝非快进更新；
需要查看 Actions 或线上页面时单独检查，不阻塞提交。

## 任务交接

- 每个任务开始完整阅读 `AGENTS.md`、本文和 `development-handoff.md`。
- `development-handoff.md` 保持短小，只写活动目标、当前 base、已完成、pending、实际验证、
  改动 owner、遗留风险和下一步。新工作包覆盖旧流水账，不永久追加历史。
- 多会话大目标使用一份临时 workstream handoff 记录 milestone；每次会话更新它和主 handoff。
  只有形成稳定机制时才同步本文，避免每个小任务反复改三份文档。
- 不运行的验证保持 `pending`；未推送不写成已发布；未人工审图不写“视觉已改善”。
