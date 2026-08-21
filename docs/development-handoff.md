# Board Race 开发交接

状态：`flight prompt card desktop fix / 待真机确认`

更新时间：2026-08-22

## 已完成

- 海面体积感+低日光照套装已随 `5071367` 发布(相机 heave 解耦、太阳方位定向明暗、
  朝日暖光路、NFS 式低日盘);待真机动态观感确认。
- 修复 `hud.css` 未提交改动的桌面回归(用户的飞行提示卡 media query 重构,桌面回退到
  sightline 基础卡后溢出冒烟红线):
  - 根因 1:基础卡 `::before/::after` 装饰环用 `inset: -22px -38px` 探出卡外,acquire
    动画以 scaleX(1.55) 定格,scrollWidth 542→749。改为卡内顶部 accent 条+右下虚线
    (与移动紧凑卡同一视觉语言),动画在卡内播放不再撑爆。
  - 根因 2:`.hud-keycap` 固定 88px 盒配 62px 字,装不下桌面词文案 "SPACE"
    (197px)。改 min-width+auto 自适应模型(88/30px),三个小屏覆盖块(62/52/46px)
    同步改 auto,词文案任何视口不再溢出。
  - 顺手修了紧凑块 `::before, ::before` 重复选择器笔误。

## 实际验证

- 探针实测(已删):修复后 prompt cw=sw=542、ch=sh=134,keycap cw=sw=149,桌面溢出归零。
- `npm run verify:smoke` 桌面+844x390 OK。

## 下一步

- 用户真机确认海面套装动态效果与桌面/手机提示卡视觉;认可后做波形原型 2
  (crest 谐波 0.3+、4-8m chop、浪群包络,改 `waves.ts`,需 `verify:collision`)。
