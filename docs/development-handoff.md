# Board Race 开发交接

状态：`current / M7-live-verified`

更新时间：2026-08-19

这份文档只回答“现在做到哪里、接下来还能做什么、哪些事情不要重复踩坑”。稳定的
玩法和代码契约见 [`llmwiki.md`](llmwiki.md)；玩家说明见 [`../README.md`](../README.md)。

## 当前暂停点与下一轮路线

本轮已经暂停代码实现，先把商业级美术目标拆成可独立交接的串行任务。M7 checked release
已将以下视觉候选与 blocker repair 发布到 `main`，不能再把它们写成未发布实验：

- `src/cel/postPipeline.ts`
- `src/game/course.ts`
- `src/water/ocean.ts`
- `src/water/spray.ts`
- `src/water/wake.ts`
- `harness/screenshot.mjs`

临时路线图和每个 task 的验收合同放在
`/home/github/board-race/shots/visual-roadmap/README.md`。该目录被 `shots/` 忽略，
是下一轮 goal 的执行入口，不是源码事实源，也不属于本次发布。一个总 goal 可以串行
承载全部里程碑，但每个 `M0-M7` 必须在独立 session 完成：完成当前 task 的代码、截图、
性能和文档交接后才进入下一个，不能跨 task 带着未验证的半成品继续堆改。

本轮事实状态：代码 `pushed-and-live-verified`；运行态 `live-verified`；文档
`changed-and-verified`；规则 `verified-current`；记忆 `generated-read-only`；工作区 `clean`
（保留忽略的实验现场和 M7 截图，未清场）。M7 surface-guide blocker 已修复：只将
`src/game/course.ts` 的窄中心 `navSpine` alpha 基值由 `0.18` 调到 `0.28`。checked release 的
candidate release commit / release-time `origin/main` 为 `428120044836951e266583481be35bbcadbbaa1f`；八道 release gate 全部
通过，Actions deploy job `95878185185` 成功，Pages live marker 返回同一完整 SHA。独立
`verify-pages.sh` 已执行，但其公共 API deployment 查询遇到 `403`，所以只记录可复核的 deploy
job、Pages URL 和 exact marker，不补造 deployment id。

### M7 surface-guide blocker repair（2026-08-19）

- 状态：`completed` 仅指本次 blocker repair；以下记录形成于 checked release 之前，最终发布状态见
  本节末的 M7 closeout。
- owner：只修改 `src/game/course.ts` 的 surface-guide fragment shader，将窄中心
  `navSpine` alpha 基值从 `0.18` 调到 `0.28`。宽的中性半透明水面 veil、波浪位移、tessellation、
  masks、open chevrons、route/physics/collision/AI/fixed-step 和资源数量均未改变。
- focused evidence：before 在
  `shots/visual-roadmap/M7/evidence/course-fix-before/`，after 在
  `shots/visual-roadmap/M7/evidence/course-fix-after/`；desktop 为 `1440x900` / DPR2、mobile
  为 `844x390` / DPR3，均为 `hairpin` 固定步截图。
- focused A/B probe：baseline 为 `p90Delta=86`、`p95Delta=111`、`meanDelta=51.8`、
  `softShare=.925`、`softMeanDelta=46.5`；final desktop 为 `p90Delta=118`、`p95Delta=163`、
  `meanDelta=63.88`、`softShare=.872`、`softMeanDelta=51.64`，mobile 为 `p90Delta=116`、
  `p95Delta=163`、`meanDelta=62.77`、`softShare=.876`、`softMeanDelta=50.75`。两端均满足未改变
  的 `p90 >= 90 && p90 < 185`、`p95 >= p90 + 10 && p95 < 260` 合同。
- renderer：desktop `189 calls / 2,025,000 px/frame / 16.7ms`，mobile `189 calls /
  2,057,250 px/frame / 16.7ms`；renderer ratios 为 `1.25` / `2.5`。无新增 instance pool、
  render target 或 fixed-step allocation。
