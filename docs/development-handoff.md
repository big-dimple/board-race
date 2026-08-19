# Board Race 开发交接

状态：`current / handoff-ready`

更新时间：2026-08-19

这份文档只回答“现在做到哪里、接下来还能做什么、哪些事情不要重复踩坑”。稳定的
玩法和代码契约见 [`llmwiki.md`](llmwiki.md)；玩家说明见 [`../README.md`](../README.md)。

## M1 海面材质重做（2026-08-19）

本 session 只改了 [`src/water/ocean.ts`](../src/water/ocean.ts)，用于 M1 海面材质层。海面
仍是一个 camera-following opaque/depth-tested Mesh draw，复用 `waves.ts` 的 displacement；
没有改波形、浮力、碰撞、路线、船体、尾流、水花、HUD、输入、AI 或 harness。材质现在以深藏青蓝
近景、中蓝中景、冷亮远景连续过渡，加入低频方向性 visual-only normal 和宽日照，保留太阳
方向约束的导数过滤 glint，并把白浪收紧到高 / 陡 / 上升波峰。Performance 通过 shader define
关闭 fine glint layer。

本地运行态证明海面为 `124725 vertices / 246248 triangles / 1 draw`，`transparent=false`、
`depthWrite=true`；Auto desktop `1440x900` 为 `334 calls / 2025000 drawing pixels / 16.7ms /
DPR 1.25`，mobile `844x390` 为 `334 calls / 2057250 drawing pixels / 16.7ms / DPR 2.5`。
Auto start 的喷溅池为 `134 droplets + 4 landing volumes`，landing-plume 为 `28 + 1`，容量
为 `1536 / 12`。所有数字来自 harness / 一次性浏览器 probe，不是估算。

`npm run verify:release` 已通过（build、flight、mobile、collision、audio、systems、performance）；
当前结果只代表本地 M1 candidate，仍未 commit、push 或 release。M0 staged rollback 保持不动。
Logo deferred，等待用户提供官网 SVG 后另开 task，本 session 没有生成占位 Logo。

## 当前版本

- 当前交付包含全车手 Final Station 真实过线排名、终点强光前的实体遮挡、真实 BOOST
  同源尾焰、动态海面高光、真实落水水冠 / 两舷水幕、中央破碎尾迹，以及合批竞速艇与真实蒙皮车手。
  精确版本以包含本文件的 Git commit 为准，
  不在交接正文复制一个随后必然过期的 SHA。
- checked release 会在提交前重新执行 build、flight、mobile、collision、audio、systems、
  performance 和 closeout；交接中的“已发布”只以该脚本成功后的远端 SHA 为准。
- 本项目发布默认不等待 GitHub Pages；“已推送”不等于“Pages 已 live 验证”，如需确认线上版本，单独检查 Actions 和页面资源版本。
- `dist/`、`node_modules/` 是生成或依赖目录，不是源码交接内容；临时视觉验收资料按需生成，
  不属于源码交接内容。

## 已完成且不要重复重做

- 三飞勋章、七飞 Final Station、冻结结算和资料片画廊壳已经完成。
- Final 只在第七门正式计分后解除水面路线失败；此前的门、空中通道和水面逆行判定仍有效。
- 中性白雾空中航道、绿色水面主线、门后 recovery tail 和第四至第五飞的急弯提示已形成单一路线视觉合同。
- 水面主线跑过后的近端尾迹与空中白雾航道的起终边缘已改为连续渐隐，视觉端点不会再以硬直线提前收缩；完整阈值和验收证据见 [`llmwiki.md`](llmwiki.md)。
- 七条空中航道已删除入口前不参与玩法的白雾“预先云桥”：绿色水面线交到升空菱形，白雾
  corridor 只从真实 `entryU` 起画；第四飞提前部署、保留库存早起飞和原判定窗口均未改。
