# Board Race 开发交接

状态：主分支当前工作包已圆满交付“高光时刻视频与回放底层逻辑重构（导弹击落与720°爆炸翻滚实录回放）、霸气战斧巡航导弹与超萌卡通大鲨鱼导弹全尺寸 3D 造型与实弹呈现、灯塔唯美三层体积光束与星芒透镜光晕（POTG Missile Replay, Dominator Tomahawk & Chibi Shark 3D Models, Tri-Layer Aesthetic Lighthouse Beam）”。

## 当前工作包

- **高光时刻视频与回放底层逻辑重构（POTG Missile Replay & Climax Explosion Tracking）**：
  1. **全量导弹与爆炸火球环形缓冲录像**：`HighlightRecorder`（`src/game/highlightRecorder.ts`）与 `HighlightSample` 全面纳入导弹 3D 空间轨迹、四元数姿态与爆炸火球（`missiles: ReplayMissileSnapshot[]`），彻底解决“空中被导弹炸回放播放不了/突然掉到底上/没有被炸飞”的底层阉割问题；
  2. **高光回放实时渲染导弹飞行与空中爆炸**：`main.ts` 在 `updateHighlightVideoPresentation` 中实时插值并同步导弹飞行网格与爆炸火球膨胀，高光回放可完整重现导弹从发射、超音速逼近、凌空精准命中直击到 720° 腾云爆炸翻滚坠海的全过程；
  3. **导弹击落高光候选专属权重与 0.20x 极度慢动作子弹时间**：
     - 当发生导弹击落时，`tagDefeat` 自动打上最高权重 **100**、得分 **1680** 的专属高光标签：`💥 遭遇超音速导弹轰杀 · 翻滚 720°`（副标题：`飞行空域遭遇战斧/鲨鱼导弹精准直击 · 720° 腾云爆炸坠海`，评级：`[ EX · 喜剧之神 // 凌空轰炸 ]`）；
     - 回放自动将镜头焦点精准居中对齐导弹命中的爆炸峰值时间点（`peakTime`），在命中瞬间执行 **0.20x 极度子弹时间慢动作** 与近景俯冲盘旋特写，视觉冲击力与喜剧效果拉满！
  4. **失败语录精准对齐导弹命中**：`src/contracts.ts`、`src/game/boat.ts` 与 `src/hud/hud.ts` 新增 `'missile_blast'` 专属失败类型，失败结算界面与复盘教训精准展示 `💥 遭遇导弹超音速轰杀 · 翻滚 720°` 及针对性的漂移规避教学建议，彻底告别与事实不符的无关失败信息。

- **霸气战斧巡航导弹与超萌卡通大鲨鱼导弹 3D 造型与实弹呈现（Dominator Tomahawk & Chibi Shark 3D Models & Full Visibility）**：
  1. **2.2 倍全尺寸霸气重装战斧巡航导弹（Dominator Dark Tactical Tomahawk）**：
     - $5.2\text{m}$ 哑光碳黑与钛灰涂装长圆柱弹体、红宝石发光红外导引头（`0xff1e00`）、明黄警示斜纹带、4 片前置鸭翼 + 4 片警告红尖尾翼；
     - 双层超音速马赫环（Mach Shockwave Rings）与三层金橙+白金核芯火箭喷射尾焰；
  2. **2.2 倍全尺寸超萌Q版大眼鲨鱼导弹（Chibi Kawaii Shark Banger）**：
     - $4.2\text{m}$ 饱满圆润的青蓝色海洋弹体、珠光白腹皮、超萌大眼珠配专属高光星芒、粉红萌系腮红面颊、大嘴鲨鱼利齿锯齿涂装、背部高挺背鳍与流线胸鳍、金黄色火箭喷火尾焰；
  3. **单人与双人模式全场景导弹发射与更新**：`src/main.ts` 确保在单人竞速与双人对决中，导弹物理轨迹与发射架点火均高频更新，赛道两侧导轨与空域均可清晰观赏两大神级导弹外观。

