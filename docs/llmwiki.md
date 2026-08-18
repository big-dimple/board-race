# Board Race AI 运行手册

状态：`current / schema-v8`

这份文档给接手代码的 AI 使用，记录容易因上下文压缩而丢失、但又不能靠猜的
稳定事实。面向玩家的说明只放在 `README.md`；当前版本的开发事项、未完成工作和
发布状态只放在 [`docs/development-handoff.md`](development-handoff.md)；资料片专案
只放在 [`docs/expansion-gallery-handoff.md`](expansion-gallery-handoff.md)。项目级硬
约束在 `AGENTS.md`。有冲突时以当前代码、确定性 harness 和用户最新明确决定为准，
修正事实后必须同步相关文档，不能保留两个都自称现役的版本。

## 一分钟恢复上下文

- Board Race 是横屏优先的 Three.js 街机赛艇游戏，玩家自动前进，只控制转向、
  水面漂移 / 空中空刹，以及主动起飞 / 空中续航。
- 核心循环是 `漂移 -> 松开入库 -> 在白雾分支前起飞 -> 穿门`。三次独立飞行
  获得男人勋章，拿到第一升级为优秀男人；第七飞通过后解除航线约束，只需从任意
  路线、任意方向在水面穿过可见金门。
- 首次 READY 不出现教学，首局也没有模态教程。全新 PC 键盘存档只在 GO 后显示
  一条左下角动作提示，按真实 `Shift -> 黄线松开入库 -> Space 起飞` 状态递进；
  移动端不显示。第一次真实失败仍会出现一次完整聚光教学邀请。
- `BoatInput` 和 60 Hz fixed-step 是稳定合同。教学只观察状态和成功动作，绝不
  注入输入、改物理、放宽路线判定或创建教程专用比赛规则。
- 任何本地改动都不等于已发布。代码推送到 `main` 即完成本项目的发布动作；GitHub
  Pages 只会在 workflow 后部署，Pages 与 live verification 独立进行，不阻塞提交和推送。

## 真实玩法语义

### 漂移、库存与飞行

1. 水面速度超过阈值后按住漂移键才会累积 `boostCharge`。
2. 船边左条的黄色刻度是合格线。达到后松开，才会存入一颗飞行菱形；只按过
   Shift 或进入 `drifting` 不代表已经理解或完成入库。
3. 最多存五颗菱形。每次合格释放只增加一颗，库存已满仍会正常结算水面 BOOST。
4. 继续漂过黄线只会延长释放后的水面 BOOST。它不会改变单格基础飞行时长。
   这是已经确定的现行规则，不得改成“漂得越久飞得越久”。
5. 水面起飞消耗一颗。基础飞行包络固定为 `6.45s`；巡航或下降时可把备用格
   消耗一次，增加 `2.4s`，总包络为 `8.85s`。spool / ascending 阶段的连按
   必须拒绝，一飞最多续航一次。
6. 通过或错过目标门会立即进入下降。未消费的备用格可跨落水和三飞勋章冻结
   保留；全新一局会清空。
7. 普通受控飞行落水时，若玩家一直按住同一个漂移 / 空刹动作，接触水面的那个
   fixed-step 必须原子切换为水面漂移、清零旧空刹包络，并只从该帧开始累计
   `boostCharge`。不能回算空中时间，也不能要求松开重按。Final 已 arm 时是唯一
   例外：该动作继续是 `return-brake`，不得进入漂移、蓄力或 BOOST。

权威实现：`src/game/boat.ts`。跨系统只读合同：`src/contracts.ts` 的
`BoatState`。HUD 派生：`src/core/abilityTelemetry.ts`。

### 船边仪表

- 左竖条是上下文动作条：水面漂移蓄力、释放后的 BOOST 剩余，或飞行中的空刹
  介入强度。它不是飞行库存。
- 黄色横线只表示“现在松开足够存一格”。
- 右竖条只在受控飞行中表示本次飞行包络剩余时间，不是高度、速度或库存。
- 五颗菱形构成飞行库存；桌面五格高亮、艇边五枚小菱形和手机 `x0..x5` 必须与
  `flightCharges` 一致，只有 `x5` 使用满仓强调。
- 空刹不会消耗库存或读条。它降低目标速度，并提高空中转向与回正权限。

### 穿门后的惯性与路线交接

- 穿门只完成计分并进入下降，不会清除 `x/z` 位置、水平速度、船头或 yaw。现行物理
  保留真实惯性；禁止用 teleport、snap、重置速度或隐藏的自动驾驶把船拉回主线。
- `flightRouteState='passed'` 不等于路线所有权已经回到 surface。当前 flight branch
  必须继续负责下降、触水和门后的 authored recovery tail；落水本身也不是交接点。
  唯一的提前交权事件是玩家真实花费库存、Boat 接受 `surface -> spool` 的下一飞；此时
  新 flight 在同一 fixed-step 原子接管视觉，旧 recovery 不得因状态已被 Boat 清成 idle
  而冻结或复活。这个例外只影响 presentation owner，不调用 settle、不改惯性或计分。
- 普通分支的交接条件是船已回到水面，并越过该分支的 exit 平面、处于出口横向
  `24m` 内、真实水平速度没有逆着出口切线。按门到出口距离与路线目标速度计算的
  `2.5-4s` 上限只是防逃线兜底；它不能改变船体运动。
- 第三飞是唯一的局部几何特例：评分门前仍使用原 CatmullRom，不动门位、物理或判定；
  门后改用从门切线到 surface `exitU=.47` 切线连续的 CubicBezier recovery，交接横向
  margin 为 `18m`，并用 `5.2s` 上限覆盖 medal / resume 后的真实惯性。禁止把它改成
  `flightsCleared>=3`、slot 复用或全局 warning grace；第二飞和第四飞后的执法必须原样。
- `Course.sample()` 收到显式 flight route hint 时必须把该分支视为权威，不能因为离
  分支较远就偷偷回退到全局最近的 surface 段。branch -> surface 交接时 `Race` 只
  重建采样基线并保留连续比赛进度，不能把投影差误当倒退。
