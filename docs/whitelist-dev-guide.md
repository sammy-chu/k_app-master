# 白名单功能开发指南（MVP）

## 概述

在前端添加股票白名单过滤功能，所有页面只显示白名单内的股票。
白名单为空时不过滤，显示所有数据。数据存储在 localStorage。

---

## Step 1: 创建白名单核心模块

### 要做什么

新建文件 `public/js/whitelist.js`，封装白名单 CRUD 和过滤逻辑。

```javascript
// public/js/whitelist.js
(function () {
  const STORAGE_KEY = 'whitelist_symbols';

  function getWhitelist() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function setWhitelist(symbols) {
    const unique = [...new Set(symbols.map(s => s.trim().toUpperCase()).filter(Boolean))];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(unique));
    window.dispatchEvent(new Event('whitelist-changed'));
  }

  function addToWhitelist(symbol) {
    const list = getWhitelist();
    const s = symbol.trim().toUpperCase();
    if (s && !list.includes(s)) {
      list.push(s);
      setWhitelist(list);
    }
  }

  function removeFromWhitelist(symbol) {
    const s = symbol.trim().toUpperCase();
    setWhitelist(getWhitelist().filter(x => x !== s));
  }

  function clearWhitelist() {
    localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new Event('whitelist-changed'));
  }

  function isWhitelistEnabled() {
    return getWhitelist().length > 0;
  }

  /**
   * 过滤数据数组，仅保留白名单内的股票
   * @param {Array} data - 数据数组
   * @param {string} symbolKey - 股票代码字段名，默认 'symbol'
   * @returns {Array} 过滤后的数组（白名单为空则返回原数组）
   */
  function filterByWhitelist(data, symbolKey = 'symbol') {
    const list = getWhitelist();
    if (list.length === 0) return data;
    const set = new Set(list);
    return data.filter(item => set.has((item[symbolKey] || '').toUpperCase()));
  }

  // 暴露全局 API
  window.Whitelist = {
    get: getWhitelist,
    set: setWhitelist,
    add: addToWhitelist,
    remove: removeFromWhitelist,
    clear: clearWhitelist,
    isEnabled: isWhitelistEnabled,
    filter: filterByWhitelist,
  };
})();
```

### 如何验证

浏览器打开任意页面（先在 HTML 中临时加 `<script src="js/whitelist.js"></script>`），在控制台执行：

```javascript
Whitelist.add('AAPL');
Whitelist.add('MSFT');
console.log(Whitelist.get()); // ['AAPL', 'MSFT']
console.log(Whitelist.filter([{symbol:'AAPL'},{symbol:'GOOG'}])); // [{symbol:'AAPL'}]
Whitelist.clear();
console.log(Whitelist.filter([{symbol:'AAPL'},{symbol:'GOOG'}])); // 返回全部
```

### DoD

- `Whitelist.add/remove/get/set/clear/filter` 全部正常工作
- 白名单为空时 `filter()` 返回原数组
- 数据持久化到 localStorage（刷新后仍在）

### Git

```bash
git add public/js/whitelist.js
git commit -m "feat: add whitelist core module (localStorage CRUD + filter)"
```

---

## Step 2: 在 index.html 添加白名单管理 UI

### 要做什么

修改文件：`public/index.html`

**2a. 引入 whitelist.js（在 `<script>` 标签之前）：**

在 `</body>` 前的 `<script>` 之前添加：

```html
<script src="js/whitelist.js"></script>
```

**2b. 在导航栏 `.nav-bar` 末尾添加管理按钮：**

```html
<!-- 在 nav-bar div 内最后一个 <a> 后面添加 -->
<a href="javascript:void(0)" id="btn-whitelist" onclick="toggleWhitelistPanel()" style="border-color:#ff9800;color:#ff9800;">⚙ 白名单</a>
```

**2c. 在 `<body>` 内（nav-bar 下方）添加白名单管理面板 HTML：**