- **灯塔唯美细腻三层体积光束与星芒透镜光晕（Aesthetic Tri-Layer Volumetric Beam & Starburst Lens Flare）**：
  1. **三层同心体积光锥架构（Tri-Layer Volumetric Cones）**：
     - **Layer 1（钻石针状准直光芯）**：长度 $320\text{m}$，半径 $0.28\text{m}\sim 2.6\text{m}$，纯净炽热白金发光核心（`0xfff8e0`），高强度穿透力；
     - **Layer 2（暖金琥珀丁达尔光柱）**：长度 $340\text{m}$，半径 $0.55\text{m}\sim 7.8\text{m}$，暖金琥珀色（`0xffaa33`）大气 Mie 散射柱身，细腻指数级纵向衰减（$e^{-1.85 t}$）与微粒粉尘动态呼吸；
     - **Layer 3（唯美晨雾透光光晕）**：长度 $360\text{m}$，半径 $0.95\text{m}\sim 14.5\text{m}$，如梦如幻的轻柔外层空气晕（`0xff8811`），边缘与夜空无缝自然过渡；
  2. **解析连续体积截面着色器（Analytic Smooth Cross-Section Shader）**：
     - 彻底消除以往折叠拼缝与镂空圆筒硬边缘，基于圆柱体线视径解析公式计算光深，截面呈现 100% 丝滑柔和的摄影级高斯过渡；
  3. **六芒星金辉透镜光晕与变形宽荧幕眩光（6-Point Starburst & Anamorphic Lens Flare）**：
     - 在灯塔灯室核心架设自适应朝向摄像机的六芒星芒耀斑与水平宽荧幕变形眩光条带；当旋转光束扫过玩家摄像机视角时，触发犹如真实海岸灯塔摄影般震撼夺目的金光闪耀效果！

- **全量高光成就候选池高权重评分引擎（Weighted Achievement Highlight Candidate Engine）**：
  1. **告别单点覆盖，建立候选池动态评分机制**：
     - **[ SSS · 破空神话 ] 穿云过门 / 飞行通道极限穿越**：权重 **100**，得分 $1200\sim 1500$（最高优先级，完美过门必上高光！）；
     - **[ SSS · 弯道主宰 ] 极限深漂 / 弯心反打贴角**：权重 **85**，得分 $900\sim 1200$；
     - **[ SS · 猎风突袭 ] 氮气喷射 / 绝影突袭超车**：权重 **75**，得分 $800\sim 1050$；
     - **[ S · 逐浪飞仙 ] 巨浪腾跃 / 踏浪飞驰**：权重 **65**，得分 $700\sim 900$；
     - **[ SSS · 战术大师 ] 双人导弹精确打击**：权重 **90**，得分 $1100$；
     - **[ EX · 喜剧之神 ] 翻车 / 撞障回弹**：权重仅 **15**（低权重保底兜底），得分 $60\sim 120$；
  2. **正能量高光绝对优先**：只要整局比赛中玩家打出过任何一次穿云、深漂、喷射或腾空，其高光权重大幅超越翻车 50~100 倍，高光回放将百分之百锁定最惊艳的成就高光瞬间！

- **双模导弹体系与命中机制修缮（Dual-Style Missiles & True Water Drift Hit Logic）**：
  1. **双模导弹体系交替发射（Dual-Style Missiles）**：
     - **霸气重装战斧巡航导弹（Dominator Dark Tomahawk）**：哑光碳钛合金机身、雷达导引头、前置鸭翼与后掠后缘三角翼、超音速马赫环尾焰；
     - **超萌Q版大眼鲨鱼导弹（Chibi Kawaii Shark Banger）**：圆润Q萌弹体、水蓝色海洋涂装与白色肚皮、超萌大眼珠、粉红腮红与鲨鱼利齿涂装、背部背鳍与萌感侧鳍；
     - 灯塔发射台 4 个导轨交替配备并点火弹射，兼顾军事霸气与二次元爆笑萌感；
  2. **彻底移除红色提线木偶线（No Puppet String）**：删除 `trail` 连线几何体，导弹飞行以纯净 3D 箭体、超音速马赫环喷焰与膨胀大爆炸光球呈现；
  3. **修复空中飞可以豁免到的 Bug**：严格限制仅当快艇在**真实海面上**（`flightPhase === 'surface' && !airborne`）高速漂移时才享有 50% 规避豁免；空中腾空、起飞滑翔或直行冲刺时一律 90% 绝对精确轰炸击落！

- **全场赛艇多船同步录像与对手实时回放（Multi-Boat Full Replay Recording）**：
  1. **全员赛艇位置与姿态高频录制**：`HighlightRecorder` 重构为全量多船环形缓冲采样，完整记录主驾快艇及赛道上全部对手/AI快艇（`boats[1..N]`）的 3D 坐标、四元数姿态、车手动画、速度与航行模式（漂移/喷射/飞行）；
  2. **高光回放对手完全可见、激烈角逐**：在回放播放中实时同步插值还原所有对手与玩家并驾齐驱、贴弯角逐与起飞超车的全景实况，彻底杜绝“空无一船只有地图”的 Bug；
  3. **7.5秒超长电竞级广播时长（7.5s Duration）**：高光片段从 5.2s 延长至 7.5s，并配备商业 3 段式电竞运镜（Angle 1: 0.0–2.8s 上帝天眼全局鸟瞰广角建立、Angle 2: 2.8–5.4s 0.35x 子弹时间慢动作 360° 上帝盘旋、Angle 3: 5.4–7.5s 1.15x 终点前向远景长焦俯送）；
  4. **动态空天追踪（Dynamic Aerial Skycam Tracking）**：摄像机高居船体上方 $8.5\text{m}\sim 6.8\text{m}$ 俯角 $35^\circ$ 全景拍摄，镜头牢牢将赛艇与对手锁定在黄金画面中心，既有宏大上帝视角又绝对不会丢船。