- recovery 期间不累计 surface off-course / wrong-way timer。所有船在连续 surface
  运动中都必须沿上一帧已接受的 `u` 做局部投影：世界步长不超过 `4m` 时调用
  `sampleSurfaceNear()`，搜索半径取 `min(.02, (worldStep + 2m) / course.length)`；Race
  的碰撞位置同步和 AI 自己的线路采样使用同一原则。全局 nearest 只允许在初始化、明确
  route ownership 切换或超过该步长的 staging / teleport 时接管进度；玩家已偏离
  `24m` 后可只读比较全局候选，以识别正冲向另一折面的捷径并提前启动原 `0.8s` 纠正窗，
  但绝不能采纳该候选的 `u`。小步物理运动却跳到非相邻
  `u` 时必须锁住原路线所有权，不能把空间上邻近的折返段认成合法前进。船体碰撞和渲染
  始终使用同一个世界 transform；名次、AI 和可见性不得各自选择不同的赛道折面。逆行同时
  观察船头方向和真实水平速度，避免惯性仍向前时反向船体只偶发提示。
  唯一例外是第七飞已经 arm Final：此时两种 timer 和 warning 永久清零直到冲线。
  HUD 必须分别显示“偏离航线”和“方向反了”，不能共用含糊的 `WRONG WAY!`。
- 视觉语法固定为 `绿色水面主线 -> 三枚升空菱形 -> 半透明白雾航道 -> 白雾回收尾段 -> 绿色水面主线`。
  绿色水面主线负责到 `launchCueU`，三枚菱形负责从水面姿态交向空中姿态，七条白雾航道的
  mesh 则必须精确从各自真实 `entryU` 开始。禁止在入口前铺一段不参与起飞、碰撞或计分却像
  可驾驶水道的白雾面 / 云桥；surface mask 仍从 launch cue 开始，不能为了填空重新前移。
  急弯暖色只允许落在 authored 尖角上，整片
  corridor 的暖色混合上限保持低于 `.16`，急弯颜色只属于尖角，不染整片白雾。
  穿过计分门后不能提前把空中航道改成水面指引道：船仍在空中时，recovery 保持 authored
  flight 高度、白雾材质和白雾开放尖角；真实触水后只把同一套白雾几何平滑贴合浪面，直到
  handoff 才允许恢复绿色 surface 主线。若此时真实接受下一飞，则直接从旧 recovery 切到
  新白雾 branch；触水本身仍不是换材质或换视觉所有权的时机。七条白雾航道统一使用
  `white-mist-corridor`：中性白雾主体、白色双流线、屏幕空间稳定的细墨边三层分工，
  不再用蓝绿底色和透明度叠成彩色平板。基础 alpha 为主体 `.095`、扫描节奏 `.04`、中心
  `.045`、边缘 `.34`、流线 `.54`；`55-145m` 仅增强边缘和流线，主体最多额外 `.04`，
  总 alpha 封顶 `.82`。流光必须有亮头和渐隐尾并沿 route 正方向移动。不得恢复紫色
  能量管、连续实体墙或用 bloom 堆亮。门后提前露出主线并保持 `16m`
  交叠；世界中仍然最多一个 active branch。回收提示只是可视导航，不是碰撞墙，也
  不改变判定范围。
- 水面主线横向细分后逐顶点采样实时浪高；禁止恢复粗双轨、横杆或 fragment shader
  重复 V 字。半透明场内保留一条可辨认的亮色导航脊；只实例化前方 `170m` 的开放尖角，
  间距 `10m`，并以 `10m/s` 沿真实曲线前进。尖角必须有赛璐璐墨边，急弯连续放大并
  变暖至少三枚，不能只做原地明暗呼吸。薄雾和箭头都不进入 bloom，也不能复制空中
  通道的平板几何。
- passed branch 在下降、触水、authored handoff 完成前同时负责 validation 与唯一
  visual guide；触水前后 active route id、recovery material 和箭头语法必须保持一致。
  普通预览只能在 handoff 后部署；但已接受的下一飞优先级更高，必须同帧撤掉旧 owner、
  旧 fade 和升空菱形，再成为唯一 branch。第七飞 recovery 同样必须先完成，且不得错误
  预览第一飞。

### 第四、第五飞的可读性

- 不抬高全局飞行高度、门、船体包络或镜头。第四飞只在当前门上方增加不受海面
  遮挡的细杆 + 空心白雾菱形 locator；它属于当前唯一 branch，不生成第二目标。
- 第二、三、四、五、六飞的 authored 急弯统一在白雾航道内使用一组三枚、航道宽度级
  暖色尖角，集中放在可决策区而不是平均摊到整个弯。方向分别为左、左、左、右、左；
  第一、七飞不伪造急弯。尖角属于同一 ribbon group，不计作第二 branch，也不改物理。
- 七个起飞入口统一使用同一套世界内升空向量，不用字幕或 HUD 冒充路线：水面主线在
  `launchCueU`（未单独配置时回退 `launchFromU`）处停止，两只低矮浮漂投影器随浪运动，
  三枚空心菱形沿约 22m 弧线从
  当前水面切线转向第一段空中姿态。带 authored 急弯的路线在上方两拍内嵌左右尖角，
  且 launch 前 40m 内既有水面流动尖角逐步朝第一段空中姿态偏转；开放尖角粒子沿整条
  弧线前进。因此入口同时回答“何时飞”和“朝哪里、以什么姿态飞”。绿色水面薄雾、
  流动尖角和沿线浮标从 `launchCueU` 到 flight exit 必须连续隐藏，不能在菱形退场后
  短暂重现；否则海浪和镜头会让水道与空道看起来随机互换。
  无库存为金色警示，有库存切白色 ready；离水后整组立即隐藏，由白雾 flight branch
  接管。门阵无碰撞、不参与输入、不修改
  launch window、通道宽度、门宽、物理或失败判定；世界中仍最多一条 active branch。
- 第四飞不修改 `launchFromU`、AI 或判定：正常预览仍从 `guideFromU=.465` 部署，玩家菱形
  仍锚在 `launchCueU=.493`，白雾 corridor 与其它六飞一样从真实 `entryU=.515` 开始。若
  使用保留库存早于 handoff 或菱形起飞，Course 仍必须在接受起飞的同一 fixed-step 清掉
  flight-3 recovery owner/fade、隐藏菱形、保持绿色 mask 在 `.493`，并只显示 flight-4；
  不得为这段合法但非推荐的提前起飞重新补白雾假桥。升空向量仍约 `34m`，水面
  尖角仍在前 `65m` 对齐左转；真实提前起飞仍必须通过原通道和原门宽。