- 验证：`npm run build` 通过，`npm run verify:flight` 通过（`gameplay contract: OK`、
  `gamepad input contract: OK`）。这是发布前 blocker-repair 记录；完整 release 结果见下方
  M7 closeout。

M0 基线 session（2026-08-18）以 clean `HEAD == origin/main`
`144c3bcce957417e8862e74f34637c93d44fb0f2` 完成：生成 18 张桌面 / 手机 before 截图，并通过
build、performance、flight/gamepad、mobile、collision、systems 和 diff-check。dirty
worktree 的未发布 `src/game/course.ts` 实验当时仍为 pending（其 `p90Delta=85` 未达阈值），已与
canonical baseline 分开保留。M1 独立复核已完成：临时目录 `/tmp/board-race-m1-review.WQGEga`
以 clean HEAD 只叠加 `src/water/ocean.ts`，`build`、`verify:performance`、`verify:flight` 和
`verify:mobile` 全部通过。该结果只证明 clean HEAD + M1 owner patch，不代表当时的 dirty
workspace 或线上成果；M7 blocker-repair handoff 已在上文记录当时的通过结果。本次 checked
release 结果见下方 M7 closeout。

## 当前版本

以下条目描述 M7 前已存在的稳定基线；M7 release 已将本工作树叠加的 M0-M6 visual candidate
deltas 与 M7 blocker repair 纳入 `428120044836951e266583481be35bbcadbbaa1f` 并完成 live marker
核验。

- 当前交付包含全车手 Final Station 真实过线排名、终点强光前的实体遮挡、真实 BOOST
  同源尾焰、动态海面高光、真实落水水冠 / 两舷水幕、中央破碎尾迹，以及合批竞速艇与真实蒙皮车手。
  精确版本以包含本文件的 Git commit 为准，
  不在交接正文复制一个随后必然过期的 SHA。
- checked release 会在提交前重新执行 build、flight、mobile、collision、audio、systems、
  performance 和 closeout；交接中的“已发布”只以该脚本成功后的远端 SHA 为准。
- 本项目发布默认不等待 GitHub Pages；本次已单独核对 Actions deploy job、Pages URL 和完整
  build marker，确认 `428120044836951e266583481be35bbcadbbaa1f` live。
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

已发布基线包含单个海面 draw call 内的连续风浪受光和尾流交互；本轮进一步的波涛、尾流
和落水实验尚未发布。除单个海面 draw call 内的连续风浪受光外，竞速艇现在会读取其他艇的
新鲜尾流，并用五点船体采样驱动极轻的姿态响应和艇首碎喷。尾流耦合只服务于“吃浪”的
身体可读性，仍不改 `waves.ts` 的水面高度、路线判定、起飞阈值或碰撞；后续若继续追求
商业竞速级浪峰细节，必须先证明不会淹没漂移、对手姿态、艇尾技巧提示或路线判读，动作
信息优先于水面炫技。

M1 session 的未发布材质实验只改了 `src/water/ocean.ts`：保留共享 Gerstner displacement
和单海面 draw，增加的连续法线 / 风浪受光保持为 normal-only；本轮收紧了高、陡、上升三条件
白浪和近船低对比留白，移除了额外的 broad storm crest 白化。`src/water/waves.ts`、浮力、
路线、碰撞、尾流采样均未改。固定相机 before/after 证据在
`shots/visual-roadmap/M1/`，但由于既有 dirty `src/game/course.ts` 的 flight contract
仍失败，本轮不能写成已发布；M1 隔离复核本身已完成，但不能把当前工作树的失败写成隔离候选失败。

新的分阶段验收顺序、截图矩阵、性能门和交接格式以临时路线图为准；不要把路线图中的
目标、待验证假设或旧截图当成当前产品承诺。

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

