# Board Race 开发交接

状态：`complete / user-playtest-next`

更新时间：2026-08-19

## 当前工作包

- Base：`61fbc323a072cd46ffcdb92e995263b648eaf722`，`main`。
- 目标：修复四项明确 HUD 问题，落实三格库存与六个中文玩梗名，并移除拖慢开发的无效
  harness、重复文档和发布仪式。
- 玩家美术原始要求和明确否决项见 [`art-direction.md`](art-direction.md)。

## 本轮完成

- Gemini 空刹广播改为页面会话只播一次；移动正文居中、换行且留在卡片内容区。
- 艇边库存移出角色中心轮廓；手机固定在右上安全通道并避开右侧操作区。
- `续航 +2.4 秒` 移到右上，关闭全屏闪白和速度线，让出中心飞行路线。
- 门柱失败统一显示“撞柱”，方向与超出距离只保留为次级证据。
- 飞行库存唯一上限改为 3；六个中文名改为唐老杰、奥特曼、美国豆包、杨植麟、蓬蓬头、
  梁圣梁子，英文模型名和稳定内部 id 保持不变。
- `harness/screenshot.mjs` 从 5220 行缩至 288 行；删除 979 行 systems、8 个 probe 和主程序
  中仅供旧 harness 使用的场景、计数器与端点。`src/main.ts` 从 5610 行缩至 2128 行。
- 删除 knowledge-map、closeout/Pages fallback 脚本和发布配置副本；发布只保留 staged diff、
  build、桌面/手机 smoke、commit 和普通 push。
- `AGENTS.md`、`llmwiki`、本 handoff 已压缩分工；每次提交前由轻量 `jiepi-clear` 检查死代码、
  无消费者测试、残留物和文档漂移，不恢复全量审计。

## 实际证据

- `npm run build`：通过；生产 JS 为 1,051.34 kB（此前约 1,306.10 kB）。
- `npm run verify:smoke`：通过。
- 桌面 `1440x900`：161 draw calls，323,081 triangles，2,025,000 drawing pixels，16.7 ms。
- 手机 `844x390`：181 draw calls，326,097 triangles，2,057,250 drawing pixels，16.7 ms。
- after 截图：`shots/ui-contract-slimming/after/`，共 5 个桌面和 5 个横屏手机场景；已人工检查
  广播居中、库存避让、续航避线与撞柱文案。本结论不代表海面、船体或角色美术已升级。
- 当前 `shots/` 为 24 MB；旧 visual-roadmap 大图和无关流水截图已移入系统回收站。
- `npm run verify:collision`、`npm run verify:audio`：通过，确认精简主 harness 后两套按需诊断仍可用；
  它们不进入常规发布门禁。

## 遗留风险

- Pages/线上页面未核验；本轮发布动作只承诺普通 push，用户需实际试玩当前版本。
- 海面、尾流、水花、开场船体落座、船体模型和 16 骨骼角色均未改，不能写成已改善。
- 玩梗 Logo 等正式 SVG 和六张立绘水印处理仍等待用户资产或独立资产工作包。
- 六个常驻英文世界名牌继续保持否决，不恢复。

## 下一工作包

先由用户试玩本提交。确认 HUD 小修可接受后，只做“真实、汹涌、有尺度的大海”单项原型：
允许修改物理浪形，但 CPU 浮力与 GPU 位移必须保持同源；先交一组桌面/横屏手机 before/after
和一项资源指标供人工定方向。用户确认海面方向后，再分别处理尾流/水花/开场落座和船体/角色，
不得把这些视觉大项塞进同一轮后用 harness 结果代替审美验收。
