# 跨股冰山联动 — 一键折叠/展开功能开发步骤

## 目标

为 `public/active-trading.html` 的「跨股冰山联动」区块增加一键折叠/展开功能，点击标题栏可折叠表格，折叠状态与数据刷新互不干扰。

## 涉及文件

| 文件 | 改动点 |
|---|---|
| `public/active-trading.html` | HTML（标题栏加箭头 + 点击区）、CSS（折叠样式）、JS（切换函数） |

## 开发原则

- **MVP**：只实现折叠/展开，不做 localStorage 记忆、不做展开/折叠动画（表格行数不定，动画价值低）。
- **小步快跑**：拆成 2 个可独立验证的步骤，一次只实现一个功能。
- **Git**：每个步骤从干净状态开始；失败时 `git reset --hard` 果断重置，再重做。

## 关键设计（先读，避免踩坑）

1. **折叠标记挂在 `#cross-iceberg-section` 上，不挂在表格上**。
   - `#cross-iceberg-section.visible` 控制「区块是否显示」（无数据时隐藏）。
   - `#cross-iceberg-section.collapsed` 控制「表格是否折叠」，标题栏始终可见，保证折叠后还能再展开。
   - 两个状态 class 互不冲突，`renderCrossIceberg()` 每次只操作 `.visible`，与折叠状态天然解耦。
2. **渲染逻辑零改动**：`renderCrossIceberg()` 每次 10s 刷新重建 `tbody.innerHTML`，折叠只是 CSS 隐藏，数据照常写入。展开时即显示最新数据，无需处理"旧快照"问题。

---

## Step 1：HTML 标记 + CSS 折叠样式（静态部分）

### 要做什么

**1.1 HTML**：在 `public/active-trading.html` 的跨股冰山标题栏（约 L448-451）右侧加箭头，当前结构为：

```html
<div class="cross-ice-header">
  <span class="dot"></span>
  <span>跨股冰山联动</span>
</div>
```

改为：

```html
<div class="cross-ice-header" title="点击折叠/展开">
  <span class="dot"></span>
  <span>跨股冰山联动</span>
  <span class="cross-ice-chevron">▼</span>
</div>
```

**1.2 CSS**：在跨股冰山区块样式末尾（`@keyframes cross-ice-flash` 之后，约 L342）追加：

```css
.cross-ice-header { cursor: pointer; user-select: none; }
.cross-ice-chevron { margin-left: auto; font-size: 10px; color: #a57bbf; transition: transform 0.2s ease; }
#cross-iceberg-section.collapsed .cross-ice-chevron { transform: rotate(-90deg); }
#cross-iceberg-section.collapsed .cross-ice-table { display: none; }
```

> 说明：`.cross-ice-header` 已有定义（L304-307），这里新增独立规则追加 `cursor` 两行，不改动原有代码块。chevron 用 `margin-left:auto` 靠右对齐。

### 如何验证

1. 启动服务（nodemon 自动重载，无需手动重启）：

```powershell
cd f:\TradingPlatform\market-monitor\market-monitor
npm run dev
```

2. 浏览器访问 <http://localhost:3000/active-trading>。
3. 确认页面加载正常、标题栏右侧出现 `▼` 箭头、鼠标悬停标题栏显示手型光标。
4. 打开 DevTools（F12）→ Console，手动给区块切换 `collapsed` class 验证样式：

```js
document.getElementById('cross-iceberg-section').classList.toggle('collapsed')
```

- 有 `collapsed` 时：表格隐藏、箭头旋转 90°。
- 无 `collapsed` 时：表格恢复显示、箭头复原。

> 若当前 API 无跨股联动数据（区块整体不显示），可在 Console 注入假数据验证：
> `renderCrossIceberg([{core:'TEST', pairs:[{partner:'ABC',size:100,seconds:5,times:3}], detected_at:new Date().toISOString(), updated_at:new Date().toISOString()}])`

### DoD（完成定义）

- [ ] 浏览器中箭头正常显示、靠右对齐
- [ ] DevTools 手动切换 `collapsed` 可控制表格显隐 + 箭头旋转
- [ ] 等待 10s 数据刷新后，手动切换的折叠状态仍生效（渲染不破坏样式状态）
- [ ] DevTools Console 无报错

### Git 提交

```powershell
git add public/active-trading.html
git commit -m "feat(active-trading): 跨股冰山联动添加折叠/展开静态样式"
```

---

## Step 2：JS 交互（点击折叠/展开）

### 要做什么

**2.1 HTML**：给标题栏加点击事件（`public/active-trading.html` 约 L448）：

```html
<div class="cross-ice-header" title="点击折叠/展开" onclick="toggleCrossIce()">
```

**2.2 JS**：在 `renderCrossIceberg()` 函数之后（约 L670）追加：

```js
// ── 跨股冰山联动：折叠/展开 ──
let crossIceCollapsed = false;
function toggleCrossIce() {
  crossIceCollapsed = !crossIceCollapsed;
  document.getElementById('cross-iceberg-section').classList.toggle('collapsed', crossIceCollapsed);
}
```

> 默认不折叠（`crossIceCollapsed = false`，与当前行为一致）。刷新页面后默认展开。

### 如何验证

1. 确保服务运行中，浏览器访问 <http://localhost:3000/active-trading>。
2. 点击「跨股冰山联动」标题栏：
   - 第一次点击 → 表格折叠、箭头旋转；
   - 第二次点击 → 表格展开、箭头复原。
3. 折叠状态下等待 10s 自动刷新：区块不消失、折叠状态保持。
4. 展开状态下等待 10s 自动刷新：表格数据更新为最新。
5. 刷新整个页面：默认展开。
6. 无跨股联动数据时（区块隐藏），页面不报错。

### DoD（完成定义）

- [ ] 点击标题栏可折叠/展开表格，箭头方向正确
- [ ] 折叠状态在 10s 自动刷新后保持
- [ ] 页面刷新后默认展开
- [ ] 无数据时页面无 JS 报错

### Git 提交

```powershell
git add public/active-trading.html
git commit -m "feat(active-trading): 实现跨股冰山联动一键折叠/展开交互"
```

---

## Step 3：回归验证 + 收尾

### 要做什么

整体回归，确认本次改动不影响页面其他功能。

### 如何验证

```powershell
# 1. API 正常返回
curl -s http://localhost:3000/api/active-trading | Select-Object -First 1

# 2. 页面返回 200
curl -s -o $null -w "%{http_code}" http://localhost:3000/active-trading

# 3. 工作区仅含本次改动
git status
git log --oneline -3
```

浏览器回归清单：

- [ ] 主表格正常渲染、排序、宽限期/冰山高亮不受影响
- [ ] 筛选面板折叠、屏蔽管理、右键菜单功能不受影响
- [ ] 跨股冰山联动折叠/展开正常（含数据刷新场景）

### DoD（完成定义）

- [ ] API 与页面均返回 200
- [ ] 回归清单全部通过
- [ ] Git 历史含 Step 1 / Step 2 两个提交，工作区无未提交改动

---

## 回滚预案

任一 Step 失败且无法快速修复时：

```powershell
git reset --hard HEAD~1   # 回退最近一次提交（按失败步骤次数叠加）
git status                # 确认工作区干净后重做
```