- 第五飞空中急弯先用三枚主弯尖角，再在出口回正段使用两枚反向尖角，防止持续空刹
  把船带过头。五枚标记均随浪浮动并由小浮漂和细杆支撑，不得换成矩形高速路牌、文字墙
  或无支架悬浮图标；后两枚必须与前三枚方向相反，HUD 也要按当前弯段切换。桌面首段短提示必须用
  `[SHIFT] + [→]`，不能写泛化 `A/D`；移动端只描边既有空刹与右转触区，不能移动
  hit zone、显示额外文字卡或增加第二次震动。航道坐标的局部 `+X` 是左舷：左转尖角保持
  原向，右转尖角必须翻转 `PI` 指向右舷。立牌、航道内尖角和起飞菱形各自对真实路线切线
  验证，禁止只验证它们彼此一致；`DoubleSide` 只负责双面可见，不能决定箭头方向。
- 白雾只承担“可飞行空间”语义，材质语言是可持续辨认的半透明虚拟面、白色风痕、
  泡沫节奏和细墨结构；主体透明度不得低到让天空或浪面擦掉通道，也不能退化成实体
  平板。透明双面航道必须 `forceSinglePass`，保留 depth test、关闭 depth write；否则同一
  面被重复混合会让透明度随视角漂移。禁止恢复紫色能量管、连续实体墙或 bloom 堆亮。黄/白 action marker 靠形状区分，颜色
  只做冗余，门、路线和提示始终最多一个当前权威目标。

权威状态在 `src/game/course.ts`，连续进度和 surface 警告在 `src/game/race.ts`。
任何调整必须覆盖第 4-7 飞完整的 gate -> descent -> water -> handoff，不得只测门口。

### 第七飞后的 Final 自由接近

- 第七门被正式计分的同一 fixed-step 由 `Race.armFinale()` 与 `Course.armFinalStation()`
  原子切换目标。切换前的 gate / corridor / late / landing 仍照常失败；切换后不再产生
  flight 或 surface 路线失败，也不显示回绿色线 / 掉头提示。
- 第七飞的 authored recovery 仍完整保留，不能因为 Final 已 arm 就提前撤掉下降与落水
  导航。handoff 后 active flight branch 必须为零，水面绿线统一降到 `18%` 仅作参考，
  金门成为唯一强目标；小地图和屏幕外边缘只允许一个金色 Final 标记。
- 完成真相是 `Course.crossFinalStation(previous,current)`：真实逐帧扫掠穿过可见两根
  金柱之间，返回同一 fixed-step 内的穿越比例 `0..1`，没有合法穿越则返回 `-1`。正反
  方向都接受，单步超过 `4m` 视为 cut/teleport 而拒绝。柱外擦过既不完成也不失败，
  玩家可绕回再试；必须处于 `surface + idle`，下降中穿门不偷完成。
- Final arm 后所有六条实体船共用同一穿门真相。每名选手的 `finishTime` 必须用穿越比例
  落到亚帧时间；同一步多人冲线先比较这个时间，已冲线者永久排在未冲线者之前。玩家
  结果只能在本步所有船完成检测并重新排序后生成，因此先让五名对手穿门必须得到 `6/6`，
  不能因为 Final 是玩家触发就默认第一。对手冲线后仍保留真实世界变换、碰撞和可见实体。
- Final approach 冻结玩家在第七飞认证时的竞速 progress，未冲线 AI 仍继续排序；离开
  绿色样条不能凭 nearest projection 虚增名次。碰撞、惯性、落水、后台恢复规则全部保留。
- Final approach 的玩家漂移/空刹输入改作回港刹车：目标速度 `18m/s`、最大减速度
  `28m/s^2`，使用既有 air-brake 转向权限但绝不选择倒车。此时不得漂移、蓄力、BOOST、
  获取或消耗飞行格；松开后自动油门恢复。键盘仍是 Shift，手机右下显示 `刹 / BRAKE`，
  右上显示不可点击的 `终 / FINAL`。该动作不新增音效、触觉或输入合同字段。

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
- 手机默认触控转向并在 `GO` 后直接就绪；只有玩家主动切到重力转向才请求传感器权限并校准。
  选角页任意真实 `click` 都可尝试全屏，`GO` 同时保留自己的同步请求；全局
  `pointerdown` 只解锁音频，不能抢先创建 pending fullscreen promise 吞掉后续 click。
  倾斜 / 触控切换只允许改变左拇指区，右侧漂移与飞行位置不能移动。触控转向的
  两块命中区固定为各 140px，不随大屏手机继续外扩；右转可见圆钮向左内收 22px，
  但不得缩小或移动它背后的命中区。
- iPhone 普通网页没有可依赖的 element fullscreen；继续按能力检测请求即可，失败后保留
  浏览器托管形态，禁止伪造滚动全屏。`manifest.webmanifest` 只负责玩家主动“添加到主屏幕”
  后的 `standalone + landscape` 启动，不新增 Service Worker。页面必须在 head 阶段取消
  `beforeinstallprompt` 默认行为，禁止 Chrome 自动推广安装；玩家仍可从浏览器菜单主动安装。
  launcher 名称使用完整产品名，不能再用脱离品牌语境的缩写。
- 支持 Fullscreen API 的浏览器若因系统 UI / 安装推广竞争而拒绝一次请求，下一次真实控件
  手势必须恢复重试资格；只有真正进入 fullscreen 或明确不支持 API 才消费一次性资格。
  `GO` 始终保留自己的同步请求，测试必须区分“调用过”与“失败后能够重试”。
  已从主屏幕以 standalone 启动时本身就是沉浸窗口，不得再嵌套请求 fullscreen。
- 勋章 / Final 截图预览属于全屏 viewer：出现时必须隐藏并释放所有移动游戏控件，不能让
  空刹命中区盖住分享。系统分享或下载导致 `fullscreenchange` 退出时必须恢复请求资格；
  点关闭要在同一 trusted gesture 内立即重试，若被拒绝，下一次真实控件触摸继续重试。
  Escape 或程序化关闭不伪造用户手势，也不能在 frozen finale / dossier 后错误露出控件。
- iOS standalone 的全屏根层必须使用 `100vh` 覆盖 Home Indicator 区，不能用 `svh`、
  `visualViewport.height` 或一次性的 `innerHeight` 猜高度。Three.js Stage 以 `#app` 的实际
  `getBoundingClientRect()` 为尺寸真相，并由 `ResizeObserver` 跟随；场景铺满整屏，只有 HUD
  与触控按钮通过 `env(safe-area-inset-*)` 避开不可操作区。移动合同必须验证 app、Canvas
  与 renderer viewport 同边界，并模拟容器高度与 `innerHeight` 不一致后的恢复。