GitHub Pages 从 `main` 的 `deploy.yml` 部署。本次 `origin/main`、Actions deploy job、
`github-pages` artifact / environment 链接和线上 build marker 均指向
`428120044836951e266583481be35bbcadbbaa1f`；公共 API deployment 查询在独立 verifier 中返回
`403`，没有伪造 deployment id。

## 本轮验证

- clean `HEAD` M0 重新执行：`npm run build`、`npm run verify:performance`、
  `npm run verify:flight`、`npm run verify:mobile`、`npm run verify:collision`、
  `npm run verify:systems` 和 `git diff --check` 通过；本轮没有运行 release 或 jiepi-clear。
- canonical 截图矩阵为 clean baseline 的 9 个场景桌面 `1440x900` 与手机 `844x390` before，
  共 18 张；PNG 分别为 `2880x1800` 和 `2532x1170`。dirty 版本保存在
  `shots/visual-roadmap/M0/dirty-worktree/`，不作为发布资产。
- clean Auto `start` 为桌面 / 手机 `334` draw calls，drawing pixels 分别为 `2,025,000` /
  `2,057,250`；performance 合同输出 `1,997,196 px / 334 calls`，软件渲染 p50/p95/p99
  为 `466.6/666.7/950.0ms`。High 为 `369 / 4,097,600px`，Performance 为
  `334 / 1,296,000px`。
- clean 水花池为 idle `0/0`、landing contact `28 droplets + 1 volume`、settled `0/0`；
  容量为 `1536/12`。dirty worktree 的 flight 像素实验仍标记 `pending`，不得通过加亮、放宽
  阈值或顺手进入 M1 修复来掩盖。
- M1 隔离复核目录为 `/tmp/board-race-m1-review.WQGEga`：以 clean
  `HEAD=144c3bcce957417e8862e74f34637c93d44fb0f2` 为基线，只覆盖 `src/water/ocean.ts` 并链接
  `node_modules`。`npm run build` 通过（仅既有 chunk-size warning）；`npm run verify:performance`
  通过，输出 `1,997,196px / 334 calls`，software p50/p95/p99 为 `450.0/466.8/483.4ms`；
  `npm run verify:flight` 通过（gameplay/gamepad OK）；`npm run verify:mobile` 通过（mobile
  controls OK）。当前 dirty 工作树的 `src/game/course.ts` 仍是 pending，`p90Delta=86` 要求
  `>=90`；该失败不归因于 ocean patch，也不代表隔离候选或线上成果。
- M1 同一 `start` 场景的三档采样：Auto `334 calls / 2,025,000px / 16.7ms / spray 134+4`，
  High `369 / 4,097,600px / 16.7ms / 189+4`，Performance `334 / 1,296,000px / 16.7ms /
  fineDetail=0 / spray 88+4`；三档均为 `246,248` ocean triangles、`124,725` vertices、
  单 draw、opaque、depthWrite。采样还确认 pool capacity `1536/12`，没有新增实例池。
- M1 截图矩阵为桌面 `2880x1800` PNG 的 `water/hairpin/wake-close/landing-plume/start`
  加远景逆光，以及手机 `2532x1170` 的 `water/start`，before/after 均保留在
  `shots/visual-roadmap/M1/before/` 和 `shots/visual-roadmap/M1/after/`。固定相机 RMSE 为
  `water .01956`、`hairpin .00512`、`wake-close .03477`、`landing-plume .02425`、
  `start .01393`；手机 `water .01712`、`start .01534`。水面 ROI 的 80% 亮像素为 water
  `10.5345% -> 10.3547%`、wake-close `0.6099% -> 0.5309%`。
- M1 task 已标为 `completed`（仅隔离候选），现有 before/after 截图只检查路径、尺寸和代表性
  画面，未重写。未运行 collision/systems，因为 `waves.ts` 未改；未运行 release、commit 或 push。

### 全局美术渲染性能标准（摘要）