- 飞行库存上限为五格，桌面、艇边和手机读数共用一个上限合同；起飞消耗一格，但一飞仍
  最多只允许一次空中续航。满仓后的合格漂移仍正常兑现水面 BOOST。
- 手机截图预览会完整隐藏并释放触控按钮；预览页的“回到游戏”和关闭按钮都返回当前冻结
  画面，不跳过勋章 / Final 流程；原生分享 / 下载退出 fullscreen 后，真实返回手势会立即
  请求恢复，若被拒绝则保留到下一次游戏触控继续重试。
- 首局 PC 键盘基础提示、首败后可跳过驾驶教练、移动端触控默认、手柄映射和真实落水持有 Shift 交接已纳入验收。
- GO 使用非语音合成信号；持续水面 / 空气白噪声保持关闭，环境声音必须经过明确听感审核。
- 两名强敌在第四飞前通过真实 `BoatInput` 链式漂移、释放 BOOST、起飞和空刹保持可见；没有传送、假进度或玩家减速。
- 第四飞计分同帧仍精确解除编队；此后强敌保留真实链漂和普通自动油门，拥堵可以松油，
  但实际水面帧不能输出负油门，也不能重新读取玩家差距。
- 连续水面运动改为围绕上一帧 `u` 的有界局部投影，Race、AI 和碰撞修正不再在折返处
  各自跳到不同赛段；第四飞后的真实近距离超越 / 反超会验证对手确实进入追车镜头并
  贡献画面像素，而不是只剩名次数值。
- 对手技巧视觉现在复用玩家已有的 `thrust-outer/core` 实例，只在真实 BOOST 时沿艇尾
  短暂出现，漂移 hold 保持干净；旧的 12 片 billboard 蓝色脉冲、灰烟、漫画线、橙色尾焰
  和透明热雾锥体均已移除。精确比例、生命周期和像素合同见 [`llmwiki.md`](llmwiki.md)，
  不要在本文件维护第二套参数。
- 海面物理波形不变，连续四向微法线、中尺度风浪受光、背光面微光、宽日照、更清楚的稀疏白浪和导数过滤
  的移动波光共同恢复运动感；Auto 风浪材质法线从 `18-225m` 连续淡出，近场不会出现闪烁马赛克，
  也不接触船体浮力、碰撞或尾流采样。船尾迹改为一条有开合缺口的中央含气水带，Kelvin
  肩浪只是低透明次级细节，不得重新形成两条连续白轨。
- 受控飞行落水不再按时长把已下潜船体抬回水面：下降阶段第一次进入实时浮力面即记录真实
  `landImpulse`，并与自然浪跳共用一次落水事件。共享水花池用一个实例化立体水冠 / 两舷连续
  水幕和一组沿速度方向拉伸的细水滴表现；接触帧立即夹住垂直穿透，但 `surface` 驾驶仍在原定
  飞行结束帧交接，不提前改变横向竞速节奏。空闲与退场均提交零实例，不创建贴图，不常驻扫描
  `1536` 个死粒子。
- 天空保持原有三段渐变；近云与远云均改为逐像素密度纹理，近云带上下受光和软边体积，
  远云为低对比宽幅空气层，不再复用卡通云图标或整幅矩形薄片。可见太阳改为白金亮核、
  双层柔和光晕和宽方向光束，取消硬环与等距射线，不改变艇体、水面或车手的受光合同。
- 海面新增一层由波面法线、半向量和波动导数共同决定的粗糙镜面反光，仍在同一个海面
  draw call 内，由受控 `uSunPathStrength=.28` 驱动；近船动作区和远景都连续淡出，避免
  位置色块或白色大斑覆盖尾流与航道。
- 船体交互第二阶段已完成：`WakeRibbon` 的新鲜尾流环形缓冲现在可被其他船的五点船体
  采样读取。进入尾流时只产生低幅度艇身俯仰 / 横倾和一次艇首碎喷，离开后约 `2.35s`
  自动衰减；不改水面路线、起飞阈值、速度和碰撞法线，也不增加 draw call。长跑系统合同
  已覆盖进入、峰值上限和离开后的归零。