- Safari 防误缩放只监听 `gesturestart / gesturechange`，并且必须同时满足移动控制已启用、
  横屏、`activation === ready`、control phase 非 inactive、资料片覆盖层未隐藏控制。选角和
  资料片继续由浏览器拥有手势；不得追加 `user-scalable=no`、全局 `touchmove` 拦截或缩放重置。
  捕获阶段只取消浏览器默认 gesture，不能清理/合并 PointerEvent ownership，三指转向、漂移、
  起飞仍须独立持有。
- 教学文案使用最近真实活动的设备，不以“浏览器支持触控”或“有手柄连接”猜测。
- 未知手柄映射继续走 READY 校准。涉及手柄的任何改动都要覆盖首次边沿、多手柄、
  未知映射、断连释放和有界震动。

## 渐进式驾驶提示

### 首局 PC 键盘提示

- 资格在 `startFreshCountdown()` 调用 `records.beginRun()` 之前判定，但绝不能使用
  `records.data.runs` 猜玩家是否会漂移。当前条件是非 mobile、最近活动输入为键盘、
  `bestFlights < 1` 且 `knowledge.bankRule=false`。它复用 v8 coach knowledge，不增加
  schema 字段；单纯入库只写真实 mastery，不得替玩家确认已理解整条首飞因果。
- fresh countdown 第一帧就显示左下角非模态字幕，让玩家在得到控制前读到
  `按住 SHIFT 不放`；不能先讲菱形或 Space。提示本体不截获驾驶输入，`Esc` 或
  可见关闭按钮持久写入 `knowledge.bankRule=true`，但必须保留
  `mastery.bankedCharge` 的真实原值（未入库时仍为 false）与 `automaticEligible=true`，
  不能伪造动作掌握，也不能顺带关闭首败 coach。
- 进度只认 `BoatState` 成功边沿：`driftReleaseReady` 后才提示松开；随后真实
  `flightCharges` 上升才确认入库并至少停留 `1.8s`；有库存且
  `CourseGuidanceStatus.actionCue==='launch'` 才提示 Space；真实 `surface -> spool`
  就算起飞成功，包括松 Shift + 按 Space 同 fixed-step 后库存净值仍为 0 的组合动作。
  只按过 Shift 不算完成。
- 入库确认必须明确“黄线后松开 = 入库”，不能暗示漂移时长决定飞行时长。
  Space 未可用时不提前催按，也不能缓冲起飞。
- 普通右上角 flight prompt 与首飞 console 是两个互斥 owner：前者只在真实 launch cue
  与库存同时有效时消费一次 token，extension window 另有一次 token；库存上升本身不能
  触发。实际手柄输入会隐藏键盘字幕；返回键盘可继续当前动作。只有首飞真实通过或
  主动关闭后，retry / reload 才不再重复基础字幕。失败、勋章、结果和完整 coach 接管时立即停止。移动端 DOM 可以存在，但
  JS 与 CSS 都必须保持不可见。
- 纯观察状态机在 `src/game/pcControlPrimer.ts`。桌面锚点在 `src/hud/hud.ts/.css`；
  首败 coach 的键盘漂移步骤复用同一锚点，不再聚光卡片内部的自指假键帽。

### 首败后驾驶提示

### 产品原则

- 首局保持无模态裸考，不在选手页或倒计时前强塞控制总图；PC 首局左下动作字幕
  是唯一例外，只解决 Shift 可发现性和漂移入库因果，不展开完整课程。
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
| 起飞并沿白雾航道穿门 | 有库存且当前分支展开 | `surface -> spool`；route passed。组合动作不依赖库存净下降 |
| 急弯空刹 | 第二飞以后进入真实急弯警告 | 警告中空刹介入并转向，随后过门 |
| 备用格续航 | 真实出现可续航窗口时 | `flightExtended` 成功脉冲 |

首局状态机在 `src/game/pcControlPrimer.ts`；首败状态机在 `src/game/drivingCoach.ts`。
二者只消费 `BoatState`、合并后的玩家输入、
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

- frozen finale 的唯一主动作是 `神秘资料片`，默认键盘/手柄确认必须打开它；`截图` 与
  `继续游戏` 是角落里的紧凑 utility。终局和 dossier 都隐藏移动端开始、模式、转向、
  漂移和飞行控件；从 dossier 返回终局仍保持隐藏，只有继续游戏或 reset 才恢复。
- 勋章和终局截图按钮只负责生成 PNG 并打开冻结预览，不能直接调用含义模糊的系统
  share sheet。桌面显示明确的保存/下载与复制；Android 显示下载 PNG 与分享；iOS
  显示系统“存储图像”/分享与下载到“文件”备用路径。取消、unsupported 或 failed
  必须留在预览并显示准确状态；预览拥有移动触控层和上述 fullscreen 恢复合同。只有确认
  成功的非 share-opened 导出才计入终局截图记录。
- 七张资料片图只按当前页请求，不在构造阶段或翻页后预取相邻页。网络未完成时显示明确
  loading，锁住翻页以避免并发拉图；失败时保留返回结算并提供重试。

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
- 同一时刻最多一个教育提示。PC 基础字幕固定在 fine-pointer 桌面的左下静区，
  与底中能量条保持间隔；它不能出现在 coarse/mobile。guide 不能遮挡船边仪表、右拇指技能区、急弯警告、
  medal、Final 或 interruption gate。
- 提示标题先写动作，副行写结果；每次只讲一个当前有意义的概念。READY `?` 默认
  只解释逐步标注，黄线、左右条、备用格和雷达放在玩家主动展开的“进阶规则”。
- 控制 glyph 必须跟随最近活动设备和自定义手柄映射，不能硬编码 Shift 给所有人。
- 教学帮助不降低物理难度、不影响勋章资格，也不自动驾驶。
- 桌面选角从 `1366x768` 起使用固定 `portrait / identity / radar` 三栏和六个等宽候选；
  1920、2560/3440 与真 4K 走离散尺寸档，超宽只增加背景留白，不按 viewport 连续放大
  字号。移动端 standing portrait 布局是独立合同，本桌面规则不得覆盖它。
- 桌面 READY 相机和 presentation time 冻结，GO 后从同一 orbit phase 连续恢复。浏览
  切换只允许 incoming 图在 `200ms` 内单向 clip reveal，旧图只做未揭示区域的底图；
  禁止完整双图 crossfade、DRIVER CONTRACT 假卡或强制 layout reflow。连续输入以最后
  一次为准，`260ms` 硬收敛；reduced motion 立即切换。雷达 backing store 必须覆盖
  `CSS size * min(devicePixelRatio, 2)`。
