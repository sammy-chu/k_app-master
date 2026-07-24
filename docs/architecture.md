# 架构设计

## 系统架构图

```
┌─────────────────────────────────────────────────────────────────┐
│  外部数据采集层（不属于本项目）                                       │
│  PPro8 UDP Listener → tos_trades_bl / l1_quote_bl / l2_order_book  │
│  ohlc_writer.py → ohlc_snapshot                                 │
│  orderbook_processor_bl.py → l2_active_orders / events / intra  │
│  monitor_market.py → active_trading_symbols                     │
│  volatility_scanner.py → volatility_cycles                      │
└──────────────────────────┬──────────────────────────────────────┘
                           │ PostgreSQL (market_data schema)
┌──────────────────────────▼──────────────────────────────────────┐
│  K_App Server (本项目)                                           │
│                                                                  │
│  ┌──────────────────┐  ┌───────────────────┐  ┌──────────────┐ │
│  │  内存缓存层       │  │  定时任务引擎      │  │  REST API    │ │
│  │  ─ priceCache    │  │  ─ 数据同步任务    │  │  /api/ranking│ │
│  │  ─ quoteCache    │  │  ─ 信号扫描任务    │  │  /api/alerts │ │
│  │  ─ priceWindow   │  │  ─ 快照持久化任务  │  │  /api/screen*│ │
│  │  ─ window10m     │  │                   │  │  /api/volume*│ │
│  │  ─ window30m     │  │                   │  │  /api/l2-*   │ │
│  │  ─ rankingCache  │  │                   │  │  /api/volati*│ │
│  │  ─ orderBookCache│  │  (v1已禁用/legacy)│  │  ...         │ │
│  │  ─ boundaryAlert │  │                   │  │              │ │
│  │  ─ stableHistory │  │                   │  │              │ │
│  └──────────────────┘  └───────────────────┘  └──────────────┘ │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │  连接池                                                       ││
│  │  pool (主池, max=20) — 面向 API 查询 + 告警写入               ││
│  │  pricePool (价格池, max=10) — 面向 PriceWindow/Cache/Window  ││
│  └──────────────────────────────────────────────────────────────┘│
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP :3000
┌──────────────────────────▼──────────────────────────────────────┐
│  前端 Dashboard（public/）                                       │
│  ─ ranking.html          排行榜                                  │
│  ─ screener.html         自由选股器                              │
│  ─ screener-stable.html  稳定选股                                │
│  ─ screener-oscillator   震荡筛选                                │
│  ─ boundary-alerts.html  边界预警                                │
│  ─ alerts.html           K线振幅预警                             │
│  ─ volume-alerts.html    成交量预警                              │
│  ─ volatility.html       波动率分析                              │
│  ─ active-trading.html   活跃成交                                │
│  ─ abnormal-trades.html  异常成交                                │
│  ─ ...                                                          │
└─────────────────────────────────────────────────────────────────┘
```

## 核心设计原则

1. **只读上游** — 本项目不写入 `tos_trades_bl`、`l1_quote_bl`、`l2_order_book` 等原始表，只读取并聚合。
2. **内存优先** — 高频指标全部基于内存缓存计算（Map），避免每次 API 请求触发数据库查询。
3. **双连接池隔离** — `pool`（主池）面向低频 API 和告警写入，`pricePool` 面向高频 10s 循环任务，互不干扰。
4. **冷启动 + 增量** — 启动时查历史窗口填满缓存，之后仅查增量数据合并。
5. **信号是线索不是决策** — 所有输出均为监测信号/告警候选，不代表买卖指令。

## 连接池策略

| 池 | max | 用途 | statement_timeout |
|----|-----|------|-------------------|
| pool | 20 | API 查询、告警写入、快照写入 | 30s |
| pricePool | 10 | PriceCache、PriceWindow、Window10m/30m、QuoteCache | 15s（冷启动60s） |

## 定时任务分类

### 第一类：数据同步任务

从数据库拉取最新数据写入内存缓存，为后续计算提供输入。

| 间隔 | 任务 | 连接池 | 说明 |
|------|------|--------|------|
| 10s | PriceCache | pricePool | 最新成交价 |
| 10s | PriceWindow | pricePool | 2分钟逐笔窗口 |
| 10s | Window10m | pricePool | 10分钟分钟K线 |
| 10s | Window30m | pricePool | 30分钟分钟K线（滚动追加） |
| 10s | QuoteCache | pricePool | L1 报价增量 |
| 10s | RankingCache | pool | 排行榜主缓存 |
| 60s | Price30mCache | pricePool | 精确30分钟基准价 |
| 60s | IntradayAvgVol | pool | 当前时段10日均量 |
| 3600s | DailyRangeCache | pool | 5日高低差均值 |

### 第二类：信号扫描任务

基于内存缓存执行规则判断，检测是否触发告警/信号。

| 间隔 | 任务 | 连接池 | 说明 |
|------|------|--------|------|
| 10s | BoundaryAlerts | 纯内存 | 边界预警扫描（状态机） |
| 30s | PriceMonitor | pool | 振幅预警检测 |
| 300s | VolumeMonitor | pool | 累计量比预警 |
| 300s | HillMonitor | pool | 山丘形放量检测 |
| 300s | VolumeSurge | pool | 分时放量检测 |

### 第三类：快照 / 持久化任务

