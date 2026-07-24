

# 开发计划：土耳其（TR）市场 L2 大单页面

## 目标

新增 TR 市场 L2 活跃大单页面，复用 BL 页面全部逻辑，仅切换到 `_tr` 后缀数据源，并接入 `/api/ranking-tr` 实现置顶高亮。

## 数据前提（已确认）

TR 侧四张依赖表均存在且在写入：`l2_active_orders_tr`、`ohlc_snapshot_tr`、`last_price_tr`、`daily_summary_tr`。TR 无 `priceCache`（`tos_trades_bl` 为 BL 源），故 TR 分支跳过 priceCache，改用 `ohlc_snapshot_tr.last_price` 作中间兜底。

## 涉及文件

| 文件 | 改动类型 |
|------|---------|
| `market-monitor/src/server.js` | 修改端点 `/api/l2-active-orders`；新增路由 `/l2-alerts-tr` |
| `market-monitor/public/l2_alert_history_tr.html` | 新建（复制 BL 页并改数据源） |
| `market-monitor/public/l2_alert_history.html` | 仅加一个导航链接 |

## Git 工作约定

- 从干净状态开新分支：`git status` 确认无未提交改动 → `git checkout -b feature/l2-alerts-tr`
- 每步完成且验证通过后单独提交。
- 某步失败且难以定位时，果断重置该步改动重来：
  - 丢弃工作区改动：`git checkout -- <file>`
  - 丢弃全部未提交改动回到上一个提交：`git reset --hard HEAD`（仅在本 feature 分支使用）

---

## Step 0：准备干净分支

**要做什么**
```bash
cd f:\TradingPlatform\market-monitor\market-monitor
git status              # 确认工作区干净
git checkout -b feature/l2-alerts-tr
```

**如何验证**
```bash
git branch --show-current   # 输出 feature/l2-alerts-tr
git status                  # 输出 nothing to commit, working tree clean
```

**DoD**：已在 `feature/l2-alerts-tr` 分支，工作区干净。

---

## Step 1：后端端点支持 `market=tr`

只改后端，先让数据接口跑通，前端暂不动。

**要做什么**

在 `market-monitor/src/server.js` 的 `/api/l2-active-orders`（约 1890 行）做市场感知改造。

现状（关键行）：
```js
const ALLOWED_MARKETS = new Set(['bl', 'sh', 'sz']);
...
const table = `market_data.l2_active_orders_${market}`;

const sql = `
  SELECT
    ...
    COALESCE(os.volume, d.total_volume, 0) AS total_volume,
    os.open_price AS open_price,
    lp.price AS lp_last_price
  FROM ${table} a
  LEFT JOIN market_data.daily_summary d ...
  LEFT JOIN market_data.ohlc_snapshot os ...
  LEFT JOIN market_data.last_price lp ...
`;
...
const lastPrice = lpPrice > 0 ? lpPrice : (cached ? cached.price : Number(row.price));
```