- 全局造型继续由 `CelOutline` 墨线承担，不能为了削弱赛璐珞把轮廓一起淡掉。普通
  `CelToon` 使用 `.46/.54/.62/.70/.78/.86/.93/1` 八级光照，shadow tint 为 `.42`，
  rim 强度按原值乘 `.82`，up tint 为 `.096`，高光阈值至少 `.95/.995`。这组参数的
  目标是缩小大块明暗跳变，不是改成无轮廓写实材质。
- 天空 dome 保持三段渐变；8 个近云使用 `256x160` 逐像素密度贴图，8 个远云使用
  `512x220` 宽幅低对比空气贴图与 `.62` 不透明度。两层纹理都必须保持透明边缘，不能
  复用卡通云图标、平底阴影或整幅矩形薄片；近云内部必须有上下受光差异以读出体积。
  可见太阳使用独立的 `uSunVisualDir`，只改变天空中的偶发可见位置，不改变共享
  `SUN_DIR` 对艇体、车手和水面的受光；太阳使用白金亮核、连续双层光晕和宽方向光束，
  不得恢复硬环或等距矩形旋转符号。
- 玩家可见的竞速文案采用短句和强动词：二飞冲击层固定为“你已超过天下 80%的男人”，
  奖励、战斗广播和技巧提示必须先让目标玩家一眼读懂，再提供情绪张力；禁止用“卧槽”、
  “小小失误”等口语填充替代明确的进度或动作信息。
- 海面位移与 CPU 船体采样继续共用原 Gerstner 波形；材质不再按浪高切赛璐珞色带，
  而是由连续法线、视线、日照和 Fresnel 共同塑形。四向、仅影响材质法线的近场细浪强度
  为 `.056`，从 `58m` 到 `155m` 连续淡出，绝不能修改船体浮力所用的物理波形。
- 宽日照之外允许一层强度 `.5` 的短促方向波光和一层太阳方向反光带：两者必须来自连续细法线，并以
  `fwidth(glintField)` 和细粒度 `microField` 做导数过滤，只在 `8-34m` 渐入、`150-360m` 渐出。
  旧的高度色块、量化闪点、hash 像素噪声和菱形符号仍然退役；太阳反光的材质强度为 `.20`，必须由
  `sunFacing`、半向量镜面和波动导数共同形成碎片，不能用位置色块占满近船动作区或远景。
- 第一阶段中尺度风浪层只影响海面材质法线和受光：`uWindNormalStrength=.038`、
  `uWindSpecStrength=.16`，由连续行波组成并以 `fwidth(windField)` 过滤，在 `18-210m`
  连续淡出。不得把它接入 `waves.ts`、浮力、碰撞、wake 或航道；不得通过加亮或青绿色
  色块弥补纹理不足。新增海面层必须继续保留单个不透明、写深度 draw，并通过海面时间变化
  和路线像素合同。
- 白浪只允许出现在同时够高、够陡、正在上升的浪面，基础阈值为 `.24/.01/.015`，再经
  大尺度噪声打碎，并在 `170-340m` 淡出。海面保持单个不透明、写深度的跟随式 draw，
  原船体吃水泡沫圈保留；后续调参必须同时通过海面材质合同、时间变化和路线像素合同。
- 船尾水痕是一条 `5.2s` 生命周期的单 draw ribbon，但视觉主体必须是断续的中央充气湍流；
  Kelvin 肩浪只能作为低透明、分段出现的次级细节，禁止重新形成两条连续白轨，也不能
  填成一条发光道路。泡沫高光继续读取与海面相同的 Gerstner 法线，近场中心命中、覆盖
  宽度和空隙率都由 wake 像素合同约束。
- 所有船体和车手无论质量档是否生成倒壳描边，都必须在 `LAYER_INK` 法线/深度预通道中
  获得完整实体覆盖。船的静态外观固定为 shell、safety trim、mechanical、flight hardware、
  paired number 五个材质批次；物理、碰撞和画面仍共享外层 `boat-*` transform，合批不得产生
  第二套位置。车手由 `src/game/riderMesh.ts` 生成一个带顶点调色的 `SkinnedMesh`，16 根
  `THREE.Bone` 继续由 `src/game/rider.ts` 原有受力、漂移、飞行、落地和庆祝弹簧驱动；不得
  退回逐胶囊 draw 或脱离状态的循环动作。高画质的倒壳描边必须共享同一 skeleton 并留在
  ink layer 之外；`detailedAiInk=false` 不再使用假粗代理，而由同一真实蒙皮网格同时进入
  beauty 和预通道。单个低画质对手仍只能贡献 2 个 ink mesh：一份批合并船壳和一份真实车手。
  能量合成用膨胀后的 ink mask
  抑制船体内部 bloom、热偏移和大闪白，但实体外的光晕必须继续可见。
- 新增视觉设计先按所有权选择提交方式：同一 transform 且生命周期一致的静态零件按材质
  合并，重复几何优先 `InstancedMesh`，等价外观共享材质与纹理；独立动画、蒙皮、剔除边界、
  透明排序或单独显隐的对象保持分离。优化必须保留真实动作、碰撞和唯一 transform，不能用
  假代理或删反馈换 draw call。

### 全局美术渲染性能合同

- 这套性能约束覆盖整个游戏的道具、场景、船体、车手、水面和航道，不是只给白雾航道做
  的局部优化。`Stage` 明确开启 `renderer.sortObjects=true`，让不透明批次尽量按前到后提交，
  减少被遮挡片元的无效着色；可见性仍由 Three.js 的深度测试和真实世界变换决定。
- 路线 ribbon、surface guide、箭头和漂移脉冲不再用可避免的 fragment `discard` 做动态裁剪，
  改为零 alpha 路径以保留早期深度测试机会。喷溅的硬 alpha cutout 暂时保留：把它改成普通
  半透明会扩大过绘，当前没有足够的视觉或设备证据证明值得付出这笔成本。
- 赛璐珞主材质的八档漫反射已从共享 1D Ramp 纹理改为等价的解析 `step()` 阶梯；阈值和亮度
  仍保持原八档，运行时不再为每个 toon 片元做 Ramp 纹理采样。该合同由截图 harness 检查
  `uRamp` 缺失和全部七个阶梯阈值。