完整标准唯一维护在 [`llmwiki.md`](llmwiki.md) 的“全局美术渲染性能合同”中，本文件只保留
本次交付的结果：船体五批静态材质、16 骨骼真实车手、动态效果实例化 / TypedArray 池、
局部安全剔除和中性白雾航道均已通过性能与视觉合同。后续新增美术或特效必须回到该合同，
同时提供资源 / 渲染指标和固定相机视觉证据；不要在交接文档复制第二套参数。

## 接手顺序

1. 先读 `AGENTS.md` 和 [`llmwiki.md`](llmwiki.md)，确认输入、固定步进、路线所有权和视觉分支规则。
2. 再根据任务阅读本文件对应的“未完成与暂缓”项；没有明确任务不要顺手扩展声音、资料片或电台。
3. 改动物理、生命周期、音频、记录或渲染后，运行对应 harness；跨模块改动最后运行 `npm run verify:release`。
4. 发布时默认使用 `npm run release:checked -- --no-wait-pages "type: message"`；Pages live verification 独立进行，并在下一次交接中如实保留状态。

## 交接检查

- [x] 当前分支和最近提交已记录。
- [x] 已完成事项与未完成事项分开。
- [x] 资料片、环境声音和人味内容的边界已明确。
- [x] M7 blocker repair 已执行并记录；`npm run verify:flight` 的 gameplay/gamepad 与 surface-guide
      pixel contract 通过，未进入 commit / push。
- [x] 临时路线图的 `M0-M7` 全部完成，并为每个 task 留下独立截图、性能读数和 handoff。
- [x] 本 task 已同步 `docs/llmwiki.md`、本文件和 `docs/knowledge-map.json`；blocker、checked
      release、remote SHA 和 live marker 均已记录。
- [x] Pages live 已按候选 SHA 核验；Android / iOS 真机听感和任何新增资产的最终验收仍按需完成，
      不属于本次交接已验证范围。

## M2 尾流、水花与开场贴水交接（2026-08-19）

- 状态：`completed` 仅对 `/tmp/board-race-m2-isolation-20260819` 的未发布隔离候选成立；没有 commit、push、release 或线上成果。
- owner：`src/water/wake.ts`、`src/water/spray.ts`。尾流主读为断续中央含气湍流，Kelvin 肩浪为低透明次级层；落水沿真实接触点/速度方向复用池化 crown/sheet 与 TypedArray droplets。未改 `boat.ts`、`main.ts`、`course.ts`，开场贴水通过既有 presentation sync 验证。
- 截图：`shots/visual-roadmap/M2/before/` 和 `shots/visual-roadmap/M2/after/`；桌面包含 `ready`、`countdown`、`start`、`wake-close`、`wake-close-no-wake`、`landing-impact`、`landing-plume`、`boost-burst`，手机包含 `start-mobile`、`landing-impact-mobile`。
- 固定渲染证据（1440x900、DPR2）：Auto `334 / 2,025,000 px / 16.7ms`，High `369 / 4,097,600 px / 16.7ms`，Performance `334 / 1,296,000 px / 16.7ms`。落水 active droplets 峰值 `28/40/18`，active landing volumes `1/1/1`，容量 `1536/12`，settle 后实例 `0/0`。
- 隔离验证：clean `HEAD=144c3bcce957417e8862e74f34637c93d44fb0f2` 加 M1 `ocean.ts` 和 M2 两个 owner 文件的 build、performance、flight/gamepad、collision、mobile 全通过；performance 输出 `1,997,196 px / 334 calls`，software p50/p95/p99 `450.0/483.2/550.0ms`。
- 主工作树的 `verify:flight` 仍被用户已有 dirty `src/game/course.ts` surface-guide `p90Delta=86`（要求 `>=90`）挡在 owner 断言前；该文件和阈值均未修改。当前 dirty 实验必须继续保持 pending，不能把隔离通过写成线上通过。
- 文档已同步：本 task、`docs/llmwiki.md`、本文件、`docs/knowledge-map.json`。下一 M3 由后续独立 session 处理；本 session 不做 M3。

