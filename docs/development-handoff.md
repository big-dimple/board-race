# Board Race 开发交接

状态：导弹直击爆炸反馈 + 爆炸音效重做 + iOS 转向箭头修复已随本提交发版；人工真机复核 pending。

## 上一工作包（已发版 `a912d2e`）

- 导弹脱靶爆炸反馈 + 双打 PC 标注已发版；Tide 五官与全角色开场头脸修正已发版。

## 当前工作包（本提交）

- 导弹直击命中（单人吃弹/借刀炸人 `singlePlayerMissiles.ts` impact 分支、双打背刺 `prank-impact`）
  在命中点水面引爆预分配爆炸池 `missileBlast.ts`，落点采样 `waterHeight` 坐在真实浪面上；船从
  水波里被炸飞（`applyScudHit` 弹跳翻滚保留、水柱 80/20 → 110/26 与脱靶冲击同级）。
- 爆炸音效 `audio.explosion()` 从 3 声部扩为 5 声部：次低音下坠 + 失谐 saw 中频主体（手机可闻）
  + 更亮更长的 crack 瞬态 + 带通火球轰声（原 900→220 低通是"闷"的根源）+ 延迟回声尾；直击
  `impact` 音频从 `thud` 换成 `explosion()`。
- iPhone 12 转向箭头退化（iOS 把 `‹`/`›` 渲染成细线）修复：`mobile-controls` 左右键的空 `<b>`
  改用边框旋转画 CSS chevron（`drop-shadow` 还原墨边），不再依赖字体字形。
- Owner：`singlePlayerMissiles.ts`、`boat.ts`、`audio.ts`、`main.ts`、`mobileControls.ts/css`、
  llmwiki 合同句、handoff。

## 验证与证据

- build / smoke / audio 全绿（smoke 中 `solo-missile-blast` 爆炸池生命周期合同不变）。
- 截图：`shots/missile-hit/`（直击爆炸瞬间，桌面 + `844x390`）、`shots/mobile-review/`（移动端
  转向 chevron 特写）；人工复核 pending。

## 唯一下一步

用户真机复核：iPhone 12 转向箭头形状、导弹直击的炸浪 + 炸飞表现、新爆炸音效听感。