- **空中走廊击中与坠毁专属高光字幕（Air Corridor Climax Highlight Quote & Macho Typography）**：
  1. **标志性高光台词与喜剧效果拉满**：在空中走廊/飞行阶段被导弹击落或坠毁时，高光回放以最高优先级自动生成并呈现专属喜剧之神大字幕：`💥 我死了你也别想好过！`（副标题：`空中走廊遭遇极限坠毁 · 华丽翻车喜剧效果拉满`，评级：`[ EX · 喜剧之神 ]`）；
  2. **全面替换消除刺眼的蓝+黑外影**：高光横幅与 HUD 互动通知彻底告别模糊重影与蓝黑双重光晕，全面对齐“猛男勋章”级的高质感排版：硬朗暗色描边（`0 4px 0 rgba(12, 12, 37, 0.95)`）+ 温暖金色环境光晕（`0 0 36px rgba(255, 207, 74, 0.7)`）+ 斜体加粗醒目字体设计。

- **战术巡航导弹 90% 精准打击与 50% 漂移规避豁免（Tactical Cruise Missile 90% Precision & 50% Drift Evasion）**：
  1. **90% 基础精确打击 + 50% 漂移规避豁免**：目标未处于漂移状态时（无论是直行冲刺、空中腾空还是任意飞行姿态），一律 90% 绝对精确轰炸打击；唯有在海面上持续保持高速极限漂移时，享有 50% 规避豁免（命中率降至 45%）；
  2. **近失弹冲天水柱与爆炸火光效果拉满（Near-Miss Maxed VFX & Water Geyser）**：脱靶掠过水面时触发 100 粒漫天冲天水柱大水花喷发（$26\text{m}$ 溅射半径）、水面火球冲击波膨胀光球、深水爆炸巨浪轰鸣音效、强震手柄马达与分屏剧烈震颤，呈现极具视觉冲击力的惊魂一刻；
  3. **背刺锁定战术话术提示**：导弹发射锁定时，向主驾席位提示 `🚨 战术锁定预警！立即长按漂移！无限漂移触发 50% 规避豁免！`；
  4. **静止导轨点火起飞动画与重新装填**：发射台上的导弹由静止状态点火，伴随火箭发动机剧烈喷火加速沿发射架弹射升空（发射后静止模型同步隐藏，爆炸后完成装填复原）；
  5. **爆炸轰飞 720° 冲击波**：击中施加 $18.5\text{m/s}$ 升空冲击波、侧向反冲与 $2.4\text{s}$ 720° 空中剧烈翻滚与 80 粒水花大爆炸。

- **高光时刻上帝天眼高塔全局大视角（True God's-Eye Sky Tower Highlights & Clean Angle Cuts）**：
  1. **上帝天眼高塔全局鸟瞰（God's-Eye Sky Tower Overview）**：彻底解绑跟随船体的平移锁定，机位 1 采用 $22\text{m}$ 高空静态俯瞰天眼塔，摄像机居高临下摇镜注视赛艇在宽广海域破浪飞驰；机位 2 采用 $24\text{m}$ 半径 $16\text{m}$ 高空 360° 旋转慢镜头；机位 3 采用 $36\text{m}$ 远景高空俯视长焦塔；
  2. **干净利落的镜头切镜（Clean Cuts）**：机位切换瞬间直接切镜重置平滑锚点，杜绝空间拉扯橡皮筋感。

- **第七门过后全局操作体验一致性回归（Consistent Controls & Full Gameplay Freedom After Gate 7）**：
  1. **移除强制减速与特殊刹车**：`main.ts` 彻底移除在 `finalStationArmed` 时将玩家漂移键篡改为 `airBrake`、强行设 `flightTrigger: false` 以及将快艇模式切换为 `return-brake` 强制减速至 18m/s 的特殊逻辑；快艇全程保持 100% 正常的动力学、漂移手感与喷射加速；
  2. **移除移动端与 HUD 按钮锁定**：`mobileControls.ts` 与 `abilityTelemetry.ts` 彻底移除 `finalMode` 对触控按键的禁用及 `finish` 状态覆写，玩家在过 7 门后依然可以正常长按漂移蓄力、起跳飞行与空中续航，界面操作反馈与前 6 门完全一致；
  3. **标准 15 秒掉头与出圈规则对齐**：`race.ts` 移除过 7 门后对 `wrongT` / `offCourseT` 的特殊规避，未进终点站掉头回进或偏离航道均统一遵循标准的 15 秒纠偏倒计时，规则统一透明。