- 赛中挑战文案完成一轮目标玩家审阅：二飞冲击层固定为“你已超过天下 80%的男人”，三飞、
  结算、战斗广播和 Gemini 技巧提示统一改为短句、强动词、可立即理解的商业竞速口吻；操作提示
  仍保持动作语义，不用夸张文案覆盖关键信息。
- Final Station 解锁后六名车手按真实穿门先后排序；玩家故意最后过线会得到 `6 / 6`。
  已冲线对手仍保留实体、碰撞和画面，低画质终点强光也不能把它们洗成幽灵。具体扫掠、
  遮挡和性能合同由 [`llmwiki.md`](llmwiki.md) 统一说明。
- 赛艇外观重制为五个静态材质批次：完整硬脊艇壳、贴体座舱围护、蓝黑风挡与飞行硬件、
  嵌入式泵喷、分体碳纤水翼和舷侧速度线不再按零件逐个提交。车手重制为一个顶点调色
  `SkinnedMesh`，16 根骨骼保留原有转向受力、漂移、腾空、落地和庆祝动作；低画质对手也
  使用同一真实人形参与画面和遮挡，不再换成胶囊粗代理。
- 选手大名字保持为 `GLM`、`ChatGPT`、`Gemini`、`Kimi`、`Claude`、`DeepSeek`；卡片小号统一为
  `格莱美`、`欧朋智科`、`杰米奈`、`月之亮面`、`反人类`、`浅度求和`；
  旧的内部 ID 和资源文件名保持不变，仅用于存档、资产兼容和行为配置。
- 文档职责已经拆分：README 面向人，`llmwiki` 面向 AI 稳定契约，本文件面向当前开发交接。
- 全屏由跨设备 `ImmersiveModeController` 统一管理：只有 GO 在 trusted gesture 内首次请求；
  PC 在比赛中退出或拒绝后提供可关闭的“恢复全屏”，手机等下一次真实控制手势重试。Chrome
  原生退出提示无法由网页缩短，GO 后先隐藏选角层并展示约 3.6s 的六人开场；Chromium 成功
  全屏请求还会占用约 2.8s 固定步缓冲，完成后才进入倒计时。
- GO 后的短开场会把六名真实车手的本地立绘、中文玩梗名和英文模型名投影到艇上方；小屏
  卡片采用固定容量的屏幕空间避让，不移动艇位、不改变物理。海面和天空只在这段不可操作展示
  中提高日照与波光，远景帆影 / 飞鸟 / 亮片是低密度 `InstancedMesh`，进入倒计时后自动降回
  比赛密度，不能占用漂移和航道的动作走廊。

## 未完成与暂缓

### 资料片玩法

资料片目前仍是冻结画廊和概念图，七个新游戏都没有独立可玩玩法。后续应按
[`expansion-gallery-handoff.md`](expansion-gallery-handoff.md) 为每个世界单独设计化身、
碰撞、镜头、教学、音效和可访问性，不要把赛艇纹理换皮当成资料片完成。

### 环境声音

海浪、空气压力等持续环境噪声目前不在生产混音里。只有拿到明确审核过的环境录音和
可辨认的事件设计后，才可以重新加入；不要因为“听起来太安静”直接抬高 ambience 或
塞入新的白噪声循环。

### 海面表现

第二阶段已完成：除单个海面 draw call 内的连续风浪受光外，竞速艇现在会读取其他艇的
新鲜尾流，并用五点船体采样驱动极轻的姿态响应和艇首碎喷。尾流耦合只服务于“吃浪”的
身体可读性，仍不改 `waves.ts` 的水面高度、路线判定、起飞阈值或碰撞；后续若继续追求
商业竞速级浪峰细节，必须先证明不会淹没漂移、对手姿态、艇尾技巧提示或路线判读，动作
信息优先于水面炫技。

### 渲染性能

