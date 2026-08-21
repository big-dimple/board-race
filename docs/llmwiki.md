# Board Race AI 运行手册

状态：`current / schema-v8`

本文只记录接手代码必须知道的稳定结构和行为合同。每个任务都要完整读取本文、根目录
`AGENTS.md` 和 [`development-handoff.md`](development-handoff.md)。当前进度不写在本文；
玩家说明归 `README.md`；美术目标归 [`art-direction.md`](art-direction.md)。代码与用户最新
明确决定高于文档，发现冲突时先按真实实现修正文档。

## 一分钟恢复上下文

- Board Race 是横屏 Three.js 街机赛艇游戏。玩家自动前进，只控制转向、水面漂移 /
  空中空刹，以及起飞 / 一次空中续航。
- 核心循环是 `漂移到黄线 -> 松开入库 -> 在白雾入口起飞 -> 穿门 -> 落水回线`。
- 三飞完成基础资格；第七飞通过并完成 recovery 后，进入可双向穿越的 Final Station。
- `BoatInput`、60 Hz fixed-step、唯一 flight branch 和统一 boat transform 是最重要的跨模块合同。
- 本地修改、已推送、Actions 成功和 Pages 已更新是不同状态。常规发布只负责构建、冒烟、
  提交和普通推送，不等待或比对远端 SHA。

## 事实归属

| 事实 | 权威位置 |
| --- | --- |
| 玩家控制与可见玩法 | `README.md` |
| 跨模块类型和状态 | `src/contracts.ts` |
| 船与飞行物理 | `src/game/boat.ts` |
| 路线、门和视觉分支 | `src/game/course.ts` |
| 比赛生命周期、失败与排名 | `src/game/race.ts` |
| 存档和迁移 | `src/game/records.ts` |
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
- 水面越过主线硬边后立即显示 `off_course` 警告，只有持续 15 秒未回线才判负；回线衰减、
  Final Station 解除和 `wrong_way` 的独立警告 / 判负时钟保持原语义。
- 第七飞计分后路线失败永久退休，但该飞 recovery 仍完整播放。所有实体选手通过同一个
  swept Final portal 排名，使用亚帧 crossing time；已完赛车手继续保留实体和碰撞。
- Final 回港刹车不能触发漂移、BOOST、飞行库存变化、倒车或额外反馈。

## 输入、浏览器与生命周期

```text
READY -> opening -> countdown -> racing
       -> medal freeze -> resume countdown -> same run
       -> defeated -> review -> READY
       -> Final Station -> frozen finale / dossier
```

- 键盘、手柄和移动输入最终合并为一个 `BoatInput`。一次性动作只接受首个 keydown；
  steering/drift 等持续动作允许 repeat 恢复 held state。
- 页面隐藏、旋转阻断和系统 UI 冻结模拟。恢复时清边沿，但不能让物理仍按住的 Shift 永久失效。
- 手机默认触控转向；重力模式只有玩家主动选择后才请求权限。右手漂移和飞行触区不可移动。
- Safari 缩放抑制只在横屏活跃游戏控制层生效，不加 viewport 锁、全局 touchmove 取消或缩放重置。
- Fullscreen 只由真实 GO 或后续真实控制手势请求。iPhone 不支持时保持浏览器托管形态，
  不伪造全屏。截图预览、结算和 dossier 必须隐藏并释放移动控制。
- READY 的桌面与移动选角是两套布局；桌面相机冻结，移动端竖屏由旋转提示完全接管。

## 教学、存档和反馈

- 首局 PC 提示只观察成功状态：按住 Shift、达到黄线、松开入库、到入口后 Space。
  移动端不显示这条 PC console。第一次真实失败可邀请完整聚光教学。
- 教学不能注入输入、改物理、降低难度、增加第二条路线或用提示覆盖危险信息。
- 当前存档 key 为 `board-race:challenge:v8`。迁移和导入必须清洗坏数据，localStorage
  写入失败不能阻塞当前比赛。
- 倒计时为 `3 -> 2 -> 1 -> GO`，GO 使用一次非语音合成信号。未审核的持续水声和空气
  白噪声保持关闭；碰撞、落水和触觉按真实事件、设备所有权与优先级处理。
- 强敌只能通过真实 `AIController -> BoatInput -> Boat.update` 追赶、漂移和 BOOST；禁止
  传送、假进度、碰撞免疫、玩家减速或脱离状态的循环特效。

## HUD 与电台

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
- 可续航动作窗口复用现有一次性提示，不新增教程层：桌面提示明确本飞最多使用两格，即起飞
  一格、续航一格；横屏手机只在现有“续”按钮内显示每飞一次，完整规则进入该按钮的无障碍说明。
- 比赛短通知按 `data-kind` 分别避让中央动作区：起飞、过门、路线完成和优秀锁定留在船体、车手、
  门与紧急航线上方，`flight-pass` 保持桌面右上且紧凑移动端隐藏；禁止用全局偏移统一搬动。
- 语义冲击的两侧受光条带由 HUD CSS 所有；横屏粗指针端只使用更细条带，桌面宽度及颜色、数量、
  覆盖、透明度、动画和触发节奏保持不变。后处理 polar wind streak 与 air-brake bands 是独立效果。
- 同一时刻只允许一个教育提示；碰撞、路线危险、勋章和 Final 表现拥有更高优先级。

## 渲染与美术合同

- `waves.ts` 是海面唯一真相：CPU 浮力与 GPU 使用同一组五向二阶高度波，水面保持
  `y = f(worldXZ, time)`，不再存在只由 GPU 横向位移而 CPU 无法采样的近似。近场使用完整
  波谱，短波在进入稀疏地平线网格前连续退场，远场只保留主涌浪，质量档不得改物理结果。
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
- 船体、车手、路线和特效不能制造第二套 world transform。当前五材质批船体、16 骨骼
  SkinnedMesh 车手、共享材质、实例化和 typed-array 池是已知性能基线，不是禁止重构的美术规格。
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
```

`verify:smoke` 只检查桌面和横屏手机能启动、画面非空，以及 Gemini、艇边库存、续航提示和
撞柱文案的关键布局。截图使用 `npm run shot -- <scenario...>`；可加 `--mobile` 和
`--out <directory>`。

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