- **车手高精五官与 3D 头部造型系统（HD Rider Facial Features, Upright UV & 3D Layered Bangs）**：
  1. **UV 坐标与贴图方向修复**：`riderMesh`（`src/game/riderMesh.ts`）修复面部补丁网格 UV $v = t_Y$ 贴图倒置 Bug，面部贴图完全正向贴合头部网格；
  2. **高精度生动动漫五官重构**：`getOrCreateFaceTexture` 重构 512x512 动漫面部贴图，引入平滑柔和的径向渐变肤色底色与边缘透明平滑羽化衰减（彻底消除面部贴片边界感），重构清晰锐利的眼线双眼皮、多色虹膜反射弧渐变光晕、高光星芒、个性化挑眉、立体动漫鼻翼与专属嘴角表情（Axle 沉稳微笑、Tide 傲然微翘、Sol 阳光皓齿灿笑、Reef 咬牙坚毅战意、Kai 极客专注、Jinx 虎牙鬼马坏笑）；
  3. **3D 前额刘海与发型造型体系（告别秃顶）**：收拢头骨穹顶开角（`frontGap = 0.52`），为全量 6 位车手打造丰满立体的 3D 前额刘海（Bangs）、鬓角发丝与专属 3D 标志性头饰（Jinx 头顶动态呆毛与护目镜、Axle 盛唐翡翠额带与通讯麦、Tide 左眼全息战术单镜、Sol 额前太阳镜、Reef 鼻梁战术贴与莫西干尖刺、Kai AR 战术目镜横梁与钛金耳翼）；
  4. **通关近景旋转镜头实测验证**：`main.ts` 新增 `finale-orbit-face` 与 `finale-orbit-close` 通关旋转近距离特写场景，通过通关结算“七飞认证”近景环绕实测，车手在通关近景旋转镜头下五官精致清晰，发型立体自然。

- **第五门高能字幕、实时真实物理名次、白天太阳自然暖晕与夜间物理写实灯塔光束（Gate 5 Subtitle, Pure Progress Rank, Warm Sun & Real Lighthouse Beam）**：
  1. **过第五门高能字幕**：`Hud`（`src/hud/hud.ts`）在过 Gate 5 及第 5 飞全过（Flight 5 Cleared）时第一时间打出高能字幕提示 `卧槽，最难发卡弯过了！`（大弧度天轨回旋完美通过 · 保持节奏迎战第 6 飞）；
  2. **实时真实物理名次判定**：`Race`（`src/game/race.ts`）移除了在未完赛竞速期间仅因达成 7 飞成就就强行置顶的逻辑，未完赛车手名次完全由赛道真实行进距离 `progress` 决定；被对手超越即如实落后，过第七门后必须在物理上真正超越前车冲线才能摘得第一，彻底杜绝“前车在前却瞬间变第一”的逻辑 Bug；
  3. **白天太阳自然暖晕重构**：`Sky`（`src/cel/sky.ts`）废除以往叠加导致天穹蓝光透入变成“蓝色光晕”的旧着色，重构为物理正向 Mie 散射插值，天穹在太阳方向平滑过渡至浓郁耀眼的纯金白晕与金霞丁达尔光，杜绝任何蓝色光晕；
  4. **夜间物理写实灯塔光束**：`LighthouseLandmark`（`src/water/lighthouse.ts`）参考现实物理世界与商业竞品，将原先夸张的 64m 巨型实心光锥收敛为直径 0.45m~6.8m 纤细修长、~1.4° 半发散角的高端准直光束，结合高斯截面与指数级大气微粒散射衰减，呈现通透逼真的夜间 360° 旋转光束，不遮挡星空与月牙。

