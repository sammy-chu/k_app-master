# K_App — 市场监测平台

## 定位

实时市场监测与信号生成系统。从 PostgreSQL 读取已入库的逐笔成交与 L2 盘口数据，进行滚动窗口聚合、指标计算、异常检测，生成监测信号并通过 Web Dashboard 展示。

> **重要边界声明**：本项目输出的是"监测信号 / 交易线索 / 告警候选"，不是最终买卖决策。信号评分和综合排序仅作为辅助参考，交易决策由交易员自行判断。

## 职责范围

### 负责

| 模块 | 说明 |
|------|------|
| 滚动窗口聚合 | 面向监测逻辑的 10min / 30min 内存 OHLCV 窗口（非权威历史 K 线） |
| 价格监测 | 急涨急跌（振幅预警）、2分钟波动筛选 |
| 成交量监测 | 累计量比、分时放量、山丘形放量 |
| 稳定选股 | 6规则复合筛选（振幅+量+价格偏离+漂移+安静分钟+触轨） |
| 震荡筛选 | 15/20/25/30分钟多窗口 ABA/BAB 模式检测 |
| 边界预警 | 7分钟触碰次数 + 30分钟突破校验 |
| L2大单监控 | 活跃大单、事件流、异常成交（滑价/盘内价差） |
| 波动率分析 | 周期化波动率统计 |
| 活跃成交监测 | 1分钟内成交次数异常股票 |
| 信号去重与生命周期 | 告警冷却、过期、升级状态管理 |
| Web Dashboard | Express 静态页面 + REST API |

### 不负责

- 连接 PPro8 终端
- 接收 UDP 实时行情流
- 原始数据采集与入库（由外部 Python 进程负责）
- **生产权威历史 K 线数据**（由 `ohlc_writer.py` 负责入库，K_App 不作为 K 线数据源）
- 下单 / 自动交易执行
- 最终交易决策

### K 线聚合边界澄清

| 组件 | 职责 | 产出 |
|------|------|------|
| `ohlc_writer.py`（外部） | 生产快照级权威 OHLC，写入 `ohlc_snapshot` 表 | 历史 K 线数据源 |
| K_App `window10m` / `window30m` | 面向监测逻辑的滚动窗口聚合，纯内存，不持久化 | 稳定选股/震荡筛选/边界预警的计算输入 |

K_App 的窗口聚合是计算中间态，不对外提供 K 线查询服务。

## 技术栈

| 层 | 技术 |
|----|------|
| 运行时 | Node.js + Express |
| 数据库 | PostgreSQL（schema: `market_data`） |
| 前端 | 原生 HTML + Lightweight Charts |
| 部署 | Nginx 反代 + Cloudflare Tunnel |

## 外部依赖

- `pg` — PostgreSQL 客户端
- `express` — Web 框架
- `compression` — gzip 压缩
- `redis` — 预留（跨进程共享缓存 + 告警去重，当前未激活）

## 上游数据源（只读）

| 表 | 写入者 | 说明 |
|----|--------|------|
| `tos_trades` | PPro8 UDP Listener | 逐笔成交 |
| `l1_quote_bl` | PPro8 L1 Listener | L1 报价 |
| `l2_order_book_bl_default` | PPro8 L2 Listener | L2 盘口深度 |
| `l2_active_orders_bl` | orderbook_processor | 活跃大单 |
| `l2_order_events_bl` | orderbook_processor | L2 事件流 |
| `l2_alert_history_bl` | orderbook_processor | L2 预警历史 |
| `ohlc_snapshot` | ohlc_writer.py | GetLv1 实时 OHLCV（权威 K 线源） |
| `last_price` | 逐笔成交写入 | 最新价快照 |
| `active_trading_symbols` | monitor_market.py | 活跃成交标记 |
| `volatility_cycles` | volatility_scanner.py | 波动率周期 |
| `daily_intraday_vol` | orderbook_processor | 分时累计量 |

## 统一信号模型（逻辑层）

当前各类信号分散在独立表中（`k_alerts`、`k_volume_alerts`、`k_hill_alerts`、`intraday_volume_surge`、`stable_screener_snapshot`、`boundary_alert_snapshot`）。后续做综合排序时，各模块应统一转换为以下逻辑模型：

```
Signal {
  id              -- 唯一标识
  symbol          -- 标的
  market          -- 市场 (BL / NY / HK)
  signal_type     -- boundary_breakout / volume_surge / stable_pass / ...
  direction       -- up / down / neutral
  severity        -- low / medium / high
  score           -- 综合评分（0-100）
  reason          -- 触发原因描述
  source_module   -- 产生信号的模块名
  params_version  -- 使用的参数版本
  created_at      -- 首次产生时间
  confirmed_at    -- 最近确认时间
  expired_at      -- 过期时间
  status          -- active / upgraded / cooled / expired
  cooldown_secs   -- 冷却时间
  dedup_key       -- 去重键 (symbol + signal_type + price_zone)
  raw_payload     -- 原始指标数据 (JSON)
}
```

当前阶段各模块继续写自己的表，综合排序 / API 层负责统一转换。此模型暂不建表，作为后续拆分的设计目标。