当前 Auto 档在 `1440x900` 性能合同中为 `334 / 600` draw calls。艇体五批、车手单蒙皮批次
和低密度远景装饰实例化已经回收了原先逼近上限的提交成本，`600` 红线没有放宽。后续若继续增加艇、场景或特效，
先判断同 transform 静态件能否按材质合并、重复几何能否实例化、等价材质 / 纹理能否共享；
独立动画、蒙皮、剔除和显隐所有权必须保留。同时复核高画质骨骼描边与低画质实体遮挡，
不能靠删动作信息或恢复假代理换预算。

### 人味与烟火气

可考虑稀疏、事件驱动的对手回应、赛道工作人员动作、起终点环境细节和跨局记忆，但
这些只是待评估方向，尚未获得新的内容定案。电台必须继续遵守单槽、优先级、冷却和
不遮挡路线的规则；不要恢复“艇况正常”一类填充播报。

### 线上状态

GitHub Pages 从 `main` 的 `deploy.yml` 部署。源码是否已推送以 `origin/main` 为准，部署是否
完成以对应 SHA 的 Actions、`github-pages` deployment 和线上 build marker 为准；本文件
不把发布候选、已推送和 live verified 混写成同一状态。

## 本轮验证

- `npm run build`、`npm run verify:flight`、`npm run verify:mobile`、`npm run verify:systems`、
  `npm run verify:collision`、`npm run verify:audio` 和 `npm run verify:performance` 分项通过；
  build 只有既有的单包体积警告。
- 桌面与移动端的 READY、比赛、电台、落水和 Final 视觉状态均已人工复核；名次榜和浮动电台
  均显示新选手名称，水花在船体轮廓外可见且不遮操作区。
- 落水合同同时锁定真实接触、单次事件、屏幕像素和最多两个附加 draw；短暂效果结束后两个
  实例池均归零。
- flight 合同实赚五格、验证第六次不溢出但仍兑现 BOOST、满仓起飞只扣一格，并在仍余
  三格时拒绝同一飞第二次续航；桌面和手机库存读数都锁定到真实状态。
- systems 合同模拟了原生分享退出 fullscreen、关闭手势首次恢复被拒，以及下一次真实
  漂移触摸成功重试；移动截图合同还确认选角阶段零 fullscreen 请求，GO 只请求一次；预览期间
  移动操作区不可见且不再遮挡分享。
- 视觉验收脚本覆盖桌面和 `844x390` 横屏手机的道具、船体、车手、海面、尾迹、对手脉冲、
  白雾航道和 Final 定向场景，并逐张人工复核。未发现安全剔除漏画，白雾保持白色结构且不覆盖
  海面动作信息，飞行中 `x1` 只亮一枚库存。
- performance 仍为 Auto `1,997,196 px / 334 calls`；五批赛艇、16 骨单网格车手、真实
  预通道、开场远景实例和 `600` draw-call 红线均未回归。

### 全局美术渲染性能标准（摘要）

完整标准唯一维护在 [`llmwiki.md`](llmwiki.md) 的“全局美术渲染性能合同”中，本文件只保留
本次交付的结果：船体五批静态材质、16 骨骼真实车手、动态效果实例化 / TypedArray 池、
局部安全剔除和中性白雾航道均已通过性能与视觉合同。后续新增美术或特效必须回到该合同，
同时提供资源 / 渲染指标和固定相机视觉证据；不要在交接文档复制第二套参数。

## 接手顺序

1. 先读 `AGENTS.md` 和 [`llmwiki.md`](llmwiki.md)，确认输入、固定步进、路线所有权和视觉分支规则。
2. 再根据任务阅读本文件对应的“未完成与暂缓”项；没有明确任务不要顺手扩展声音、资料片或电台。

## M6 continuation closeout：action priority（2026-08-19）

状态：`completed-locally / pending-release`。这是最终源码的本地验证候选，仍未 commit、未 push、
未运行 `release:checked`，也没有 GitHub / Pages / live 操作；不得写成线上成果。