- **四大核心改进与日夜交替系统全量交付（4 Issues & Day/Night Cycle Architecture）**：
  1. **Phase 1A（雾道 Bug 修复）**：`Course`（`src/game/course.ts`）去除了阻断后续航道生成的 `!this.finalArmed` 守卫，优化 Route 0 终点跨线判定（`surfaceU >= 0.98 || surfaceU <= def.exitU + 0.01`），彻底修复双人模式中一人或两人冲线后，后经过终点站的第一个雾道消失的 Bug；
  2. **Phase 1C（方向判定重设计与纠偏倒计时）**：`Race`（`src/game/race.ts`）与 `Hud`（`src/hud/hud.ts`）将逆向行驶判负时钟收敛至与 `off_course` 一致的成熟商业标准 `WRONG_WAY_FAIL_HOLD_S = 15` 秒，回正后平滑衰减，HUD 呈现精准倒计时警报 `⚠️ 逆向行驶 · 请掉头 (Xs)`；
  3. **Phase 1B（飞毛腿慢镜追尾视角与 90% 命中）**：`DuoInteractionController`（`src/game/duoInteraction.ts`）在灯塔基底构建静态发射架群，导弹以 45m/s 黄金速率点火起飞，命中率提升至 90%；`main.ts` 与 `CameraRig`（`src/game/chaseCamera.ts`）在发射时无缝将淘汰屏切换为导弹追尾第一视角监控；
  4. **Phase D1–D3（日夜交替与夜间视觉生态）**：
     - `timeOfDay.ts` / `nightPalette.ts`：实现一轮白天、一轮黑夜自动交替（`round % 2 === 1 ? 'night' : 'day'`）；
     - `sky.ts`：黑夜模式升起优雅赛博月牙（Crescent Moon）与动态呼吸闪烁四芒星（4-pointed cross stars）；
     - `lighthouse.ts`：黑夜模式开启 360° 缓慢旋转的半透明体积光锥（`rotY = t * 0.32 rad/s`）与金色灯芯核心；
     - `ocean.ts` / `toonMaterial.ts`：夜间深海调色板、月光水面微波与船只尾迹生物荧光（Cyan Glow）；
     - `course.ts` / `honors.ts`：夜间 `EMISSIVE_FLOOR` 自发光保底（1.8x 缎带流光、光门地标圆环、3D 纯金硬币光芒璀璨），夜间竞技可读性 100% 保证。

- **6 大车手个性化发型与标志性头饰全面重构（6 Unique Driver Hair Styles & Iconic Headwear System）**：
  1. `riderMesh`（`src/game/riderMesh.ts`）彻底废除以往 6 名角色千篇一律的全黑大头盔，回归生动鲜活的人性化美学设计，全量还原 6 位车手专属的角色面部表情与肖像肤色质感（`Role.Skin`）；
  2. **6 大车手独立发型与标志性 3D 头饰系统**：
     - **Axle（GLM / 盛唐俊杰，沉稳）**：干练短发 + 盛唐赛博额带（镶嵌中心发光翡翠玉石）+ 右耳通讯麦克风；
     - **Tide（ChatGPT / 山姆傲慢，冷酷）**：飘逸短波波头（青蓝渐变挑染发梢）+ 左眼全息智能战术单镜 `[ ⌖ ]` + 银色机械耳骨夹；
     - **Sol（Gemini / 美国豆包，骄傲）**：5 段物理骨骼动态摇曳的耀阳金发高马尾 + 束发金环 + 额前佩戴的赛博太阳镜；
     - **Reef（KK / Kimi，愤怒）**：怒火狂暴绯红莫西干朋克尖刺发型 + 战术作战头带 + 鼻梁防擦战术贴 + 通讯天线；
     - **Kai（Claude / 打你嗷，专注）**：极客沉稳曜黑偏分短发 + AR 全息战术目镜横梁 + 双侧气动钛合金耳翼；
     - **Jinx（DeepSeek / 梁圣梁子，兴奋）**：鬼才叛逆紫蓝蓬松碎发 + 头顶架设的赛博双筒防风护目镜 + 像素星星面颊腮红 + 信号小天线。
     从第三人称追尾镜头（车尾视角）与前向发车网格均能一眼识别出独一无二的角色剪影！
- **光门撞柱碰撞切片精确化与物理反弹满足感强化（Pillar Exact Contact Slice & Rebound Dwell）**：
  1. `Course`（`src/game/course.ts`）将柱体碰撞判定由以往过于宽泛的 `normalDist > -2.8m` 提前判定，收敛精确至柱体实际几何接触切片（`-1.1m <= normalDist <= 1.3m`，接触半径收敛为 `1.60m`）；
  2. 撞柱瞬间施加充足的弹性冲量（`applyCollisionResponse` 反弹速率提升至 `18m/s ~ 0.72*speed`），玩家能清晰看到船身在撞上立柱后被真实反弹震开、剧烈摇晃的物理冲击画面，再过渡至失败结算。