改为（整段替换该 handler）：
```js
app.get('/api/l2-active-orders', async (req, res) => {
  try {
    const market = String(req.query.market || 'BL').toLowerCase();
    const ALLOWED_MARKETS = new Set(['bl', 'sh', 'sz', 'tr']);
    if (!ALLOWED_MARKETS.has(market)) {
      return res.status(400).json({ error: 'invalid_market' });
    }

    // 市场感知表映射：TR 走 _tr 后缀且额外取 os.last_price 作兜底；
    // 其余市场沿用 BL 默认（非后缀）表 + 内存 priceCache。
    const isTr       = market === 'tr';
    const table      = `market_data.l2_active_orders_${market}`;
    const ohlcTable  = isTr ? 'market_data.ohlc_snapshot_tr' : 'market_data.ohlc_snapshot';
    const lastTable  = isTr ? 'market_data.last_price_tr'    : 'market_data.last_price';
    const dailyTable = isTr ? 'market_data.daily_summary_tr' : 'market_data.daily_summary';
    const osLastCol  = isTr ? ', os.last_price AS os_last_price' : '';

    const sql = `
      SELECT
        a.stock_code, a.alert_type, a.price, a.volume, a.depth,
        a.price_ratio, a.median_vol, a.first_seen, a.last_seen, a.alive_rounds,
        COALESCE(os.volume, d.total_volume, 0) AS total_volume,
        os.open_price AS open_price,
        lp.price AS lp_last_price${osLastCol}
      FROM ${table} a
      LEFT JOIN ${dailyTable} d
             ON d.symbol = a.stock_code AND d.trade_date = CURRENT_DATE
      LEFT JOIN ${ohlcTable} os
             ON os.symbol = a.stock_code AND os.trade_date = CURRENT_DATE
      LEFT JOIN ${lastTable} lp
             ON lp.symbol = a.stock_code
      WHERE a.trade_date = CURRENT_DATE
      ORDER BY a.price_ratio DESC NULLS LAST
    `;

    const { rows } = await pricePool.query(sql);

    const enriched = rows.map(row => {
      const openPrice = Number(row.open_price);
      if (!openPrice) return { ...row, day_change_pct: null, day_change_amt: null };
      const lpPrice = Number(row.lp_last_price) || 0;

      let lastPrice;
      if (isTr) {
        // TR 无 priceCache：last_price_tr → ohlc_snapshot_tr.last_price → 挂单价
        const osPrice = Number(row.os_last_price) || 0;
        lastPrice = lpPrice > 0 ? lpPrice : (osPrice > 0 ? osPrice : Number(row.price));
      } else {
        const cached = priceCache.get(row.stock_code);
        lastPrice = lpPrice > 0 ? lpPrice : (cached ? cached.price : Number(row.price));
      }

      const changeAmt = lastPrice - openPrice;
      const changePct = Number((changeAmt / openPrice * 100).toFixed(2));
      return {
        ...row,
        day_change_pct: changePct,
        day_change_amt: Number(changeAmt.toFixed(3)),
      };
    });

    res.json(enriched);
  } catch (e) {
    console.error('[l2-active-orders]', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

**如何验证**
```bash
npm start
# 另开一个终端：
curl "http://localhost:3000/api/l2-active-orders?market=tr"     # TR：返回 200 JSON 数组
curl "http://localhost:3000/api/l2-active-orders"               # BL 默认：无回归，仍返回数组
curl -i "http://localhost:3000/api/l2-active-orders?market=xx"  # 非法市场：HTTP 400 invalid_market
```
- TR 若当日无数据，返回 `[]` 属正常（数据侧问题，非 bug）。
- 服务端控制台无 `[l2-active-orders]` 报错（尤其确认没有 `relation "market_data.daily_summary_tr" does not exist` 之类的表缺失错误）。

**DoD**：`market=tr` 返回 200 且结构与 BL 一致；BL 无回归；非法市场返回 400；控制台无表缺失报错。

**提交**
```bash
git add src/server.js
git commit -m "feat(l2): /api/l2-active-orders 支持 market=tr（_tr 后缀 + 无 priceCache 兜底）"
```

---

## Step 2：新建 TR 页面并注册路由

**要做什么**

1. 复制 `public/l2_alert_history.html` 为 `public/l2_alert_history_tr.html`，然后改动以下 6 处：

- `<title>`：
```html
<title>TR L2 大单</title>
```
- 页面标题 h1：
```html
<h1 class="title">TR L2 大单</h1>
```
- `buildApiUrl()`：
```js
function buildApiUrl() {
    syncFiltersToUrl();
    // TR 市场实时活跃大单
    return '/api/l2-active-orders?market=tr';
}
```
- `fetchRankingData()` 里的接口地址（置顶高亮改用 TR 榜，字段兼容无需改其它逻辑）：
```js
const res = await fetch('/api/ranking-tr');
```
- 代码筛选与手动屏蔽的占位符（两处 `.BL` 示例改成 `.TR`）：
```html
<input type="text" id="filter-symbol" placeholder="如 THYAO.TR" style="width:110px">
```
```html
<input type="text" id="manual-block-input" placeholder="手动输入代码,如 THYAO.TR">
```
- `NAV_PERSIST_PATHS` 增加 `'/l2-alerts-tr'`：
```js
const NAV_PERSIST_PATHS = new Set(['/ranking','/screener','/stable-screener','/active-trading','/swing-screener','/abnormal-trades','/boundary-alerts','/oscillator-screener','/l2-alerts','/l2-alerts-tr','/large-orders','/volatility','/alerts','/volume-alerts','/volume-surge']);
```
- 该页导航条：把 TR 链接标 `active`，同时保留指向 BL 的链接：
```html
<a href="/l2-alerts">L2大单</a>
<a href="/l2-alerts-tr" class="active">L2大单-TR</a>
```

2. 在 `src/server.js` 路由区（约 4852 行 `/l2-alerts` 那一行下面）新增：
```js
app.get('/l2-alerts',       (req, res) => res.sendFile(path.join(__dirname, '../public/l2_alert_history.html')));
app.get('/l2-alerts-tr',    (req, res) => res.sendFile(path.join(__dirname, '../public/l2_alert_history_tr.html')));
```

**如何验证**
```bash
npm start
```
浏览器访问 `http://localhost:3000/l2-alerts-tr`：
- 页面加载、表格渲染 TR 大单（或"暂无记录"如当日无数据）。
- 打开浏览器 Network 面板，确认请求的是 `/api/l2-active-orders?market=tr` 和 `/api/ranking-tr`，均 200。
- 倒计时 5s 自动刷新正常；置顶高亮（▲大波动 / ★热股）不报错。
- Console 无红色报错。