## M3 车手视觉重做交接（2026-08-19）

- 状态：`completed` 仅对 `/tmp/board-race-m3-isolation-20260819.GrZPXp` 的未发布隔离候选成立；没有 commit、push、release 或线上成果。
- owner：只改 `src/game/riderMesh.ts`。车手保持每人一个真实顶点调色 `SkinnedMesh`、16 根骨骼、原 `rider.ts` 状态驱动、rider mount、collision envelope、实体遮挡和 ink layer；低质量对手继续使用同一真实 rider beauty / ink prepass。圆角 loft / 软板、主色明暗服装层、彩色头盔、背部保护、关节和靴底分区改善近 / 中距离的身体体积、法线和动作重量；没有纹理、atlas、额外 draw、代理或循环摆 pose。
- 截图：`shots/visual-roadmap/M3/before/` 与 `shots/visual-roadmap/M3/after/`；桌面 `rider-close`、`start`、玩家 `drift-charge`、对手真实链漂 `opponent-drift-chase-hold/release`、`flight-cruise`、`landing-impact`、`final-station`，手机 `start`、`hairpin`，固定桌面 `1440x900 DPR2 Auto` 和手机 `844x390 Auto`。桌面 PNG `2880x1800`，手机 PNG `2532x1170`，before / after 均为非空像素。
- 机器证据：主树 `build`、`verify:mobile`、`verify:collision`、`verify:systems`、`verify:performance` 通过；主树 `verify:flight` 仍被用户已有 dirty `src/game/course.ts` 的 `p90Delta=86`（阈值 `>=90`）挡在 owner 断言前。隔离 clean HEAD `144c3bcce957417e8862e74f34637c93d44fb0f2` 加已验证 M1 `ocean.ts`、M2 `wake.ts` / `spray.ts` 和 M3 `riderMesh.ts` 后，build、flight/gamepad、mobile、collision、systems、performance 全通过；Auto `334 calls / 1,997,196 px / 16.7ms`，software p50/p95/p99 `466.7/533.4/549.9ms`。rider-only audit 为每艘 `beautyMeshCount=1`、`inkMeshCount=1`、`bones=16`，玩家有一个共享 outline；fixed-step 后 16/16 bones 改变。
- 遗留风险：主树 dirty course / ocean / wake / spray / post / screenshot 实验不属于 M3 证据且保持 pending；真实设备、线上发布和 Pages 未验收。下一 task 为 M4，需另开 session 且先保持 rider mount / skeleton / ink 合同。

## M4 船体视觉重做与合批交接（2026-08-19）

- 状态：`completed` 仅对 `/tmp/board-race-m4-isolation-20260819.4W7PZ7` 的未发布隔离候选成立；没有 commit、push、release 或线上成果。主工作树仍保留既有 dirty course / ocean / wake / spray / post / screenshot 实验。
- owner：只修改 `src/game/boat.ts`。船壳、甲板和侧面涂装在构建期焊接顶点并计算连续法线；六艘船继续各自五个静态批次，使用共享合批几何和共享非涂装材质。`boat-*` 外层 transform、碰撞 envelope、riderMount、wake / spray / flight anchor、真实 boat transform、rider 16 骨骼、输入、物理、AI、progress、生命周期和 fixed-step 均未改。
- 截图：`shots/visual-roadmap/M4/before/` 与 `shots/visual-roadmap/M4/after/`；桌面固定 1440x900 DPR2 Auto，覆盖 rider、侧后方、逆光、漂移、飞行、落水、碰撞、Final station，手机固定 844x390 横屏覆盖 `start` 与 `landing-impact`。桌面 PNG 2880x1800，手机 PNG 2532x1170，before / after 均通过尺寸和非空像素检查。
- 机器证据：主树 build、collision、mobile、systems、performance 通过；主树 flight 仍被 dirty `course.ts` 的 `p90Delta=86`（要求 `>=90`）挡在 owner 断言前。隔离候选 build、flight/gamepad、collision、mobile、systems、performance 全通过；Auto / High / Performance 为 `334 / 2,025,000px / 16.7ms`、`369 / 4,097,600px / 16.7ms`、`334 / 1,296,000px / 16.7ms`。每艘船 5 批，唯一批次几何 5、批次几何引用 30，唯一批次材质 15、材质引用 30；场景资源 `218 / 276 / 15`（geometry / material / texture）。Final portal 遮挡、collision、rider mount、boat transform 和低质量真实 beauty + ink 证据已归档。
- 遗留风险：主树 flight、真实设备、Actions、Pages 和线上 build marker 未验证；dirty 非 M4 owner 实验保持 pending。不得把 M4 隔离通过写成已推送、已部署或 live verified。
- 下一 task：后续独立 session 处理 M5；本 session 不运行 release，不提交或推送。