- 只给拥有局部、可证明包络的 rider、thrust 和 drift pulse 开启安全 frustum culling；海面、
  船尾 wake、喷溅和跟随相机的整圈 guide 保持保守提交，避免动态顶点、实例矩阵或波面位移
  被错误边界裁掉。任何新增剔除都必须先有固定相机像素证据，再加对应 harness 合同。
- 当前可用的合批基础必须持续复用：船体五个静态材质批次、每名车手一个 16 骨骼
  `SkinnedMesh`、重复几何的 `InstancedMesh`，以及 wake/spray/jet trail/碰撞等 typed-array
  池。它们共享真实 transform 和 fixed-step 状态，不能用假代理换 draw call。
- `meishu.md` 中的 VAT、ASTC/纹理通道打包和 Worker 搬运当前标记为“不适用”，不是遗漏：项目
  没有烘焙动画纹理或 KTX2 资源链；车手骨骼姿态、输入、碰撞和 AI 必须在同一 fixed-step 读到，
  拆到 Worker 会改变真相时序。未来若引入这些资产或异步边界，必须先以设备矩阵和像素/帧时证据
  证明收益，再单独更新合同。

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

暂存且只暂存已审阅文件后，使用
`npm run release:checked -- "type: message"`。仓库脚本会定位
`github-operator` 的 checked publisher，并一次完成确定性洁癖检查、全部 release gates、
commit、push、remote SHA 与 Pages live marker 校验。没有发现新事实、冲突或清理候选时，
不得再把这套固定流程拆成多轮大模型交互。

本项目默认不等待 Pages，使用
`npm run release:checked -- --no-wait-pages "type: message"`。该参数从版本化合同临时派生
一个只移除 `pages` 的 `.git` 内合同副本；全部 closeout / build / gameplay / mobile /
collision / audio / systems / performance 门禁、commit、push 和 remote SHA 校验仍然执行。
它不是跳过测试或跳过远端确认的开关。

`npm run verify:closeout` 会拒绝未暂存 / 未跟踪残留、备份类文件、tracked `.env` 中的
异常键，以及本仓库仍在运行的人工 Vite 服务。它已经是发布合同的第一道 gate；只有
它发现新问题时才进入交互式 `jiepi-clear` 裁决。

若 GitHub 匿名 API 配额耗尽，checked publisher 可能在成功 push 后返回 metadata
错误。`release:checked` 只在工作区已干净且 local SHA 等于 `origin/main` 时启用公开
Pages fallback；fallback 还必须同时看到 Actions HTML 对该 SHA 标记 success，且线上
canonical 首页包含相同完整 SHA。三项不能全部成立就继续失败，禁止只看 HTTP 200。

飞行回收的最低回归集：

- `flightRecoveryCase(routeCursor)` 只允许在起飞前 staging 一次；穿门后逐帧跑到
  route handoff，再继续至少 `2.5s`，中间不得 reset、teleport 或调用下一飞 helper。
- 第 4-7 飞必须分别证明 pass 只增加一次、fail 为零、全程最多一条分支、没有警告
  预累计、没有位置跳跃或水平速度归零，且连续进度不会因路线投影切换明显倒退。
- 折返赛道上的连续 surface 采样必须逐船锁 `Race` 与 AI 的最大 `du`、进度单步和 resync
  次数；第四飞解除编队后还要让玩家与一名强敌在同一水面真实完成一次近距离超越和反超。
  反超证据必须同时包含接近的世界坐标、连续 progress、追车镜头内 NDC 和实际 WebGL
  像素差；只看名次数值、碰撞触发或 object `visible=true` 都不能证明对手仍然显示。
- `medalRecoveryCase()` 必须真实跑第三门 -> medal freeze -> resume countdown -> 下降 ->
  落水 -> handoff，证明合法惯性无 warning/event，且 Final 未 arm；第二飞现有越线与
  逆行合同必须同时通过，锁住局部修复不外泄。
- `medalEarlyFourthLaunchCase()` 必须从同一真实链路分别覆盖 recovery 尚未 handoff、
  以及 handoff 后但未到 `launchCueU` 两次提前起飞。接受边沿同帧必须看到 commit=flight-4、
  recovery=-1、active=flight-4、菱形撤场、mask=`.493`、flight-4 visual start=`.515`、
  旧 flight-3 父级不可见，且
  实际渲染像素证明 flight-4 不是只有子节点 `visible=true`；桌面和移动端都必须通过。
- `route45ContinuousCase()` 只允许在第四飞起飞窗前 staging 一次，随后真实完成第四
  门、下降、落水、handoff、漂移入库、第五飞起飞、空刹右转和第五门。必须看到
  bank cue、至少 `1.2s` 反应窗、真实库存上升边沿；若入库和起飞发生在同一 fixed
  step，允许 armed launch cue 没有单独展示帧，但不能为满足测试破坏同帧操作合同。
  第四飞落水的精确边沿还必须证明 held air-brake 已在同帧变成漂移、只增加一帧
  charge 且空刹包络归零。全程零 warning/fail、零 teleport，并保持
  `visibleRouteCount<=1`。
- `third-recovery-air` 与 `third-recovery-surface` 必须走真实第三门、medal freeze
  和 resume countdown；两个 beat 都断言 active/recovery route 仍是 flight-3、同一个
  shader、同一白雾开放尖角几何，空中 blend 必须为 0、触水后才允许贴浪，且
  `visibleRouteCount===1`。`flight-route4-recovery-air` 必须额外锁定第四飞穿门后仍是
  白雾、仍保持 authored 空中高度。通用
  `flight-recovery-air/surface` 继续覆盖其它路线和紧凑横屏。
- 整圈绿色水面主线采用随浪薄雾 + 导航脊：base alpha 约 `.17`、峰值不超过 `.58`，
  像素合同必须分开测柔和水幕与高对比中央主脊：大多数低差值像素保留海面色带方差，
  高分位差值则证明主脊肉眼可发现，不能再把两者平均后误判为“整片涂死”。前方只保留
  15-17 枚带墨边的流动开放尖角；第三门
  后的真实 medal recovery 在落水前后都必须看到至少三枚放大的暖色转弯尖角。七个
  起飞入口都必须各有两只投影浮漂、三枚弧线上升菱形和三枚流动开放尖角；弧线平面
  长度保持约 20-26m，第二至第六飞各有两枚与 authored 方向一致的姿态尖角。至少分别
  验证 unarmed / armed / committed，且 committed 时水面门阵撤场、起飞后绿色路线
  重现距离恒为 0；第四飞菱形前必须至少有两枚水面尖角已经进入 authored 左转姿态。七条空中分支门前
  的虚拟面主体、边缘和流线须各有可测透明度下限，不得因追求“烟雾感”而降到肉眼
  难以追踪。`verifyFlightGuideVisualContract()` 必须逐一 staging 七条真实分支，关闭 / 开启
  当前 ribbon 对比 WebGL 像素，并在固定相机下推进材质时间验证流光确实移动；只检查
  uniform 或只截门口不算验收。fragment shader 必须用 `fwidth` 保持远距结构最小屏幕宽度，
  同时检查海面亮度方差仍被保留；七条 ribbon 的 `visualStartU` 必须分别等于自己的
  `entryU`，防止前置假桥回归。