本次 M6 只确认并收尾六个 owner：`src/cel/postPipeline.ts` 的 action-window 后处理减法、
`src/game/radioDirector.ts` 的 run-scoped radio coalescing、`src/hud/raceTower.ts` 与
`raceTower.css` 的单槽 / 居中广播，以及 `src/hud/hud.ts` 与 `hud.css` 的 flight prompt 与
compact right-lane power placement。action window 只压低漂移、BOOST、空刹时的 ambient energy，
保留白雾航道；radio 的重复逻辑不再按 inventory 增量刷屏；mobile prompt 保持可见并与右侧
动作区和 near-boat power panel 分离。没有改 `main.ts`、boat、rider、riderMesh、course、ocean、
wake、spray、worldNameplates、audio、input、collision 或 harness；M5 world nameplates 和 Logo
仍 deferred。

最终证据目录：[`shots/visual-roadmap/M6/continuation-20260819-action-priority-01/`](../shots/visual-roadmap/M6/continuation-20260819-action-priority-01/)。
after desktop `flight-prompt.png` 为 `2880x1800`（`1440x900 / DPR2`），after mobile
`flight-prompt-mobile.png` 为 `2532x1170`（`844x390 / DPR3`）；after contact sheets 为
desktop `1344x1652`、mobile `1344x1180`，尺寸 / 非空清单在 `metrics/png-inventory.tsv`。
`metrics/after-machine-evidence.json` 的 `compactLaneRefresh` 是最终源码复验：desktop
`223 calls / 2,025,000 px / 16.7ms / 1.25`，mobile `223 calls / 2,057,250 px / 16.7ms / 2.5`；
mobile prompt `252..592 x 8..86`、driver power `724..832 x 67.34..125.34`、actions
`504.84..834 x 239.61..380`，三项 non-overlap 均为 true。完整 evidence 还保留 `2 renderTargets /
2 effectComposers / 2 renderPasses / 1 shaderPass / 0 update allocations`、radio one-slot 与
duplicate attempt（`sameRunQueued=0 / secondQueued=0`）、`riderMountChildren=1`、five static
batches、16 bones / real SkinnedMesh，以及 head-on collision `TOI=0.26 / maxCorrection=0.18`。

最终门禁按严格顺序全部通过：build（既有 chunk warning）、flight（gameplay/gamepad）、mobile、
collision、audio、systems、performance（`1,997,196 px / 334 calls / software
533.3/583.4/600.0ms`），最后 `verify:release`（内部全通过；最终 software `566.7/683.2/683.4ms`）。

知识地图的仓库脚本 `scripts/check-knowledge-map.mjs` 当前不存在；本次 JSON parse 与等价的唯一 id、
字段、authority / summary path 校验通过，脚本缺失作为 M7 工具链待办保留。

遗留与下一步：M1-M5 的 dirty owner 实验和 staged rollback 现场保持不变，属于本次 out-of-scope、
未发布风险；当前 final source 没有越界修改。真实移动设备、不同 GPU、Actions、Pages/live marker
和 release approval 仍 pending。下一 task 为 M7；M6 仍明确是 unpublished local work。
3. 改动物理、生命周期、音频、记录或渲染后，运行对应 harness；跨模块改动最后运行 `npm run verify:release`。
4. 发布时默认使用 `npm run release:checked -- --no-wait-pages "type: message"`；Pages live verification 独立进行，并在下一次交接中如实保留状态。

## 交接检查

- [x] 当前分支和最近提交已记录。
- [x] 已完成事项与未完成事项分开。
 - [x] 资料片、环境声音和人味内容的边界已明确。
 - [x] 完整发布门禁结果已记录。
 - [ ] Pages live、Android / iOS 真机听感和任何新增资产的最终验收：按需完成，不属于本次交接已验证范围。

## M2 尾流与落水 continuation closeout（2026-08-19）