## M5 世界空间英文名牌交接（2026-08-19）

- 状态：`completed` 仅对 `/tmp/board-race-m5-review-20260819` 的未发布隔离候选成立；基线为 clean `HEAD=144c3bcce957417e8862e74f34637c93d44fb0f2` 加已验证 M1/M2/M3/M4 owner 和 M5 owner/wiring。本 session 没有 commit、push、release、Pages 或真实设备验收。
- owner：新增 `src/game/worldNameplates.ts`，`src/main.ts` 仅作固定六目标构造、READY roster atlas 更新，以及生产 / harness capture / perf render 的 update wiring。名称严格为 `GLM`、`ChatGPT`、`Gemini`、`Kimi`、`Claude`、`DeepSeek`；没有改 racer profile、中文 callsign、HUD rank/driver labels、boat、rider、course、water/wake/spray、physics、input、collision、postPipeline 或 harness。
- 世界空间合同：每个实例从真实 `boat.riderMount` 的 local anchor `(0,1.72,-1.18)` 求 world position，render phase camera-face；共享 `2048x128` atlas、一个 PlaneGeometry、一个 ShaderMaterial、六个 InstancedMesh capacity，atlas 只在构造 / READY roster 变化时重绘。`depthTest=true`、`depthWrite=false`，真实 hull/rider/gate/route 负责遮挡；`96m` fade start、`160m` despawn。移动端只在原世界锚点落入底部 controls band 时隐藏，不移动到屏幕坐标。armed Final portal 的 target-reading window 暂时隐藏，冻结 Final Station 保留；low quality 与桌面 / 手机共用实体策略。
- 截图证据：`shots/visual-roadmap/M5/before/` 与 `shots/visual-roadmap/M5/after/` 具备相同固定 seed/camera/quality 的 near/mid/far、portal occlusion、drift、flight、landing、Final station/hero/settled 和 mobile 矩阵。桌面 `1440x900 DPR2 Auto`，PNG `2880x1800`；手机 `844x390 DPR3 Auto`，PNG `2532x1170`。全部图片通过尺寸 / 非零像素检查，并检查代表性桌面、手机画面非空且取景正确。
- 机器证据：desktop-auto probe 的 near/mid/far/drift/flight/landing/final 为 `153/307/127/304/228/145/282 calls`、`2,025,000 px/frame`；mobile DPR3 为 `193/327/127/304/228/155/302 calls`、`2,057,250 px/frame`。active 普通峰值 6，landing 1，mobile control-band suppression 后 mid/flight 5，portal active false/count 0；active draw instances 6，atlas `2048x128`，geometry/material 各 1 个共享对象，fade/despawn `96/160m`。Performance `1,296,000 px/frame`，没有 low-quality 分叉。所有 M5 owner 工作均在 render phase，无 per-fixed-step allocation。
- 验证：主树 `npm run build`、`npm run verify:mobile`、`npm run verify:systems`、`npm run verify:performance`、`npm run verify:collision` 通过；主树 `npm run verify:flight` 仍被已有 dirty `course.ts` `p90Delta=86`（要求 `>=90`）挡住，本轮未动 course / threshold。隔离候选依次通过 `npm run build`、`npm run verify:flight`（gameplay/gamepad）、`npm run verify:mobile`、`npm run verify:collision`、`npm run verify:systems`、`npm run verify:performance`；isolated performance `1,997,196 px / 335 calls`，software p50/p95/p99 `466.6/516.7/566.6ms`。
- 风险 / 下一步：M5 仍未发布；dirty course 与既有 M1-M4 实验、真实设备、Actions、Pages 继续 pending。下一 task 是 M6，另开 session。收尾必须保持 `git diff --check`、JSON parse、进程清场和“不 commit/push”事实一致。

