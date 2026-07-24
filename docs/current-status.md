# 当前状态

> 更新日期：2026-07-06

## 阶段目标

**Phase 1（当前）：实时监测 + 信号生成 + Web 展示**

核心目标：对 BL 市场的全部活跃股票进行实时异常检测，将告警/信号呈现给交易员辅助决策。

## 已完成功能

| 功能模块 | 状态 | 备注 |
|---------|------|------|
| K线振幅预警 (amplitude_1pct) | ✅ 运行中 | 30s 周期写入 k_alerts |
| 排行榜 (涨跌幅 + 量比) | ✅ 运行中 | 10s 刷新，ohlc_snapshot 数据源 |
| 2分钟波动筛选 (Swing Screener) | ✅ 运行中 | 分价格档位阈值 |
| 自由选股器 | ✅ 运行中 | 价格/涨跌/量比/价差多条件 AND/OR |
| 稳定选股 (6规则) | ✅ 运行中 | R1~R6 + 快照写入 + 诊断 API |
| 震荡筛选 (多窗口) | ✅ 运行中 | 15/20/25/30分钟四窗口 ABA/BAB |
| 边界预警 | ✅ 运行中 | 7分钟触碰 + 30分钟突破 + 升级机制 |
| 累计量比预警 | ✅ 运行中 | time_checkpoints 可配置 |
| 分时放量预警 | ✅ 运行中 | 30分钟窗口/3倍阈值 |
| 山丘形放量 | ✅ 运行中 | 300s 周期 |
| L2 大单监控 | ✅ 运行中 | 活跃大单 + 事件流 + 预警历史 |
| 异常成交 (滑价/盘内价差) | ✅ 运行中 | intra_spread_trades / slip_trades |
| 波动率分析 | ✅ 运行中 | 读 volatility_cycles（外部写入） |
| 活跃成交监测 | ✅ 运行中 | 读 active_trading_symbols |
| 配置热更新 (app_settings) | ✅ 运行中 | PUT /api/settings/:key |
| 部署 (Nginx + Cloudflare Tunnel) | ✅ 运行中 | GitHub Actions 自动部署 |

## 已禁用 / 迁移的功能

| 功能 | 状态 | 说明 |
|------|------|------|
| updateDailySummary() | 🚫 已禁用 | close/high/low/volume 由 orderbook_processor_bl.py 负责 |
| initOpenPrice() | 🚫 已禁用 | open_price 由 ohlc_writer.py 负责 |
| writeIntradayVolMinute() | 🚫 已禁用 | 分时累计量由 orderbook_processor_bl.py 负责 |
| snapshotTodayAllMinutes() | 🚫 已禁用 | 收盘快照由外部进程负责 |
| OrderBookCache (v1) | 🚫 已禁用 | v2 改用 l2_alert_history_bl 直查 |

## 核心待建模块

以下模块对系统长期健康运行至关重要，优先级高于新功能开发。

### 信号去重 / 冷却 / 生命周期（P0）

当前各类告警仅依靠 `ON CONFLICT DO NOTHING` 做最基础去重，缺乏完整的信号生命周期管理。不控制信号数量和生命周期，会导致告警疲劳和前端信息过载。

**目标设计**：

| 字段 | 说明 | 示例 |
|------|------|------|
| signal_type | 信号类型 | boundary_breakout / volume_surge / stable_pass |
| symbol | 标的 | AAPL.BL |
| first_seen_at | 首次出现 | 2025-07-06 09:15:00 |
| last_seen_at | 最近确认 | 2025-07-06 09:23:00 |
| status | 状态 | active → upgraded → cooled → expired |
| cooldown_seconds | 冷却时间 | 300 |
| dedup_key | 去重键 | symbol + signal_type + price_zone |
| severity | 严重级别 | low / medium / high |

**当前已有的部分实现**：
- `boundaryAlertMap`：有 `expireAt`、`upgraded`、`pinnedUntil` 状态管理
- `volumeSurgeToday`：当日 Set 去重，跨天清空
- `k_alerts`：`ON CONFLICT (symbol, bucket, rule_id) DO NOTHING`

**待补充**：
- 统一冷却机制（同一 symbol + signal_type 在 N 秒内不重复触发）
- 信号过期自动清理
- 前端按 severity 分级展示 + 历史归档

### 监控与健康检查（P0）

市场监测系统最怕"页面还在，但数据其实停了"。必须有机制让运维和交易员快速判断数据是否正常。

**最低要求**：

| 端点 | 检查项 | 返回 |
|------|--------|------|
| `GET /health` | 进程存活 | ✅ 已有 |
| `GET /health/db` | pool + pricePool 连接正常 | ❌ 待实现 |
| `GET /health/cache` | 各缓存最后更新时间 + stale 判定 | ❌ 待实现 |
| `GET /metrics` | 每个任务耗时、失败次数、最近成功时间 | ❌ 待实现 |