本次独立 session 只在 `src/water/wake.ts`、`src/water/spray.ts` 内完成 M2 owner 迭代，状态为
`completed-locally / pending-release`。尾流现在以断续中央含气洗流为主，Kelvin 肩浪短、低透明并
带缺口；落水 volume 由真实接触点、速度方向和 right basis 驱动，冠、水幕和速度对齐水滴共用
现有池化 / TypedArray / `InstancedMesh` 路径。没有改 `boat.ts`、`main.ts`、harness 或阈值，也没有
恢复双连续白轨、硬端盖、道路核心、billboard 或 bloom。

固定 before/after 证据位于
[`shots/visual-roadmap/M2/rebuild-20260819/`](../shots/visual-roadmap/M2/rebuild-20260819/)。同一
`?harness=1` seed/camera 下，desktop `1440x900` 与 mobile `844x390` 的 contact sheet 和代表
full-size 已实际复核；开场 countdown/start 没有船体淹水证据，wake-close 没有连续双肩线，落水
主体保持在船尾接触区。`wake-close-no-wake` 不是独立 scenario 名称，而是 wake-close 的同帧关闭
尾流输出，unknown 原事实保留。

当前机器证据：start `334 calls / 2,025,000 px / 16.7ms`；landing impact/plume 各 `94 calls`；
settle `76 calls`。Auto 落水峰值为 `28` droplets、`1` landing volume，池容量 `1536/12`，settle
后活跃数和 instance count 均为 `0/0`。最后 `npm run verify:release` 全部通过，performance 为
`1,997,196 px / 334 calls`，software p50/p95/p99 为 `466.7/533.3/550.0ms`。本地工作树保持
未 commit、未 push、未 release；HEAD/origin 仍为 `b55907bb258514e9dd42b2ecd3f8af498ed53dca`，
M0 staged rollback 仍为 `144c3bcce957417e8862e74f34637c93d44fb0f2`。Logo deferred，Pages/live、
真实移动设备和不同 GPU 仍是发布前风险；下一 task 为 M3。

## M3 车手视觉 continuation closeout（2026-08-19）

本 session 只修改 [`src/game/riderMesh.ts`](../src/game/riderMesh.ts)，状态为
`completed-locally / pending-release`。车手静态几何改为圆角 loft / 软板和连续后背护具壳，主色
明暗分区替代黑色拼件；头盔后壳、冠带、护目层、膝肘和圆角靴底在 chase close、drift、flight
cruise、landing 和 Final 中更可读。动作仍完全由 [`rider.ts`](../src/game/rider.ts) 的 16 骨骼
物理弹簧驱动，没有循环 pose、proxy、纹理、atlas、外部资源、额外 rider draw 或 owner 外溢。

新的 fresh before/after 证据在
[`shots/visual-roadmap/M3/continuation-20260819-rider-refresh-01/`](../shots/visual-roadmap/M3/continuation-20260819-rider-refresh-01/)，旧 M3 证据未覆盖。桌面 `1440x900 / DPR2`
输出 `2880x1800`，手机 `844x390 / DPR3` 输出 `2532x1170`；包括 full-size PNG、contact sheet
和非空尺寸记录。第一版 after 后又进行了两次 close-up 几何/分区迭代，正式 after 使用第三版。

机器审计：6 艘船各 `1` 个 beauty rider；玩家 `1` 个共享 skeleton outline，5 艘低质量对手的
ink prepass 仍复用真实 rider；每名 `16` bones，fixed-step 后 `16/16` 骨骼变化、`192` changed
matrix floats。正式 rider audit 记录在 evidence `metrics/rider-audit.json`。Auto start 为
`320 calls / 2,025,000 px / 16.7ms`，performance contract 为 `334 calls / 1,997,196 px`；
实例池/资源容量 audit 保持 `10 sails / 3 birds / 13 glints` 与 `1536 droplets / 12 landing
volumes`，没有新增 rider 纹理或池。