- 旧的 `passFlight()` 会在每飞前 staging，适合门判定和计数等局部合同，不得把它
  当作冲门后惯性或 route handoff 的端到端证据。
- `finalApproachCase()` 必须从真实第七门继续下降、落水和 handoff，再驶出旧 `42m`
  失败走廊至少 `2.5s`；全程 warning/fail 为零、progress 不漂移、没有 teleport。随后
  覆盖金柱外擦过可重试、正反穿门、高速 sweep 和超 `4m` cut 拒绝；第七飞落水帧
  必须反向证明 Shift 仍是 return-brake、包络保留、漂移与 charge 都为零。
- 键盘 Shift、标准手柄 X / Square 和真实移动 pointer 都要在
  `descending -> surface` 的相邻 fixed-step 上断言交接；只在落水一秒后检查
  `drifting=true` 属于假阳性，不能作为这条生命周期合同。落水帧也不是终点：
  持有动作必须继续累计到 `driftReleaseReady=true`，否则浪面微跳、输入所有权切换或
  下一帧清理仍可能让玩家看见“一帧漂移”却无法真正入库。

### 动作游戏键盘输入：边沿不等于持有

- `keydown` 的首次边沿和“物理键仍按住”是两个合同。Space 起飞、确认等一次性动作只
  接受非 repeat 边沿；Shift 漂移 / 空刹和方向键属于持续动作，必须允许 repeat 恢复
  held state，但 repeat 绝不能重新制造 Space 边沿。
- 浏览器进入全屏、切焦点、系统弹层或窗口短暂 blur 时，输入层会主动清 held state，
  而物理键可能从未松开。焦点恢复后浏览器可能只继续发送 `repeat=true` 的 keydown；
  若代码在写入 held set 之前直接 `return`，PC 玩家会一直按着 Shift，但游戏永久读到
  `false`。触控 pointer 不经过键盘 repeat，所以手机正常不能证明 PC 合同成立。
- 持续动作的 keydown 处理顺序必须是：先恢复 held set，再按是否 repeat 决定是否生成
  edge；keyup 始终清 held。设备活跃序列可在一个此前未记录的 repeat 恢复 held 时更新，
  但不能每个 repeat 都抖动设备来源。
- 回归必须使用真实关卡和浏览器事件：第四飞通过后处于下降阶段，触发 blur 清理初始
  Shift，再发送 repeat Shift；随后逐 fixed-step 跑过真实水接触，断言当帧开始 charge、
  空刹包络归零、持续持有不掉帧并到达黄色 BANK 线。单独调用 Boat、只测普通下降夹具、
  只看接触一帧，或随后交给 AI 漂移，都不能覆盖这类 PC 体验故障。

教学相关的最低回归集：

- 全新存档首局完整 coach 为 dormant、`automaticEligible=true`，不弹窗、不聚光；
  符合条件的 PC 键盘首局仅显示非阻断基础操作提示。
- 首次真实失败才激活；复盘第一帧可继续 / 关闭；退出只回 READY。
- 关闭后刷新不复活，READY `?` 可重开，三飞后变 expert。
- 漂移掌握以真实入库为准；launch、route、air-brake、extension 也使用成功状态边沿。
- 键盘、移动、标准 / 自定义 / 多手柄及运行中换设备显示正确 glyph。
- 手机 coach 卡片与船边仪表、固定右拇指区不重叠，聚光框必须圈住真实按钮；
  portrait / background 冻结安全。
- v2-v8 迁移、v7 rollout repair、坏存档清洗与 JSON import 后的 live guide 一致。

确定性浏览器入口是 `?harness=1`；`harness/screenshot.mjs` 负责玩法、输入、移动端
和视觉几何，`harness/systems.mjs` 负责记录迁移与长跑合同。

## 倒计时与声音合同

- 浏览器禁止无手势自动播放，因此真正的冷打开仍静音；READY 上第一次键盘或指针
  手势必须启动完整 BGM。之后 GO、比赛、勋章和重回 READY 只改变混音，不重启媒体
  时间轴。整局始终只有一个 BGM media source，不按场景叠歌。
- `3/2/1` 只使用三格递减起步灯、数字和短促 tick：`3灯 -> 2灯 -> 1灯 -> GO全灭`，
  不播数字人声。
- `GO` 永久不使用男声或女声。正常路径只触发一次 `GameAudio.startSignal()`：
  低频起拍 + 两层上行三角音（最高 `1320Hz`，高于 `3/2/1` 的 `880Hz` tick），
  峰值也高于倒计时 tick。全部由当前 `AudioContext` 即时合成，没有资源请求、解码
  竞态或迟到播报。若 context 尚未 running，主循环只在同一帧发一次
  `countdownBeep(true)` 作为电子 fallback；不得在比赛开始后补播。
- 选角页第一次明确手势可以启动同一条 BGM media source；GO、比赛、勋章和回到 READY
  只改变混音，不叠加第二首歌，也不重启媒体时间轴。

音频拓扑是一个循环 BGM media source 加 ambience-events / vehicle / event 三类
Web Audio 总线，最后统一经过 master high-pass 和 limiter。它不是多首 BGM 互相抢占。
水面 rush 与空中 pressure 的共享白噪声循环已关闭；环境总线只接受经过审计的短事件。
当前 owner master 测得约 `-15.9 LUFS / -6.6 dBTP`，已有事件叠加余量；没有可听见的
持续噪声证据时不要擅自给 BGM 做全曲降噪，也不要新增海浪录音。

### 碰撞、落水与触觉

- 玩家碰撞同一 fixed-step 只呈现最大一次音效/镜头/触觉；物理层仍保留所有碰撞对。
  音频有短 cooldown、active one-shot 上限和事件环形审计（`audioEventLog()`），
  同一噪声 buffer 使用确定性偏移，避免相位重叠变成白噪墙。
