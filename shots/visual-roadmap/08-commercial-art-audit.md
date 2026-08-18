# M8 商业视觉整合审查

状态：`ready`

## 背景

M7 已把 M0-M6 候选发布到 Pages，但固定截图的整体观感仍停留在技术演示：海面是大面积
蓝色雾化，船人与对手在动作区缺乏重量，尾流像透明道路，起终点门像占位几何，终点闪光
洗掉主体，移动控件又抢走了构图。这个 task 不是增加更多特效，而是做一次商业竞速视觉
导演式的收敛，把第一眼的主体、速度、路线、风险和结果层级排清楚。

## Owner 文件

源码 owner 只允许：

- `src/water/ocean.ts`
- `src/water/wake.ts`
- `src/water/spray.ts`
- `src/cel/postPipeline.ts`
- `src/hud/hud.css`
- `src/hud/raceTower.css`
- `src/hud/finaleCelebration.ts`
- `src/hud/finaleOverlay.css`
- `src/core/mobileControls.css`

允许同步的事实文档：`docs/llmwiki.md`、`docs/development-handoff.md`、
`docs/knowledge-map.json`，以及本 task 文档的末尾交接。不得修改 `waves.ts`、BoatInput、
固定步物理、rider/boat geometry、rider mount、boat collision、ink/prepass、五批合批合同、
实例化池、路线判定、任何 harness 阈值或 release gate。

## 必须解决的审美问题

1. 比赛截图第一眼必须读到玩家艇 / 车手轮廓、前方路线和至少一个对手；海面需要有方向性
   的风浪、受控波光和稀疏白浪，但不能成为蓝色雾墙、白色大斑或发光道路。
2. 玩家艇尾必须是破碎的中央含气水带，Kelvin 肩浪只能是断续低对比副信息；尾流不能再
   读成两条连续白线，也不能是填满赛道的透明带。落水水冠和滴水要只在真实事件出现。
3. HUD、教练卡、排名塔和移动控制必须形成一个安静、坚固的竞速仪表系统。移动触控区域
   的命中范围和左右 / 漂移 / 飞行位置不能变，只能降低遮挡、装饰噪音和圆盘体积感；不能
   通过去掉动作信息来“美化”。
4. 起点、飞行、落水、对手 BOOST 和 Final Station 都要有自己的颜色和亮度层级；任何脉冲
   都必须让动作更容易辨认。终点闪光不能把海面、门、玩家艇和 HUD 洗成同一块白色。
5. 所有调整必须服务同一套方向：海水是深青蓝，速度和路线用克制的青 / 绿，玩家用高对比
   品红，结果用金色；禁止继续叠加随机霓虹、厚重黑描边、硬边白条和廉价 bloom。

## 验收合同

- 开始前必须读取 `AGENTS.md`、`docs/llmwiki.md`、`docs/development-handoff.md`、
  `docs/knowledge-map.json`、`shots/visual-roadmap/README.md` 和本文件。
- 用同一 seed / 质量档 / 固定相机建立 before：桌面 `1440x900` 与横屏手机 `844x390`，
  至少覆盖 start、hairpin、drift/BOOST、flight、landing、finale 六个关键帧。改完生成完全
  对应的 after，不能只截一张最好看的画面。
- 必须记录 draw calls、活跃实例 / 池实例、drawing pixels/frame、帧时、DPR 或资源数量中的
  至少一项机器证据；必须运行与 owner 相关的 harness，至少 build、performance、flight、
  mobile，并运行完整 `npm run verify:release`。
- 不得降低任何既有阈值，不得把 pending 写成 completed，不得用截图后处理或文档措辞掩盖
  实际画面问题。若某个目标仍失败，继续在本 task 内迭代，不反向询问用户选择。
- 完成时同步 `llmwiki`、`development-handoff`、`knowledge-map`，在本文件末尾记录实际改动、
  before/after 截图、机器证据、harness、遗留风险和下一 task。M8 未通过截图和机器证据前，
  不得提交或推送。

## 审美门槛

