# 数据流

## 总览

```
PostgreSQL (market_data)
    │
    ├─ tos_trades ──────────────┐
    ├─ l1_quote_bl ─────────────┤
    ├─ ohlc_snapshot ───────────┤
    ├─ last_price ──────────────┤  读取（10s/60s 周期）
    ├─ daily_summary ───────────┤
    ├─ daily_intraday_vol ──────┤
    ├─ l2_* 表 ─────────────────┤
    ├─ active_trading_symbols ──┤
    └─ volatility_cycles ───────┘
              │
              ▼
    ┌─────────────────────────────────────┐
    │       内存缓存层（Map）               │
    │                                      │
    │  priceCache     → 最新价              │
    │  quoteCache     → L1 bid/ask/spread  │
    │  priceWindow    → 2分钟逐笔价格序列   │
    │  window10m      → 10分钟 OHLCV bars  │
    │  window30m      → 30分钟 OHLCV bars  │
    │  price30mCache  → 精确30分钟基准价    │
    │  rankingCache   → 全市场排行榜快照    │
    │  intradayAvgVol → 同期10日均量        │
    │  dailyRangeCache→ 5日高低差均值       │
    │  orderBookCache → L2 大单缓存        │
    └────────────┬────────────────────────┘
                 │
                 ▼
    ┌─────────────────────────────────────┐
    │       计算引擎（纯内存）              │
    │                                      │
    │  scanBoundaryAlerts()                │
    │  checkOscillatorWindow()             │
    │  snapshotStableHistory()             │
    │  getSwingRule() + 筛选               │
    │  scanAndInsertAlerts()               │
    │  scanAllVolumeAlerts()               │
    │  scanIntradayVolumeSurge()           │
    └────────────┬────────────────────────┘
                 │
       ┌─────────┴──────────┐
       ▼                    ▼
  写入 PostgreSQL      REST API 响应
  (告警/快照表)        (JSON → 前端)
```

## 详细数据路径

### 1. 价格链路

```
tos_trades (received_at DESC)
  → [10s] updatePriceCache()        → priceCache (symbol → {price, receivedAt})
  → [10s] updatePriceWindow()       → priceWindow (symbol → [{price, receivedAt}...])
  → [10s] updateWindow10m()         → window10m (symbol → [{bucket,O,H,L,C,V}...])
  → [10s] updateWindow30m()         → window30m (symbol → [{bucket,O,H,L,C,V}...])
  → [60s] updatePrice30mCache()     → price30mCache (symbol → {price, at})
```

### 2. 排行榜链路

```
ohlc_snapshot + last_price + daily_summary + daily_intraday_vol
  → [10s] refreshRankingCache()
  → rankingCache [{symbol, open_price, last_price, change_pct, total_volume, avg_vol_10d, ...}]
  → /api/ranking (附加 priceWindow 2分钟涨跌 + price30mCache 30分钟涨跌)
```

### 3. 稳定选股链路

```
window10m + rankingCache
  → [10s] snapshotStableHistory()    → stableHistory (内存，供 /history 查)
  → [60s] writeStableSnapshot()      → stable_screener_snapshot (数据库，供 /diagnose 查)
  → /api/screener-stable             (实时：直接从 window10m + rankingCache 计算)
```

### 4. 边界预警链路

```
window10m + window30m + rankingCache
  → [10s] scanBoundaryAlerts()       → boundaryAlertMap (内存状态机)
  → [60s] writeBoundarySnapshot()    → boundary_alert_snapshot (数据库)
                                     → boundaryHistory (内存时间轴)
  → /api/boundary-alerts             (读 boundaryAlertMap)
  → /api/boundary-alerts/check       (实时调用 evalBoundaryCondition)
```

### 5. 震荡筛选链路

```
window30m + rankingCache
  → /api/screener-oscillator         (实时调用 checkOscillatorWindow, 15/20/25/30 四窗口)
```

### 6. 成交量预警链路

```
tos_daily_volume + daily_summary
  → [300s] scanAllVolumeAlerts()     → k_volume_alerts (数据库)
  → [300s] scanIntradayVolumeSurge() → intraday_volume_surge + volumeSurgeToday (Set)
```

### 7. L2 盘口链路

```
l2_active_orders_bl / l2_order_events_bl / l2_alert_history_bl
  → /api/l2-active-orders            (直查 pricePool)
  → /api/l2-order-events             (直查 pricePool)
  → /api/l2-alert-history            (直查 pricePool)
  → /api/screener-large-orders-v2    (直查 pricePool, 最近10分钟)
```

> **边界说明**：K_App 当前不从 `l2_order_book_bl_default` 重建完整订单簿。L2 相关页面主要消费 `orderbook_processor_bl.py` 产出的活跃大单、事件流和历史预警结果，不直接处理原始盘口深度数据。

### 8. 波动率链路

```
volatility_cycles (外部写入)
  → /api/volatility/today            (直查 pool)
  → /api/volatility/timeseries       (直查 pool)
  → /api/volatility/latest           (直查 pool)
```

## 数据新鲜度与延迟容忍度