```html
<!-- Whitelist Management Panel -->
<div id="whitelist-panel" style="display:none; background:#242424; border:1px solid #444; border-radius:8px; padding:16px; margin-bottom:20px;">
  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
    <span style="font-size:15px; font-weight:600; color:#ff9800;">白名单管理</span>
    <span id="wl-count" style="font-size:12px; color:#888;">0 只股票</span>
  </div>
  <div style="display:flex; gap:8px; margin-bottom:12px;">
    <input type="text" id="wl-input" placeholder="输入股票代码（逗号或空格分隔批量添加）"
      style="flex:1; background:#1a1a1a; border:1px solid #555; color:#ddd; padding:8px 12px; border-radius:4px; font-size:13px;">
    <button onclick="addWhitelistFromInput()" style="background:#ff9800; color:#fff; border:none; padding:8px 16px; border-radius:4px; cursor:pointer; font-size:13px;">添加</button>
    <button onclick="if(confirm('确认清空白名单？')) { Whitelist.clear(); refreshWhitelistUI(); }" style="background:#555; color:#ddd; border:none; padding:8px 12px; border-radius:4px; cursor:pointer; font-size:13px;">清空</button>
  </div>
  <div id="wl-list" style="display:flex; flex-wrap:wrap; gap:6px; max-height:120px; overflow-y:auto;"></div>
</div>
```

**2d. 在 `<script>` 标签内添加白名单管理逻辑：**

```javascript
// ── Whitelist UI ──────────────────────────────────────────────
function toggleWhitelistPanel() {
  const panel = document.getElementById('whitelist-panel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  if (panel.style.display === 'block') refreshWhitelistUI();
}

function addWhitelistFromInput() {
  const input = document.getElementById('wl-input');
  const symbols = input.value.split(/[,，\s\n]+/).filter(Boolean);
  symbols.forEach(s => Whitelist.add(s));
  input.value = '';
  refreshWhitelistUI();
}

function refreshWhitelistUI() {
  const list = Whitelist.get();
  document.getElementById('wl-count').textContent = list.length > 0 ? list.length + ' 只股票' : '未启用（显示全部）';
  const container = document.getElementById('wl-list');
  container.innerHTML = list.map(s => `<span style="background:#333;padding:4px 10px;border-radius:4px;font-size:12px;color:#ddd;display:inline-flex;align-items:center;gap:6px;">${s}<span onclick="Whitelist.remove('${s}');refreshWhitelistUI();" style="cursor:pointer;color:#ef5350;font-weight:bold;">×</span></span>`).join('');
  // 更新按钮状态
  const btn = document.getElementById('btn-whitelist');
  if (btn) btn.textContent = list.length > 0 ? `⚙ 白名单(${list.length})` : '⚙ 白名单';
}

// 页面加载时初始化按钮显示
refreshWhitelistUI();

// Enter 键支持
document.getElementById('wl-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') addWhitelistFromInput();
});
```

### 如何验证

1. 浏览器打开 `http://localhost:端口/`
2. 看到导航栏右侧出现橙色「⚙ 白名单」按钮
3. 点击按钮展开管理面板
4. 输入 `AAPL, MSFT, GOOG` 点击添加
5. 看到三个标签出现，按钮变为「⚙ 白名单(3)」
6. 点击标签上的 × 可删除
7. 刷新页面，白名单数据仍在

### DoD

- 白名单管理面板可正常打开/关闭
- 可添加（支持批量）、删除、清空
- 数量显示正确
- 刷新后数据持久化

### Git

```bash
git add public/index.html
git commit -m "feat: add whitelist management UI on index page"
```

---

## Step 3: 在 index.html 的数据渲染中应用白名单过滤

### 要做什么

修改文件：`public/index.html`

在 `fetchRanking()` 函数中，获取数据后应用过滤：

```javascript
async function fetchRanking() {
  try {
    const res = await fetch(API + '/api/ranking');
    if (!res.ok) return;
    let data = await res.json();
    if (!Array.isArray(data)) return;

    // ★ 白名单过滤
    data = Whitelist.filter(data);

    // Overview cards
    let up = 0, down = 0, flat = 0;
    // ... 后续代码不变
```

同样在 `fetchActiveTrading()` 中对 `data.symbols` 过滤：

```javascript
// 在 const top10 = ... 之前
const filtered = Whitelist.filter(data.symbols || []);
const top10 = filtered.slice(0, 10);
```

对 `fetchBoundaryAlerts()` 返回的 alerts 过滤：

```javascript
const alerts = Whitelist.filter(data.alerts || []);
```

### 如何验证

1. 打开白名单面板，添加 2-3 个实际存在的股票代码
2. 刷新页面
3. 涨跌榜只显示白名单内的股票
4. 清空白名单后刷新，恢复显示全部

### DoD

- 白名单启用时 index 页面的涨跌榜、活跃股票等只显示白名单内数据
- 白名单为空时显示全部（无回归）

### Git

```bash
git add public/index.html
git commit -m "feat: apply whitelist filter on index dashboard data"
```

---

## Step 4: 在 ranking.html 集成白名单过滤

### 要做什么

修改文件：`public/ranking.html`

