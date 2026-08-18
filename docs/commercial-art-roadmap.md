# 商业美术路线图入口

这是商业美术跨会话任务的唯一仓库内入口。详细的 `M0-M7` 计划暂存于被忽略的
`/home/github/board-race/shots/visual-roadmap/README.md`；该目录是临时验收现场，不是
源码事实源，最终结果必须回写 `docs/llmwiki.md` 与 `docs/development-handoff.md`。

执行合同只有三条：一个总 goal 串行推进；每个里程碑独立 session 闭环；每个完成 task 都要有
固定相机桌面 / 手机截图、机器性能证据、三份知识文档同步和下一 task handoff。M7 已完成发布
收尾；M0-M6 候选与 M7 blocker repair 已由 checked release 推送并完成线上核验。被忽略的截图和
路线图现场继续保留，不因发布而清场。

## M7 发布凭证（2026-08-19）

- candidate release commit / release-time `origin/main`：`428120044836951e266583481be35bbcadbbaa1f`，两者完全一致。
- checked release：`npm run release:checked -- --no-wait-pages "feat: commercial art milestones"`；
  closeout、build、gameplay、mobile、collision、audio、systems、performance 八道门禁全部通过。
- Actions / deployment：`deploy.yml` workflow run `32188235255` 对应该 SHA，deploy job
  `95878185185` 成功并链接 `https://big-dimple.github.io/board-race/`；该 job 的 `github-pages`
  artifact 已生成。独立 `verify-pages.sh` 已执行，但公共 API 的 deployment 查询返回 `403`，
  因此不伪造 deployment id；成功 deploy job 与 live marker 作为可复核部署证据保留。
- live：Pages 首页的 `<meta name="build-sha">` 精确返回该完整 SHA。
- 视觉证据：`shots/visual-roadmap/M7/before/` 15 张桌面 / 15 张手机矩阵，以及
  `shots/visual-roadmap/M7/evidence/course-fix-after/` 两张 focused after 图均为非空；桌面
  `2880x1800`、手机 `2532x1170`。focused desktop/mobile 分别为 `189 calls / 2,025,000`
  与 `189 calls / 2,057,250 px/frame`，均 `16.7ms`；active nameplates `6/6`，落水 droplets
  `28`、landing volume `1`，无新增 pool / render target / fixed-step allocation。
- post-push knowledge closeout：本次文档修订也通过独立的 `release:checked` checked release
  发布；最终 remote-SHA 校验由该流程完成。