每条链路允许的数据延迟、超时处理方式如下：

| 链路 | 刷新周期 | 允许延迟 | 超时/失败处理 | Stale 判定 |
|------|---------|---------|--------------|-----------|
| priceCache（最新价） | 10s | 10–30s | 保留上一轮数据，不清空 | receivedAt 距今 > 60s |
| quoteCache（L1报价） | 10s | 10–30s | 保留旧值，但价差类信号标记不可用 | receivedAt 距今 > 60s |
| priceWindow（2min逐笔） | 10s | 10–20s | clear() 重建，窗口不足时不输出 Swing 信号 | 数组长度 < 2 |
| window10m（10min K线） | 10s | 10–60s | 保留上一轮，但 bars 数量不足时规则降级 | bars.length < 3 |
| window30m（30min K线） | 10s | 10–60s | 保留上一轮（滚动追加模式），增量失败不清空 | 最新 bar.bucket 距今 > 3min |
| price30mCache（30min基准价） | 60s | 60–120s | 保留旧值，/api/ranking 中 change_30m 显示为 null | 无数据时 API 返回 null |
| rankingCache（排行榜） | 10s | 10–30s | 保留旧值继续服务，日志报错 | rankingCacheTime 距今 > 60s |
| intradayAvgVolCache（同期均量） | 60s | 60–120s | 保留旧值，回退到全天均量 | 缓存为空时用 avg_vol_10d |
| L2 大单（直查） | 实时 | 1–5s | API 返回 500 错误 | — |
| volatility_cycles（波动率） | 实时查 | 1–5min | API 返回 500 错误 | 低频参考，无 stale 判定 |

### 前端数据新鲜度标识

前端轮询 API 时，应依据以下逻辑展示 stale 警告：

- 排行榜 / 选股器：如果 `rankingCacheTime` 超过 60s 未刷新，API 应附加 `stale: true` 字段。
- 价格类字段：如果 priceCache 中该 symbol 的 `receivedAt` 超过 60s，应在 API 响应中标记。
- 当前实现中尚未添加 stale 标记，作为后续改进项记录。

## 缓存失败与降级策略

| 缓存 | 数据不足时行为 | 是否允许输出信号 | 具体影响 |
|------|--------------|----------------|---------|
| priceCache | 使用上一轮数据 | 允许，但标记 stale | 排行榜价格可能滞后 |
| quoteCache | 不计算 spread | 不允许价差类信号 | 选股器 spread 列显示 null |
| priceWindow | 窗口为空时跳过 | 不输出 Swing 信号 | swing-screener 无结果 |
| window10m | 窗口不足时跳过 | 不输出稳定选股/边界预警 | bars < 3 时规则不评估 |
| window30m | 保留旧值 | 震荡筛选不输出 | bars < 15 时最小窗口不够 |
| rankingCache | 保留旧值 | 允许 | 前端排行延迟 |
| intradayAvgVolCache | 回退全天均量 | 允许（精度降低） | vol_ratio 略有偏差 |
| boundaryAlertMap | 重启后清空 | 不输出历史预警 | 数据库快照可部分恢复 |
| stableHistory | 重启后清空 | 不输出历史时间轴 | /history 返回空数组 |
| orderBookCache | 已禁用 | — | 不影响 |

### 进程重启恢复策略

| 缓存 | 重启后恢复方式 | 恢复耗时 |
|------|--------------|---------|
| priceCache | warmUpPriceCache() 查 30min 历史 | 2–5s |
| quoteCache | initQuoteCache() 查 10/30/60min | 3–10s |
| window10m | updateWindow10m() 全量查 10min | 1–2s |
| window30m | updateWindow30m() 冷启动查 30min | 3–5s |
| rankingCache | refreshRankingCache() 立即刷新 | 2–3s |
| boundaryAlertMap | **不恢复**，从零开始积累 | — |
| stableHistory | **不恢复**，快照表可查历史 | — |
| boundaryHistory | **不恢复**，快照表可查历史 | — |
| volumeSurgeToday | loadVolumeSurgeFromDB() 查当日 | < 1s |

## 缓存生命周期

| 缓存 | 冷启动数据量 | 增量窗口 | 跨天重置 |
|------|------------|---------|---------|
| priceCache | 30min | 1min | 自然淘汰 |
| quoteCache | 10/30/60min | 30s | 自然淘汰 |
| priceWindow | 2min | 2min | clear() |
| window10m | 10min | 10min (全量刷新) | clear() |
| window30m | 30min | 增量追加 | 07:55 clear() |
| price30mCache | 即时 | 60s | 07:55 clear() |
| rankingCache | 即时 | 10s | 自然刷新 |
| intradayAvgVolCache | 14天历史 | 60s | 自然刷新 |
| stableHistory | — | 10s 追加 | 07:55 clear() |
| boundaryAlertMap | — | 10s 扫描 | 07:55 clear() |

## ETF 排除

启动时加载 `ETF.csv`，排行榜查询时用 `NOT (symbol = ANY(...))` 排除 ETF 标的，避免干扰选股结果。
