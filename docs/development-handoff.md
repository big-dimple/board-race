# Board Race 开发交接

状态：`tornado-boundary / runtime reverted; no active implementation`

更新时间：2026-08-20

## 当前状态

- 被用户否决的龙卷风实验已通过 Git 回退提交 `b5c627d` 和 `7460e12` 撤回。
- `src/game/course.ts` 与 `src/main.ts` 已确认与龙卷风开发前的 `3d521b0` 完全等价；龙卷风私有渲染树、
  红色闪电和专用 screenshot harness 均已移除。
- 该回退不改 flight 判定、碰撞、物理、AI、波浪或既有发射引导。此前工作流文件
  `docs/workstream-launch-pillars.md` 继续保持删除状态。

## 未来可选工作（未启动）

若重新立项，必须从当前干净基线重新设计，不能恢复或微调被否决的锥面、细螺旋带或稀疏球体方案。用户目标是：
在真实 flight entrance `def.entryU` 两侧呈现高、黑灰、具有烟尘体积和层次的动态边界；远景能读为入口，近景
不读成贴纸、线圈、路障或海上垃圾。暗红核心和偶发短促闪电只能作为烟雾成立后的附加效果。

任何新方案只可改私有视觉树和必要的真实截图 harness；不得改 flight state、判负、碰撞、速度、AI、波浪或
`BoatInput`。先出 desktop 与 `844x390` 的真实近中远截图供人审，通过后再进入发布流程。

## 下一步

当前没有待执行的龙卷风代码任务。下一位若重启该方向，先读取 `AGENTS.md`、`docs/llmwiki.md`、本文件和
`docs/art-direction.md`，先提交新的视觉方案与验收截图，不得把已撤回实验视作现有基础。