## M6 全局美术整合与动作可读性 session 复核（2026-08-19）

- 状态：`completed` 仅对未发布隔离候选 `/tmp/board-race-m6-isolation.otWwe1`
  成立；clean base 为 `HEAD=144c3bcce957417e8862e74f34637c93d44fb0f2` 加已验证
  M1-M5 review tree 和本轮 M6 owner。没有 commit、push、release、GitHub、Pages
  或 live 验证。本地 dirty experiments 仍 unpublished。
- owner：只改 `src/cel/postPipeline.ts` 的现有 fullscreen shader 组合。M6
  delta 通过中心 action window、surface-only ambient subtraction、flight
  preservation 和少量 unwarped ink subject clarity 减少后处理对漂移、BOOST、
  overtake、门、落水、碰撞和 Final 的遮挡；没有增加 draw、实例、材质、纹理、
  render target、fixed-step 分配或 detached loop。该文件原有 lane/wind dirty
  实验不属于本 session 的 M6 claim。
- 保护面：没有改 `boat.ts`、`rider.ts`、`riderMesh.ts`、`course.ts`、
  `ocean.ts`、`wake.ts`、`spray.ts`、`worldNameplates.ts`、`main.ts`、HUD、
  audio、physics、input、collision、harness 或 release scripts；rider 16-bone
  skin、mount、boat transform/collision、五批船体、ink、route/Final 和 fixed-step
  仍由原 owner 管理。
- 截图：`shots/visual-roadmap/M6/before/` 与 `after/` 都有桌面和手机完整矩阵，
  包含 `ready/countdown/start/sweeper/hairpin/drift-charge/opponent-drift`
  hold/release、`overtake-chain/flight-route4-approach/flight-cruise/landing-impact`
  `collision/sky-sun/final-station` impact/hero/settled。桌面 capture `1440x900`
  DPR2、PNG `2880x1800`、Auto renderer ratio `1.25`；手机横屏 `844x390` DPR3、
  PNG `2532x1170`、Auto renderer ratio `2.5`。fresh harness run seed 为 1，
  fixed-step，same scenario order。失败 probe 单独在 `M6/evidence/failed-probes.md`，
  没有计入 before/after。
- 机器证据：Auto desktop calls `335/274/225/145/73`（start/drift/flight/
  landing/collision），`2,025,000 px/frame`，`16.7ms`；Auto mobile
  `335/274/225/155/73`，`2,057,250 px/frame`，`16.7ms`。Performance desktop
  `1,296,000 px/frame`、mobile `329,160 px/frame`，两者 `16.7ms`。M6 新增
  active instances/draw calls/render targets 均为 `0`；既有 nameplate capacity
  `6` 和 pooled effect ownership 不变。isolated performance 为
  `1,997,196 px / 335 calls`，software p50/p95/p99 `466.7/499.9/500.1ms`。