**4a. 在 `<script>` 标签前引入：**

```html
<script src="js/whitelist.js"></script>
```

**4b. 在 `renderTable()` 函数的 `currentData.filter(...)` 之前插入白名单过滤：**

找到 `renderTable()` 中：
```javascript
const filteredData = currentData.filter(item => {
```

改为：
```javascript
// ★ 白名单过滤
const whitelistedData = Whitelist.filter(currentData);
const filteredData = whitelistedData.filter(item => {
```

### 如何验证

1. 在 index 页面设置白名单（添加 2-3 只股票）
2. 打开 `/ranking` 页面
3. 只显示白名单内的股票
4. 清空白名单后刷新，全部显示

### DoD

- ranking 页面正确响应白名单过滤
- 与现有的价格/成交量筛选互不干扰

### Git

```bash
git add public/ranking.html
git commit -m "feat: apply whitelist filter on ranking page"
```

---

## Step 5: 在所有其他页面集成白名单过滤

### 要做什么

修改以下所有文件，统一模式：

| 文件 | 引入 whitelist.js | 过滤切入点 |
|------|-------------------|------------|
| screener.html | ✓ | 数据 fetch 后、渲染前 |
| screener-stable.html | ✓ | 同上 |
| screener-oscillator.html | ✓ | 同上 |
| screener-breakout.html | ✓ | 同上 |
| screener-range.html | ✓ | 同上 |
| swing-screener.html | ✓ | 同上 |
| boundary-alerts.html | ✓ | 同上 |
| active-trading.html | ✓ | 同上 |
| abnormal-trades.html | ✓ | 同上 |
| large-orders.html | ✓ | 同上 |
| volume-alerts.html | ✓ | 同上 |
| volume-surge.html | ✓ | 同上 |
| hills.html | ✓ | 同上 |
| hill-alerts.html | ✓ | 同上 |
| volatility.html | ✓ | 同上 |
| l2_alert_history.html | ✓ | 同上 |
| alerts.html | ✓ | 同上 |

**每个页面的修改模式相同：**

1. 在 `</head>` 前或业务 `<script>` 前添加：
   ```html
   <script src="js/whitelist.js"></script>
   ```

2. 找到数据 fetch 成功后的数组变量，应用过滤：
   ```javascript
   data = Whitelist.filter(data); // 或 Whitelist.filter(data, 'symbol_name')
   ```

> 注意：需逐个页面确认 symbol 字段名（大部分为 `symbol`）。

### 如何验证

逐个打开每个页面：
1. 设置白名单含 2-3 只股票
2. 确认只显示白名单内数据
3. 清空白名单确认显示全部

```bash
# 快速手动验证清单
# 在浏览器中依次访问每个页面确认过滤生效
```

### DoD

- 所有 17 个页面都正确应用白名单过滤
- 无白名单时全部正常显示
- 无 console 报错

### Git

```bash
git add public/
git commit -m "feat: apply whitelist filter across all pages"
```

---

## Step 6: 各页面添加白名单状态指示

### 要做什么

在每个页面（index 以外）添加一个小型状态提示，让用户知道当前白名单是否启用。

在每个页面的导航栏区域末尾（或紧挨导航栏下方）添加：

```html
<span id="wl-status" style="font-size:12px;color:#ff9800;margin-left:12px;"></span>
<script src="js/whitelist.js"></script>
<script>
  (function() {
    const el = document.getElementById('wl-status');
    function update() {
      const list = Whitelist.get();
      el.textContent = list.length > 0 ? '白名单: ' + list.length + '只' : '';
    }
    update();
    window.addEventListener('whitelist-changed', update);
  })();
</script>
```

### 如何验证

1. 设置白名单（3只股票）
2. 打开任意非 index 页面
3. 导航栏旁显示「白名单: 3只」
4. 清空白名单后刷新，提示消失

### DoD

- 所有页面可见白名单启用状态
- 白名单为空时无多余显示

### Git

```bash
git add public/
git commit -m "feat: add whitelist status indicator on all pages"
```

---

## 总结

| Step | 功能 | 文件 |
|------|------|------|
| 1 | 核心模块 | `public/js/whitelist.js`（新建）|
| 2 | 管理 UI | `public/index.html` |
| 3 | index 页过滤 | `public/index.html` |
| 4 | ranking 页过滤 | `public/ranking.html` |
| 5 | 全量页面过滤 | 所有 HTML 页面 |
| 6 | 状态指示 | 所有 HTML 页面 |

每步独立可验证，失败可 `git reset --hard HEAD` 回退到上一步。
