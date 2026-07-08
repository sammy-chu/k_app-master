# AI 协作开发指南

本文档面向 Codex / Kiro / Trae / DeepSeek 等 AI 开发工具，定义修改本项目时的规则和约束。

## 修改边界规则

### 绝对禁止

1. **不允许修改外部数据采集进程**（ohlc_writer.py / orderbook_processor_bl.py / monitor_market.py / volatility_scanner.py / PPro8 UDP Listener）
2. **不允许修改原始行情表结构**（tos_trades / l1_quote_bl / l2_order_book_bl_default / ohlc_snapshot / last_price）
3. **不允许让 K_App 承担数据采集职责**（不接 UDP、不连 PPro8、不写原始表）
4. **不允许让 K_App 生产权威历史 K 线**（window10m / window30m 是临时计算窗口，不对外提供）
5. **不允许在 K_App 中实现下单 / 自动交易逻辑**

### 必须遵守

6. **新增 API 必须放在 `routes/` 目录**（若目录尚不存在，先从 server.js 中抽取已有路由再添加）
7. **新增扫描/信号逻辑必须放在 `scanners/` 目录**
8. **新增缓存必须声明以下信息**（在代码注释或 PR 描述中说明）：
   - 数据源表
   - 刷新周期
   - 过期策略
   - 是否跨天清理
   - stale 判定阈值
9. **涉及 SQL 查询必须说明索引需求**（是否需要新建索引，或确认已有索引能覆盖）
10. **涉及告警/信号写入必须说明去重规则**（用哪个 UNIQUE 约束，冲突时 DO NOTHING 还是 DO UPDATE）
11. **涉及定时任务必须说明分类**（数据同步 / 信号扫描 / 快照持久化，见 architecture.md）
12. **涉及时间/时区必须引用 Market Context**（不允许新增硬编码 `Asia/Shanghai`、`08:00`、`16:00` 等魔数）
13. **涉及前端页面修改必须保持无框架依赖**（当前为原生 HTML + fetch，不引入 React/Vue 除非明确要求）

### 推荐遵守

14. 优先使用 `pricePool` 进行高频查询（10s 周期内的任务），`pool` 用于 API 响应和写入
15. 新增参数应通过 `app_settings` 表管理，支持热更新
16. 新增信号应设计 dedup_key，遵循统一信号模型（见 project-overview.md）
17. 大批量写入使用分批 INSERT（BATCH_SIZE = 500），避免长事务锁
18. 日志格式统一为 `[ModuleName] message`，便于 grep

## 代码风格

- Node.js，CommonJS (`require` / `module.exports`)
- 不使用 TypeScript（当前项目无 TS 配置）
- 缩进 2 空格
- 字符串用单引号
- SQL 用模板字符串，参数化查询（`$1, $2...`），禁止字符串拼接
- 异步统一使用 `async/await`，不混用 callback
- 错误处理：`try/catch` + `console.error('[Module] message:', err.message)`

## 开发任务模板

AI 接收开发任务时，应先填写以下模板确认范围，再开始编码：

```
## 任务信息

任务名称：
目标：
触发条件：（什么情况下执行 / 什么 API 调用触发）

## 影响范围

涉及页面：（如 ranking.html, screener-stable.html, 或"无"）
涉及 API：（如 GET /api/xxx, POST /api/yyy, 或"无"）
涉及缓存：（如 window10m, rankingCache, 或"新增 xxxCache"）
涉及数据表：（读哪些表 / 写哪些表）
是否写数据库：是 / 否
是否需要新索引：是（说明） / 否
是否影响现有定时任务：是（说明） / 否

## 设计要点

信号去重规则：（dedup_key / UNIQUE 约束 / 冷却时间）
降级策略：（数据不足时如何处理）
跨天清理：（是否需要在 07:55 reset）
参数配置：（是否通过 app_settings 管理）

## 验收标准

1. ...
2. ...
3. ...

## 回滚方式

- 代码回滚：git revert
- 数据回滚：DROP TABLE / DELETE FROM ... WHERE ...
- 缓存影响：重启进程自动恢复 / 需要手动清理
```

## 常见任务示例

### 示例 1：新增一个筛选器 API

```
任务名称：新增"大幅回调筛选器"
目标：检测近10分钟内从高点回调超过 1% 的股票
触发条件：GET /api/screener-pullback?min_drop=1.0

涉及页面：新增 screener-pullback.html
涉及 API：GET /api/screener-pullback
涉及缓存：读 window10m + rankingCache（不新增缓存）
涉及数据表：只读，不写表
是否写数据库：否
是否需要新索引：否
是否影响现有定时任务：否

信号去重规则：纯 API 查询，无持久化，无需去重
降级策略：window10m bars < 5 时该 symbol 不输出
跨天清理：无（纯计算）
参数配置：min_drop 通过 query param 传入，不入 app_settings

验收标准：
1. API 返回符合条件的 symbol 列表，包含 symbol/last_price/high_10m/drop_pct
2. 前端页面可正常展示并 10s 自动刷新
3. 无新增定时任务，不影响现有功能

回滚方式：删除路由 + 页面文件即可
```

### 示例 2：新增一个定时告警任务

```
任务名称：新增"连续放量告警"
目标：连续3根1分钟K线成交量 > 前10分钟均量 × 2 时触发
触发条件：定时任务，10s 周期

涉及页面：alerts.html 中新增展示行
涉及 API：GET /api/alerts?rule_id=consecutive_volume_surge
涉及缓存：读 window10m（不新增缓存）
涉及数据表：写 k_alerts (rule_id = 'consecutive_volume_surge')
是否写数据库：是
是否需要新索引：否（已有 idx_k_alerts_unique 覆盖）
是否影响现有定时任务：新增一个信号扫描任务（第二类）

信号去重规则：UNIQUE (symbol, bucket, rule_id) + ON CONFLICT DO NOTHING
降级策略：window10m bars < 4 时不评估
跨天清理：无（告警表按时间自然累积）
参数配置：倍数阈值 2.0 → app_settings key: consecutive_vol_ratio

验收标准：
1. 告警正确写入 k_alerts
2. 不产生重复告警（同一分钟 + symbol 只触发一次）
3. alerts.html 可筛选展示此 rule_id
4. 启动日志输出 [ConsecutiveVolScanner] starting

回滚方式：
- 代码：移除 scanner 函数 + 移除 runScan 调用
- 数据：DELETE FROM k_alerts WHERE rule_id = 'consecutive_volume_surge'
```

## 文档维护规则

修改代码时，如果涉及以下变更，必须同步更新对应文档：

| 变更类型 | 需更新的文档 |
|---------|------------|
| 新增/删除 API | architecture.md（路由列表）|
| 新增/删除缓存 | data-flow.md（缓存表 + 降级表）|
| 新增/删除定时任务 | architecture.md（任务分类表）|
| 新增/删除数据表 | architecture.md（写入表）+ project-overview.md（上游表）|
| 修改项目边界/职责 | project-overview.md |
| 修改信号模型 | project-overview.md（统一信号模型）|
| 完成 TODO 项 | current-status.md |
| 新增已知限制 | current-status.md |