- **天际雾桥高度黄金区间调优（6.8m–10.5m）与光门支架物理学重构（Skyway Elevation Sweet-Spot Calibration & Aero-Gantry Fix）**：
  1. `Course`（`src/game/course.ts`）将 7 条飞行空轨高度由 35m 极端高度调优回调至体验绝佳的 **6.8m–10.5m 黄金空域区间**（约为原始 4.5m 的 1.5x–2.3x）：
     - 第 1 飞：**6.8m**（轻盈大跳，视野极度通透）
     - 第 2 飞：**8.2m–8.8m**（海岛大反弯，水面绿线与弯心一览无余）
     - 第 3 飞：**7.5m–8.0m**（S 弯空域侧切）
     - 第 4 飞：**8.5m–9.2m**（跨海长程飞行，着水点清晰可辨）
     - 第 5 飞：**9.2m–9.8m**（大弧度天轨回旋）
     - 第 6 飞：**8.8m–9.5m**（海岛山脊飞掠）
     - 第 7 飞：**9.8m–10.5m**（终点巅峰翱翔）
     既保留了快艇冲上云端飞翔的爽快感，又确保车手在空中能**百分百看清水面绿线、后续下坡俯冲角度与弯心走向**，操作预判极度清晰舒适！
  2. `Course`（`src/game/course.ts`）彻底修复光门支架因随切线旋转导致的“柱子斜插海水违背物理学”问题：光门重构为悬浮式高科技气动门框拱门（`gateHalfHeight = 1.9m`, `pillarHeight = 5.6m`），双侧能量立柱完美贴合拱门边界，彻底剔除任何斜插海水的畸变支柱；
  3. `Boat`（`src/game/boat.ts`）与 `contracts.ts` 动力学参数适配：垂直加速度弹性阻尼调整为 `flightAccelMax: 72`，爬升/下潜时间曲线优化（`flightAscend: 0.52s`, `flightDescend: 0.78s`），确保起飞腾空与着水入水如丝般顺滑；
  4. `CameraRig`（`src/game/chaseCamera.ts`）与 `AudioSystem`（`src/audio/audio.ts`）：下俯角增益优化至 `FLIGHT_LOOK_GAIN = 0.54`，FOV 呼吸区间微调至 `[78..84]`，高空镜头拉远后距控制在 `1.2m` 内，彻底避免船身遮挡前方光门与入水点，视觉与听觉体验全面封板。
- **中远景白色三角与暗色鸟群视觉层已移除（Remote Sea Decor Removal）**：
  `SeaDecor` 原本生成的 `sea-decor-sails` 白色四分段圆锥和 `sea-decor-birds` 暗色鸟群均为无 gameplay 依赖的视觉装饰，现已连同装饰节点、资源和每帧更新调用一并删除；运行态证据仍保留在 `/tmp/white_triangles_runtime_evidence.md` 作为根因记录。
- **金币拾取立体声空间化与晶莹和弦升级 + 超强长程磁吸（Coin Audio Spatial Panning & 34m Suction Magnet）**：
  1. `AudioSystem`（`src/audio/audio.ts`）重构金币拾取音效为四音阶晶莹清脆和弦（523Hz 击打底音 + B5/E6/G#6/C7 晶莹泛音）配合音乐引擎智能瞬态避让，并引入 Web Audio `StereoPannerNode` 空间声相支持；`src/main.ts` 根据双人分屏席位下发声相（左席 -0.45 / 右席 +0.45），彻底解决右屏听不见金币拾取音效的问题！
  2. `HonorTargetSystem`（`src/game/honors.ts`）磁吸范围由 18m 大幅强化至 **34m 长程磁吸** 与 **14m 全向近接磁吸**，飞行吸入速率提升至 0.26s 且自转速率提升至 36 rad/s，金币如飞燕还巢般流畅吸入座舱驾驶员头部！
- **彻底根治全场景所有残留白色三角、菱形与指示箭头（Complete Root-Cause Eradication of All White Triangles & Chevrons）**：
  1. `Course`（`src/game/course.ts`）全面移除了在起飞跳台处添加的 `diamonds`（带白色 `postureFill` 偏航翼片）、`packets`（`makeOpenChevronGeometry` 开口三角箭头）以及光门柱顶菱形几何体（`locator-diamond`），彻底还给玩家 100% 纯净通透的海面与天际雾桥！
  2. `teamCourseVisuals.ts`（`src/game/teamCourseVisuals.ts`）移除工位上的 `ConeGeometry` 箭头。
- **第四门飞跃着水路线引导全面强化与水面绿线持续高亮（Gate 4 Landing Guidance & Continuous Surface Ribbon）**：
  1. `Course`（`src/game/course.ts`）在 `buildRibbonMaterial` 中去除了以往起飞与飞行期间对水面绿线的强制遮罩抹除，水面翡翠流光赛道缎带全程清晰连贯；前向可视距离扩展至 260m，弯道流光脉冲更加鲜明！
  2. `Hud`（`src/hud/hud.ts`）在飞跃第 4 门通过时立即呈现 `➡️ 右切入弯 ➔ 迎战第 5 飞` 明确转向指引，让玩家着水后顺畅切入右转大弯心迎接第 5 飞！