验证：`npm run build`、`npm run verify:flight`、`npm run verify:mobile`、
`npm run verify:collision`、`npm run verify:audio`、`npm run verify:systems`、
`npm run verify:performance` 和最终 `npm run verify:release` 均通过。最终 performance software
p50/p95/p99 为 `466.6/499.9/533.3ms`。未运行 `release:checked`。

本地状态仍为未提交、未推送、未发布；HEAD/origin 仍为
`b55907bb258514e9dd42b2ecd3f8af498ed53dca`，M0 staged rollback 仍为
`144c3bcce957417e8862e74f34637c93d44fb0f2`。旧的 M0/M1/M2/其他 owner dirty 现场未被清理或重写。
未验证真实 iOS/Android、不同 GPU、线上 Pages。下一 task 为 M4，仅处理 boat owner 的船体视觉
和合批整合，不能改变 rider mount、collision envelope、物理动作或本轮 rider batching 合同。

## M4 船体视觉 continuation closeout（2026-08-19）

本 session 只修改 [`src/game/boat.ts`](../src/game/boat.ts)，状态为
`completed-locally / pending-release`。构建期将连续船壳、圆角水线、甲板、侧面涂装、座舱、推进
机械和翼面按五个既有材质批次合并；六艘船共享五套批次几何和三套非涂装材质，涂装与号码仍按船
独立。没有修改 rider.ts、riderMesh.ts、course.ts、main.ts、harness、HUD、water、physics、
collision、AI、route 或 Logo；没有新增 fixed-step 分配，也没有创建第二个 transform truth。

fresh before / after 证据在
[`shots/visual-roadmap/M4/continuation-20260819-boat-refresh-01/`](../shots/visual-roadmap/M4/continuation-20260819-boat-refresh-01/)。桌面 `1440x900 / DPR2`
为 `2880x1800`，手机 `844x390 / DPR3` 为 `2532x1170`，contact sheet 为桌面 `1536x747`、
手机 `1532x570`；PNG 均通过尺寸和非空检查。人工复核结论：before 的船体在侧面和中远景更像
黑线拼件，after 第二版具有连续粉色船壳、白色甲板、深蓝侧带、座舱 / 尾翼 / 推进层次；低质量
对手仍能读出真实船体轮廓。第一次 after 观察后重新拟合了侧面涂装带，未靠全局黑边、饱和发光或
额外特效遮掩几何。

机器证据见 evidence `metrics/renderer-resource-audit.json`：

- Auto：`334 calls / 2,025,000 drawing pixels / 16.7ms`，pixel ratio `1.25`。
- High：`369 calls / 4,097,600 drawing pixels / 16.7ms`，pixel ratio `1.7786456215`。
- Performance：`334 calls / 1,296,000 drawing pixels / 16.7ms`，pixel ratio `1`。
- 六船静态批次为 `[5,5,5,5,5,5]`；几何为 `30 refs / 5 unique`，材质为 `30 refs / 15 unique`，
  号码纹理为 `6 refs / 6 unique`。
- 场景资源 Auto/Performance 为 `550 geometry refs / 219 unique / 550 material refs / 278 unique /
  41 texture refs / 17 unique`；High 为 geometry/material refs `565`，唯一资源和纹理相同。
- `riderMount -> hull`，local `(0, 0.64, -1.05)`；六名 rider 均为真实 16-bone SkinnedMesh。
  Auto/Performance 的 rival shell mesh layer mask 为 `3`，High 也为 `3`；rival rider layer mask 为
  `3` 且仍为真实蒙皮。`head-on-ccd` 为 `1 hit / TOI 0.26 / finite true / max correction 0.18`。

验证结果：`npm run build`、`npm run verify:flight`、`SHOT_PORT=5220 npm run verify:mobile`、
`npm run verify:collision`、`npm run verify:systems`、`npm run verify:performance`、
`npm run verify:release` 均通过。standalone mobile 第一次只因 5199 临时端口冲突未启动，备用端口
重跑通过；没有修改其他 owner 或放宽阈值。未运行 `release:checked`，本地未 commit、未 push、未
发布，不能写作线上成果。真实移动设备、不同 GPU、GitHub Actions、Pages live 和线上 build marker
仍未验证。下一 task 为 M5。