将内存计算结果写入数据库，供历史诊断和回溯。

| 间隔 | 任务 | 连接池 | 说明 |
|------|------|--------|------|
| 60s | StableSnapshot | pool | 稳定选股快照写入 |
| 60s | BoundarySnapshot | pool | 边界预警快照写入 |
| — | PriceMonitor (写入) | pool | K线振幅告警持久化 |
| — | VolumeMonitor (写入) | pool | 成交量告警持久化 |

> **拆分意义**：后续迁移到 Redis/Worker/队列架构时，第一类可独立为"缓存同步 Worker"，第二类可独立为"信号计算 Worker"，第三类可独立为"持久化 Worker"。注意：第一类是从 PostgreSQL 同步到内存缓存，不是原始数据采集（那属于外部进程职责）。

## 本项目写入的表

| 表 | 说明 |
|----|------|
| `k_alerts` | K线振幅预警 |
| `k_volume_alerts` | 成交量预警 |
| `k_hill_alerts` | 山丘形放量预警 |
| `intraday_volume_surge` | 分时放量预警 |
| `stable_screener_snapshot` | 稳定选股历史快照 |
| `boundary_alert_snapshot` | 边界预警历史快照 |
| `app_settings` / `settings_change_log` | 配置管理 |

## 目标目录结构（重构方向）

当前 `server.js` 承载了 API + 定时任务 + 缓存逻辑 + 信号计算的全部职责，这是最大的技术债。后续重构目标：

```
src/
├── server.js                    # 仅负责 Express 启动、模块注册、任务调度
├── db/
│   ├── pools.js                 # pool / pricePool 初始化
│   └── queries/                 # 复用 SQL 模板
├── caches/
│   ├── price-cache.js           # priceCache + warmUp + update
│   ├── quote-cache.js           # quoteCache + init + incremental
│   ├── window-cache.js          # window10m / window30m
│   ├── ranking-cache.js         # rankingCache + intradayAvgVol
│   └── index.js                 # 统一导出
├── scanners/
│   ├── boundary-scanner.js      # scanBoundaryAlerts + evalBoundaryCondition
│   ├── stable-scanner.js        # snapshotStableHistory + checkOscillator
│   ├── volume-scanner.js        # scanAllVolumeAlerts + scanIntradayVolumeSurge
│   ├── hill-scanner.js          # scanAndInsertHillAlerts
│   └── price-monitor.js         # scanAndInsertAlerts (amplitude)
├── routes/
│   ├── ranking-routes.js        # /api/ranking
│   ├── screener-routes.js       # /api/screener* + /api/screener-stable + oscillator
│   ├── alert-routes.js          # /api/alerts + /api/boundary-alerts + /api/volume-*
│   ├── l2-routes.js             # /api/l2-* + /api/screener-large-orders-v2
│   ├── volatility-routes.js     # /api/volatility/*
│   └── settings-routes.js       # /api/settings
├── services/
│   ├── settings-service.js      # ConfigManager 包装
│   └── alert-writer.js          # 统一告警写入（含去重逻辑）
└── market/
    └── market-config.js         # 多市场配置（见下方）
```

> **注意**：这是目标架构，不要求一次性重构。每次改动应渐进式将功能从 `server.js` 抽出。

## 多市场扩展设计（Market Context）

当前仅支持 BL 市场，时区硬编码为 `Asia/Shanghai`。后续扩展需要抽象 Market Context：

```js
// src/market/market-config.js

const MARKETS = {
  BL: {
    id: 'BL',
    timezone: 'Asia/Shanghai',
    sessionStart: '08:00',
    sessionEnd: '16:00',
    resetTime: '07:55',           // 跨天清理时间
    symbolSuffix: '.BL',
    tables: {
      trades: 'tos_trades_bl',
      quote: 'l1_quote_bl',
      l2ActiveOrders: 'l2_active_orders_bl',
      l2Events: 'l2_order_events_bl',
      l2AlertHistory: 'l2_alert_history_bl',
      orderBook: 'l2_order_book_bl_default',
    },
    etfListFile: 'ETF.csv',
    tickSize: 0.01,               // 最小跳动单位
  },
  // 后续扩展示例：
  // NY: {
  //   id: 'NY',
  //   timezone: 'America/New_York',
  //   sessionStart: '09:30',
  //   sessionEnd: '16:00',
  //   resetTime: '09:25',
  //   symbolSuffix: '',
  //   tables: { ... },
  //   tickSize: 0.01,
  // },
};

module.exports = { MARKETS };
```

**影响范围**（扩展新市场时需修改的点）：

| 维度 | 当前硬编码位置 | 扩展方式 |
|------|--------------|---------|
| 时区 | `Asia/Shanghai` 散落在多处 | 从 market.timezone 读取 |
| 交易时段 | `MARKET_OPEN_MINS=480` | 从 market.sessionStart 解析 |
| 表名 | `l2_active_orders_bl` | 从 market.tables 字典取 |
| ETF排除 | `ETF.csv` 固定路径 | 从 market.etfListFile 取 |
| symbol后缀 | `.BL` | 从 market.symbolSuffix 取 |
| 跨天清理 | 07:55 硬编码 | 从 market.resetTime 取 |

哪怕当前只实现 BL，新代码应优先引用 `MARKETS.BL.xxx` 而非硬编码魔数。