把截图缩小到约 25% 观察时，仍必须能回答：我是谁、我在往哪里走、谁在威胁我、我刚刚做了
什么、下一次动作是什么。只要主体被雾、HUD、指导卡或终点闪光吞掉，状态就保持 `pending`。

## 交接

状态：`pending / pages-unverified`

实际改动：只修改允许 owner：`ocean.ts` 以深青蓝 `0x063c54 -> 0x0b7184 -> 0x5ac3bd` 收敛海面
纵深、波光和白浪；`wake.ts` / `spray.ts` 保留单 mesh / 池化事件路径并降低白色道路感；
`postPipeline.ts` 压低中心 action window 的 energy、风带和 air-brake 亮度并提升真实 ink subject
清晰度；`hud.css` / `raceTower.css` / `mobileControls.css` 收敛面板、排名和移动可见面；
`finaleCelebration.ts` / `finaleOverlay.css` 降低全屏 flash、火花、光晕和结果标题遮挡。未修改
waves、BoatInput、fixed-step、boat/rider、collision、AI、ink/prepass、合批、路线或阈值。

截图：before 保留于 `shots/visual-roadmap/M8/before/desktop/`、`shots/visual-roadmap/M8/before/mobile/`；
after 保留于 `shots/visual-roadmap/M8/after/desktop/`、`shots/visual-roadmap/M8/after/mobile/`。
两套均覆盖 `start`、`hairpin`、`opponent-drift-boost`、`flight-cruise`、`landing-impact`，Final
覆盖 `finale-impact/hero/settled`。viewport 为桌面 `1440x900` 与横屏手机 `844x390`，PNG 为
桌面 `2880x1800`、手机 `2532x1170`；before 未被 after 覆盖。

机器证据：桌面六帧 draw calls 为 `335/173/300/225/95/228`，triangles 为
`383569/311391/381699/335599/306393/372969`；手机为 `335/177/144/225/105/227` 与
`383569/313623/342703/334873/307903/373067`。桌面统一 `2,025,000 drawing pixels/frame`、
`16.7ms`、`DPR1.25`；手机统一 `2,057,250`、`16.7ms`、`DPR2.5`。Pool evidence 为 ocean
`246248 triangles / 1 mesh / 1 draw`、wake `720 positions / 2154 indices / 1 mesh`、spray
capacity `1536` 且 idle `0/0` droplet/volume instances。

Harness：`npm run build`、`npm run verify:performance`、`npm run verify:flight`、
`npm run verify:mobile`、`npm run verify:release` 全部通过，未调整阈值。一次并发截图启动造成
严格 `5199` 端口竞争，mobile opponent 随后隔离重跑并通过既有 `changedCss >= 220`、
`meanDelta >= 12` release-pulse 合同；无 Vite 残留。

Release：`npm run release:checked -- --no-wait-pages "feat: commercial art integration pass"` 的
plan 与正式执行均通过，八道 gate、commit、push、remote-SHA 校验完成。首个 release SHA 为
`d8e012c4d388d08d4e0e855fadc617146267b022`，`origin/main` 与本地一致。Actions 已观测到
workflow run `32195338481` / run `#84`，URL 为
`https://github.com/big-dimple/board-race/actions/runs/32195338481`；官方
`verify-pages.sh --timeout 600` 的真实结果是 `Pages workflow did not complete before timeout`，
期间 GitHub API 与页面请求反复返回 HTTP `403`，因此没有记录或伪造 deployment id，也不能声称
Pages live build-sha 已核验。

文档同步：本段事实同步到 `docs/llmwiki.md`、`docs/development-handoff.md`、
`docs/knowledge-map.json`；文档收尾 release 仍需在本段更新后执行。遗留风险仍为 Final station
authored white gate geometry 属于本轮禁止扩张的 route owner，只能通过海面、后处理和庆祝层对比
改善；真实设备视觉和线上 Pages 仍未核验。

精确 blocker：代码发布已完成，但 Pages workflow 在官方 600 秒核验窗口内未完成，且公共 API / Pages
请求受 HTTP `403` 阻塞，无法取得成功 deployment 或 live marker 证据。下一 task 应从该 workflow
和 GitHub Pages 可访问性继续；在 blocker 消失前不得把本 task 写成 `completed`。
