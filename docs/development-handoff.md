# Board Race 开发交接

状态：READY 全屏引导按钮强化完成（build ✅、smoke 桌面 + 844x390 双绿），待提交。

## 当前工作包

- 目标（用户 2026-09-21 裁决）：READY 页全屏按钮「做大一点、放右下角、点了
  就不用出现」；手机版原按钮太小看不清，且首屏被状态栏/地址栏压缩，第一步
  观感不友好。
- 已完成：
  - `src/core/immersiveMode.ts`：新增 `readyEntryConsumed` 锁存——任何来源
    （READY 按钮/GO/控制手势）真实进入过一次全屏后，READY 按钮本会话不再
    出现；`readyEntryAvailable()` 加锁存条件，`onReadyAvailability` 文档同步。
    GO 每局仍走 `requestGo()` 真实手势请求全屏，按钮消失不构成全屏死角。
  - `src/hud/driverSelect.ts`：按钮移出 footer 挂到选角层 root，双行结构
    （队色 ⛶ 图标 + 「全屏体验」主标 + 「隐藏地址栏更沉浸」小字），
    aria-label 说明用途。
  - `src/hud/driverSelect.css`：桌面锚 overlay 右下角（z-index 8，安全区
    aware），2.8s 呼吸光引导动画（`driver-fs-call`，reduced-motion 静止）；
    coarse 横屏端页脚带垫高 66px、按钮落在带内（root 锚定，参照物是
    overlay 不是 footer），featured 选手信息零遮挡；≤340px 矮屏页脚 52px +
    紧凑按钮 44px。
- Owner：`src/core/immersiveMode.ts`、`src/hud/driverSelect.ts/css`、
  `docs/llmwiki.md`、本文。
- 合同同步（llmwiki）：READY 全屏按钮形态/位置/「成功进入过一次后本会话
  自隐」条款已写入 Fullscreen 合同。

## 验证与证据

- `npm run build` ✅。
- 一次性探针（已删除，未入库）：移动 844x390 下断言——GO 前按钮可见且
  `hidden:false`（rect 660,320,172x62，右缘 832=844-12、落在页脚带内）；
  点按钮后 `outcome:"entered"` 且按钮自隐；`document.exitFullscreen()` 后
  `outcome:"exited"` 按钮仍隐藏（锁存生效）。
- 截图自审：`shots/fs-review/ready.png`（桌面右下角大按钮）、
  `shots/fs-review/ready-mobile-fs-button.png`（移动：按钮醒目、选手
  优势/短板与雷达完整无遮挡）、`ready-mobile-fs-entered.png`（进入全屏后
  按钮消失）。
- `npm run verify:smoke` ✅ 桌面 + 844x390 双绿（`smoke contract: OK`）。

## 遗留风险

- 桌面 1366px 临界宽度下按钮右缘与雷达背板右缘间距极小（1440 截图无交叠）；
  真机窄窗 + 已连接手柄时状态文案可能与按钮邻近，未实测。
- iOS 真机 Safari 无 requestFullscreen → 按钮走「unsupported/idle 不可获得」
  路径保持隐藏，与此前形态一致（竖屏小字引导到系统浏览器）。

## 唯一下一步

jiepi-clear 预检 + 暂存已审文件 + `npm run release:checked` 提交推送；
用户实机复核移动首屏按钮观感与全屏进入/退出后的显隐。