- `CollisionHit` 必须携带真实接触法线和世界接触点。镜头冲击以玩家艇坐标中的左右侧为
  主信息，只做受限横移、滚转和短 FOV 回弹；随机 shake 是次级。`SOUND` 中保留
  `标准 / 弱 / 关`，`prefers-reduced-motion` 等效为关，不得靠增加晃动制造撞击感。
- 只有玩家落水播放 splash/thud；对手落水保持视觉反馈，直到有空间化环境样本并经
  用户审核。环境事件不等于持续海浪。
- 漂移 / 空刹 / 起飞等 control-lane 触觉拥有约几十毫秒保护窗。碰撞与 landing 进入
  单槽队列并合并为最高强度，绝不打断右手 drift/air-brake 手感；手机和手柄只向
  最近活动的设备输出，不能双震。`Haptics.update()` 在 fixed-step 中冲刷队列。
- 触觉只使用短促分级脉冲，不做持续震动；任何调参必须同时覆盖移动端、标准/未知
  手柄、多手柄、断连和控制中碰撞的 harness。

### 对手追赶与赛道电台

- 开局接触只是一种按 run seed 决定的偶发 pack pressure：最多一名相邻、非 clean 对手
  稍微收向玩家的 authored lane；避碰仍生效，不保证接触，也不修改碰撞物理。
- 两名最强 rival 在开局承担短编队职责：第二飞、第三飞和第四飞计分时，两名都必须
  领先进度；真实世界距离超过 `8m` 时还必须位于玩家前方且不超过 `55m`，近于 `8m`
  则允许在 S 弯出口可读地并排。`RivalPaceDirective` 是唯一编队指令，分别提供
  `surfaceTargetScale=1..1.16`、`flightTargetScale=1..1.02`、水面油门辅助和收口压力；
  同一份指令同时进入 `AIController` 和 `Boat.update`，玩家船始终强制为 `1`。动作必须
  通过标准 `AIController -> BoatInput -> Boat.update` 按住漂移、达到真实
  `driftReleaseReady`、松开得到 BOOST，再按既有飞行 / 空刹逻辑行驶。第四飞计分同一
  fixed-step 调用 `releaseFormation()`，把 `formationActive=false`、两种倍率归 `1`、
  水面油门辅助关闭、收口压力归零；已经开始的合法空道尝试可保留线路控制到落水，
  但不得再读取玩家差距。解除编队后的 chain specialist 继承玩家式水面自动油门：正常
  直线输出 `1`，拥堵、打转或 mistake 可以降到 `0`，帧开始已在水面时绝不输出负值；
  空中仍由独立 vector air-brake 包络负责减速。禁止 teleport、位置插值、假 progress、
  免碰撞或玩家减速。
- 连漂表现必须来自真实状态：所有对手在真实 hold 时保持干净艇尾，只有真实松开并兑现
  BOOST 的 rising edge 才触发 `opponent-drift-burst`。它是一个朝后上方约 `28deg` 展开的
  `.55s` 蓝白等离子脉冲，由 `12` 个互相覆盖的相机朝向 lobe 组成一个 depth-aware instanced
  energy draw；长度随衰减在约 `3.8-5.2m` 内变化。不得复用飞行向下喷口、持续排气、
  灰烟、假热雾锥体、白色角标或脱离 `BoatInput` 的循环。普通尾流倍率仍为 `.68`，只负责贴水。
- harness 要锁同一名 rival 的 `drifting -> boosting -> drifting`、AI accepted cycle 与
  Boat BOOST rising edge 数量完全一致、hold 时 burst 为零、release 时蓝白脉冲出现、READY 时 burst
  清零，并从正常 `10-35m` 追车视角证明 release 真实改变至少 `220` 个 CSS 像素；累计计数、
  object `visible=true` 或贴近自由相机都不能单独冒充可读性。第四飞后还要连续采样至少
  五秒，证明 player-gap 指令全为零、实际水面输入无负油门，同时仍观察到真实 chain hold
  与 BOOST。
- 电台是纯 `RadioDirector` 单槽仲裁，优先级为 `critical > tactical > flavor`；危险警告、
  键位引导、飞行提示和表现层冻结时暂停，不与它们争屏。每条消息有 run key、TTL、
  duration，可选 session key；不得用多个独立 timer 叠出一排 toast。
- 第 `1/2/4/5/6` 飞和轻碰撞保持静默，不再播“艇况正常”等填充句。重碰只播有明确
  对手人格的短句，每局最多两次且间隔至少 `8s`；粗口仍由 session key 限一次。
  Gemini 技巧固定为 `Gemini // 线路读懂了` / `空刹压住速度，转向咬住弯心`，卡片小号为 `杰米奈`，未掌握
  空刹时每局最多一次。桌面用约 `0.55s` 右侧滑入、`4.2s` 中心停留、`0.9s` 左侧退出
  的 32px 半透明广播；移动端在左侧赛事槽放大呈现，出现时名次列表让位，绝不能盖住
  任一触控热区。危险或教学遮挡期间 active timer 与 CSS animation 一起暂停。

Final 自由接近与桌面选角舞台不改变 records 结构，不升 schema，也不触发存档迁移。

## 开发、端口与收尾纪律

- `npm run dev` 使用严格端口 `5173`。若被占用，先用 `ss -ltnp` / `ps` /
  `/proc/<pid>/cwd` 确认归属；不要凭端口号杀进程，也不要让 Vite 静默漂到 5174。
- 确需并行服务时显式运行 `npm run dev -- --port <port>`，记录 PID 或工具 session；
  验收结束必须停止该精确进程并复查监听端口。
- `dist/` 和 `shots/` 是 ignored 生成产物。不要把“ignored”误当成“可随手删除”；
  先确认是否仍是视觉验收凭证，再按清场流程列候选。
- 图像生成 working directory、一次性计划、旧副本和临时脚本不属于项目真相。
  先确认正式资产已入库、没有未合并或独有成果、没有进程占用，再列删除候选。
- 实现任务完成并通过对应门禁后，默认启用 `github-operator` skill 并直接提交、推送；
  只有用户明确要求“先别发布”或等候验收时，才保留在本地。PR、Release、Pages 设置
  或其他超出既定 checked release 的仓库变更仍需以用户授权范围为准。
- 用户要求洁癖 / 收尾时启用 `jiepi-clear`：代码、运行态、文档、规则、记忆和
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