## M5 fresh continuation closeout：英文世界名牌 deferred（2026-08-19）

状态：`completed-locally / pending-release`，并明确 `superseded-by-user-decision`。用户已否决旧的六个
英文世界名牌方案；本轮没有实现 `GLM`、`ChatGPT`、`Gemini`、`Kimi`、`Claude`、`DeepSeek` 的船后、车手旁、
世界空间或 HUD 名牌。`src/game/worldNameplates.ts` 删除状态保持不变，也没有修改 `src/main.ts`、HUD、boat、
rider、course、water、wake、spray、harness 或其他 source。已有 opening showcase 小互动保留，未新增大面积
名牌、文字墙、替代 UI 或 Logo。本轮是未发布本地实验，不能写成线上成果。

fresh before / after 证据位于
[`shots/visual-roadmap/M5/continuation-20260819-nameplates-deferred-01/`](../shots/visual-roadmap/M5/continuation-20260819-nameplates-deferred-01/)。desktop `1440x900 / DPR2`
full-size 为 `2880x1800`，mobile `844x390 / DPR3` full-size 为 `2532x1170`；desktop contact sheet 为
`1504x864`，mobile contact sheet 为 `1504x714`，尺寸 / 非空清单和 runtime audit 同在 `metrics/`。两套
证据都覆盖 READY、真实 opening active、race start、near/mid/far、drift、flight、landing 和 Final。opening
active 的真实 harness 状态为 `beat=orbit`、`6/6` echo 可见；这是已有小互动，不是竞速世界名牌。after 与
before 是同一实现复验，未伪造视觉变化。

机器证据：`metrics/runtime-audit-after.json` 与直接零名牌审计 `metrics/nameplate-zero-audit.json` 在 desktop near/mid/far/drift/flight/landing/Final 与 mobile
race 中均报告 world-nameplate object matches `[]`、`activeCount=0`、`drawInstances=0`、material/texture
`[]`、atlas `0`；`src/game/worldNameplates.ts` 不存在，source/harness scan 没有残留 owner。M3 关键合同为
所有观察到的 SkinnedMesh 骨骼 `16`（六名 beauty 加玩家共享 ink 共 `7` 个）；M4 六船各 `5` static batches、
`5` shared geometry、`3` shared materials，rider mount `(0,0.64,-1.05)`；head-on CCD `1 hit / TOI 0.26 /
max correction 0.18 / finite true`。桌面代表帧 `334 calls / 2,025,000 drawing pixels / 16.7ms`，移动代表帧
`334 calls / 2,057,250 drawing pixels / 16.7ms`。

本轮验证：

- `npm run build`：通过，仅有既有 chunk-size warning。
- `npm run verify:flight`：通过，gameplay / gamepad contract OK。
- `npm run verify:mobile`：通过，mobile controls contract OK。
- `npm run verify:systems`：通过，records / roster / rivals / endurance OK。
- `npm run verify:performance`：通过，`1,997,196 px / 334 calls`，software `p50/p95/p99=550.0/600.0/616.6ms`。
- `npm run verify:collision`：通过。

`verify:audio`、`verify:release` 和 `release:checked` 未运行。当前仍未 commit、未 push、未 release；HEAD/origin
仍为 `b55907bb258514e9dd42b2ecd3f8af498ed53dca`，M0 staged rollback target 仍为
`144c3bcce957417e8862e74f34637c93d44fb0f2`。M1-M4 dirty owner 未清理或覆盖。真实 iOS/Android、不同 GPU、
GitHub Actions、Pages/live marker 未验证，均保持 pending。下一 task 为 M6，不能恢复旧名牌；Logo 等待用户
提供 SVG 后另开 task。