- dirty gates：build、mobile、collision、audio、systems、performance 通过；
  必须运行的 dirty `npm run verify:release` 在 `verify:flight` 先被已知 dirty
  `src/game/course.ts` surface-guide `p90Delta=86`（要求 `>=90`）挡住。没有改
  course 或阈值。isolated 最终 `npm run verify:release` 的 build、flight/gameplay+
  gamepad、mobile、collision、audio、systems、performance 全部通过。
- 失败与回归：第一版 isolated M6 让 flight corridor probe 降到 `p95Delta=65`，
  后续修正为 active flight 保留 route composition；一次独立 Space/countdown timing
  probe 读到 `ready` 而非 `countdown`，立即 rerun 通过。详细记录在
  `shots/visual-roadmap/M6/evidence/failed-probes.md`，完整矩阵与指标在
  `shots/visual-roadmap/M6/evidence/closeout.md`。
- 下一步：M6 只停留在未发布隔离候选；真实设备、Actions、Pages、release approval
  留给 M7。当前 dirty course 和既有 visual experiments 继续 pending；本 session 不
  进入 M7。

## M7 发布、洁癖与线上核验 session（2026-08-19）

- 状态：`completed / live-verified`。M0-M6 候选与 M7 course repair 已由 checked release
  发布；本次 post-push 只更新知识收尾记录，没有继续修改 gameplay / visual source owner。
- candidate release commit 与 release-time `origin/main`：`428120044836951e266583481be35bbcadbbaa1f`。代码状态为
  `pushed-and-live-verified`，运行态 `live-verified`，文档 `changed-and-verified`，规则
  `verified-current`，记忆 `generated-read-only`，工作区 `clean`；忽略的截图与临时路线图现场
  仍保留，未执行清场。
- 最终 before 证据在 `shots/visual-roadmap/M7/before/`：fresh `?harness=1`、run seed
  `1`、fixed-step、Auto quality；桌面 `1440x900` / browser DPR2 / PNG `2880x1800`
  共 15 张，手机横屏 `844x390` / browser DPR3 / PNG `2532x1170` 共 15 张。矩阵覆盖
  READY、countdown、opening、surface chase / hairpin / drift、rival BOOST hold/release、
  fourth-flight approach、flight、landing、overtake、sky/sun 和 Final Station。
- fresh screenshot machine evidence：桌面 draw calls `95-335`、`2,025,000 px/frame`、
  renderer ratio `1.25`、frame `16.7ms`；手机 draw calls `105-335`、
  `2,057,250 px/frame`、ratio `2.5`、frame `16.7ms`。Focused runtime probe 记录
  desktop start `world-nameplates 6/6`, droplets `134`; landing `world-nameplates 6/6`,
  droplets `28`, landing volumes `1`。M7 没有新增 draw、instance pool、render target
  或 fixed-step allocation。
- `npm run release:checked -- --plan --no-wait-pages "feat: commercial art milestones"` 计划通过；
  随后执行同一 checked release，closeout、build、gameplay、mobile、collision、audio、systems、
  performance 八道门禁通过并完成 commit / push / remote-SHA 校验。`node /mnt/c/Users/
  wanghongping/.codex/skills/jiepi-clear/scripts/check-knowledge-map.mjs /home/github/board-race`
  和 `git diff --check` 也通过。
- Actions workflow `32188235255` 的 deploy job `95878185185` 成功，`github-pages` artifact 与
  Pages URL `https://big-dimple.github.io/board-race/` 可复核；live 首页的完整 `build-sha`
  marker 匹配上述 SHA。独立 `verify-pages.sh` 已执行，但公共 API deployment 查询返回 `403`，
  没有把缺失的 deployment id 写成已知事实。
- 事实归属：`project-status` 的完整状态由本文件负责；商业路线状态由
  `docs/commercial-art-roadmap.md` 负责；`docs/llmwiki.md` 只保留 M7 合同和证据摘要；
  `docs/knowledge-map.json` 已同步 verifier / status / release metadata。删除候选
  仍待用户在完整汇报后明确确认，当前不清场。