- **淘汰席位“飞毛腿在途的聚变打击”战术 CRT 监控视频与导弹外观超绝拉风升级（Scud-B Hypersonic Video & Military Mesh Refinement）**：
  1. `DuoInteractionController`（`src/game/duoInteraction.ts`）将飞毛腿导弹飞行速度提升至 82m/s 超音速拦截，3D 模型增加红外寻的头、前置鸭翼、双重马赫超音速震波环与白炽尾焰；
  2. `duoViewportHud`（`src/hud/duoViewportHud.ts` / `src/hud/duoViewportHud.css`）在淘汰席屏幕直接播放高燃战术 CRT 监控视频（`.duo-tactical-feed`），带超音速径向流光线、红光警报频闪、`[MACH 3.8]` 极速拦截遥测、动态雷达锁定与核爆直击闪光白化，将整蛊与双人竞技喜剧效果拉满！
- **双人模式淘汰席 Y 键飞毛腿导弹骚扰 + 75% 命中率 + 720° 空中旋转 + 战术 CRT 监控视频（Scud-B Harassment & Tactical CRT Feed）**：
  1. `DuoInteractionController`（`src/game/duoInteraction.ts`）重构 Y 键恶搞投射物为真实质感【飞毛腿战术导弹（Scud-B）】3D 模型（草绿弹体、深红战斗部整流锥、4 枚三角稳定翼面、尾喷管与火光烟圈），每局限制发射 7 枚。
  2. 命中判定升级为 75% 致命命中率与 25% 擦身而过分支。
  3. `Boat`（`src/game/boat.ts`）新增 `applyScudHit` 动力学响应：被击中后向惯性方向升空并触发 720°（$4\pi$ 完整双周）喜剧转体翻滚，着水后连续恢复航向。
  4. `duoViewportHud`（`src/hud/duoViewportHud.ts` / `src/hud/duoViewportHud.css`）在已淘汰席位屏幕直接播放【战术 CRT 导弹监控视频】（`.duo-tactical-feed`），带雷达扫描、战术锁定准星、`🔴 LIVE SATELLITE FEED // SCUD-B LAUNCH` 与 `🚀 飞毛腿在途的聚变打击` 战术字样及爆炸闪光，将整蛊与双人竞技喜剧效果拉满！
- **撞柱死亡即时判定 + 物理反弹力学 + 错失光门文案细分（Instant Gate Pillar Collision, Elastic Rebound & Copy Differentiation）**：
  1. `Course`（`src/game/course.ts`）在光门逼近切片区（$-2.8\text{m} \le \text{normalDist} \le 2.0\text{m}$）引入柱体圆柱近接碰撞判定（$R \le 2.25\text{m}$），彻底根治了以往必须等待穿越光门平面才判负的 1.5–2.5m 延迟问题。
  2. 发生撞柱时施加弹性反弹冲量（`applyCollisionResponse`），船身根据相对撞击角度被真实弹开。
  3. 细分“撞柱”与“错失光门”：当横向偏离飞太靠外（$|\text{lateral}| > \text{passHalfWidth} + 2.5\text{m}$）而在空中掠过时，不再施加反弹冲量；`Hud`（`src/hud/hud.ts`）将失败提示明确区分显示为 `第 X 飞 · 错失光门` 与 `错失光门 · 偏离 X.Xm`，提示更精准。
- **高科技赛博竞速头盔重构与全息战术目镜（High-Tech Cyber Aerodynamic Helmets & Holographic HUD Visors）**：
  `riderMesh`（`src/game/riderMesh.ts`）为全体主角与 AI 车手深度重构高科技气动竞速头盔系统（午夜碳纤复合外壳、低风阻顶流导流脊、后置气动尾翼与排气扩散口、带车队专属发光 LED 环的耳部通讯舱、下颚气动滤网与吸气槽、512x512 偏光渐变全息 HUD 战术风镜与车手呼号徽章），彻底摆脱粗糙感，呈现顶级未来街机大作级质感！