**DoD**：`/l2-alerts-tr` 可访问并渲染 TR 数据，接口指向正确，自动刷新与置顶正常，无 Console 报错。

**提交**
```bash
git add public/l2_alert_history_tr.html src/server.js
git commit -m "feat(l2): 新增 TR L2 大单页 /l2-alerts-tr 及页面文件"
```

---

## Step 3：BL 页面加入 TR 入口（互链闭环）

**要做什么**

在 `public/l2_alert_history.html` 导航条的 BL L2 链接后加一个 TR 入口（BL 链接保持 `active`）：
```html
<a href="/l2-alerts" class="active">L2大单</a>
<a href="/l2-alerts-tr">L2大单-TR</a>
```

**如何验证**
```bash
npm start
```
- 打开 `http://localhost:3000/l2-alerts`，点「L2大单-TR」跳到 TR 页；在 TR 页点「L2大单」跳回 BL 页。
- 两页 `active` 高亮各自正确。

**DoD**：BL ↔ TR 两页可双向跳转，导航高亮正确，形成闭环。

**提交**
```bash
git add public/l2_alert_history.html
git commit -m "feat(l2): BL L2 页新增 TR 入口，互链闭环"
```

---

## 收尾：合并

```bash
git checkout main          # 或团队约定的主分支
git merge --no-ff feature/l2-alerts-tr
```
（是否推送/建 PR 按团队流程，本机不自动推送。）

## 验证矩阵（总）

| 项 | 命令 / 操作 | 期望 |
|----|------------|------|
| TR 接口 | `curl ".../api/l2-active-orders?market=tr"` | 200 JSON 数组 |
| BL 无回归 | `curl ".../api/l2-active-orders"` | 200 JSON 数组 |
| 非法市场 | `curl -i ".../api/l2-active-orders?market=xx"` | 400 |
| TR 页面 | 浏览器 `/l2-alerts-tr` | 渲染 + 自动刷新 + 无报错 |
| 互链 | BL↔TR 导航点击 | 双向跳转、高亮正确 |

## 风险与回滚

- **表缺列风险**：`daily_summary_tr` 若无 `total_volume` 列，Step 1 的 curl 会 500。此时可临时把 TR 分支的 `COALESCE(os.volume, d.total_volume, 0)` 降级为 `COALESCE(os.volume, 0)` 并去掉 daily join（`ohlc_snapshot_tr.volume` 已足够）。
- **任一步失败**：`git reset --hard HEAD` 回到上一个通过的提交重来，不在坏状态上打补丁。

---