**额外目标**：
- 定时任务 watchdog：某任务连续失败 N 次 → 输出告警日志
- 数据延迟检测：`tos_trades_bl.received_at` 距当前时间超过阈值 → 标记数据断流
- 前端健康面板：顶部显示各数据源状态（绿/黄/红）

### 参数版本管理（P1）

当前 `app_settings` + `settings_change_log` 提供了参数修改追踪能力，但存在以下缺口：

| 问题 | 影响 |
|------|------|
| 历史告警不记录当时使用的参数 | 回测时不知道信号是用哪套阈值生成的 |
| 参数修改后立即影响当前所有信号 | 无法做 A/B 对比 |
| 回测无法选择特定参数快照 | 策略优化缺少基准 |

**建议方案**：
1. 每次参数修改时生成 `params_version` 递增版本号
2. 告警写入时附带 `params_version` 字段
3. 回测 API 支持指定 `params_version` 查询
4. `settings_change_log` 已有足够信息，前端增加"历史参数对比"视图即可

## 未完成事项 / TODO

### P0 — 系统稳定性与可维护性

- [ ] 信号去重 / 冷却 / 生命周期统一模型（见上方详细设计）
- [ ] 监控与健康检查 /health/db + /health/cache + /metrics（见上方详细设计）
- [ ] server.js 职责拆分（目标结构见 architecture.md）
- [ ] 前端告警推送（WebSocket / SSE），取代当前轮询模式

### P1 — 功能增强

- [ ] Redis 接入（明确用途见下方）
- [ ] 参数版本管理（见上方详细设计）
- [ ] 信号评分 / 综合排序算法（多维度加权，依赖统一信号模型）
- [ ] 多市场支持（Market Context 抽象，见 architecture.md）
- [ ] 告警降噪机制优化
- [ ] API 认证 / 权限管理

### P2 — 工程质量

- [ ] 前端 UI 框架化（当前为原生 HTML）
- [ ] 单元测试 / 集成测试覆盖（核心算法优先）
- [ ] Docker 容器化部署
- [ ] 历史回测框架

## Redis 用途定义

`redis` 依赖已安装但未启用。明确其职责边界，避免盲目接入：

| 用途 | 说明 | 优先级 |
|------|------|--------|
| 跨进程共享结果缓存 | 多实例部署时共享 rankingCache 等低频结果 | P1 |
| 告警去重 | SET NX + TTL 实现分布式冷却 | P1 |
| 前端推送 Pub/Sub | WebSocket 广播告警事件 | P1 |
| 进程重启恢复 | 非持久化缓存的快照保存（boundaryAlertMap 等） | P2 |

**Redis 不应承载**：
- 高频逐笔明细（tos_trades_bl 级别数据不走 Redis）
- 权威持久化存储（信号历史必须在 PostgreSQL）
- 复杂查询（时间范围查询、聚合计算仍走 PG）

> Redis 定位为：跨进程共享的结果缓存层 + 告警去重 + 事件广播，不替代 PostgreSQL，不承载原始数据。

## 已知限制

1. **单进程架构** — 所有定时任务在同一 Node.js 进程内 `while(true)` 循环，内存占用较高，无法水平扩展。
2. **内存状态不持久** — `stableHistory`、`boundaryAlertMap`、`boundaryHistory` 仅存内存，进程重启丢失（快照表可部分恢复）。
3. **时区硬编码** — 多处使用 `Asia/Shanghai`，切换市场需修改代码（已规划 Market Context）。
4. **无测试覆盖** — 核心计算逻辑（checkOscillatorWindow、evalBoundaryCondition 等）缺少自动化测试。
5. **server.js 过度膨胀** — 单文件承载 API + 缓存 + 定时任务 + 信号计算，是最大技术债。
6. **无 stale 标记** — 前端无法感知数据是否陈旧，可能展示滞后数据而不自知。

## 目录结构

```
k_app-master-production-only/
├── src/
│   ├── server.js              # 主入口（API + 定时任务 + 缓存逻辑）← 待拆分
│   ├── config-manager.js      # app_settings 配置管理
│   ├── scan-flexible-hills.js # 山丘形放量算法
│   └── sql/                   # SQL 迁移脚本
├── public/                    # 前端静态页面
│   ├── index.html
│   ├── ranking.html
│   ├── screener*.html
│   ├── alerts.html
│   ├── boundary-alerts.html
│   ├── volatility.html
│   ├── ...
│   └── js/lightweight-charts.standalone.production.js
├── deployment-templates/      # 部署配置模板
├── docs/                      # 项目文档（本目录）
├── ETF.csv                    # ETF 排除列表
├── package.json
└── .github/workflows/         # CI/CD
```