- **新手引导与全场景起飞时机重磅强化（Early Flight Timing Emphasized Across All Prompts）**：`KickstartGuide`（`src/hud/kickstartGuide.ts`）与 `Hud`（`src/hud/hud.ts`）全面强化起飞时机文案，强调“见雾提早起飞 / 点按【飞】提前起飞！”并预警“提早入轨避免错失航道坠海”，彻底杜绝新手飞晚冲出空轨的挫败感！
- **移动端猛男颁奖画面四键隐藏与猛男大字超绝强化（Mobile Medal Touch Controls Hidden & Giant 「猛男」 Title）**：`hud.css`（`src/hud/hud.css`）在猛男勋章典礼开启时彻底隐藏移动端左转向/右转向/漂移/起飞 4 个触摸按键，全屏纯净沉浸；PC 桌面端「猛男」大字尺寸大幅放大至 `clamp(72px, 8.8vw, 108px)` 极粗大黑体，配合细腻鎏金呼吸闪光与 `250px × 64px` 超大气势按钮，荣耀仪式感拉满！
- **起飞跳台大菱形与所有多余装饰彻底去除（Complete Removal of Launch Diamonds & Pure Mist Bridge Flight）**：`Course`（`src/game/course.ts`）彻底关闭了起飞跳台处的大菱形光环模型与所有多余的浮空装饰物。水面起飞区域 100% 还原为无遮挡纯净海面，由玩家凭肉眼观察白色的天际雾桥航道自主决定提前点火起飞！
- **经典纯净 3D 黄金硬币与清脆 Bling 铃音（Classic Pure 3D Gold Coin & Snappy Crisp Chime）**：`HonorTargetSystem`（`src/game/honors.ts`）剔除所有繁琐杂乱的浮动环绕小币，回归单枚优雅自转的经典 3D 纯金大硬币；`AudioSystem`（`src/audio/audio.ts`）全面重构拾取音效为经典街机纯净双音晶莹铃音（B5 987.8Hz $\rightarrow$ E6 1318.5Hz），配合金属高频轻灵余音与 18m 弧线吸入座舱动画，干脆利落、欢快清爽！
- **高光时刻赛博玻璃拟物重构与高阶极限操作荣誉（Cyberpunk Glassmorphic Accolades & High-Skill Accolade Tiers）**：`honors.ts` 与 `honorHighlights.ts` / `honorHighlights.css` 全面升级荣誉高光体系。告别以往单一平庸的高光展示，引入 4 大品质梯度（`legendary` 传说高光 / `epic` 极限操作 / `gold` 卓越战术 / `classic` 稳健航行）与全新高阶极限荣誉（`极限空域回正` 200 PTS、`风暴连击` 190 PTS、`超音速破空` 175 PTS、`领跑统御` 170 PTS、`弯心掠影` 160 PTS、`精准蓄力` 140 PTS 等）；主焦点展示卡引入评级徽章（`[ SSS · 极速传说 ]`、`[ SS · 破浪狂鲨 ]` 等）、动态流光边框、独立荣誉徽章与金币 PTS 统计，仪式感与视觉冲击力倍增！
- **第四门飞跃后右转指引强化与非活跃空轨智能淡化（Gate 4 Disambiguation & Inactive Route Dimming）**：`Course`（`src/game/course.ts`）在第 4 飞行路线出口追加了向右反向转向引导（`counterTurn: { fromU: 0.555, toU: 0.605, direction: 'right' }`）与着水恢复引导；同时重构了 7 条永久空轨的动态材质渲染逻辑，非活跃/身后旧航线自动淡化为柔和远景背景云（透明度降至 0.07 且关闭流动能量），当前/前方激活航线保持高亮金色粒子流，彻底根除新手过 4 门后因左侧 3 门残留雾道误判而飞错掉头的困扰！
- **冲过终点站继续比赛掉名次彻底根治（Final Station Checkpoint Credit & Contender Ranking Latch Fix）**：`Race`（`src/game/race.ts`）彻底根治了完成 7 飞冲过 Final Station 继续比赛后名次掉到 6/6 或过门后停在 4/6 的底层元凶。根因是空中大侧偏航线（如第 2、5 飞）距离水面检查点浮标超过 15m 导致圈内通过数不足 8 个，过线时被判定为未完整圈而清空了整整一圈的累积里程；现修复为空中航段合规计入检查点，并将完成 7 飞的 `finalContender` 资格在后续圈数持续生效，确保冲线第一的玩家继续比赛时名次坚挺第一！
- **彻底清除所有离散引导与航路恢复白色三角箭头（Complete Purge of Stray White Triangles & Recovery Arrows）**：`Course`（`src/game/course.ts`）全面删除了在通过各飞行门（尤其是第 7 门通过后）以及水面远端离散生成并随船只转向机械偏转的 `turnChevronGroup`、`recoveryArrows`、`surfaceGuideArrows` 几何体与渲染逻辑，从根源上彻底拔除了孤立三角箭头，赛道与空轨指引 100% 依托平滑纯净的流光缎带。
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

**真机验收四大核心改进与日夜交替系统**：
1. **日夜交替验收**：第一轮为明亮白天，完成一轮冲线 / 进入第二轮后无缝切换为深邃黑夜（赛博月牙、闪烁四芒星、灯塔 360° 体积光锥旋转、赛道与金币自发光）；第三轮自动切回白天。
2. **飞毛腿导弹视角验收**：双人模式中一席淘汰后发射飞毛腿导弹（Y键 / 手柄 Y），淘汰席分屏无缝切换至导弹追尾第一视角，以 45m/s 黄金速率锁定追踪对手，90% 致命爆破并定格特写 720° 腾空旋转。
3. **雾道连续性验收**：双人模式中一人或两人冲过终点站后，经过终点站后的第一雾道（Route 0）全程稳定显示并支持正常起飞。
4. **逆向行驶 15 秒纠偏验收**：水面逆向行驶时 HUD 呈现 15 秒倒计时警报，掉头回正后平滑恢复。
