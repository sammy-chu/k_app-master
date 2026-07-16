const express = require('express');
const fs = require('fs');
const path = require('path');
const compression = require('compression');
const { Pool } = require('pg');
const { getFlexibleHills } = require('./scan-flexible-hills');
const ConfigManager = require('./config-manager');

const app = express();
app.use(compression());

// ══════════════════════════════════════════════════════════════
// [PERF] 就绪状态标记：冷启动完成前 API 返回 503
// ══════════════════════════════════════════════════════════════
let serverReady = false;

// 健康检查端点（不受就绪门控）
app.get('/api/health', (req, res) => {
  res.json({ ready: serverReady, uptime: process.uptime() });
});

// Enable CORS for production and development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// [PERF] 就绪门控中间件：数据 API 在冷启动完成前返回 503 + Retry-After
app.use((req, res, next) => {
  if (serverReady || !req.path.startsWith('/api/') || req.path === '/api/health') {
    return next();
  }
  res.set('Retry-After', '5');
  return res.status(503).json({
    error: 'server_warming_up',
    message: '服务器正在初始化数据缓存，请稍候...',
    retry_after: 5,
  });
});

// 主连接池
const pgSchema = process.env.PGSCHEMA || 'market_data';
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000,
});

pool.on('connect', (client) => {
  client.query('SET search_path TO ' + pgSchema);
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err.message);
});

// [FIX 1] 独立连接池，专供 PriceWindow、PriceCache 和 QuoteCache
// [PERF] max 从 10 提升到 15，支持并行冷启动期间更高并发
const pricePool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  max: 15,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000,  // 启动期连接排队，从10s延长到30s
  statement_timeout: 15000,
});

pricePool.on('connect', (client) => {
  client.query('SET search_path TO ' + pgSchema);
});

pricePool.on('error', (err) => {
  console.error('[pricePool] Unexpected error on idle client', err.message);
});

// Initialize ConfigManager
const config = new ConfigManager(pool);

async function ensureTables() {
  // [PERF] 跳过 DDL 检查：表结构已稳定，仅首次部署或显式传入 ENSURE_TABLES=1 时执行
  if (process.env.ENSURE_TABLES !== '1') {
    console.log('[ensureTables] Skipped (set ENSURE_TABLES=1 to run DDL checks)');
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('SET search_path TO ' + pgSchema);

    await client.query(`
      CREATE TABLE IF NOT EXISTS k_alerts (
        id SERIAL PRIMARY KEY,
        symbol TEXT NOT NULL,
        bucket TIMESTAMPTZ NOT NULL,
        open NUMERIC,
        high NUMERIC,
        low NUMERIC,
        close NUMERIC,
        amplitude_pct NUMERIC,
        direction INTEGER,
        rule_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_k_alerts_unique ON k_alerts (symbol, bucket, rule_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS k_volume_alerts (
        id SERIAL PRIMARY KEY,
        symbol TEXT NOT NULL,
        bucket TIMESTAMPTZ NOT NULL,
        volume_ratio NUMERIC,
        current_cum_vol NUMERIC,
        avg_daily_vol NUMERIC,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        rule_id TEXT NOT NULL DEFAULT 'volume_surge',
        updated_at TIMESTAMPTZ,
        current_price NUMERIC,
        prev_price NUMERIC,
        price_change_val NUMERIC,
        price_note TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_k_vol_alerts_unique ON k_volume_alerts (symbol, bucket, rule_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tos_daily_volume (
        symbol TEXT NOT NULL,
        trade_date DATE NOT NULL,
        daily_volume NUMERIC,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (symbol, trade_date)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_summary (
        symbol TEXT NOT NULL,
        trade_date DATE NOT NULL,
        open_price NUMERIC,
        close_price NUMERIC,
        high_price NUMERIC,
        low_price NUMERIC,
        total_volume NUMERIC,
        PRIMARY KEY (symbol, trade_date)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS k_hill_alerts (
        id SERIAL PRIMARY KEY,
        symbol TEXT NOT NULL,
        bucket_time TIMESTAMPTZ NOT NULL,
        volume NUMERIC,
        baseline_volume NUMERIC,
        breakout_ratio NUMERIC,
        hill_data JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uniq_hill_alert UNIQUE(symbol, bucket_time)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS intraday_volume_surge (
        symbol        TEXT NOT NULL,
        trade_date    DATE NOT NULL,
        bucket_time   TIMESTAMPTZ NOT NULL,
        window_vol    NUMERIC,
        avg_daily_vol NUMERIC,
        vol_ratio     NUMERIC,
        PRIMARY KEY (symbol, trade_date)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        value_type TEXT,
        description TEXT,
        min_value NUMERIC,
        max_value NUMERIC,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS settings_change_log (
        id SERIAL PRIMARY KEY,
        key TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        changed_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS stable_screener_snapshot (
        symbol      TEXT     NOT NULL,
        trade_date  DATE     NOT NULL,
        snap_time   TIME     NOT NULL,
        last_price  NUMERIC(12,4),
        open_price  NUMERIC(12,4),
        change_pct  NUMERIC(8,4),
        bars_count  SMALLINT,
        r1_val      NUMERIC(8,4),
        r2_vol      NUMERIC(14,2),
        r3_pct      NUMERIC(8,4),
        r4_pct      NUMERIC(8,4),
        r5_cnt      SMALLINT,
        r6_a        SMALLINT,
        r6_b        SMALLINT,
        pass_all    BOOLEAN  NOT NULL DEFAULT FALSE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (symbol, trade_date, snap_time)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS boundary_alert_snapshot (
        symbol       TEXT     NOT NULL,
        trade_date   DATE     NOT NULL,
        snap_time    TIME     NOT NULL,
        last_price   NUMERIC(12,4),
        change_pct   NUMERIC(8,4),
        bars_count   SMALLINT,
        win_high     NUMERIC(12,4),
        win_low      NUMERIC(12,4),
        price_a      NUMERIC(12,4),
        price_b      NUMERIC(12,4),
        touch_a      SMALLINT,
        touch_b      SMALLINT,
        cycle_vol    NUMERIC(14,2),
        high30       NUMERIC(12,4),
        low30        NUMERIC(12,4),
        price_a30    NUMERIC(12,4),
        price_b30    NUMERIC(12,4),
        trigger_type TEXT,
        triggered    BOOLEAN  NOT NULL DEFAULT FALSE,
        fail_reason  TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (symbol, trade_date, snap_time)
      );
    `);

    console.log('Tables ensured');
  } catch (err) {
    console.error('Error ensuring tables:', err);
  } finally {
    client.release();
  }
}

// Load ETF exclusion list
let etfList = [];
try {
  const etfPath = path.join(__dirname, '../ETF.csv');
  if (fs.existsSync(etfPath)) {
    const etfContent = fs.readFileSync(etfPath, 'utf-8');
    etfList = etfContent.split(/\r?\n/).map(line => line.trim()).filter(line => line);
    console.log(`Loaded ${etfList.length} ETFs from ETF.csv`);
  } else {
    console.warn('ETF.csv not found, skipping ETF exclusion');
  }
} catch (err) {
  console.error('Failed to load ETF.csv:', err.message);
}

// In-memory price snapshot cache: symbol -> { price, receivedAt }
const priceCache = new Map();

// L1 quote cache: symbol -> { bid, ask, spread, receivedAt }
// 冷启动：LATERAL 取5分钟内每个 symbol 最新一条（只跑一次）
// 之后每10秒：只扫 received_at >= NOW()-30s 的增量行，merge 进缓存
// 依赖索引: idx_l1_quote_bl_received_at (received_at DESC)  → 0.67ms / 3841行
const quoteCache = new Map();
let quoteCacheInitialized = false;

async function initQuoteCache() {
  // 冷启动用独立 client，单独设 statement_timeout=60000，与池默认15s隔离
  // 启动期 pricePool 连接紧张，connectionTimeoutMillis=30s 确保能拿到连接
  const windows = ['10 minutes', '30 minutes', '60 minutes'];
  for (const w of windows) {
    const client = await pricePool.connect();
    try {
      await client.query('SET statement_timeout = 60000');
      const { rows } = await client.query(`
        SELECT symbol,
               bid::numeric AS bid,
               ask::numeric AS ask,
               received_at
        FROM market_data.l1_quote_bl
        WHERE received_at >= NOW() - INTERVAL '${w}'
          AND bid IS NOT NULL AND bid::numeric > 0
          AND ask IS NOT NULL AND ask::numeric > 0
        ORDER BY received_at DESC
      `);
      const seen = new Set();
      for (const row of rows) {
        if (seen.has(row.symbol)) continue;
        seen.add(row.symbol);
        const bid    = Number(row.bid);
        const ask    = Number(row.ask);
        const spread = Number((ask - bid).toFixed(4));
        quoteCache.set(row.symbol, { bid, ask, spread, receivedAt: row.received_at });
      }
      quoteCacheInitialized = true;
      console.log(`[QuoteCache] Cold-start done (window=${w}), ${quoteCache.size} symbols loaded`);
      return;
    } catch (err) {
      console.error(`[QuoteCache] Cold-start failed (window=${w}):`, err.message);
    } finally {
      await client.query('SET statement_timeout = 0').catch(() => {});
      client.release();
    }
  }
  // 所有窗口都失败，仍标记完成让增量接管
  quoteCacheInitialized = true;
  console.log(`[QuoteCache] Cold-start skipped, incremental update will populate cache`);
}

async function updateQuoteCache() {
  // 冷启动未完成时跳过增量更新，避免覆盖空缓存
  if (!quoteCacheInitialized) return;
  try {
    // 增量：只扫最近30秒新增的行，走 idx_l1_quote_bl_received_at
    // 实测：0.67ms，70 buffers全部 shared hit，无磁盘读
    const { rows } = await pricePool.query(`
      SELECT symbol,
             bid::numeric AS bid,
             ask::numeric AS ask,
             received_at
      FROM market_data.l1_quote_bl
      WHERE received_at >= NOW() - INTERVAL '30 seconds'
        AND bid IS NOT NULL AND bid::numeric > 0
        AND ask IS NOT NULL AND ask::numeric > 0
      ORDER BY received_at DESC
    `);

    // 每个 symbol 只保留最新一条（ORDER BY DESC，第一次出现的就是最新的）
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.symbol)) continue;
      seen.add(row.symbol);
      const bid    = Number(row.bid);
      const ask    = Number(row.ask);
      const spread = Number((ask - bid).toFixed(4));
      quoteCache.set(row.symbol, { bid, ask, spread, receivedAt: row.received_at });
    }
  } catch (err) {
    console.error('[QuoteCache] Incremental update failed:', err.message);
  }
}

// updatePriceCache 只查最近1分钟成交价，数据量小速度快（~0.3s）
// 超时或无数据时保留旧缓存值，稀疏成交股票用上次价格
async function updatePriceCache() {
  const client = await pricePool.connect();
  try {
    await client.query('SET statement_timeout = 5000');
    const { rows } = await client.query(`
      SELECT DISTINCT ON (symbol) symbol, price::numeric AS price, received_at
      FROM market_data.tos_trades
      WHERE received_at >= NOW() - INTERVAL '1 minute'
        AND price > 0
      ORDER BY symbol, received_at DESC, id DESC
    `);
    for (const row of rows) {
      priceCache.set(row.symbol, { price: Number(row.price), receivedAt: row.received_at });
    }
  } catch (err) {
    console.error('[PriceCache] Update failed:', err.message);
  } finally {
    client.release();
  }
}

// 冷启动时查30分钟，快速填满 priceCache，之后切换到1分钟增量
async function warmUpPriceCache() {
  const client = await pricePool.connect();
  try {
    await client.query('SET statement_timeout = 15000');
    const { rows } = await client.query(`
      SELECT DISTINCT ON (symbol) symbol, price::numeric AS price, received_at
      FROM market_data.tos_trades
      WHERE received_at >= NOW() - INTERVAL '30 minutes'
        AND price > 0
      ORDER BY symbol, received_at DESC, id DESC
    `);
    for (const row of rows) {
      priceCache.set(row.symbol, { price: Number(row.price), receivedAt: row.received_at });
    }
    console.log(`[PriceCache] warm up done, ${priceCache.size} symbols loaded`);
  } catch (err) {
    console.error('[PriceCache] Warm up failed:', err.message);
  } finally {
    client.release();
  }
}

// Sliding 4-minute price window: symbol -> array of { price, receivedAt } sorted oldest-first
const priceWindow = new Map();

// 10-minute OHLCV window cache (方案A: GROUP BY 聚合，实测 ~71ms)
// symbol -> array of { bucket, open, high, low, close, volume } sorted oldest-first
// 每根 bar 代表一个完整分钟，最多 10 根
const window10m = new Map();

// 30-minute OHLCV window cache，供震荡筛选规则（15/20/25/30分钟窗口）使用
// symbol -> array of { bucket, open, high, low, close, volume } sorted oldest-first
// 滚动追加模式：每次只查增量，内存保留最近30根bar，不全量重查
const window30m = new Map();
let window30mLastBucket = null; // 上次已写入的最新 bucket（Date对象），null表示冷启动

// 精确30分钟基准价缓存：symbol -> { price, at }
// 每60秒更新一次，取 "30分钟前最后一笔成交价"，避免 window30m 滚动淘汰造成的跳变
const price30mCache = new Map();
let price30mLastUpdate = 0;

// 稳定选股历史快照：symbol -> [{ time, r1_val, r2_vol, r3_pct, r4_pct, r5_cnt, last_price, change_pct }, ...]
const stableHistory = new Map();

// 边界预警状态表：symbol -> alertState
// alertState: { symbol, anchorTime, expireAt, triggerType, maxA, maxB,
//               upgraded, pinnedUntil, priceA, priceB,
//               winHigh, winLow, cycleVol, lastPrice }
const boundaryAlertMap = new Map();

// 边界预警历史时间点：symbol -> [{ time, triggerType, a, b, priceA, priceB, winHigh, winLow, last_price, change_pct }, ...]
// 仅记录"满足触发条件"的分钟，供"今日时间点"时间轴查询，内存态，重启清空
const boundaryHistory = new Map();

// 实时盘口缓存：symbol -> { bid: [{price, vol}, ...], ask: [{price, vol}, ...], receivedAt }
// 最多保留 L1/L2/L3 三档，每10秒增量刷新
const orderBookCache = new Map();

const LARGE_ORDER_RATIO     = 10.0;  // 与 monitor_market.py 保持一致
const LARGE_ORDER_MIN_VOL   = 1000;

function _isLargeOrder(vol, levels) {
  if (vol < LARGE_ORDER_MIN_VOL) return false;
  const vols = levels.map(l => l.vol).filter(v => v > 0).sort((a, b) => a - b);
  if (vols.length === 0) return false;
  const median = vols[Math.floor(vols.length / 2)];
  return median > 0 && vol / median >= LARGE_ORDER_RATIO;
}

async function _fetchOrderBook(intervalMins) {
  const client = await pricePool.connect();
  try {
    await client.query('SET statement_timeout = 15000');
    const { rows } = await client.query(`
      SELECT s.symbol, ob.bid_depth, ob.ask_depth, ob.received_at
      FROM (
        SELECT DISTINCT symbol
        FROM market_data.l2_order_book_bl_default
        WHERE received_at >= NOW() - ($1 * INTERVAL '1 minute')
      ) s
      CROSS JOIN LATERAL (
        SELECT bid_depth, ask_depth, received_at
        FROM market_data.l2_order_book_bl_default
        WHERE symbol = s.symbol
          AND received_at >= NOW() - ($1 * INTERVAL '1 minute')
        ORDER BY received_at DESC
        LIMIT 1
      ) ob
    `, [intervalMins]);

    for (const row of rows) {
      const parseLevels = (depth, maxLevels = 10) => {
        if (!depth) return [];
        const arr = typeof depth === 'string' ? JSON.parse(depth) : depth;
        return arr.slice(0, maxLevels).map(item => ({
          price: Number(item[0]),
          vol:   Number(item[1]),
        }));
      };

      const bidAll = parseLevels(row.bid_depth, 10);
      const askAll = parseLevels(row.ask_depth, 10);

      // 只保留满足大单条件的档位（用全部10档计算中位数），仅展示前3档
      const filterLarge = (levels) => {
        const result = {};
        levels.slice(0, 3).forEach((lv, i) => {
          if (_isLargeOrder(lv.vol, levels)) {
            result[i + 1] = { price: lv.price, vol: lv.vol };
          }
        });
        return result;
      };

      const bid = filterLarge(bidAll);
      const ask = filterLarge(askAll);

      // 只缓存有大单的 symbol
      if (Object.keys(bid).length > 0 || Object.keys(ask).length > 0) {
        orderBookCache.set(row.symbol, { bid, ask, receivedAt: row.received_at });
      } else {
        orderBookCache.delete(row.symbol);
      }
    }
    return rows.length;
  } catch (err) {
    console.error('[OrderBookCache] fetch failed:', err.message);
    return 0;
  } finally {
    client.release();
  }
}

async function warmUpOrderBookCache() {
  const n = await _fetchOrderBook(5);
  console.log(`[OrderBookCache] warm up done, ${n} symbols loaded`);
}

async function updateOrderBookCache() {
  await _fetchOrderBook(1);
}

// [FIX 3] updatePriceWindow 改用 pricePool，加 id ASC 修复同毫秒乱序
async function updatePriceWindow() {
  const client = await pricePool.connect();
  try {
    const { rows } = await client.query(`
      SELECT symbol, price::numeric AS price, received_at
      FROM tos_trades
      WHERE received_at >= NOW() - INTERVAL '2 minutes'
        AND received_at >= current_date AT TIME ZONE 'Asia/Shanghai' + interval '8 hours'
      ORDER BY symbol, received_at ASC, id ASC
    `);
    priceWindow.clear();
    for (const row of rows) {
      if (!priceWindow.has(row.symbol)) priceWindow.set(row.symbol, []);
      priceWindow.get(row.symbol).push({ price: Number(row.price), receivedAt: new Date(row.received_at) });
    }
  } catch (err) {
    console.error('[PriceWindow] Update failed:', err.message);
  } finally {
    client.release();
  }
}

// [Window7m] 7分钟每分钟 OHLCV 聚合缓存（方案A: GROUP BY）
// 走 idx_tos_trades_received_at 索引，实测 ~71ms / 31628 行 / 2839 bars
// 仅用 pricePool，与其他 pricePool 任务完全隔离，不影响任何现有功能
async function updateWindow10m() {
  const client = await pricePool.connect();
  try {
    await client.query('SET statement_timeout = 15000');
    const { rows } = await client.query(`
      SELECT
        symbol,
        date_trunc('minute', received_at AT TIME ZONE 'Asia/Shanghai') AS bucket,
        (array_agg(price::numeric ORDER BY received_at ASC,  id ASC))[1]  AS open,
        MAX(price::numeric)                                                AS high,
        MIN(price::numeric)                                                AS low,
        (array_agg(price::numeric ORDER BY received_at DESC, id DESC))[1] AS close,
        COALESCE(SUM(size::numeric), 0)                                   AS volume
      FROM tos_trades
      WHERE received_at >= NOW() - INTERVAL '10 minutes'
        AND received_at >= current_date AT TIME ZONE 'Asia/Shanghai' + INTERVAL '8 hours'
        AND price IS NOT NULL
        AND price::numeric > 0
      GROUP BY symbol, date_trunc('minute', received_at AT TIME ZONE 'Asia/Shanghai')
      ORDER BY symbol, bucket ASC
    `);

    window10m.clear();
    for (const row of rows) {
      if (!window10m.has(row.symbol)) window10m.set(row.symbol, []);
      window10m.get(row.symbol).push({
        bucket: new Date(row.bucket),
        open:   Number(row.open),
        high:   Number(row.high),
        low:    Number(row.low),
        close:  Number(row.close),
        volume: Number(row.volume),
      });
    }
  } catch (err) {
    console.error('[Window10m] Update failed:', err.message);
  } finally {
    client.release();
  }
  snapshotStableHistory();
}

// 30分钟 OHLCV 聚合缓存，与 updateWindow10m 结构完全相同，仅拉取窗口扩展到30分钟
// 供震荡筛选规则使用，每10秒刷新，仅用 pricePool
// updateWindow30m：滚动追加模式
// 冷启动（window30mLastBucket === null）：查最近30分钟，重启后立即填满bar，无需预热
// 热更新：只查 lastBucket 所在分钟起的增量（通常1-2分钟），极快
// 内存中每个 symbol 最多保留30根bar，超出时从头部淘汰（oldest-first）
// 当前分钟的bar在该分钟内会被反复更新（因为分钟未收盘），通过 bucket 时间匹配原地替换
async function updateWindow30m() {
  const client = await pricePool.connect();
  try {
    // 冷启动给60s（30分钟数据量稍大但索引命中很快），热更新保持15s
    const isColdStart = !window30mLastBucket;
    await client.query(`SET statement_timeout = ${isColdStart ? 60000 : 15000}`);

    // 冷启动查30分钟（足够填满15-30根bar，重启后震荡筛选器立即可用）
    // 热更新从上次已知bucket所在分钟起查（覆盖当前分钟未收盘的bar）
    const cutoff = window30mLastBucket
      ? new Date(window30mLastBucket.getTime() - 60 * 1000) // 往前退1分钟，确保当前分钟bar被重新聚合
      : new Date(Date.now() - 30 * 60 * 1000);

    const { rows } = await client.query(`
      SELECT
        symbol,
        date_trunc('minute', received_at AT TIME ZONE 'Asia/Shanghai') AS bucket,
        (array_agg(price::numeric ORDER BY received_at ASC,  id ASC))[1]  AS open,
        MAX(price::numeric)                                                AS high,
        MIN(price::numeric)                                                AS low,
        (array_agg(price::numeric ORDER BY received_at DESC, id DESC))[1] AS close,
        COALESCE(SUM(size::numeric), 0)                                   AS volume
      FROM tos_trades
      WHERE received_at >= $1
        AND received_at >= current_date AT TIME ZONE 'Asia/Shanghai' + INTERVAL '8 hours'
        AND price IS NOT NULL
        AND price::numeric > 0
      GROUP BY symbol, date_trunc('minute', received_at AT TIME ZONE 'Asia/Shanghai')
      ORDER BY symbol, bucket ASC
    `, [cutoff]);

    for (const row of rows) {
      const bar = {
        bucket: new Date(row.bucket),
        open:   Number(row.open),
        high:   Number(row.high),
        low:    Number(row.low),
        close:  Number(row.close),
        volume: Number(row.volume),
      };

      if (!window30m.has(row.symbol)) window30m.set(row.symbol, []);
      const arr = window30m.get(row.symbol);

      // 当前分钟bar原地替换；新分钟bar追加到尾部，超30根从头部淘汰
      const existIdx = arr.findIndex(b => b.bucket.getTime() === bar.bucket.getTime());
      if (existIdx >= 0) {
        arr[existIdx] = bar;
      } else {
        arr.push(bar);
        if (arr.length > 30) arr.shift();
      }

      if (!window30mLastBucket || bar.bucket > window30mLastBucket) {
        window30mLastBucket = bar.bucket;
      }
    }
  } catch (err) {
    console.error('[Window30m] Update failed:', err.message);
  } finally {
    client.release();
  }
}

// 更新精确30分钟基准价缓存
// 查询每个 symbol 在"30分钟前"那个时间点的最后一笔成交价
// 每60秒执行一次（基准价变化慢，不需要高频）
async function updatePrice30mCache() {
  const now = Date.now();
  if (now - price30mLastUpdate < 60000) return;
  price30mLastUpdate = now;

  const client = await pricePool.connect();
  try {
    await client.query('SET statement_timeout = 15000');
    // 取所有在今日有成交的 symbol，各自30分钟前的最后一笔价格
    const { rows } = await client.query(`
      SELECT DISTINCT ON (symbol)
        symbol,
        price::numeric AS price,
        received_at    AS at
      FROM tos_trades
      WHERE received_at BETWEEN NOW() - INTERVAL '31 minutes'
                             AND NOW() - INTERVAL '29 minutes'
        AND received_at >= current_date AT TIME ZONE 'Asia/Shanghai' + INTERVAL '8 hours'
        AND price IS NOT NULL
        AND price::numeric > 0
      ORDER BY symbol, received_at DESC
    `);
    for (const row of rows) {
      price30mCache.set(row.symbol, {
        price: Number(row.price),
        at:    row.at,
      });
    }
  } catch (err) {
    console.error('[Price30mCache] Update failed:', err.message);
  } finally {
    client.release();
  }
}

// === 震荡筛选核心算法 ===
// 对给定的 bars 数组取最后 windowSize 根，按规则文档计算是否触发预警
// 返回 { triggered, countA, countB, totalCount, winHigh, winLow, winVol, matchedPattern }
function checkOscillatorWindow(bars, windowSize) {
  const win = bars.slice(-windowSize);
  if (win.length < windowSize) return { triggered: false };

  // 条件1：总成交量 >= 310
  const winVol = win.reduce((s, b) => s + b.volume, 0);
  if (winVol < 310) return { triggered: false, winVol };

  // 条件2：窗口高低差 >= 0.05
  const winHigh = Math.max(...win.map(b => b.high));
  const winLow  = Math.min(...win.map(b => b.low));
  const winRange = winHigh - winLow;
  if (winRange < 0.05) return { triggered: false, winVol, winHigh, winLow };

  // 条件3：逐根K线计算触A/触B，构建事件序列
  // A_i = low_i + range_i * 0.15，触A条件：low_i <= A_i（即 low_i 在振幅15%分位以内）
  // B_i = low_i + range_i * 0.85，触B条件：high_i >= B_i
  let countA = 0, countB = 0;
  const events = []; // 每根K线的事件：'A' | 'B' | 'AB' | null

  for (const bar of win) {
    const barRange = bar.high - bar.low;
    const touchedA = barRange > 0 ? bar.low  <= bar.low  + barRange * 0.15 : false; // low_i <= A_i 恒成立当 barRange>0
    // 注：A_i = low_i + barRange*0.15，触A条件 low_i <= A_i 即 0 <= barRange*0.15，barRange>=0时恒真
    // 正确语义：low_i 触及"靠近该K线自身低点的15%区域"
    // 按规则文档：A_i = low_i + amp*0.15，触A = low_i <= A_i（即最低价落在A以下，即bar本身就是低位）
    // 实际触A：该K线最低价 <= 窗口振幅15%分位价（窗口绝对低点+窗口振幅*0.15）
    // 触B：该K线最高价 >= 窗口绝对低点+窗口振幅*0.85
    // ——以窗口的 winHigh/winLow 作为基准，而非每根K线自身振幅
    const priceA = winLow + winRange * 0.15;
    const priceB = winLow + winRange * 0.85;
    const isA = bar.low  <= priceA;
    const isB = bar.high >= priceB;

    if (isA) countA++;
    if (isB) countB++;
    if      (isA && isB) events.push('AB');
    else if (isA)        events.push('A');
    else if (isB)        events.push('B');
    else                 events.push(null);
  }

  // 条件3子条件：countA >= 2，countB >= 2，countA + countB >= 5
  if (countA < 2 || countB < 2 || countA + countB < 5) {
    return { triggered: false, winVol, winHigh, winLow, countA, countB };
  }

  // 条件4：事件序列中存在 A→B→A 或 B→A→B（三根不同K线，时序递增，AB可充当A或B）
  // 贪心三指针：先找第一个满足角色的位置，再往后找第二个，再往后找第三个
  const matchedPattern = _findABAorBAB(events);
  if (!matchedPattern) {
    return { triggered: false, winVol, winHigh, winLow, countA, countB, totalCount: countA + countB };
  }

  return {
    triggered:      true,
    winVol,
    winHigh,
    winLow,
    countA,
    countB,
    totalCount:     countA + countB,
    matchedPattern, // 'ABA' | 'BAB'
  };
}

// 检测事件序列中是否存在 A→B→A 或 B→A→B 子序列
// events: Array of 'A' | 'B' | 'AB' | null
// AB 既可充当 A，也可充当 B
function _findABAorBAB(events) {
  // 尝试检测指定模式：roles = ['A','B','A'] 或 ['B','A','B']
  function _detect(r0, r1, r2) {
    const canBe = (ev, role) => ev === role || ev === 'AB';
    let i = -1;
    // 找第一个满足 r0 的位置
    for (let a = 0; a < events.length; a++) {
      if (!canBe(events[a], r0)) continue;
      i = a;
      // 找第一个满足 r1 的位置（在 i 之后）
      for (let b = i + 1; b < events.length; b++) {
        if (!canBe(events[b], r1)) continue;
        // 找第一个满足 r2 的位置（在 b 之后）
        for (let c = b + 1; c < events.length; c++) {
          if (canBe(events[c], r2)) return true;
        }
      }
    }
    return false;
  }
  if (_detect('A', 'B', 'A')) return 'ABA';
  if (_detect('B', 'A', 'B')) return 'BAB';
  return null;
}

const STABLE_R1 = 1.2, STABLE_R2 = 310, STABLE_R5_WINDOW = 10, STABLE_R5_MIN = 6;

// R3/R5 共用阈值：按开盘价分档（"低于X按X算"向上取边界）
// 开盘价 < 125 → 0.5%；125~267 → 0.4%；267~480 → 0.3%；480~1000 → 0.25%；≥1000 → 0.15%
function getR35Thresh(openPrice) {
  const p = Math.max(openPrice, 0);
  if (p < 125)  return 0.005;   // 0.5%
  if (p < 267)  return 0.004;   // 0.4%
  if (p < 480)  return 0.003;   // 0.3%
  if (p < 1000) return 0.0025;  // 0.25%
  return 0.0015;                 // 0.15%
}

// R4 阈值：按开盘价分档（价格低于最低边界按最低边界算）
// < 200 → 0.3%；200~400 → 0.2%（低于300按300算）；400~800 → 0.15%（低于533.5按533.5算）；≥800 → 0.1%（低于1200按1200算）
function getR4Thresh(openPrice) {
  const p = Math.max(openPrice, 0);
  if (p < 200)  return 0.003;    // 0.3%
  if (p < 400)  return 0.002;    // 0.2%（低于300时按300算，阈值仍0.2%）
  if (p < 800)  return 0.0015;   // 0.15%（低于533.5时按533.5算，阈值仍0.15%）
  return 0.001;                   // 0.1%（低于1200时按1200算，阈值仍0.1%）
}

function snapshotStableHistory() {
  const now = new Date();
  const bj  = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const h = bj.getHours(), m = bj.getMinutes();
  if (h < 8 || h >= 17) return;

  const timeStr = bj.toTimeString().slice(0, 8);

  for (const row of rankingCache) {
    const price     = Number(row.last_price);
    const openPrice = Number(row.open_price) || price;
    const changePct = Number(row.change_pct);
    if (!price) continue;

    const bars = window10m.get(row.symbol);
    if (!bars || bars.length === 0) continue;

    const winHigh  = Math.max(...bars.map(b => b.high));
    const winLow   = Math.min(...bars.map(b => b.low));
    const r1_val   = Number(((winHigh - winLow) / price * 100).toFixed(3));
    const r2_vol   = bars.reduce((s, b) => s + b.volume, 0);
    const avgClose = bars.reduce((s, b) => s + b.close, 0) / bars.length;
    const r3_pct   = avgClose > 0 ? Number((Math.abs(price - avgClose) / avgClose * 100).toFixed(3)) : null;
    const firstMid = (bars[0].high + bars[0].low) / 2;
    const lastMid  = (bars[bars.length - 1].high + bars[bars.length - 1].low) / 2;
    const r4_pct   = lastMid > 0 ? Number((Math.abs(firstMid - lastMid) / lastMid * 100).toFixed(3)) : null;
    const r35Thresh  = getR35Thresh(openPrice);
    const r5_bars  = bars.slice(-STABLE_R5_WINDOW);
    const r5_cnt   = r5_bars.filter(b => b.open > 0 && Math.abs(b.close - b.open) / b.open < r35Thresh).length;

    if (r1_val >= STABLE_R1) continue;
    if (r2_vol <  STABLE_R2) continue;
    if (r3_pct === null || r3_pct >= r35Thresh * 100) continue;
    if (r4_pct === null || r4_pct >= getR4Thresh(openPrice) * 100) continue;
    if (r5_cnt <  STABLE_R5_MIN) continue;

    // R6: 7分钟内触下轨/上轨的K线数，a >= 3 或 b >= 3 才通过
    const r6Range = winHigh - winLow;
    let r6_a = 0, r6_b = 0;
    if (r6Range > 0) {
      const priceA = winLow + r6Range * 0.1;
      const priceB = winLow + r6Range * 0.9;
      r6_a = bars.filter(b => b.low  < priceA).length;
      r6_b = bars.filter(b => b.high > priceB).length;
    }
    if (r6_a < 3 && r6_b < 3) continue;

    if (!stableHistory.has(row.symbol)) stableHistory.set(row.symbol, []);
    const hist   = stableHistory.get(row.symbol);
    const minute = timeStr.slice(0, 5);
    const last   = hist[hist.length - 1];
    const entry  = { time: timeStr, r1_val, r2_vol, r3_pct, r4_pct, r5_cnt, r6_a, r6_b, last_price: price, change_pct: changePct };
    if (last && last.time.slice(0, 5) === minute) {
      hist[hist.length - 1] = entry;
    } else {
      hist.push(entry);
    }
  }
}


// === 稳定选股快照写入 ===
// 每60s从内存 window10m + rankingCache 批量 upsert 当前分钟所有活跃股票的规则指标值
async function writeStableSnapshot() {
  const now = new Date();
  const bj  = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const h = bj.getHours(), m = bj.getMinutes();
  if (h < 8 || h >= 17) return;

  const tradeDate = `${bj.getFullYear()}-${String(bj.getMonth()+1).padStart(2,'0')}-${String(bj.getDate()).padStart(2,'0')}`;
  const snapTime  = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;

  const rows = [];
  for (const row of rankingCache) {
    const bars      = window10m.get(row.symbol);
    if (!bars || bars.length === 0) continue;
    const price     = Number(row.last_price);
    const openPrice = Number(row.open_price) || price;
    if (!price) continue;

    const winHigh   = Math.max(...bars.map(b => b.high));
    const winLow    = Math.min(...bars.map(b => b.low));
    const r1_val    = Number(((winHigh - winLow) / price * 100).toFixed(4));
    const r2_vol    = bars.reduce((s, b) => s + b.volume, 0);
    const avgClose  = bars.reduce((s, b) => s + b.close, 0) / bars.length;
    const r3_pct    = avgClose > 0 ? Number((Math.abs(price - avgClose) / avgClose * 100).toFixed(4)) : null;
    const firstMid  = (bars[0].high + bars[0].low) / 2;
    const lastMid   = (bars[bars.length - 1].high + bars[bars.length - 1].low) / 2;
    const r4_pct    = lastMid > 0 ? Number((Math.abs(firstMid - lastMid) / lastMid * 100).toFixed(4)) : null;
    const r35Thresh = getR35Thresh(openPrice);
    const r5_bars   = bars.slice(-STABLE_R5_WINDOW);
    const r5_cnt    = r5_bars.filter(b => b.open > 0 && Math.abs(b.close - b.open) / b.open < r35Thresh).length;

    const r6Range = winHigh - winLow;
    let r6_a = 0, r6_b = 0;
    if (r6Range > 0) {
      const priceA = winLow + r6Range * 0.1;
      const priceB = winLow + r6Range * 0.9;
      r6_a = bars.filter(b => b.low  < priceA).length;
      r6_b = bars.filter(b => b.high > priceB).length;
    }

    const r4T    = getR4Thresh(openPrice);
    const pass_all = (
      r1_val < STABLE_R1 &&
      r2_vol >= STABLE_R2 &&
      r3_pct !== null && r3_pct < r35Thresh * 100 &&
      r4_pct !== null && r4_pct < r4T * 100 &&
      r5_cnt >= STABLE_R5_MIN &&
      (r6_a >= 3 || r6_b >= 3)
    );

    rows.push([
      row.symbol, tradeDate, snapTime,
      price, openPrice, Number(row.change_pct),
      bars.length,
      r1_val, r2_vol, r3_pct, r4_pct, r5_cnt, r6_a, r6_b,
      pass_all,
    ]);
  }

  if (rows.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 20000');
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch  = rows.slice(i, i + BATCH);
      const values = [];
      const params = [];
      let   pi     = 1;
      for (const r of batch) {
        values.push(`($${pi},$${pi+1},$${pi+2},$${pi+3},$${pi+4},$${pi+5},$${pi+6},$${pi+7},$${pi+8},$${pi+9},$${pi+10},$${pi+11},$${pi+12},$${pi+13},$${pi+14})`);
        params.push(...r);
        pi += 15;
      }
      await client.query(`
        INSERT INTO stable_screener_snapshot
          (symbol, trade_date, snap_time,
           last_price, open_price, change_pct, bars_count,
           r1_val, r2_vol, r3_pct, r4_pct, r5_cnt, r6_a, r6_b, pass_all)
        VALUES ${values.join(',')}
        ON CONFLICT (symbol, trade_date, snap_time) DO UPDATE SET
          last_price = EXCLUDED.last_price,
          open_price = EXCLUDED.open_price,
          change_pct = EXCLUDED.change_pct,
          bars_count = EXCLUDED.bars_count,
          r1_val     = EXCLUDED.r1_val,
          r2_vol     = EXCLUDED.r2_vol,
          r3_pct     = EXCLUDED.r3_pct,
          r4_pct     = EXCLUDED.r4_pct,
          r5_cnt     = EXCLUDED.r5_cnt,
          r6_a       = EXCLUDED.r6_a,
          r6_b       = EXCLUDED.r6_b,
          pass_all   = EXCLUDED.pass_all,
          created_at = NOW()
      `, params);
    }
    console.log(`[StableSnapshot] Wrote ${rows.length} rows @ ${snapTime}`);
  } catch (err) {
    console.error('[StableSnapshot] Write failed:', err.message);
  } finally {
    await client.query('SET statement_timeout = 0').catch(() => {});
    client.release();
  }
}

// 清理7天前的快照数据（每天07:55重置时执行）
async function pruneStableSnapshot() {
  try {
    const { rowCount } = await pool.query(`
      DELETE FROM stable_screener_snapshot
      WHERE trade_date < current_date - INTERVAL '7 days'
    `);
    if (rowCount > 0) console.log(`[StableSnapshot] Pruned ${rowCount} old rows`);
  } catch (err) {
    console.error('[StableSnapshot] Prune failed:', err.message);
  }
}

// === 边界预警诊断（共用逻辑） ===
// 给定 symbol，按 scanBoundaryAlerts 的同一套判断顺序逐步计算，返回每一步的中间值、
// 是否最终触发(triggered)、以及未触发时的具体原因(failReason)。
// 仅做计算，不读写 boundaryAlertMap，可安全在快照写入和实时查询中复用。
function evalBoundaryCondition(symbol) {
  const allBars = window10m.get(symbol);
  if (!allBars || allBars.length === 0) {
    return { found: false, failReason: '无10分钟K线数据' };
  }

  const bars = allBars.slice(-7);
  const winHigh = Math.max(...bars.map(b => b.high));
  const winLow  = Math.min(...bars.map(b => b.low));
  const r6Range = winHigh - winLow;

  const result = {
    found: true,
    barsCount: bars.length,
    winHigh, winLow,
    priceA: null, priceB: null,
    touchA: null, touchB: null,
    cycleVol: null,
    high30: null, low30: null, priceA30: null, priceB30: null,
    triggerType: null,
    triggered: false,
    failReason: null,
  };

  if (r6Range <= 0) {
    result.failReason = '7分钟窗口内价格无波动（最高=最低）';
    return result;
  }

  const priceA = winLow + r6Range * 0.2;
  const priceB = winLow + r6Range * 0.8;
  result.priceA = priceA;
  result.priceB = priceB;

  if ((priceA - winLow) >= 0.15) {
    result.failReason = `A线绝对约束未通过：priceA-最低点=${(priceA - winLow).toFixed(4)} ≥ 0.15元`;
    return result;
  }
  if ((winHigh - priceB) >= 0.15) {
    result.failReason = `B线绝对约束未通过：最高点-priceB=${(winHigh - priceB).toFixed(4)} ≥ 0.15元`;
    return result;
  }

  const cycleVol = bars.reduce((s, b) => s + b.volume, 0);
  result.cycleVol = cycleVol;
  if (cycleVol <= 100) {
    result.failReason = `周期成交量不足：${cycleVol} ≤ 100股`;
    return result;
  }

  const a = bars.filter(b => b.low  < priceA).length;
  const b = bars.filter(b => b.high > priceB).length;
  result.touchA = a;
  result.touchB = b;

  if (a < 4 && b < 4) {
    result.failReason = `触碰次数不足：a=${a}, b=${b}（需任一项 ≥4）`;
    return result;
  }

  const triggerType = a >= 4 ? '4a' : '4b';
  result.triggerType = triggerType;

  const bars30 = window30m.get(symbol);
  if (!bars30 || bars30.length === 0) {
    result.failReason = '无30分钟K线数据，无法判断突破';
    return result;
  }

  const high30  = Math.max(...bars30.map(b => b.high));
  const low30   = Math.min(...bars30.map(b => b.low));
  const range30 = high30 - low30;
  result.high30 = high30;
  result.low30  = low30;

  if (range30 <= 0) {
    result.failReason = '30分钟窗口内价格无波动，无法判断突破';
    return result;
  }

  const priceA30 = low30 + range30 * 0.2;
  const priceB30 = low30 + range30 * 0.8;
  result.priceA30 = priceA30;
  result.priceB30 = priceB30;

  if (triggerType === '4a') {
    if (priceA < low30 || priceA > priceA30) {
      result.failReason = `未突破30分钟轨道：priceA(${priceA.toFixed(4)}) 不在 [low30(${low30.toFixed(4)}), priceA30(${priceA30.toFixed(4)})] 区间内`;
      return result;
    }
  } else {
    if (priceB < priceB30 || priceB > high30) {
      result.failReason = `未突破30分钟轨道：priceB(${priceB.toFixed(4)}) 不在 [priceB30(${priceB30.toFixed(4)}), high30(${high30.toFixed(4)})] 区间内`;
      return result;
    }
  }

  result.triggered  = true;
  result.failReason = null;
  return result;
}

// === 边界预警扫描 ===
// 每10秒执行，基于 window10m 滚动窗口最近7根K线
// 逻辑：首次触发（触碰≥4次）后锚定，保留7分钟，期间持续追踪，同向达到5次升级置顶3分钟
// 新增约束（突破30分钟轨道）：首次触发时，
//   触A → 7分钟预警价A(priceA) 必须落在 [30分钟最低点low30, 30分钟预警价A30(priceA30)] 之间
//   触B → 7分钟预警价B(priceB) 必须落在 [30分钟预警价B30(priceB30), 30分钟最高点high30] 之间
function scanBoundaryAlerts() {
  const now = new Date();
  const bj  = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const h = bj.getHours(), m = bj.getMinutes();
  if (h < 8 || h >= 17) return;

  // ① 清理过期预警
  for (const [symbol, state] of boundaryAlertMap) {
    if (now >= state.expireAt) {
      boundaryAlertMap.delete(symbol);
    }
  }

  // ② 扫描所有 symbol
  for (const row of rankingCache) {
    const symbol = row.symbol;
    const allBars = window10m.get(symbol);
    if (!allBars || allBars.length === 0) continue;

    // 取最近7根
    const bars = allBars.slice(-7);

    // 计算窗口极值
    const winHigh = Math.max(...bars.map(b => b.high));
    const winLow  = Math.min(...bars.map(b => b.low));
    const r6Range = winHigh - winLow;
    if (r6Range <= 0) continue;

    // 预警价（0.2 / 0.8 分位）
    const priceA = winLow  + r6Range * 0.2;
    const priceB = winLow  + r6Range * 0.8;

    // 0.15 元绝对值约束
    if ((priceA - winLow)  >= 0.15) continue;
    if ((winHigh - priceB) >= 0.15) continue;

    // 周期成交量 > 100 股
    const cycleVol = bars.reduce((s, b) => s + b.volume, 0);
    if (cycleVol <= 100) continue;

    // 统计触碰次数
    const a = bars.filter(b => b.low  < priceA).length;
    const b = bars.filter(b => b.high > priceB).length;

    const existing = boundaryAlertMap.get(symbol);

    if (existing) {
      // ── 已有活跃预警：更新最大值，检查升级 ──
      existing.maxA = Math.max(existing.maxA, a);
      existing.maxB = Math.max(existing.maxB, b);

      if (!existing.upgraded) {
        const shouldUpgrade =
          (existing.triggerType === '4a' && existing.maxA >= 6) ||
          (existing.triggerType === '4b' && existing.maxB >= 6);

        if (shouldUpgrade) {
          existing.upgraded    = true;
          existing.pinnedUntil = new Date(now.getTime() + 2 * 60 * 1000);
        }
      }
    } else {
      // ── 无活跃预警：检查是否首次触发 ──
      if (a < 4 && b < 4) continue;

      const triggerType = a >= 4 ? '4a' : '4b';

      // 突破30分钟轨道校验：
      // 30分钟窗口（含当前7根）算出 high30/low30，再按同样20%/80%分位算 priceA30/priceB30
      const bars30 = window30m.get(symbol);
      if (!bars30 || bars30.length === 0) continue;

      const high30  = Math.max(...bars30.map(b => b.high));
      const low30   = Math.min(...bars30.map(b => b.low));
      const range30 = high30 - low30;
      if (range30 <= 0) continue; // 30分钟内无波动，无法判断突破，跳过

      const priceA30 = low30  + range30 * 0.2;
      const priceB30 = low30  + range30 * 0.8;

      if (triggerType === '4a') {
        // 触A → priceA 必须落在 [low30, priceA30] 之间
        if (priceA < low30 || priceA > priceA30) continue;
      } else {
        // 触B → priceB 必须落在 [priceB30, high30] 之间
        if (priceB < priceB30 || priceB > high30) continue;
      }

      boundaryAlertMap.set(symbol, {
        symbol,
        anchorTime:   now,
        expireAt:     new Date(now.getTime() + 7 * 60 * 1000),
        triggerType,
        maxA:         a,
        maxB:         b,
        upgraded:     false,
        pinnedUntil:  null,
        priceA,
        priceB,
        winHigh,
        winLow,
        cycleVol,
        lastPrice:    Number(row.last_price),
      });
    }
  }
}

// === 边界预警快照写入 ===
// 每60s对 rankingCache 中所有股票跑一遍 evalBoundaryCondition，写入数据库快照表，
// 同时把"满足触发条件"的分钟记入内存 boundaryHistory（供"今日时间点"时间轴查询）
async function writeBoundarySnapshot() {
  const now = new Date();
  const bj  = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const h = bj.getHours(), m = bj.getMinutes();
  if (h < 8 || h >= 17) return;

  const tradeDate = `${bj.getFullYear()}-${String(bj.getMonth()+1).padStart(2,'0')}-${String(bj.getDate()).padStart(2,'0')}`;
  const snapTime  = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;
  const timeStr   = bj.toTimeString().slice(0, 8);

  const rows = [];
  for (const row of rankingCache) {
    const symbol = row.symbol;
    const price  = Number(row.last_price);
    if (!price) continue;

    const ev = evalBoundaryCondition(symbol);
    if (!ev.found) continue;

    rows.push([
      symbol, tradeDate, snapTime,
      price, Number(row.change_pct), ev.barsCount,
      ev.winHigh, ev.winLow, ev.priceA, ev.priceB,
      ev.touchA, ev.touchB, ev.cycleVol,
      ev.high30, ev.low30, ev.priceA30, ev.priceB30,
      ev.triggerType, ev.triggered, ev.failReason,
    ]);

    // 满足触发条件 → 记入内存历史时间轴
    if (ev.triggered) {
      if (!boundaryHistory.has(symbol)) boundaryHistory.set(symbol, []);
      const hist   = boundaryHistory.get(symbol);
      const minute = timeStr.slice(0, 5);
      const last   = hist[hist.length - 1];
      const entry  = {
        time: timeStr, triggerType: ev.triggerType,
        touchA: ev.touchA, touchB: ev.touchB,
        priceA: ev.priceA, priceB: ev.priceB,
        winHigh: ev.winHigh, winLow: ev.winLow,
        last_price: price, change_pct: Number(row.change_pct),
      };
      if (last && last.time.slice(0, 5) === minute) {
        hist[hist.length - 1] = entry;
      } else {
        hist.push(entry);
      }
    }
  }

  if (rows.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 20000');
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch  = rows.slice(i, i + BATCH);
      const values = [];
      const params = [];
      let   pi     = 1;
      for (const r of batch) {
        values.push(`($${pi},$${pi+1},$${pi+2},$${pi+3},$${pi+4},$${pi+5},$${pi+6},$${pi+7},$${pi+8},$${pi+9},$${pi+10},$${pi+11},$${pi+12},$${pi+13},$${pi+14},$${pi+15},$${pi+16},$${pi+17},$${pi+18},$${pi+19})`);
        params.push(...r);
        pi += 20;
      }
      await client.query(`
        INSERT INTO boundary_alert_snapshot
          (symbol, trade_date, snap_time,
           last_price, change_pct, bars_count,
           win_high, win_low, price_a, price_b,
           touch_a, touch_b, cycle_vol,
           high30, low30, price_a30, price_b30,
           trigger_type, triggered, fail_reason)
        VALUES ${values.join(',')}
        ON CONFLICT (symbol, trade_date, snap_time) DO UPDATE SET
          last_price   = EXCLUDED.last_price,
          change_pct   = EXCLUDED.change_pct,
          bars_count   = EXCLUDED.bars_count,
          win_high     = EXCLUDED.win_high,
          win_low      = EXCLUDED.win_low,
          price_a      = EXCLUDED.price_a,
          price_b      = EXCLUDED.price_b,
          touch_a      = EXCLUDED.touch_a,
          touch_b      = EXCLUDED.touch_b,
          cycle_vol    = EXCLUDED.cycle_vol,
          high30       = EXCLUDED.high30,
          low30        = EXCLUDED.low30,
          price_a30    = EXCLUDED.price_a30,
          price_b30    = EXCLUDED.price_b30,
          trigger_type = EXCLUDED.trigger_type,
          triggered    = EXCLUDED.triggered,
          fail_reason  = EXCLUDED.fail_reason,
          created_at   = NOW()
      `, params);
    }
    console.log(`[BoundarySnapshot] Wrote ${rows.length} rows @ ${snapTime}`);
  } catch (err) {
    console.error('[BoundarySnapshot] Write failed:', err.message);
  } finally {
    await client.query('SET statement_timeout = 0').catch(() => {});
    client.release();
  }
}

// 清理7天前的边界预警快照数据（每天07:55重置时执行）
async function pruneBoundarySnapshot() {
  try {
    const { rowCount } = await pool.query(`
      DELETE FROM boundary_alert_snapshot
      WHERE trade_date < current_date - INTERVAL '7 days'
    `);
    if (rowCount > 0) console.log(`[BoundarySnapshot] Pruned ${rowCount} old rows`);
  } catch (err) {
    console.error('[BoundarySnapshot] Prune failed:', err.message);
  }
}

app.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ═══ 矩形区间信号 API ═══
app.get('/api/rect-signals', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, symbol, trade_date,
             TO_CHAR(rect_start, 'YYYY-MM-DD HH24:MI:SS') AS rect_start,
             TO_CHAR(rect_end, 'YYYY-MM-DD HH24:MI:SS') AS rect_end,
             duration_min, upper_price, lower_price, range_width, active_bars,
             inlier_pct, bar_coverage, high_touches, low_touches, alternations,
             total_volume,
             TO_CHAR(detected_at, 'YYYY-MM-DD HH24:MI:SS') AS detected_at,
             updated_at, status, break_direction, break_price,
             TO_CHAR(break_time, 'YYYY-MM-DD HH24:MI:SS') AS break_time
      FROM market_data.rect_signals
      WHERE trade_date = CURRENT_DATE
      ORDER BY detected_at DESC
    `);
    res.json({ count: rows.length, signals: rows });
  } catch (e) {
    console.error('[RectSignals] API error:', e.message);
    res.status(500).json({ error: 'rect_signals_failed' });
  }
});

// === 边界预警列表 API ===
// 前端筛选：price_min/max, vol_min/max, day_range_min/max, avg_range_min/max
app.get('/api/boundary-alerts', (req, res) => {
  try {
    const q = req.query;
    const priceMin    = q.price_min    !== undefined && q.price_min    !== '' ? Number(q.price_min)    : null;
    const priceMax    = q.price_max    !== undefined && q.price_max    !== '' ? Number(q.price_max)    : null;
    const volMin      = q.vol_min      !== undefined && q.vol_min      !== '' ? Number(q.vol_min)      : null;
    const volMax      = q.vol_max      !== undefined && q.vol_max      !== '' ? Number(q.vol_max)      : null;
    const dayRangeMin = q.day_range_min !== undefined && q.day_range_min !== '' ? Number(q.day_range_min) : null;
    const dayRangeMax = q.day_range_max !== undefined && q.day_range_max !== '' ? Number(q.day_range_max) : null;
    const avgRangeMin = q.avg_range_min !== undefined && q.avg_range_min !== '' ? Number(q.avg_range_min) : null;
    const avgRangeMax = q.avg_range_max !== undefined && q.avg_range_max !== '' ? Number(q.avg_range_max) : null;

    const now = new Date();

    // 从 rankingCache 建立快速查询 map
    const rankingMap = new Map();
    for (const row of rankingCache) {
      rankingMap.set(row.symbol, row);
    }

    const results = [];
    for (const [symbol, state] of boundaryAlertMap) {
      const row = rankingMap.get(symbol);
      if (!row) continue;

      const lastPrice = Number(row.last_price) || 0;
      const totalVol  = Number(row.total_volume) || 0;
      const highPrice = Number(row.high_price) || 0;
      const lowPrice  = Number(row.low_price)  || 0;
      const dayRange  = highPrice - lowPrice;
      const avgRange  = dailyRangeCache.get(symbol) || null;

      // 前端筛选
      if (priceMin    !== null && lastPrice < priceMin)    continue;
      if (priceMax    !== null && lastPrice > priceMax)    continue;
      if (volMin      !== null && totalVol  < volMin)      continue;
      if (volMax      !== null && totalVol  > volMax)      continue;
      if (dayRangeMin !== null && dayRange  < dayRangeMin) continue;
      if (dayRangeMax !== null && dayRange  > dayRangeMax) continue;
      if (avgRangeMin !== null && (avgRange === null || avgRange < avgRangeMin)) continue;
      if (avgRangeMax !== null && (avgRange === null || avgRange > avgRangeMax)) continue;

      const isPinned = state.pinnedUntil !== null && now < state.pinnedUntil;

      results.push({
        symbol,
        triggerType:  state.triggerType,
        maxA:         state.maxA,
        maxB:         state.maxB,
        priceA:       Number(state.priceA.toFixed(4)),
        priceB:       Number(state.priceB.toFixed(4)),
        winHigh:      state.winHigh,
        winLow:       state.winLow,
        cycleVol:     state.cycleVol,
        anchorTime:   state.anchorTime.toISOString(),
        expireAt:     state.expireAt.toISOString(),
        isPinned,
        pinnedUntil:  state.pinnedUntil ? state.pinnedUntil.toISOString() : null,
        // rankingCache 字段
        last_price:   lastPrice,
        total_volume: totalVol,
        high_price:   highPrice,
        low_price:    lowPrice,
        day_range:    Number(dayRange.toFixed(4)),
        avg_range:    avgRange,
        change_pct:   Number(row.change_pct),
      });
    }

    // 排序：置顶优先，其次按 anchorTime 降序（新在上）
    results.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return new Date(b.anchorTime) - new Date(a.anchorTime);
    });

    res.json({ count: results.length, alerts: results });
  } catch (e) {
    console.error('[BoundaryAlerts] API error:', e.message);
    res.status(500).json({ error: 'boundary_alerts_failed' });
  }
});

// 把 evalBoundaryCondition / 快照行 转成前端展示用的规则卡片结构
function buildBoundaryRuleCards(d) {
  // d 字段统一用驼峰命名访问；调用方负责把数据库快照行（下划线命名）转换好再传入

  // breakout（突破30分钟轨道）这一项只在"触碰次数已达标、且确实进入了30分钟校验"时才有意义；
  // 在此之前的任何一步失败，都说明流程根本没走到这一步，应显示为"—"（pass=null）
  const reachedBreakoutStep = d.touchA != null && (d.touchA >= 4 || d.touchB >= 4) && d.triggerType != null;
  let breakoutPass = null;
  if (reachedBreakoutStep) {
    // 走到了30分钟校验这一步：若最终 triggered=true 说明通过；
    // 若 triggered=false 但 failReason 明确提到"30分钟"，说明卡在这一步（未通过）；
    // 否则（理论上不会出现）保持 null
    if (d.triggered) {
      breakoutPass = true;
    } else if (d.failReason && d.failReason.includes('30分钟')) {
      breakoutPass = false;
    }
  }

  const rules = [
    { id: 'range7',  label: '7分钟振幅',  unit: '元',
      value: (d.winHigh != null && d.winLow != null) ? Number((d.winHigh - d.winLow).toFixed(4)) : null,
      pass:  (d.winHigh != null && d.winLow != null) ? (d.winHigh - d.winLow) > 0 : null,
      threshold: '> 0' },
    { id: 'abs015',  label: '0.15元约束', unit: '元',
      value: (d.priceA != null && d.winLow != null) ? Number(Math.max(d.priceA - d.winLow, (d.winHigh ?? 0) - (d.priceB ?? 0)).toFixed(4)) : null,
      pass:  d.priceA != null ? ((d.priceA - d.winLow) < 0.15 && (d.winHigh - d.priceB) < 0.15) : null,
      threshold: '< 0.15' },
    { id: 'vol',     label: '周期成交量', unit: '股',
      value: d.cycleVol != null ? Number(d.cycleVol) : null,
      pass:  d.cycleVol != null ? Number(d.cycleVol) > 100 : null,
      threshold: '> 100' },
    { id: 'touch',   label: '触碰次数',   unit: '根',
      value: (d.touchA != null && d.touchB != null) ? { a: d.touchA, b: d.touchB } : null,
      pass:  (d.touchA != null && d.touchB != null) ? (d.touchA >= 4 || d.touchB >= 4) : null,
      threshold: 'a≥4 或 b≥4' },
    { id: 'breakout',label: '突破30分钟轨道', unit: '元',
      value: reachedBreakoutStep ? (d.triggerType === '4a' ? d.priceA : d.priceB) : null,
      pass:  breakoutPass,
      threshold: d.triggerType === '4a' ? '落在 [low30, priceA30]' : d.triggerType === '4b' ? '落在 [priceB30, high30]' : '—' },
  ];
  return {
    triggered:    Boolean(d.triggered),
    failReason:   d.failReason ?? null,
    triggerType:  d.triggerType ?? null,
    last_price:   d.lastPrice != null ? Number(d.lastPrice) : null,
    change_pct:   d.changePct != null ? Number(d.changePct) : null,
    bars_count:   d.barsCount != null ? Number(d.barsCount) : null,
    winHigh: d.winHigh, winLow: d.winLow, priceA: d.priceA, priceB: d.priceB,
    touchA: d.touchA, touchB: d.touchB, cycleVol: d.cycleVol,
    high30: d.high30, low30: d.low30, priceA30: d.priceA30, priceB30: d.priceB30,
    rules,
  };
}

// 实时检查：不查库，直接用内存 window10m/window30m 实时计算（跟 scanBoundaryAlerts 同一套逻辑）
// GET /api/boundary-alerts/check?symbol=AAPL
app.get('/api/boundary-alerts/check', (req, res) => {
  const symbol = (req.query.symbol || '').trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const row = rankingCache.find(r => r.symbol === symbol);
  const inRankingCache = Boolean(row);
  const ev  = evalBoundaryCondition(symbol);

  if (!ev.found) {
    return res.json({ symbol, found: false, inRankingCache, failReason: ev.failReason });
  }

  const merged = {
    ...ev,
    lastPrice: row ? Number(row.last_price) : null,
    changePct: row ? Number(row.change_pct) : null,
  };

  res.json({ symbol, found: true, inRankingCache, ...buildBoundaryRuleCards(merged) });
});

// 今日时间点：列出今天该股票满足全部触发条件的所有分钟（内存数组，不查库）
// GET /api/boundary-alerts/history?symbol=AAPL
app.get('/api/boundary-alerts/history', (req, res) => {
  const symbol = (req.query.symbol || '').trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  res.json({ symbol, records: boundaryHistory.get(symbol) || [] });
});

// 单时间点历史诊断：查快照表，返回该分钟的完整规则诊断
// GET /api/boundary-alerts/diagnose?symbol=AAPL&time=10:23
app.get('/api/boundary-alerts/diagnose', async (req, res) => {
  const symbol = (req.query.symbol || '').trim().toUpperCase();
  const timeQ  = (req.query.time   || '').trim();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  if (!timeQ)  return res.status(400).json({ error: 'time required, format HH:MM' });
  const snapTime = timeQ.length === 5 ? timeQ + ':00' : timeQ.slice(0, 8);
  try {
    const { rows } = await pool.query(`
      SELECT * FROM boundary_alert_snapshot
      WHERE symbol = $1 AND trade_date = current_date AND snap_time = $2::time
    `, [symbol, snapTime]);
    if (rows.length === 0) return res.json({ symbol, snap_time: snapTime, found: false });
    res.json({ symbol, snap_time: snapTime, found: true, ...buildBoundaryRuleCards(snapshotRowToCamel(rows[0])) });
  } catch (e) {
    console.error('[BoundaryDiagnose] error:', e.message);
    res.status(500).json({ error: 'boundary_diagnose_failed' });
  }
});

// 时间段历史诊断：返回 [from, to] 内每分钟的快照列表
// GET /api/boundary-alerts/diagnose-range?symbol=AAPL&from=10:00&to=10:30
app.get('/api/boundary-alerts/diagnose-range', async (req, res) => {
  const symbol = (req.query.symbol || '').trim().toUpperCase();
  const fromQ  = (req.query.from   || '').trim();
  const toQ    = (req.query.to     || '').trim();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  if (!fromQ || !toQ) return res.status(400).json({ error: 'from and to required, format HH:MM' });
  const fromTime = fromQ.length === 5 ? fromQ + ':00' : fromQ.slice(0, 8);
  const toTime   = toQ.length   === 5 ? toQ   + ':00' : toQ.slice(0, 8);
  try {
    const { rows } = await pool.query(`
      SELECT * FROM boundary_alert_snapshot
      WHERE symbol     = $1
        AND trade_date = current_date
        AND snap_time >= $2::time
        AND snap_time <= $3::time
      ORDER BY snap_time ASC
    `, [symbol, fromTime, toTime]);
    const records = rows.map(r => ({ snap_time: r.snap_time, ...buildBoundaryRuleCards(snapshotRowToCamel(r)) }));
    res.json({ symbol, from: fromTime, to: toTime, count: records.length, records });
  } catch (e) {
    console.error('[BoundaryDiagnoseRange] error:', e.message);
    res.status(500).json({ error: 'boundary_diagnose_range_failed' });
  }
});

// 数据库快照行（下划线命名）→ 驼峰命名，供 buildBoundaryRuleCards 统一处理
function snapshotRowToCamel(s) {
  return {
    barsCount:   s.bars_count   != null ? Number(s.bars_count)   : null,
    winHigh:     s.win_high     != null ? Number(s.win_high)     : null,
    winLow:      s.win_low      != null ? Number(s.win_low)      : null,
    priceA:      s.price_a      != null ? Number(s.price_a)      : null,
    priceB:      s.price_b      != null ? Number(s.price_b)      : null,
    touchA:      s.touch_a      != null ? Number(s.touch_a)      : null,
    touchB:      s.touch_b      != null ? Number(s.touch_b)      : null,
    cycleVol:    s.cycle_vol    != null ? Number(s.cycle_vol)    : null,
    high30:      s.high30       != null ? Number(s.high30)       : null,
    low30:       s.low30        != null ? Number(s.low30)        : null,
    priceA30:    s.price_a30    != null ? Number(s.price_a30)    : null,
    priceB30:    s.price_b30    != null ? Number(s.price_b30)    : null,
    triggerType: s.trigger_type,
    triggered:   Boolean(s.triggered),
    failReason:  s.fail_reason,
    lastPrice:   s.last_price   != null ? Number(s.last_price)   : null,
    changePct:   s.change_pct   != null ? Number(s.change_pct)   : null,
  };
}

// === 活跃成交股票 API ===
// 数据源：market_data.active_trading_symbols（外部进程维护，DELETE-based，表内即当前全量活跃股票，
// 即"1分钟内成交次数>3"这一预警条件，不需要任何时间过滤，直接 SELECT * 即可）
// 价格/成交量/当日波动 来自 rankingCache 联查；买卖价差来自 quoteCache 联查
//
// 注：本接口不做价格/成交量/当日波动/价差筛选，始终返回当前全量活跃股票。
// 这些筛选条件完全交给前端处理——因为前端有"宽限期保留"机制：股票掉出本接口的返回结果，
// 会被当作"真正掉出活跃列表"。如果这里按筛选条件过滤，前端就无法分辨"真的掉线"和
// "仍然活跃只是不满足筛选范围"，会导致被筛掉的股票被误判为掉线、绕过筛选继续展示一段时间。
// GET /api/active-trading
app.get('/api/active-trading', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        COALESCE(a.symbol, i.symbol) as symbol, 
        a.trade_count, 
        a.window_secs, 
        a.first_detected_at, 
        a.updated_at,
        i.iceberg_size,
        i.iceberg_count,
        i.iceberg_detected_at,
        i.updated_at as iceberg_updated_at
      FROM market_data.active_trading_symbols a
      FULL OUTER JOIN market_data.iceberg_symbols i ON a.symbol = i.symbol
    `);

    const rankingMap = new Map();
    for (const row of rankingCache) rankingMap.set(row.symbol, row);

    const results = [];
    for (const r of rows) {
      const symbol = r.symbol;
      const rk     = rankingMap.get(symbol);
      const quote  = quoteCache.get(symbol);

      const hasMarketData = Boolean(rk);
      const lastPrice    = rk ? Number(rk.last_price)   : null;
      const totalVolume  = rk ? Number(rk.total_volume) : null;
      const highPrice    = rk ? Number(rk.high_price)   : null;
      const lowPrice     = rk ? Number(rk.low_price)    : null;
      const dayRange     = (highPrice != null && lowPrice != null) ? Number((highPrice - lowPrice).toFixed(4)) : null;
      const changePct    = rk ? Number(rk.change_pct)   : null;
      const spread       = quote ? Number(quote.spread) : null;

      results.push({
        symbol,
        trade_count:        r.trade_count != null ? Number(r.trade_count) : null,
        window_secs:        r.window_secs != null ? Number(r.window_secs) : null,
        first_detected_at:  r.first_detected_at,
        updated_at:         r.updated_at,
        iceberg_size:       r.iceberg_size != null ? Number(r.iceberg_size) : null,
        iceberg_count:      r.iceberg_count != null ? Number(r.iceberg_count) : null,
        iceberg_detected_at: r.iceberg_detected_at,
        iceberg_updated_at: r.iceberg_updated_at,
        has_market_data:    hasMarketData,
        last_price:         lastPrice,
        total_volume:       totalVolume,
        high_price:         highPrice,
        low_price:          lowPrice,
        day_range:          dayRange,
        change_pct:         changePct,
        bid:                quote ? Number(quote.bid) : null,
        ask:                quote ? Number(quote.ask) : null,
        spread,
      });
    }

    // 默认按成交次数降序排（最活跃的在最前）
    results.sort((a, b) => b.trade_count - a.trade_count);

    res.json({ count: results.length, symbols: results });
  } catch (e) {
    console.error('[ActiveTrading] API error:', e.message);
    res.status(500).json({ error: 'active_trading_failed' });
  }
});


// 轻量级价格快照 API
app.get('/api/price-snapshot', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').trim();
    const minutes = Number(req.query.minutes || 5);

    if (!symbol) return res.status(400).json({ error: 'symbol required' });

    const currentRes = await pool.query(`
      SELECT price::numeric
      FROM tos_trades
      WHERE symbol = $1
      ORDER BY received_at DESC, id DESC
      LIMIT 1
    `, [symbol]);

    const prevRes = await pool.query(`
      SELECT price::numeric
      FROM tos_trades
      WHERE symbol = $1
        AND received_at <= (now() AT TIME ZONE 'Asia/Shanghai' - ($2 || ' minutes')::interval)
      ORDER BY received_at DESC, id DESC
      LIMIT 1
    `, [symbol, minutes]);

    const current = currentRes.rows.length > 0 ? Number(currentRes.rows[0].price) : 0;
    const previous = prevRes.rows.length > 0 ? Number(prevRes.rows[0].price) : 0;
    const change = (current && previous) ? Number((current - previous).toFixed(2)) : 0;

    return res.json({ current, previous, change });
  } catch (e) {
    console.error('price-snapshot error:', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// OHLCV API
app.get('/api/ohlcv', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').trim();
    const date = String(req.query.date || '').trim();
    if (!symbol || !date) return res.status(400).json({ error: 'symbol and date required' });

    const sql = `
      WITH params AS (
        SELECT $1::text AS symbol,
               $2::text AS target_date
      ),
      filtered AS (
        SELECT t.symbol,
               CASE
                 WHEN trim(t.trade_time) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN trim(t.trade_time)::timestamp
                 ELSE (p.target_date || ' ' || trim(t.trade_time))::timestamp
               END AS ts,
               t.price::numeric AS price,
               t.size,
               CASE
                 WHEN trim(t.trade_time) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN date_trunc('minute', trim(t.trade_time)::timestamp)
                 ELSE date_trunc('minute', (p.target_date || ' ' || trim(t.trade_time))::timestamp)
               END AS bucket
        FROM tos_trades t
        JOIN params p ON p.symbol = t.symbol
        WHERE (
          (trim(t.trade_time) ~ '^\\d{4}-\\d{2}-\\d{2}' AND LEFT(trim(t.trade_time), 10) = p.target_date) OR
          (trim(t.trade_time) !~ '^\\d{4}-\\d{2}-\\d{2}' AND DATE(t.created_at) = p.target_date::date)
        )
          AND t.price IS NOT NULL
          AND t.price::numeric > 0
      ),
      open_price AS (
        SELECT DISTINCT ON (bucket) bucket, price AS open
        FROM filtered
        ORDER BY bucket, ts ASC
      ),
      close_price AS (
        SELECT DISTINCT ON (bucket) bucket, price AS close
        FROM filtered
        ORDER BY bucket, ts DESC
      ),
      hlv AS (
        SELECT bucket,
               MAX(price) AS high,
               MIN(price) AS low,
               COALESCE(SUM(size), 0) AS volume
        FROM filtered
        GROUP BY bucket
      ),
      ohlcv AS (
        SELECT h.bucket, o.open, h.high, h.low, c.close, h.volume
        FROM hlv h
        LEFT JOIN open_price o USING (bucket)
        LEFT JOIN close_price c USING (bucket)
      ),
      day_range AS (
        SELECT MIN(bucket) AS day_start,
               MAX(bucket) + INTERVAL '1 minute' AS day_end
        FROM ohlcv
      ),
      series AS (
        SELECT generate_series(dr.day_start, dr.day_end - INTERVAL '1 minute', INTERVAL '1 minute') AS bucket
        FROM day_range dr
        WHERE dr.day_start IS NOT NULL
      ),
      joined AS (
        SELECT s.bucket,
               o.open, o.high, o.low, o.close, o.volume
        FROM series s
        LEFT JOIN ohlcv o USING (bucket)
        ORDER BY s.bucket
      ),
      locf_grp AS (
        SELECT *,
               COUNT(close) OVER (ORDER BY bucket) as grp
        FROM joined
      ),
      filled_data AS (
        SELECT
          bucket,
          open, high, low,
          COALESCE(volume, 0) as v,
          FIRST_VALUE(close) OVER (PARTITION BY grp ORDER BY bucket) as c_filled
        FROM locf_grp
      ),
      final_ohlc AS (
        SELECT
          bucket AS t,
          COALESCE(open, LAG(c_filled) OVER (ORDER BY bucket)) AS o,
          COALESCE(high, COALESCE(open, LAG(c_filled) OVER (ORDER BY bucket))) AS h,
          COALESCE(low,  COALESCE(open, LAG(c_filled) OVER (ORDER BY bucket))) AS l,
          c_filled AS c,
          v
        FROM filled_data
      )
      SELECT
        t, o, h, l, c, v,
        ROUND(AVG(c) OVER (ORDER BY t ROWS BETWEEN 4 PRECEDING AND CURRENT ROW), 2) AS ma5,
        ROUND(AVG(c) OVER (ORDER BY t ROWS BETWEEN 9 PRECEDING AND CURRENT ROW), 2) AS ma10,
        ROUND(AVG(c) OVER (ORDER BY t ROWS BETWEEN 19 PRECEDING AND CURRENT ROW), 2) AS ma20
      FROM final_ohlc
      WHERE t IS NOT NULL;`;

    const { rows } = await pool.query(sql, [symbol, date]);
    return res.json(rows);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// === L2 Alert History API ===
// ══════════════════════════════════════════════════════════════
// L2 实时大单 & 事件流 API（读 l2_active_orders / l2_order_events）
// ══════════════════════════════════════════════════════════════

// GET /api/l2-active-orders?market=BL
// 返回当前活跃大单（与窗口程序"活跃大单"面板一致）
app.get('/api/l2-active-orders', async (req, res) => {
  try {
    const market = String(req.query.market || 'BL').toLowerCase();
    const ALLOWED_MARKETS = new Set(['bl', 'sh', 'sz']);
    if (!ALLOWED_MARKETS.has(market)) {
      return res.status(400).json({ error: 'invalid_market' });
    }
    const table = `market_data.l2_active_orders_${market}`;

    const sql = `
      SELECT
        a.stock_code, a.alert_type, a.price, a.volume, a.depth,
        a.price_ratio, a.median_vol, a.first_seen, a.last_seen, a.alive_rounds,
        -- 与 ranking 页面一致：ohlc_snapshot.volume 优先，无则回退 daily_summary.total_volume
        COALESCE(os.volume, d.total_volume, 0) AS total_volume,
        os.open_price AS open_price,
        lp.price AS lp_last_price
      FROM ${table} a
      LEFT JOIN market_data.daily_summary d
             ON d.symbol = a.stock_code AND d.trade_date = CURRENT_DATE
      LEFT JOIN market_data.ohlc_snapshot os
             ON os.symbol = a.stock_code AND os.trade_date = CURRENT_DATE
      LEFT JOIN market_data.last_price lp
             ON lp.symbol = a.stock_code
      WHERE a.trade_date = CURRENT_DATE
      ORDER BY a.price_ratio DESC NULLS LAST
    `;

    const { rows } = await pricePool.query(sql);

    const enriched = rows.map(row => {
      const openPrice = Number(row.open_price);
      if (!openPrice) return { ...row, day_change_pct: null, day_change_amt: null };
      // last_price 优先级: market_data.last_price(新表，逐笔成交) > priceCache(tos_trades) > 挂单价
      const lpPrice   = Number(row.lp_last_price) || 0;
      const cached    = priceCache.get(row.stock_code);
      const lastPrice = lpPrice > 0 ? lpPrice : (cached ? cached.price : Number(row.price));
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

// GET /api/l2-order-events?market=BL&minutes=60&limit=200&event_type=ALL
// 返回实时事件流（与窗口程序"实时事件流"面板一致）
app.get('/api/l2-order-events', async (req, res) => {
  try {
    const market    = String(req.query.market     || 'BL').toLowerCase();
    const limit     = Math.min(Number(req.query.limit    || 200), 1000);
    const minutes   = Math.max(Number(req.query.minutes  || 60), 1);
    const eventType = String(req.query.event_type || 'ALL').toUpperCase();

    const ALLOWED_MARKETS = new Set(['bl', 'sh', 'sz']);
    if (!ALLOWED_MARKETS.has(market)) {
      return res.status(400).json({ error: 'invalid_market' });
    }
    const ALLOWED_TYPES = new Set(['ALL', 'NEW', 'CHG', 'MOVED', 'GONE']);
    if (!ALLOWED_TYPES.has(eventType)) {
      return res.status(400).json({ error: 'invalid_event_type' });
    }

    const table  = `market_data.l2_order_events_${market}`;
    const params = [limit, minutes];
    const typeFilter = eventType === 'ALL' ? '' : `AND e.event_type = $3`;
    if (eventType !== 'ALL') params.push(eventType);

    const sql = `
      SELECT
        e.id, e.event_type, e.stock_code, e.alert_type,
        e.price, e.volume, e.depth, e.price_ratio,
        e.prev_volume, e.prev_depth, e.vol_pct,
        e.new_price, e.new_volume,
        e.first_seen, e.created_at
      FROM ${table} e
      WHERE e.trade_date = CURRENT_DATE
        AND e.created_at >= NOW() - ($2 * INTERVAL '1 minute')
        ${typeFilter}
      ORDER BY e.created_at DESC
      LIMIT $1
    `;

    const { rows } = await pricePool.query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('[l2-order-events]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/l2-alert-history', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 100), 500);
    const minutes = Number(req.query.minutes || 0);
    const market = String(req.query.market || 'BL').toLowerCase();

    const ALLOWED_MARKETS = new Set(['bl', 'sh', 'sz']);
    if (!ALLOWED_MARKETS.has(market)) {
      return res.status(400).json({ error: 'invalid_market' });
    }
    const table = `market_data.l2_alert_history_${market}`;

    // [FIX] 用参数化查询替换字符串拼接，避免 SQL 注入
    // [FIX] 过滤 gone（已撤）和 moved（价格漂移中间态），两者对用户无实时参考价值
    // [FIX] DISTINCT ON (stock_code, alert_type, price)：同一价格锚只保留最新一条，
    //       消除同一笔大单多次 CHG 事件堆叠在页面上的问题
    let timeFilter = '';
    const params = [limit];

    if (minutes > 0) {
      params.push(minutes);
      timeFilter = `AND h.created_at >= NOW() - ($2 * INTERVAL '1 minute')
                    AND h.level <= 3`;
    } else {
      timeFilter = `AND h.created_at >= CURRENT_DATE`;
    }

    const sql = `
      SELECT * FROM (
        SELECT DISTINCT ON (h.stock_code, h.alert_type, ROUND(h.price::numeric, 4))
               h.id, h.stock_code, h.alert_type, h.level, h.price, h.volume, h.price_ratio,
               h.trend_type, h.prev_price, h.prev_volume, h.prev_level,
               h.price_change_abs, h.price_change_ratio, h.volume_change_abs, h.volume_change_ratio,
               h.level_delta, h.alert_message, h.created_at,
               COALESCE(d.total_volume, 0) AS total_volume,
               os.open_price AS open_price,
               lp.price AS lp_last_price
        FROM ${table} h
        LEFT JOIN market_data.daily_summary d
               ON d.symbol = h.stock_code AND d.trade_date = CURRENT_DATE
        LEFT JOIN market_data.ohlc_snapshot os
               ON os.symbol = h.stock_code AND os.trade_date = CURRENT_DATE
        LEFT JOIN market_data.last_price lp
               ON lp.symbol = h.stock_code
        WHERE h.trend_type NOT IN ('gone', 'moved')
          ${timeFilter}
        ORDER BY h.stock_code, h.alert_type, ROUND(h.price::numeric, 4), h.created_at DESC
      ) latest
      ORDER BY latest.created_at DESC
      LIMIT $1
    `;

    const { rows } = await pricePool.query(sql, params);

    // last_price 优先级: market_data.last_price(新表，逐笔成交) > priceCache(tos_trades) > 挂单价
    const enriched = rows.map(row => {
      const openPrice = Number(row.open_price);
      if (!openPrice) return { ...row, day_change_pct: null, day_change_amt: null };

      const lpPrice   = Number(row.lp_last_price) || 0;
      const cached    = priceCache.get(row.stock_code);
      const lastPrice = lpPrice > 0 ? lpPrice : (cached ? cached.price : Number(row.price)); // 兜底用挂单价
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
    console.error('l2-alert-history query failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// === Settings API ===
app.get('/api/settings', async (req, res) => {
  const settings = await config.getAllSettings();
  res.json(settings);
});

app.put('/api/settings/:key', express.json(), async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    const changedBy = req.query.user || 'admin';
    const result = await config.update(key, value, changedBy);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/settings/trigger-volume-scan', async (req, res) => {
  try {
    console.log('[API] Triggering manual volume scan...');
    scanAllVolumeAlerts().catch(err => console.error('Manual scan failed:', err));
    res.json({ message: 'Volume scan triggered in background.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to trigger scan' });
  }
});

// 数据库测试路由
app.get('/api/test-db', async (req, res) => {
  try {
    const tableCheck = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = 'tos_trades'
    `, [process.env.PGSCHEMA || 'market_data']);

    if (tableCheck.rows.length === 0) {
      return res.json({ error: 'tos_trades table not found', schema: process.env.PGSCHEMA || 'market_data' });
    }

    const columns = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'tos_trades'
      ORDER BY ordinal_position
    `, [process.env.PGSCHEMA || 'market_data']);

    const sample = await pool.query('SELECT * FROM tos_trades LIMIT 3');

    return res.json({
      table_exists: true,
      columns: columns.rows,
      sample_data: sample.rows,
      row_count: sample.rowCount
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'database_error', message: e.message });
  }
});

// 提醒查询接口
function clampTradeQueryInt(value, defaultValue, maxValue) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, maxValue);
}

async function queryTradeAnomalyTable(req, res, options) {
  const {
    tableName,
    magnitudeColumn,
    absColumn,
    selectColumns,
    extraFilters = [],
  } = options;

  try {
    const symbol = String(req.query.symbol || '').trim().toUpperCase();
    const side = String(req.query.side || '').trim().toUpperCase();
    const condition = String(req.query.condition || '').trim();
    const tick = String(req.query.tick || '').trim().toUpperCase();
    const mmid = String(req.query.mmid || '').trim().toUpperCase();
    const startTs = String(req.query.start_ts || '').trim();
    const endTs = String(req.query.end_ts || '').trim();
    const limit = clampTradeQueryInt(req.query.limit, 200, 1000);
    const offset = clampTradeQueryInt(req.query.offset, 0, 50000);
    const minPrice = req.query.min_price == null ? null : Number(req.query.min_price);
    const maxPrice = req.query.max_price == null ? null : Number(req.query.max_price);
    const minAbs = req.query.min_abs == null ? null : Number(req.query.min_abs);
    const maxAbs = req.query.max_abs == null ? null : Number(req.query.max_abs);
    const minSize = req.query.min_size == null ? null : Number(req.query.min_size);
    const maxSize = req.query.max_size == null ? null : Number(req.query.max_size);
    const minMagnitude = req.query.min_bps == null ? null : Number(req.query.min_bps);

    const where = [];
    const params = [];

    if (symbol) {
      params.push(symbol);
      where.push(`symbol = $${params.length}`);
    }
    if (side) {
      params.push(side);
      where.push(`side = $${params.length}`);
    }
    if (condition) {
      params.push(condition);
      where.push(`condition = $${params.length}`);
    }
    if (tick) {
      params.push(tick);
      where.push(`tick = $${params.length}`);
    }
    if (mmid) {
      params.push(mmid);
      where.push(`mmid = $${params.length}`);
    }
    if (startTs) {
      params.push(startTs);
      where.push(`trade_ts >= $${params.length}::timestamptz`);
    }
    if (endTs) {
      params.push(endTs);
      where.push(`trade_ts <= $${params.length}::timestamptz`);
    }
    if (Number.isFinite(minPrice)) {
      params.push(minPrice);
      where.push(`price >= $${params.length}`);
    }
    if (Number.isFinite(maxPrice)) {
      params.push(maxPrice);
      where.push(`price <= $${params.length}`);
    }
    if (Number.isFinite(minAbs)) {
      params.push(minAbs);
      where.push(`${absColumn} >= $${params.length}`);
    }
    if (Number.isFinite(maxAbs)) {
      params.push(maxAbs);
      where.push(`${absColumn} <= $${params.length}`);
    }
    if (Number.isFinite(minSize) && minSize > 0) {
      params.push(minSize);
      where.push(`size >= $${params.length}`);
    }
    if (Number.isFinite(maxSize) && maxSize > 0) {
      params.push(maxSize);
      where.push(`size <= $${params.length}`);
    }
    if (Number.isFinite(minMagnitude) && minMagnitude >= 0) {
      params.push(minMagnitude);
      where.push(`${magnitudeColumn} >= $${params.length}`);
    }

    for (const filter of extraFilters) {
      filter({ req, params, where });
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countParams = params.slice();

    params.push(limit);
    const limitParam = `$${params.length}`;
    params.push(offset);
    const offsetParam = `$${params.length}`;

    const sql = `
      SELECT
        ${selectColumns}
      FROM market_data.${tableName}
      ${whereSql}
      ORDER BY trade_ts DESC, detected_at DESC, id DESC
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    `;

    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM market_data.${tableName}
      ${whereSql}
    `;

    const [dataResult, countResult] = await Promise.all([
      pool.query(sql, params),
      pool.query(countSql, countParams),
    ]);

    return res.json({
      table: tableName,
      total: countResult.rows[0]?.total || 0,
      limit,
      offset,
      rows: dataResult.rows,
    });
  } catch (e) {
    console.error(`[${tableName}] query failed:`, e);
    return res.status(500).json({ error: `${tableName}_query_failed`, message: e.message });
  }
}

app.get('/api/intra-spread-trades', async (req, res) => {
  return queryTradeAnomalyTable(req, res, {
    tableName: 'intra_spread_trades',
    magnitudeColumn: 'spread_bps',
    absColumn: 'spread_abs',
    selectColumns: `
      id, symbol, tos_entry_id, price, size, bid, ask,
      spread_abs, spread_bps,
      side, condition, tick, mmid,
      trade_ts, quote_ts, detected_at
    `,
  });
});

app.get('/api/slip-trades', async (req, res) => {
  return queryTradeAnomalyTable(req, res, {
    tableName: 'slip_trades',
    magnitudeColumn: 'slip_bps',
    absColumn: 'slip_abs',
    selectColumns: `
      id, symbol, tos_entry_id, price, size, bid, ask,
      slip_abs, slip_bps, direction,
      side, condition, tick, mmid,
      trade_ts, quote_ts, detected_at
    `,
    extraFilters: [
      ({ req, params, where }) => {
        const direction = String(req.query.direction || '').trim().toLowerCase();
        if (!direction) return;
        params.push(direction);
        where.push(`direction = $${params.length}`);
      },
    ],
  });
});

app.get('/api/alerts', async (req, res) => {
  try {
    const since = req.query.since || null;
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const ruleId = req.query.rule_id || 'amplitude_1pct';

    const sql = `
      SELECT symbol, bucket, open, high, low, close, amplitude_pct, direction, rule_id, created_at
      FROM k_alerts
      WHERE rule_id = $3
        AND ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
      ORDER BY created_at DESC
      LIMIT $2
    `;
    const { rows } = await pool.query(sql, [since, limit, ruleId]);
    res.json(rows);
  } catch (e) {
    console.error('alerts query failed:', e);
    res.status(500).json({ error: 'alerts query failed' });
  }
});

// === Ranking 缓存 ===
let rankingCache = [];
let rankingCacheTime = null;

// === 当前时段10日均量缓存 ===
// daily_intraday_vol.period_vol 存的是当天截至该分钟的累计量
// 所以取截至当前时刻的最后一条（MAX(period_vol)）即为同期累计量，再对10日求均值
const intradayAvgVolCache = new Map();

async function refreshIntradayAvgVolCache() {
  const nowBeijing = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const beijingMins = nowBeijing.getHours() * 60 + nowBeijing.getMinutes();
  // 08:00 前或 17:00 后不写入，避免收盘后产生大量重复记录
  if (beijingMins < 8 * 60 || beijingMins >= 17 * 60) return;

  const timeStr = nowBeijing.toTimeString().slice(0, 8); // 'HH:MM:SS'

  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 15000');
    // MAX(period_vol) = 截至 timeStr 的累计量（period_vol 单调递增）
    const { rows } = await client.query(`
      SELECT symbol,
             ROUND(AVG(day_vol)) AS avg_intraday_vol
      FROM (
        SELECT symbol,
               trade_date,
               MAX(period_vol) AS day_vol
        FROM market_data.daily_intraday_vol
        WHERE trade_date >= current_date - INTERVAL '14 days'
          AND trade_date <  current_date
          AND minute_time <= $1::time
        GROUP BY symbol, trade_date
      ) daily
      GROUP BY symbol
      HAVING COUNT(*) >= 3
    `, [timeStr]);

    intradayAvgVolCache.clear();
    for (const row of rows) {
      intradayAvgVolCache.set(row.symbol, Number(row.avg_intraday_vol));
    }
  } catch (err) {
    console.error('[IntradayAvgVol] Refresh failed:', err.message);
  } finally {
    await client.query('SET statement_timeout = 0').catch(() => {});
    client.release();
  }
}

// 5日高低差均值缓存：symbol -> avg_range（近5个历史交易日均值，每小时刷新）
const dailyRangeCache = new Map();

async function refreshDailyRangeCache() {
  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 20000');
    const { rows } = await client.query(`
      SELECT symbol,
             ROUND(AVG(high_price - low_price)::numeric, 2) AS avg_range
      FROM (
        SELECT symbol, high_price, low_price,
               ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY trade_date DESC) AS rn
        FROM market_data.daily_summary
        WHERE trade_date < current_date
          AND high_price IS NOT NULL
          AND low_price  IS NOT NULL
          AND high_price > low_price
      ) t
      WHERE rn <= 5
      GROUP BY symbol
      HAVING COUNT(*) >= 3
    `);
    dailyRangeCache.clear();
    for (const row of rows) {
      dailyRangeCache.set(row.symbol, Number(row.avg_range));
    }
    console.log(`[DailyRangeCache] refreshed, ${dailyRangeCache.size} symbols`);
  } catch (err) {
    console.error('[DailyRangeCache] Error:', err.message);
  } finally {
    await client.query('SET statement_timeout = 0').catch(() => {});
    client.release();
  }
}

// === 当日分时成交量写入 daily_intraday_vol ===
// period_vol 存当天从开盘到该分钟的累计成交量（单调递增）
// 数据来源已改为 daily_summary.total_volume（PPro8 L1DB 全量，由 orderbook_processor_bl.py 写入）

// 每分钟写入当前分钟的累计量
async function writeIntradayVolMinute() {
  const nowBeijing = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const beijingMins = nowBeijing.getHours() * 60 + nowBeijing.getMinutes();
  // 08:00 前或 17:00 后不写入，避免收盘后产生大量重复记录
  if (beijingMins < 8 * 60 || beijingMins >= 17 * 60) return;

  const client = await pricePool.connect();
  try {
    await client.query('SET statement_timeout = 15000');
    // 直接从 daily_summary.total_volume 取当前全量累计值，写入当前分钟快照
    // total_volume 由 L1DBSnapshotWriter 实时更新，天然就是从开盘到当前的累计量
    const { rowCount } = await client.query(`
      INSERT INTO market_data.daily_intraday_vol (symbol, trade_date, minute_time, period_vol)
      SELECT
        symbol,
        trade_date,
        date_trunc('minute', NOW() AT TIME ZONE 'Asia/Shanghai')::time AS minute_time,
        total_volume                                                    AS period_vol
      FROM market_data.daily_summary
      WHERE trade_date = current_date
        AND total_volume IS NOT NULL
        AND total_volume > 0
      ON CONFLICT (symbol, trade_date, minute_time)
      DO UPDATE SET period_vol = EXCLUDED.period_vol
    `);
    if (rowCount > 0) {
      console.log(`[IntradayVolWriter] Wrote ${rowCount} rows from daily_summary`);
    }
  } catch (err) {
    console.error('[IntradayVolWriter] Minute write failed:', err.message);
  } finally {
    await client.query('SET statement_timeout = 0').catch(() => {});
    client.release();
  }
}

// 收盘后补写当天收盘时刻的终值快照
// 改为从 daily_summary.total_volume 取收盘终量（PPro8 L1DB 全量），写入 17:00 分钟档
// 注：daily_summary 只存最新全量值，无法还原历史每分钟增量，故只补写收盘终值这一条
async function snapshotTodayAllMinutes() {
  // [DISABLED] 已由 orderbook_processor_bl.py 接管，此函数不再执行写库操作
  return;
  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 30000');
    const { rowCount } = await client.query(`
      INSERT INTO market_data.daily_intraday_vol (symbol, trade_date, minute_time, period_vol)
      SELECT
        symbol,
        trade_date,
        '17:00:00'::time AS minute_time,
        total_volume     AS period_vol
      FROM market_data.daily_summary
      WHERE trade_date = current_date
        AND total_volume IS NOT NULL
        AND total_volume > 0
      ON CONFLICT (symbol, trade_date, minute_time)
      DO UPDATE SET period_vol = EXCLUDED.period_vol
    `);
    console.log(`[IntradaySnapshot] Closing snapshot done, ${rowCount} rows upserted`);
  } catch (err) {
    console.error('[IntradaySnapshot] Snapshot failed:', err.message);
  } finally {
    await client.query('SET statement_timeout = 0').catch(() => {});
    client.release();
  }
}

// [OHLCSnapshot] Open/High/Low/Volume 优先从 ohlc_snapshot 取（GetLv1实时值），
//   ohlc_writer.py 未运行或该股无数据时自动回退到 daily_summary（零中断）
// Last 优先级: market_data.last_price(新表，逐笔成交) > ohlc_snapshot.last_price
//   (GetLv1轮询值) > open_price。priceCache/quoteCache/close_price 不再参与这条
//   链路(那两个 Map 本身没删，/api/l2-active-orders 等其他接口还在用)。
async function refreshRankingCache() {
  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 20000');
    const safeEtfList = etfList.length > 0 ? etfList : ['__NO_ETF__'];

    const sql = `
      WITH avg_vol AS (
        SELECT symbol, AVG(total_volume) AS avg_vol
        FROM market_data.daily_summary
        WHERE trade_date >= current_date - 10
          AND trade_date < current_date
        GROUP BY symbol
        HAVING AVG(total_volume) >= 1000
      )
      SELECT
        os.symbol,
        -- open_price: 只使用 ohlc_snapshot（GetLv1 官方值），无数据则不进入排名
        os.open_price                             AS open_price,
        os.last_price                             AS os_last_price,
        lp.price                                  AS lp_last_price,
        -- high/low/volume: ohlc_snapshot 优先，无则回退 daily_summary
        COALESCE(os.high_price,  ds.high_price)   AS high_price,
        COALESCE(os.low_price,   ds.low_price)    AS low_price,
        COALESCE(os.volume,      ds.total_volume) AS total_volume,
        COALESCE(ROUND(a.avg_vol), 0)             AS avg_vol_10d,
        'ohlc'                                    AS ohlc_src
      FROM market_data.ohlc_snapshot os
      LEFT JOIN market_data.daily_summary ds
             ON ds.symbol = os.symbol
            AND ds.trade_date = current_date
      LEFT JOIN market_data.last_price lp
             ON lp.symbol = os.symbol
      LEFT JOIN avg_vol a ON a.symbol = os.symbol
      WHERE os.trade_date = current_date
        AND NOT (os.symbol = ANY($1::text[]))
        AND os.open_price > 0
    `;

    const { rows } = await client.query(sql, [safeEtfList]);

    const newCache = rows.map(row => {
      const lpPrice   = Number(row.lp_last_price) || 0;
      const osPrice   = Number(row.os_last_price) || 0;
      const openPrice = Number(row.open_price);

      // 優先級：market_data.last_price(新表，逐笔成交) > ohlc_snapshot.last_price
      //        (GetLv1轮询值) > open_price
      let lastPrice;
      if (lpPrice > 0) {
        lastPrice = lpPrice;
      } else if (osPrice > 0) {
        lastPrice = osPrice;
      } else {
        lastPrice = openPrice;
      }

      const changeAmt = lastPrice - openPrice;
      // 优先使用当前时段10日均量；缓存未就绪时回退到全天均量
      const intradayAvg = intradayAvgVolCache.get(row.symbol);
      const avg_vol_10d = intradayAvg != null ? intradayAvg : Number(row.avg_vol_10d);
      return {
        symbol:        row.symbol,
        open_price:    openPrice,
        last_price:    lastPrice,
        change_amount: changeAmt,
        change_pct:    openPrice > 0 ? Number((changeAmt / openPrice * 100).toFixed(2)) : 0,
        total_volume:  row.total_volume,
        avg_vol_10d,
        high_price:    Number(row.high_price || 0),
        low_price:     Number(row.low_price  || 0),
      };
    });

    newCache.sort((a, b) => b.change_amount - a.change_amount);
    rankingCache = newCache;
    rankingCacheTime = new Date();

    if (rows.length === 0) {
      const diag = await client.query(`
        SELECT current_date AS db_date,
               MIN(trade_date) AS min_date, MAX(trade_date) AS max_date, COUNT(*) AS total
        FROM market_data.daily_summary
      `);
      console.log(`[RankingCache] 0 rows. DB date=${diag.rows[0].db_date}, range: ${diag.rows[0].min_date}~${diag.rows[0].max_date}, total=${diag.rows[0].total}`);
    } else {
      // open_price 全部来自 ohlc_snapshot
      console.log(`[RankingCache] Refreshed, ${rankingCache.length} rows (source=ohlc_snapshot only)`);
    }
  } catch (err) {
    console.error('[RankingCache] Error:', err.message);
  } finally {
    await client.query('SET statement_timeout = 0').catch(e => console.error(e));
    client.release();
  }
}

// 排行榜 API
app.get('/api/ranking', (req, res) => {
  try {
    const minVolume = Number(req.query.min_volume || 0);
    const minPriceChange3m = Number(req.query.min_price_change_3m || 0);

    const now = new Date();
    const cutoff = new Date(now.getTime() - 3 * 60 * 1000);

    const result = rankingCache
      .filter(row => Number(row.total_volume) >= minVolume)
      .map(row => {
        const window = priceWindow.get(row.symbol);
        let price_change_3m = 0;
        if (window && window.length > 0) {
          const lastEntry = window[window.length - 1];
          if (lastEntry.receivedAt >= cutoff) {
            const entry3m = window.find(e => e.receivedAt <= cutoff);
            if (entry3m) {
              price_change_3m = Number(row.last_price) - entry3m.price;
            }
          }
        }

        // ── 半小时涨跌：使用精确基准价（30分钟前最后一笔成交价）──
        // 避免 window30m 滚动淘汰造成的基准价跳变
        let change_30m = null;
        let change_30m_pct = null;
        const base30 = price30mCache.get(row.symbol);
        if (base30 && base30.price > 0 && Number(row.last_price) > 0) {
          change_30m     = Number((Number(row.last_price) - base30.price).toFixed(4));
          change_30m_pct = Number((change_30m / base30.price * 100).toFixed(2));
        }

        return { ...row, price_change_3m, change_30m, change_30m_pct };
      });

    const filteredRows = result.filter(row => {
      if (minPriceChange3m > 0) {
        return Math.abs(Number(row.price_change_3m)) >= minPriceChange3m;
      }
      return true;
    });

    res.json(filteredRows);
  } catch (e) {
    console.error('ranking query failed:', e);
    res.status(500).json({ error: 'ranking query failed' });
  }
});

// === 分价格区间波动筛选器 API ===
const SWING_RULES = [
  { maxPrice: 20,        minSwing: 0.20, minChangePct: 2.0  },
  { maxPrice: 100,       minSwing: 0.50, minChangePct: 1.0  },
  { maxPrice: 300,       minSwing: 1.00, minChangePct: 0.5  },
  { maxPrice: 600,       minSwing: 1.50, minChangePct: 0.35 },
  { maxPrice: Infinity,  minSwing: 2.00, minChangePct: 0.3  },
];

function getSwingRule(price) {
  for (const rule of SWING_RULES) {
    if (price < rule.maxPrice) return rule;
  }
  return SWING_RULES[SWING_RULES.length - 1];
}

app.get('/api/price-swing-screener', (req, res) => {
  try {
    const minVolume = Number(req.query.min_volume || 0);
    const results = [];

    for (const row of rankingCache) {
      if (Number(row.total_volume) < minVolume) continue;

      const lastPrice = Number(row.last_price);
      if (!lastPrice) continue;

      // 无实时窗口数据直接跳过，不用 daily 兜底
      const win = priceWindow.get(row.symbol);
      if (!win || win.length < 2) continue;

      // 2分钟窗口内高低价 & 波动额
      let windowHigh = win[0].price;
      let windowLow  = win[0].price;
      for (const e of win) {
        if (e.price > windowHigh) windowHigh = e.price;
        if (e.price < windowLow)  windowLow  = e.price;
      }
      const swing = windowHigh - windowLow;

      // 2分钟窗口内涨跌：最旧价 -> 最新价
      const priceStart  = win[0].price;
      const priceEnd    = win[win.length - 1].price;
      const changeAmt2m = Number((priceEnd - priceStart).toFixed(3));
      const changePct2m = priceStart > 0
        ? Number(((priceEnd - priceStart) / priceStart * 100).toFixed(2))
        : 0;

      const rule = getSwingRule(lastPrice);

      if (swing >= rule.minSwing && Math.abs(changePct2m) >= rule.minChangePct) {
        results.push({
          symbol:              row.symbol,
          open_price:          row.open_price,
          last_price:          priceEnd,
          change_pct:          changePct2m,
          change_amount:       changeAmt2m,
          swing:               Number(swing.toFixed(3)),
          swing_source:        'realtime',
          window_high:         Number(windowHigh.toFixed(3)),
          window_low:          Number(windowLow.toFixed(3)),
          total_volume:        row.total_volume,
          avg_vol_10d:         row.avg_vol_10d,
          rule_min_swing:      rule.minSwing,
          rule_min_change_pct: rule.minChangePct,
        });
      }
    }

    results.sort((a, b) => b.swing - a.swing);
    res.json(results);
  } catch (e) {
    console.error('[SwingScreener] error:', e);
    res.status(500).json({ error: 'swing_screener_failed' });
  }
});

// === 自由选股器 API ===
app.get('/api/screener', (req, res) => {
  try {
    const q = req.query;

    // AND / OR 逻辑模式，默认 AND
    const logic = (q.logic || 'and').toLowerCase() === 'or' ? 'or' : 'and';

    // 价格区间
    const priceMin = q.price_min !== undefined && q.price_min !== '' ? Number(q.price_min) : null;
    const priceMax = q.price_max !== undefined && q.price_max !== '' ? Number(q.price_max) : null;

    // 涨跌幅区间（支持负数）
    const changMin = q.change_min !== undefined && q.change_min !== '' ? Number(q.change_min) : null;
    const changMax = q.change_max !== undefined && q.change_max !== '' ? Number(q.change_max) : null;

    // 量比区间（total_volume / avg_vol_10d）
    const volRatioMin = q.vol_ratio_min !== undefined && q.vol_ratio_min !== '' ? Number(q.vol_ratio_min) : null;
    const volRatioMax = q.vol_ratio_max !== undefined && q.vol_ratio_max !== '' ? Number(q.vol_ratio_max) : null;

    // 绝对成交量下限
    const volMin = q.vol_min !== undefined && q.vol_min !== '' ? Number(q.vol_min) : null;

    // 价差区间 (ask - bid)
    const spreadMin = q.spread_min !== undefined && q.spread_min !== '' ? Number(q.spread_min) : null;
    const spreadMax = q.spread_max !== undefined && q.spread_max !== '' ? Number(q.spread_max) : null;

    // 是否有任何条件
    const hasPrice    = priceMin    !== null || priceMax    !== null;
    const hasChange   = changMin    !== null || changMax    !== null;
    const hasVolRatio = volRatioMin !== null || volRatioMax !== null;
    const hasVol      = volMin      !== null;
    const hasSpread   = spreadMin   !== null || spreadMax   !== null;
    const hasAny      = hasPrice || hasChange || hasVolRatio || hasVol || hasSpread;

    const results = [];

    for (const row of rankingCache) {
      const price     = Number(row.last_price);
      const changePct = Number(row.change_pct);
      const vol       = Number(row.total_volume) || 0;
      const avgVol    = Number(row.avg_vol_10d)  || 0;
      const volRatio  = avgVol > 0 ? vol / avgVol : 0;

      if (!price) continue;

      // 从 quoteCache 取 bid/ask/价差
      const quote  = quoteCache.get(row.symbol);
      const bid    = quote ? quote.bid    : null;
      const ask    = quote ? quote.ask    : null;
      const spread = quote ? quote.spread : null;

      // 无任何条件时返回全部
      if (!hasAny) {
        results.push({ symbol: row.symbol, last_price: price, open_price: row.open_price,
          change_pct: changePct, change_amount: Number(row.change_amount),
          total_volume: vol, avg_vol_10d: avgVol,
          vol_ratio: avgVol > 0 ? Number(volRatio.toFixed(2)) : null,
          high_price: row.high_price, low_price: row.low_price,
          bid, ask, spread });
        continue;
      }

      // 每个条件组：先判断该组是否"激活"，再判断是否"命中"
      const priceHit = !hasPrice || (
        (priceMin === null || price     >= priceMin) &&
        (priceMax === null || price     <= priceMax)
      );
      const changeHit = !hasChange || (
        (changMin  === null || changePct >= changMin) &&
        (changMax  === null || changePct <= changMax)
      );
      const volRatioHit = !hasVolRatio || (
        (volRatioMin === null || volRatio >= volRatioMin) &&
        (volRatioMax === null || volRatio <= volRatioMax)
      );
      const volHit    = !hasVol    || vol >= volMin;
      const spreadHit = !hasSpread || (spread !== null && (
        (spreadMin === null || spread >= spreadMin) &&
        (spreadMax === null || spread <= spreadMax)
      ));

      // AND：全部激活的条件组都要命中；OR：任一命中即可
      let pass;
      if (logic === 'and') {
        pass = priceHit && changeHit && volRatioHit && volHit && spreadHit;
      } else {
        const hits = [
          hasPrice    && priceHit,
          hasChange   && changeHit,
          hasVolRatio && volRatioHit,
          hasVol      && volHit,
          hasSpread   && spreadHit,
        ].filter((_, i) => [hasPrice, hasChange, hasVolRatio, hasVol, hasSpread][i]);
        pass = hits.some(Boolean);
      }

      if (pass) {
        results.push({
          symbol:        row.symbol,
          last_price:    price,
          open_price:    row.open_price,
          change_pct:    changePct,
          change_amount: Number(row.change_amount),
          total_volume:  vol,
          avg_vol_10d:   avgVol,
          vol_ratio:     avgVol > 0 ? Number(volRatio.toFixed(2)) : null,
          high_price:    row.high_price,
          low_price:     row.low_price,
          bid,
          ask,
          spread,
        });
      }
    }

    results.sort((a, b) => b.change_pct - a.change_pct);
    res.json(results);
  } catch (e) {
    console.error('[Screener] error:', e);
    res.status(500).json({ error: 'screener_failed' });
  }
});

// === 稳定选股器 API ===
// 在自由选股器基础上叠加 6 条稳定性规则（全部基于 window10m 内存缓存，不查库）
// R1: 7分钟内 high-low < 现价 × 1.2%
// R2: 7分钟内总成交量 >= 310
// R3: |现价 - 7分钟收盘均价| / 均价 < 按开盘价分档阈值（0.05%/0.04%/0.03%/0.025%/0.015%）
// R4: |首根中间价 - 末根中间价| / 末根中间价 < 按开盘价分档阈值（0.3%/0.2%/0.15%/0.1%）
// R5: 最近7根K线中，|close-open|/open < R3/R5阈值 的分钟数 >= 6
// R6: 7分钟周期内，触下轨(low < A)的K线数 >= 3，或触上轨(high > B)的K线数 >= 3 才通过
//     A = winLow + (winHigh - winLow) * 0.15，B = winLow + (winHigh - winLow) * 0.85
app.get('/api/screener-stable', (req, res) => {
  try {
    const q = req.query;

    // 基础筛选参数（与 /api/screener 相同）
    const priceMin = q.price_min !== undefined && q.price_min !== '' ? Number(q.price_min) : null;
    const priceMax = q.price_max !== undefined && q.price_max !== '' ? Number(q.price_max) : null;
    const changMin = q.change_min !== undefined && q.change_min !== '' ? Number(q.change_min) : null;
    const changMax = q.change_max !== undefined && q.change_max !== '' ? Number(q.change_max) : null;
    const volMin   = q.vol_min   !== undefined && q.vol_min   !== '' ? Number(q.vol_min)   : null;
    const volMax   = q.vol_max   !== undefined && q.vol_max   !== '' ? Number(q.vol_max)   : null;

    const results = [];

    for (const row of rankingCache) {
      const price     = Number(row.last_price);
      const changePct = Number(row.change_pct);
      const vol       = Number(row.total_volume) || 0;
      const avgVol    = Number(row.avg_vol_10d)  || 0;

      if (!price) continue;

      // ── 基础过滤 ──
      if (priceMin !== null && price     < priceMin) continue;
      if (priceMax !== null && price     > priceMax) continue;
      if (changMin !== null && changePct < changMin) continue;
      if (changMax !== null && changePct > changMax) continue;
      if (volMin   !== null && vol       < volMin)   continue;
      if (volMax   !== null && vol       > volMax)   continue;

      // ── window10m 数据 ──
      const bars = window10m.get(row.symbol);
      const openPrice = Number(row.open_price) || price;

      // 数据不足时仍返回，但规则字段为 null（前端显示"—"）
      let r1_val = null, r2_vol = null, r3_pct = null, r4_pct = null, r5_cnt = null;
      let r6_a = null, r6_b = null;

      if (bars && bars.length > 0) {
        // R1: 7分钟振幅 % = (windowHigh - windowLow) / price * 100
        const winHigh = Math.max(...bars.map(b => b.high));
        const winLow  = Math.min(...bars.map(b => b.low));
        r1_val = Number(((winHigh - winLow) / price * 100).toFixed(3));

        // R2: 7分钟总成交量
        r2_vol = bars.reduce((s, b) => s + b.volume, 0);

        // R3: |现价 - 7分钟收盘均价| / 均价 × 100 (%)
        const avgClose = bars.reduce((s, b) => s + b.close, 0) / bars.length;
        r3_pct = avgClose > 0
          ? Number((Math.abs(price - avgClose) / avgClose * 100).toFixed(3))
          : null;

        // R4: |首根中间价 - 末根中间价| / 末根中间价 × 100 (%)
        const firstMid = (bars[0].high + bars[0].low) / 2;
        const lastMid  = (bars[bars.length - 1].high + bars[bars.length - 1].low) / 2;
        r4_pct = lastMid > 0
          ? Number((Math.abs(firstMid - lastMid) / lastMid * 100).toFixed(3))
          : null;

        // R5: 最近7根K线中安静蜡烛数（按开盘价分档阈值）
        const r35Thresh = getR35Thresh(openPrice);
        const r5_bars = bars.slice(-STABLE_R5_WINDOW);
        r5_cnt = r5_bars.filter(b =>
          b.open > 0 && Math.abs(b.close - b.open) / b.open < r35Thresh
        ).length;

        // R6: 7分钟内触下轨/上轨的K线数（a >= 3 或 b >= 3 才通过）
        // 预警价A = winLow + (winHigh - winLow) * 0.15（下轨）
        // 预警价B = winLow + (winHigh - winLow) * 0.85（上轨）
        const r6Range = winHigh - winLow;
        if (r6Range > 0) {
          const priceA = winLow + r6Range * 0.1;
          const priceB = winLow + r6Range * 0.9;
          r6_a = bars.filter(b => b.low  < priceA).length;
          r6_b = bars.filter(b => b.high > priceB).length;
        } else {
          // 所有K线价格完全相同，无上下轨意义，视为不触轨
          r6_a = 0;
          r6_b = 0;
        }
      }

      // quote
      const quote  = quoteCache.get(row.symbol);
      const bid    = quote ? quote.bid    : null;
      const ask    = quote ? quote.ask    : null;
      const spread = quote ? quote.spread : null;

      results.push({
        symbol:        row.symbol,
        last_price:    price,
        open_price:    row.open_price,
        change_pct:    changePct,
        change_amount: Number(row.change_amount),
        total_volume:  vol,
        avg_vol_10d:   avgVol,
        vol_ratio:     avgVol > 0 ? Number((vol / avgVol).toFixed(2)) : null,
        high_price:    row.high_price,
        low_price:     row.low_price,
        bid,
        ask,
        spread,
        // 5条规则原始指标值（前端负责计算通过/失败）
        r1_val,   // 7min振幅%，< 1.2% 为通过
        r2_vol,   // 7min总量，>= 310 为通过
        r3_pct,   // 现价偏离均价%，按开盘价分档阈值
        r4_pct,   // 首尾中间价漂移%，按开盘价分档阈值
        r5_cnt,   // 最近7根K线中安静分钟数，>= 6 为通过
        r6_a,     // 触下轨(low < A)的K线数，a >= 3 或 b >= 3 为通过
        r6_b,     // 触上轨(high > B)的K线数，a >= 3 或 b >= 3 为通过
        bars_count: bars ? bars.length : 0,
      });
    }

    results.sort((a, b) => b.change_pct - a.change_pct);
    res.json(results);
  } catch (e) {
    console.error('[StableScreener] error:', e);
    res.status(500).json({ error: 'stable_screener_failed' });
  }
});

app.get('/api/screener-stable/history', (req, res) => {
  const symbol = (req.query.symbol || '').trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  res.json({ symbol, records: stableHistory.get(symbol) || [] });
});

// 单时间点诊断：查快照表，返回该分钟的完整规则诊断
// GET /api/screener-stable/diagnose?symbol=AAPL&time=10:23
app.get('/api/screener-stable/diagnose', async (req, res) => {
  const symbol  = (req.query.symbol || '').trim().toUpperCase();
  const timeQ   = (req.query.time   || '').trim();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  if (!timeQ)  return res.status(400).json({ error: 'time required, format HH:MM' });
  const snapTime = timeQ.length === 5 ? timeQ + ':00' : timeQ.slice(0, 8);
  try {
    const { rows } = await pool.query(`
      SELECT * FROM stable_screener_snapshot
      WHERE symbol = $1 AND trade_date = current_date AND snap_time = $2::time
    `, [symbol, snapTime]);
    if (rows.length === 0) return res.json({ symbol, snap_time: snapTime, found: false });
    res.json({ symbol, snap_time: snapTime, found: true, ...buildDiagnoseResult(rows[0]) });
  } catch (e) {
    console.error('[diagnose] error:', e.message);
    res.status(500).json({ error: 'diagnose_failed' });
  }
});

// 时间段诊断：返回 [from, to] 内每分钟的快照列表
// GET /api/screener-stable/diagnose-range?symbol=AAPL&from=10:00&to=10:30
app.get('/api/screener-stable/diagnose-range', async (req, res) => {
  const symbol = (req.query.symbol || '').trim().toUpperCase();
  const fromQ  = (req.query.from   || '').trim();
  const toQ    = (req.query.to     || '').trim();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  if (!fromQ || !toQ) return res.status(400).json({ error: 'from and to required, format HH:MM' });
  const fromTime = fromQ.length === 5 ? fromQ + ':00' : fromQ.slice(0, 8);
  const toTime   = toQ.length   === 5 ? toQ   + ':00' : toQ.slice(0, 8);
  try {
    const { rows } = await pool.query(`
      SELECT * FROM stable_screener_snapshot
      WHERE symbol     = $1
        AND trade_date = current_date
        AND snap_time >= $2::time
        AND snap_time <= $3::time
      ORDER BY snap_time ASC
    `, [symbol, fromTime, toTime]);
    const records = rows.map(r => ({ snap_time: r.snap_time, ...buildDiagnoseResult(r) }));
    res.json({ symbol, from: fromTime, to: toTime, count: records.length, records });
  } catch (e) {
    console.error('[diagnose-range] error:', e.message);
    res.status(500).json({ error: 'diagnose_range_failed' });
  }
});

// 共用：把快照行转成规则诊断结构
function buildDiagnoseResult(s) {
  const openPrice = Number(s.open_price);
  const r35Thresh = getR35Thresh(openPrice);
  const r4Thresh  = getR4Thresh(openPrice);
  const rules = [
    { id:'R1', label:'振幅',      cmp:'lt',       unit:'%',  threshold: STABLE_R1,
      value: s.r1_val !== null ? Number(s.r1_val) : null,
      pass:  s.r1_val !== null ? Number(s.r1_val) < STABLE_R1 : null },
    { id:'R2', label:'成交量',    cmp:'gte',      unit:'股', threshold: STABLE_R2,
      value: s.r2_vol !== null ? Number(s.r2_vol) : null,
      pass:  s.r2_vol !== null ? Number(s.r2_vol) >= STABLE_R2 : null },
    { id:'R3', label:'价格偏离',  cmp:'lt',       unit:'%',  threshold: Number((r35Thresh*100).toFixed(4)),
      value: s.r3_pct !== null ? Number(s.r3_pct) : null,
      pass:  s.r3_pct !== null ? Number(s.r3_pct) < r35Thresh*100 : null },
    { id:'R4', label:'中间价漂移',cmp:'lt',       unit:'%',  threshold: Number((r4Thresh*100).toFixed(4)),
      value: s.r4_pct !== null ? Number(s.r4_pct) : null,
      pass:  s.r4_pct !== null ? Number(s.r4_pct) < r4Thresh*100 : null },
    { id:'R5', label:'安静分钟',  cmp:'gte',      unit:'分钟',threshold: STABLE_R5_MIN,
      value: s.r5_cnt !== null ? Number(s.r5_cnt) : null,
      pass:  s.r5_cnt !== null ? Number(s.r5_cnt) >= STABLE_R5_MIN : null },
    { id:'R6', label:'触轨',      cmp:'gte_either',unit:'根', threshold: 3,
      value: (s.r6_a !== null && s.r6_b !== null) ? { a: Number(s.r6_a), b: Number(s.r6_b) } : null,
      pass:  (s.r6_a !== null && s.r6_b !== null) ? (Number(s.r6_a) >= 3 || Number(s.r6_b) >= 3) : null },
  ];
  for (const r of rules) {
    if (r.pass === null || r.value === null || r.pass) { r.delta = null; continue; }
    if (r.id === 'R6') {
      r.delta = `差 ${r.threshold - Math.max(r.value.a, r.value.b)} 根`;
    } else if (r.cmp === 'lt') {
      r.delta = `超出 ${(r.value - r.threshold).toFixed(4)}${r.unit}`;
    } else {
      r.delta = `差 ${(r.threshold - r.value).toFixed(r.id === 'R5' ? 0 : 4)}${r.unit}`;
    }
  }
  return {
    pass_all:   Boolean(s.pass_all),
    last_price: Number(s.last_price),
    open_price: openPrice,
    change_pct: Number(s.change_pct),
    bars_count: Number(s.bars_count),
    rules,
  };
}

// === 震荡筛选器 API ===
// 对 window30m 中每个 symbol 依次跑 15/20/25/30 分钟四个独立窗口
// 任意窗口触发则该 symbol 进入结果，返回各窗口明细
// GET /api/screener-oscillator?price_min=&price_max=&change_min=&change_max=&vol_min=
app.get('/api/screener-oscillator', (req, res) => {
  try {
    const q = req.query;
    const priceMin = q.price_min !== undefined && q.price_min !== '' ? Number(q.price_min) : null;
    const priceMax = q.price_max !== undefined && q.price_max !== '' ? Number(q.price_max) : null;
    const changMin = q.change_min !== undefined && q.change_min !== '' ? Number(q.change_min) : null;
    const changMax = q.change_max !== undefined && q.change_max !== '' ? Number(q.change_max) : null;
    const volMin   = q.vol_min   !== undefined && q.vol_min   !== '' ? Number(q.vol_min)   : null;

    const WINDOWS = [15, 20, 25, 30];
    const results = [];

    for (const row of rankingCache) {
      const price     = Number(row.last_price);
      const changePct = Number(row.change_pct);
      const vol       = Number(row.total_volume) || 0;

      if (!price) continue;

      // 基础过滤
      if (priceMin !== null && price     < priceMin) continue;
      if (priceMax !== null && price     > priceMax) continue;
      if (changMin !== null && changePct < changMin) continue;
      if (changMax !== null && changePct > changMax) continue;
      if (volMin   !== null && vol       < volMin)   continue;

      const bars = window30m.get(row.symbol);
      if (!bars || bars.length === 0) continue;

      // 对四个窗口逐一计算
      const windowResults = {};
      let anyTriggered = false;

      for (const wSize of WINDOWS) {
        const r = checkOscillatorWindow(bars, wSize);
        windowResults[wSize] = r;
        if (r.triggered) anyTriggered = true;
      }

      if (!anyTriggered) continue;

      const quote  = quoteCache.get(row.symbol);
      const avgVol = Number(row.avg_vol_10d) || 0;

      results.push({
        symbol:        row.symbol,
        last_price:    price,
        open_price:    row.open_price,
        change_pct:    changePct,
        change_amount: Number(row.change_amount),
        total_volume:  vol,
        avg_vol_10d:   avgVol,
        vol_ratio:     avgVol > 0 ? Number((vol / avgVol).toFixed(2)) : null,
        high_price:    row.high_price,
        low_price:     row.low_price,
        bid:           quote ? quote.bid    : null,
        ask:           quote ? quote.ask    : null,
        spread:        quote ? quote.spread : null,
        bars_count:     bars.length,
        windows:        windowResults,  // { 15: {...}, 20: {...}, 25: {...}, 30: {...} }
        avg_5day_range: dailyRangeCache.get(row.symbol) ?? null,
      });
    }

    results.sort((a, b) => b.change_pct - a.change_pct);
    res.json(results);
  } catch (e) {
    console.error('[OscillatorScreener] error:', e);
    res.status(500).json({ error: 'oscillator_screener_failed' });
  }
});

app.get('/api/volume-surge-today', (req, res) => {
  res.json([...volumeSurgeToday]);
});

// === 大单监控筛选器 API ===
app.get('/api/screener-large-orders', (req, res) => {
  try {
    const minVol = Number(req.query.min_vol || 0);
    const maxVol = Number(req.query.max_vol || 0);

    const result = {};
    for (const [symbol, ob] of orderBookCache) {
      // 量区间过滤：任意档位满足条件即保留该 symbol
      if (minVol || maxVol) {
        let hasMatch = false;
        for (const s of ['bid', 'ask']) {
          for (const data of Object.values(ob[s])) {
            const v = data.vol;
            if (minVol && v < minVol) continue;
            if (maxVol && v > maxVol) continue;
            hasMatch = true;
            break;
          }
          if (hasMatch) break;
        }
        if (!hasMatch) continue;
      }

      result[symbol] = {
        bid: Object.fromEntries(
          Object.entries(ob.bid).map(([lv, d]) => [lv, { price: d.price, vol: d.vol, time: ob.receivedAt }])
        ),
        ask: Object.fromEntries(
          Object.entries(ob.ask).map(([lv, d]) => [lv, { price: d.price, vol: d.vol, time: ob.receivedAt }])
        ),
        receivedAt: ob.receivedAt,
      };
    }

    res.json(result);
  } catch (e) {
    console.error('[screener-large-orders] error:', e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


// === 稳定选股器大单 API（基于 l2_alert_history_bl，最近10分钟每档最新记录）===
// 返回结构与 /api/screener-large-orders 完全相同，供 screener.html 直接替换使用
// { symbol: { bid: { 1: {price,vol,time}, 2:..., 3:... }, ask: {...} } }
app.get('/api/screener-large-orders-v2', async (req, res) => {
  try {
    const minVol = Number(req.query.min_vol || 0);
    const maxVol = Number(req.query.max_vol || 0);

    // 取最近10分钟，L1~L3，每个 symbol × side × level 取最新一条
    const { rows } = await pricePool.query(`
      SELECT DISTINCT ON (stock_code, alert_type, level)
        stock_code,
        alert_type,
        level,
        price::numeric   AS price,
        volume::numeric  AS vol,
        created_at       AS time
      FROM market_data.l2_alert_history_bl
      WHERE created_at >= NOW() - INTERVAL '10 minutes'
        AND level BETWEEN 1 AND 3
      ORDER BY stock_code, alert_type, level, created_at DESC
    `);

    // 聚合成 { symbol -> { bid: {1:...,2:...,3:...}, ask: {...} } }
    const result = {};
    for (const row of rows) {
      const sym  = row.stock_code;
      const side = row.alert_type;   // 'bid' | 'ask'
      const lv   = Number(row.level);
      const vol  = Number(row.vol);

      // 量区间过滤（在档位层面判断）
      if (minVol && vol < minVol) continue;
      if (maxVol && vol > maxVol) continue;

      if (!result[sym])              result[sym] = { bid: {}, ask: {} };
      if (!result[sym][side])        result[sym][side] = {};

      result[sym][side][lv] = {
        price: Number(row.price),
        vol,
        time: row.time,
      };
    }

    res.json(result);
  } catch (e) {
    console.error('[screener-large-orders-v2] error:', e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// /api/large-orders-screener 已停用（large-orders.html 页面不再使用）

// === 山丘形放量查询 API ===
app.get('/api/patterns/flexible-hills', async (req, res) => {
  try {
    const dateQuery = req.query.date;
    const result = await getFlexibleHills(pool, dateQuery);
    res.json(result);
  } catch (e) {
    console.error('flexible-hills query failed:', e);
    res.status(500).json({ error: 'query failed' });
  }
});

// === K Hill Alerts 查询 API ===
app.get('/api/hill-alerts', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 100);
    const minRatio = Number(req.query.min_ratio || 0);

    const sql = `
      SELECT id, symbol, bucket_time, volume, baseline_volume, breakout_ratio, hill_data, created_at
      FROM k_hill_alerts
      WHERE breakout_ratio >= $1
      ORDER BY bucket_time DESC
      LIMIT $2
    `;

    const { rows } = await pool.query(sql, [minRatio, limit]);
    res.json(rows);
  } catch (e) {
    console.error('hill-alerts query failed:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Alert monitoring configuration
const ALERT_THRESHOLD_PCT = Number(process.env.ALERT_THRESHOLD_PCT || 0.01);
const VOLUME_RATIO_THRESHOLD = Number(process.env.VOLUME_RATIO_THRESHOLD || 1.5);
const VOLUME_SCAN_INTERVAL = Number(process.env.VOLUME_SCAN_INTERVAL || 300000);
const VOLUME_HISTORY_DAYS = Number(process.env.VOLUME_HISTORY_DAYS || 20);
const VOLUME_Z_THRESHOLD = Number(process.env.VOLUME_Z_THRESHOLD || 2.0);

const MARKET_OPEN_MINS = 8 * 60;
const MARKET_CLOSE_MINS = 16 * 60;
const TOTAL_MARKET_MINS = MARKET_CLOSE_MINS - MARKET_OPEN_MINS;

function getMarketElapsedPct() {
  // BL 市场为北京时间，交易时段 08:00-16:00（MARKET_OPEN_MINS=480, CLOSE=960）
  const nowBJ = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const mins = nowBJ.getHours() * 60 + nowBJ.getMinutes();
  if (mins <= MARKET_OPEN_MINS) return 0;
  if (mins >= MARKET_CLOSE_MINS) return 1.0;
  return (mins - MARKET_OPEN_MINS) / TOTAL_MARKET_MINS;
}

const isValidDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);

app.post('/api/volume/daily-refresh', async (req, res) => {
  const start = String(req.query.start || '').trim();
  const end = String(req.query.end || '').trim();

  if (!isValidDate(start) || !isValidDate(end)) {
    return res.status(400).json({ error: 'invalid_date_format', message: 'Use YYYY-MM-DD' });
  }

  try {
    const sql = `
      INSERT INTO tos_daily_volume(symbol, trade_date, daily_volume, updated_at)
      SELECT symbol,
             DATE(CASE
                    WHEN trim(trade_time) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN trim(trade_time)::timestamp
                    ELSE created_at
                  END) AS trade_date,
             SUM(size) AS daily_volume,
             now()
      FROM tos_trades
      WHERE DATE(CASE
                   WHEN trim(trade_time) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN trim(trade_time)::timestamp
                   ELSE created_at
                 END) >= $1::date AND DATE(CASE
                   WHEN trim(trade_time) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN trim(trade_time)::timestamp
                   ELSE created_at
                 END) <= $2::date
      GROUP BY symbol, trade_date
      ON CONFLICT (symbol, trade_date)
      DO UPDATE SET daily_volume = EXCLUDED.daily_volume, updated_at = now();`;

    await pool.query(sql, [start, end]);
    res.json({ ok: true, start, end, timestamp: new Date() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

app.get('/api/volume/summary', async (req, res) => {
  const start = String(req.query.start || '').trim();
  const end = String(req.query.end || '').trim();
  const order = String(req.query.order || 'total').trim();
  const format = String(req.query.format || 'json').trim();
  const limit = parseInt(req.query.limit, 10) || 0;
  const minVolume = parseFloat(req.query.min_volume) || 0;

  if (!isValidDate(start) || !isValidDate(end)) {
    return res.status(400).json({ error: 'invalid_date_format' });
  }

  const orderBy = order === 'avg' ? 'avg_volume' : 'total_volume';

  let sql = `
    SELECT symbol,
           SUM(daily_volume) AS total_volume,
           ROUND(AVG(daily_volume), 2) AS avg_volume
    FROM tos_daily_volume
    WHERE trade_date >= $1::date AND trade_date <= $2::date
    GROUP BY symbol
    HAVING SUM(daily_volume) >= $3
    ORDER BY ${orderBy} DESC`;
  const params = [start, end, minVolume];
  if (limit > 0) {
    sql += ` LIMIT $${params.length + 1}`;
    params.push(limit);
  }
  sql += ';';

  const { rows } = await pool.query(sql, params);

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="volume_summary.csv"');
    const header = 'symbol,total_volume,avg_volume\n';
    const body = rows.map(r => `${r.symbol},${r.total_volume},${r.avg_volume}`).join('\n');
    return res.send(header + body);
  }

  return res.json(rows);
});

app.get('/api/volume/avg-daily', async (req, res) => {
  const symbol = String(req.query.symbol || '').trim();
  const start = String(req.query.start || '').trim();
  const end = String(req.query.end || '').trim();

  if (!symbol || !isValidDate(start) || !isValidDate(end)) return res.status(400).json({ error: 'invalid_params' });

  const sql = `
    SELECT COALESCE(AVG(daily_volume), 0) AS avg_daily_vol
    FROM tos_daily_volume
    WHERE symbol = $1 AND trade_date >= $2::date AND trade_date < $3::date;`;

  const { rows } = await pool.query(sql, [symbol, start, end]);
  res.json(rows[0]);
});

app.get('/api/volume/cumulative', async (req, res) => {
  const symbol = String(req.query.symbol || '').trim();
  const date = String(req.query.date || '').trim();

  if (!symbol || !isValidDate(date)) return res.status(400).json({ error: 'invalid_params' });

  const sql = `
    SELECT COALESCE(SUM(size), 0) AS cumulative_vol
    FROM tos_trades
    WHERE symbol = $1 AND (
      (trim(trade_time) ~ '^\\d{4}-\\d{2}-\\d{2}' AND trim(trade_time)::timestamp >= $2::timestamp AND trim(trade_time)::timestamp < ($2::date + INTERVAL '1 day'))
      OR
      (trim(trade_time) !~ '^\\d{4}-\\d{2}-\\d{2}' AND created_at >= $2::date AND created_at < ($2::date + INTERVAL '1 day'))
    );`;

  const { rows } = await pool.query(sql, [symbol, date]);
  res.json(rows[0]);
});

app.get('/api/volume/daily-series', async (req, res) => {
  const symbol = String(req.query.symbol || '').trim();
  const start = String(req.query.start || '').trim();
  const end = String(req.query.end || '').trim();

  if (!symbol || !isValidDate(start) || !isValidDate(end)) {
    return res.status(400).json({ error: 'invalid_params' });
  }

  const sql = `
    SELECT trade_date::text AS trade_date, total_volume
    FROM daily_summary
    WHERE symbol = $1 AND trade_date BETWEEN $2::date AND $3::date
    ORDER BY trade_date ASC`;

  const { rows } = await pool.query(sql, [symbol, start, end]);
  res.json(rows);
});

app.get('/api/volume/market-daily', async (req, res) => {
  const start = String(req.query.start || '').trim();
  const end = String(req.query.end || '').trim();

  if (!isValidDate(start) || !isValidDate(end)) {
    return res.status(400).json({ error: 'invalid_params' });
  }

  const sql = `
    SELECT trade_date::text AS trade_date,
           SUM(total_volume)::numeric AS total_volume,
           COUNT(DISTINCT symbol)::int AS stock_count
    FROM daily_summary
    WHERE trade_date BETWEEN $1::date AND $2::date
    GROUP BY trade_date
    ORDER BY trade_date ASC`;

  const { rows } = await pool.query(sql, [start, end]);
  res.json(rows);
});

app.post('/api/alerts/daily-volume-pct/scan', async (req, res) => {
  const { symbol, date, start, end, threshold } = req.query;

  if (!symbol || !isValidDate(date) || !isValidDate(start) || !isValidDate(end) || !threshold) {
    return res.status(400).json({ error: 'params_missing_or_invalid' });
  }

  const avgRes = await pool.query(
    `SELECT COALESCE(AVG(daily_volume), 0) AS avg FROM tos_daily_volume
     WHERE symbol = $1 AND trade_date >= $2::date AND trade_date < $3::date`,
    [symbol, start, end]
  );
  const avg = Number(avgRes.rows[0].avg || 0);

  const cumRes = await pool.query(
    `SELECT COALESCE(SUM(size), 0) AS val, date_trunc('minute', now()) as now_bucket
     FROM tos_trades
     WHERE symbol = $1 AND (
       (trim(trade_time) ~ '^\\d{4}-\\d{2}-\\d{2}' AND trim(trade_time)::timestamp >= $2::timestamp AND trim(trade_time)::timestamp < ($2::date + INTERVAL '1 day'))
       OR
       (trim(trade_time) !~ '^\\d{4}-\\d{2}-\\d{2}' AND created_at >= $2::date AND created_at < ($2::date + INTERVAL '1 day'))
     )`,
    [symbol, date]
  );
  const cum = Number(cumRes.rows[0].val || 0);

  const pct = avg > 0 ? cum / avg : 0;
  if (pct < Number(threshold)) {
    return res.json({ triggered: false, pct, cum, avg });
  }

  const insertSql = `
    INSERT INTO k_volume_alerts(symbol, bucket, volume_ratio, current_cum_vol, avg_daily_vol)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (symbol, bucket) DO NOTHING
    RETURNING id;`;

  const tx = await pool.query(insertSql, [symbol, cumRes.rows[0].now_bucket, pct, cum, avg]);
  res.json({ triggered: tx.rowCount > 0, pct, bucket: cumRes.rows[0].now_bucket });
});

app.get('/api/volume-alerts-data', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const sql = `
      SELECT symbol, bucket, volume_ratio, current_cum_vol, avg_daily_vol, rule_id, created_at
      FROM k_volume_alerts
      ORDER BY created_at DESC
      LIMIT $1
    `;
    const { rows } = await pool.query(sql, [limit]);
    res.json(rows);
  } catch (e) {
    console.error('volume alerts query failed:', e);
    res.status(500).json({ error: 'query failed' });
  }
});

async function scanAndInsertAlerts() {
  try {
    const sql = `
      WITH params AS (
        SELECT
          date_trunc('minute', (now() AT TIME ZONE 'Asia/Shanghai')) AS cur_bucket_local,
          date_trunc('minute', (now() AT TIME ZONE 'Asia/Shanghai')) - INTERVAL '1 minute' AS prev_bucket_local,
          (now() AT TIME ZONE 'Asia/Shanghai')::date AS target_date
      ),
      minute_trades AS (
        SELECT
          t.symbol,
          (t.received_at AT TIME ZONE 'Asia/Shanghai') AS ts_local,
          t.price::numeric AS price,
          date_trunc('minute', (t.received_at AT TIME ZONE 'Asia/Shanghai')) AS bucket_local
        FROM tos_trades t
        WHERE t.price IS NOT NULL AND t.price::numeric > 0
          AND COALESCE(t.size::numeric, 0) > 0
          AND t.received_at >= ((SELECT prev_bucket_local FROM params) AT TIME ZONE 'Asia/Shanghai')
          AND t.received_at < ((SELECT cur_bucket_local FROM params) AT TIME ZONE 'Asia/Shanghai' + INTERVAL '1 minute')
      ),
      agg AS (
        SELECT symbol, bucket_local AS bucket,
               MAX(price) AS high,
               MIN(price) AS low
        FROM minute_trades
        GROUP BY symbol, bucket_local
      ),
      open_close AS (
        SELECT a.symbol, a.bucket,
               (SELECT mt.price FROM minute_trades mt WHERE mt.symbol = a.symbol AND mt.bucket_local = a.bucket ORDER BY mt.ts_local ASC LIMIT 1) AS open,
               (SELECT mt.price FROM minute_trades mt WHERE mt.symbol = a.symbol AND mt.bucket_local = a.bucket ORDER BY mt.ts_local DESC LIMIT 1) AS close,
               a.high, a.low
        FROM agg a
      ),
      alerts AS (
        SELECT symbol,
               (bucket AT TIME ZONE 'Asia/Shanghai') AS bucket_tz,
               open, high, low, close,
               CASE WHEN open > 0 THEN (high - low) / open ELSE 0 END AS amplitude_pct,
               CASE WHEN close > open THEN 1 WHEN close < open THEN -1 ELSE 0 END AS direction
        FROM open_close
        WHERE open IS NOT NULL AND high IS NOT NULL AND low IS NOT NULL AND close IS NOT NULL
      )
      INSERT INTO k_alerts(symbol, bucket, open, high, low, close, amplitude_pct, direction, rule_id, created_at)
      SELECT symbol, bucket_tz, open, high, low, close, amplitude_pct, direction, 'amplitude_1pct', now()
      FROM alerts
      WHERE amplitude_pct >= $1
      ON CONFLICT (symbol, bucket, rule_id) DO NOTHING
      RETURNING symbol, bucket, amplitude_pct, direction;
    `;

    const { rows } = await pool.query(sql, [ALERT_THRESHOLD_PCT]);
    if (rows.length > 0) {
      console.log('Inserted alerts:', rows.length);
    }
  } catch (e) {
    console.error('scanAndInsertAlerts error:', e.message);
  }
}

let lastVolumeScanAt = null;
let volumeSchemaReady = false;

async function ensureVolumeAlertSchema() {
  if (volumeSchemaReady) return;
  await pool.query(`ALTER TABLE k_volume_alerts ADD COLUMN IF NOT EXISTS rule_id TEXT NOT NULL DEFAULT 'volume_surge'`);
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_vol_alerts_symbol_bucket') THEN
        ALTER TABLE k_volume_alerts DROP CONSTRAINT uq_vol_alerts_symbol_bucket;
        ALTER TABLE k_volume_alerts ADD CONSTRAINT uq_vol_alerts_symbol_bucket_rule
          UNIQUE (symbol, bucket, rule_id);
      END IF;
    END $$
  `);

  await pool.query(`
    INSERT INTO app_settings (key, value, value_type, description)
    VALUES ('time_checkpoints',
            '[{"elapsed_minutes": 120, "expected_pct": 0.30, "label": "开市2小时"}, {"elapsed_minutes": 180, "expected_pct": 0.50, "label": "开市3小时"}, {"elapsed_minutes": 240, "expected_pct": 0.75, "label": "收盘前"}]',
            'json',
            'Time checkpoints for volume alerts')
    ON CONFLICT (key) DO NOTHING
  `);

  volumeSchemaReady = true;
}

// initOpenPrice：每60秒定期补写，持续覆盖当日 open_price IS NULL 的行
// 数据源：tos_trades 当日 08:00 至今的第一笔成交（全天范围，覆盖盘中新股）
// 只更新 open_price IS NULL 的行，已有开盘价的行不覆盖
// 无 openPriceDone 限制，新股上市后下一个60秒自动补写
let _openPriceRunning = false;
async function initOpenPrice() {
  // [DISABLED] 按要求禁用，此函数不再执行写库操作
  return;
  if (_openPriceRunning) return;
  const nowBeijing = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  if (nowBeijing.getHours() * 60 + nowBeijing.getMinutes() < 8 * 60) return;
  _openPriceRunning = true;
  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 30000');
    const r = await client.query(`
      UPDATE market_data.daily_summary ds
      SET open_price = correct.open_price
      FROM (
        SELECT symbol,
          (array_agg(price::numeric ORDER BY received_at ASC, id ASC))[1] AS open_price
        FROM market_data.tos_trades
        WHERE received_at >= current_date AT TIME ZONE 'Asia/Shanghai' + interval '8 hours'
          AND received_at <  current_date AT TIME ZONE 'Asia/Shanghai' + interval '9 hours'
          AND price IS NOT NULL AND price::numeric > 0
        GROUP BY symbol
      ) correct
      WHERE ds.symbol     = correct.symbol
        AND ds.trade_date = current_date
        AND ds.open_price IS NULL
    `);
    if (r.rowCount > 0) {
      console.log(`[OpenPrice] patched ${r.rowCount} new symbols`);
    }
  } catch (err) {
    console.warn('[OpenPrice] failed:', err.message);
  } finally {
    await client.query('SET statement_timeout = 0').catch(() => {});
    client.release();
    _openPriceRunning = false;
  }
}


// updateDailySummary 增量模式
// 原全天汇总模式（FIX 6/H/I/J/K/L）改为增量更新，彻底避免全天重算：
//
// Step 1（每次执行）：只扫 lastDailySummaryRunAt 之后的新成交（60s窗口），
//   close/high/low/volume 用 GREATEST/LEAST/累加合并到已有行，open_price 传 NULL 跳过。
//
// Step 2（仅在必要时执行）：open_price 补写/自纠错
//   - openPriceDone = false（首次或纠错触发）时才执行，写完后置 true，此后跳过
//   - DISTINCT ON 取当日最早一笔，不再 array_agg 全量排序
//   - FIX H：已写入则不覆盖；FIX L：偏差 >20% 允许纠正
//
// FIX K 保留：08:00 前跳过
// FIX I 保留：过滤补推历史单

let lastDailySummaryRunAt = null;  // 增量扫描起点
// openPriceDone 已移除：initOpenPrice 改为定期补写，无需一次性标志

async function updateDailySummary() {
  // [DISABLED] 按要求禁用，此函数不再执行写库操作
  return;
  // [FIX K] 非交易时段不写入
  const nowBeijing = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const beijingMins = nowBeijing.getHours() * 60 + nowBeijing.getMinutes();
  if (beijingMins < 8 * 60) return;

  // 正确取北京时间日期字符串（直接格式化，不用 toISOString 避免 UTC 偏差）
  const yy  = nowBeijing.getFullYear();
  const mm  = String(nowBeijing.getMonth() + 1).padStart(2, '0');
  const dd  = String(nowBeijing.getDate()).padStart(2, '0');
  const todayStr = `${yy}-${mm}-${dd}`;

  // 跨天兜底重置
  if (updateDailySummary._lastDate !== todayStr) {
    updateDailySummary._lastDate = todayStr;
    lastDailySummaryRunAt = null;
    // openPriceDone 已移除，initOpenPrice 定期补写无需重置
  }

  // 增量起点保留用于记录上次执行时间（Step 2 open_price 纠错时仍有参考意义）
  const scanTo = new Date().toISOString();

  const client = await pool.connect();
  try {
    // ── Step 1：从 tos_trades 增量聚合 upsert（close/high/low）─────────────────
    // 冷启动（lastDailySummaryRunAt=null）：全量补算当日 08:00 HKT（UTC 00:00）至今
    // 正常增量：只扫 lastDailySummaryRunAt 之后的新成交，数据量约 3000-4000 条/分钟
    // 时段限制：UTC 00:00-09:00（北京时间 08:00-17:00），彻底隔离盘前盘后极值
    // open_price 不在此处处理，由 initOpenPrice() 独立负责
    const todayUtcStart = new Date(`${todayStr}T00:00:00Z`);  // 北京 08:00 = UTC 00:00
    const todayUtcEnd   = new Date(`${todayStr}T09:00:00Z`);  // 北京 17:00 = UTC 09:00
    const scanFrom = lastDailySummaryRunAt ? new Date(lastDailySummaryRunAt) : todayUtcStart;

    if (scanFrom < todayUtcEnd) {  // 17:00 后无需再扫
      // 冷启动（全天全量）给 600s，正常增量（60s窗口）给 30s
      const timeout = lastDailySummaryRunAt ? 30000 : 600000;
      await client.query(`SET statement_timeout = ${timeout}`);
      const result = await client.query(`
        INSERT INTO market_data.daily_summary
          (symbol, trade_date, close_price, high_price, low_price)
        SELECT
          symbol,
          $3::date                                                           AS trade_date,
          (array_agg(price::numeric ORDER BY received_at DESC, id DESC))[1] AS close_price,
          MAX(price::numeric)                                                AS high_price,
          MIN(price::numeric)                                                AS low_price
        FROM market_data.tos_trades
        WHERE received_at >= $1::timestamptz
          AND received_at <  $2::timestamptz
          AND received_at <  $4::timestamptz
          AND price > 0
        GROUP BY symbol
        ON CONFLICT (symbol, trade_date) DO UPDATE SET
          close_price = COALESCE(EXCLUDED.close_price, daily_summary.close_price),
          high_price  = GREATEST(daily_summary.high_price,  EXCLUDED.high_price),
          low_price   = LEAST(daily_summary.low_price,       EXCLUDED.low_price)
          -- open_price  由 initOpenPrice() 负责，此处不更新
          -- total_volume 由 orderbook_processor_bl.py 负责，此处不更新
      `, [
        scanFrom,      // $1 增量起点（冷启动=当日UTC 00:00，正常=上次执行时间）
        scanTo,        // $2 增量终点（当前时间）
        todayStr,      // $3 trade_date
        todayUtcEnd,   // $4 时段上限（UTC 09:00 = 北京 17:00）
      ]);
      const mode = lastDailySummaryRunAt ? 'incremental' : 'cold-start';
      console.log(`[DailySummary] Step1 ${mode}: ${result.rowCount} rows upserted`);
    }

    // Step 1 成功后立即推进时间戳
    lastDailySummaryRunAt = scanTo;


    // Step 2（open_price）已独立为 initOpenPrice()，启动时异步执行，此处跳过



  } catch (err) {
    console.error('[DailySummary] Update failed:', err.message);
    // Step 1 成功则 lastDailySummaryRunAt 已推进；Step 2 失败不影响增量窗口
  } finally {
    await client.query('SET statement_timeout = 0').catch(() => {});
    client.release();
  }
}

async function scanAllVolumeAlerts() {
  await ensureVolumeAlertSchema();

  const VOLUME_HISTORY_DAYS = await config.get('volume_history_days', 20);
  console.log(`[VolumeMonitor] Running scan with history=${VOLUME_HISTORY_DAYS}d`);

  let timeCheckpoints = await config.get('time_checkpoints', []);
  if (!Array.isArray(timeCheckpoints)) {
    console.warn('[VolumeMonitor] time_checkpoints is not an array, using defaults');
    timeCheckpoints = [
      { elapsed_minutes: 120, expected_pct: 0.30, label: "开市2小时" },
      { elapsed_minutes: 180, expected_pct: 0.50, label: "开市3小时" },
      { elapsed_minutes: 240, expected_pct: 0.75, label: "收盘前" }
    ];
  }

  const today = new Date().toISOString().split('T')[0];
  const scanTs = new Date().toISOString();

  if (!lastVolumeScanAt) {
    await pool.query(`
      INSERT INTO tos_daily_volume(symbol, trade_date, daily_volume, updated_at)
      SELECT symbol, DATE(received_at), SUM(size), now()
      FROM tos_trades
      WHERE received_at >= $1::date AND received_at < ($1::date + INTERVAL '1 day')
      GROUP BY symbol, DATE(received_at)
      ON CONFLICT (symbol, trade_date)
      DO UPDATE SET daily_volume = EXCLUDED.daily_volume, updated_at = now()
    `, [today]);
    console.log('[VolumeMonitor] Full refresh');
  } else {
    await pool.query(`
      INSERT INTO tos_daily_volume(symbol, trade_date, daily_volume, updated_at)
      SELECT symbol, DATE(received_at), SUM(size), now()
      FROM tos_trades
      WHERE received_at > $1::timestamptz
        AND received_at < $2::timestamptz
        AND DATE(received_at) = $3::date
      GROUP BY symbol, DATE(received_at)
      ON CONFLICT (symbol, trade_date)
      DO UPDATE SET daily_volume = tos_daily_volume.daily_volume + EXCLUDED.daily_volume,
                    updated_at = now()
    `, [lastVolumeScanAt, scanTs, today]);
  }
  lastVolumeScanAt = scanTs;

  const now = new Date();
  const nowBeijing = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));

  const day = nowBeijing.getDay();
  if (day === 0 || day === 6) {
    console.log('[VolumeMonitor] Weekend detected but continuing for testing/verification purposes.');
  }

  const currentMins = nowBeijing.getHours() * 60 + nowBeijing.getMinutes();
  const elapsedMinutes = currentMins - MARKET_OPEN_MINS;

  console.log(`[VolumeMonitor] Beijing Time: ${nowBeijing.toLocaleTimeString()}, elapsedMinutes=${elapsedMinutes}`);
  if (elapsedMinutes <= 0) return;

  let totalTriggered = 0;

  for (const cp of timeCheckpoints) {
    if (elapsedMinutes < cp.elapsed_minutes) continue;

    const ruleId = `checkpoint_${cp.elapsed_minutes}min_${Math.round(cp.expected_pct * 100)}pct`;

    try {
      // 先查出需要触发的 symbol 列表，再分批 INSERT，避免单事务锁占数百秒
      const selectSql = `
        WITH hist_ranked AS (
          SELECT symbol,
                 daily_volume,
                 PERCENT_RANK() OVER (PARTITION BY symbol ORDER BY daily_volume) AS pct_rank,
                 COUNT(*) OVER (PARTITION BY symbol) AS total_days
          FROM tos_daily_volume
          WHERE trade_date >= ($1::date - $2 * INTERVAL '1 day')
            AND trade_date < $1::date
        ),
        hist AS (
          SELECT symbol,
                 AVG(daily_volume) AS avg_vol
          FROM hist_ranked
          WHERE total_days >= 1
            AND pct_rank >= 0.1 AND pct_rank <= 0.9
          GROUP BY symbol
        ),
        today_vol AS (
          SELECT symbol, daily_volume AS cum_vol
          FROM tos_daily_volume
          WHERE trade_date = $1::date
        )
        SELECT t.symbol,
               t.cum_vol / NULLIF(h.avg_vol, 0) AS volume_ratio,
               t.cum_vol,
               ROUND(h.avg_vol, 2) AS avg_vol
        FROM today_vol t
        JOIN hist h USING (symbol)
        WHERE h.avg_vol > 0
          AND (t.cum_vol / NULLIF(h.avg_vol, 0)) >= $3::numeric
      `;

      const candidates = await pool.query(selectSql, [today, VOLUME_HISTORY_DAYS, cp.expected_pct]);

      if (candidates.rowCount === 0) continue;

      // 分批 INSERT，每批100条，避免单次大事务
      const BATCH_SIZE = 100;
      let triggered = 0;
      for (let i = 0; i < candidates.rows.length; i += BATCH_SIZE) {
        const batch = candidates.rows.slice(i, i + BATCH_SIZE);
        const values = batch.map((_, j) => {
          const base = j * 5;
          return `($${base+1}, $${base+2}::date::timestamp, $${base+3}, $${base+4}, $${base+5}, '${ruleId}', now())`;
        }).join(',');
        const params = batch.flatMap(r => [r.symbol, today, r.volume_ratio, r.cum_vol, r.avg_vol]);
        const insertSql = `
          INSERT INTO k_volume_alerts
            (symbol, bucket, volume_ratio, current_cum_vol, avg_daily_vol, rule_id, created_at)
          VALUES ${values}
          ON CONFLICT (symbol, bucket, rule_id) DO NOTHING
        `;
        const batchRes = await pool.query(insertSql, params);
        triggered += batchRes.rowCount;
      }

      totalTriggered += triggered;
      if (triggered > 0) {
        console.log(`[VolumeMonitor] Checkpoint ${cp.label} (${ruleId}) triggered for ${triggered} symbols`);
      }
    } catch (err) {
      console.error(`[VolumeMonitor] Error checking checkpoint ${cp.label}:`, err);
    }
  }

  if (totalTriggered > 0) {
    console.log(`[VolumeMonitor] Total alerts triggered: ${totalTriggered}`);
  }
}

// ── 分时放量监控 ──────────────────────────────────────────────────────────────

// 当日已触发量异常的 symbol（内存 Set，进程重启时从 DB 恢复）
const volumeSurgeToday = new Set();

async function loadVolumeSurgeFromDB() {
  try {
    const { rows } = await pool.query(`
      SELECT symbol FROM intraday_volume_surge
      WHERE trade_date = current_date
    `);
    rows.forEach(r => volumeSurgeToday.add(r.symbol));
    console.log(`[VolumeSurge] Loaded ${volumeSurgeToday.size} symbols from DB`);
  } catch (e) {
    console.error('[VolumeSurge] loadFromDB error:', e.message);
  }
}

async function scanIntradayVolumeSurge() {
  const SURGE_WINDOW  = Number(process.env.INTRADAY_SURGE_WINDOW  || 30);  // 分钟
  const SURGE_RATIO   = Number(process.env.INTRADAY_SURGE_RATIO   || 3);   // 倍数
  const SURGE_HISTORY = Number(process.env.INTRADAY_SURGE_HISTORY || 10);  // 历史天数

  try {
    const { rows } = await pool.query(`
      WITH window_vol AS (
        SELECT t.symbol, SUM(t.size) AS vol
        FROM market_data.tos_trades t
        INNER JOIN market_data.daily_summary ds
          ON ds.symbol = t.symbol AND ds.trade_date = current_date
        WHERE t.received_at >= NOW() - ($1 * INTERVAL '1 minute')
        GROUP BY t.symbol
      ),
      hist_avg AS (
        SELECT symbol, AVG(daily_volume) AS avg_vol
        FROM tos_daily_volume
        WHERE trade_date >= current_date - CAST($2 AS INTEGER)
          AND trade_date < current_date
        GROUP BY symbol
        HAVING COUNT(*) >= 3
      )
      INSERT INTO intraday_volume_surge
        (symbol, trade_date, bucket_time, window_vol, avg_daily_vol, vol_ratio)
      SELECT
        w.symbol,
        current_date,
        date_trunc('minute', NOW()),
        w.vol,
        ROUND(h.avg_vol, 2),
        ROUND(w.vol / h.avg_vol, 2)
      FROM window_vol w
      JOIN hist_avg h USING (symbol)
      WHERE w.vol / h.avg_vol >= $3
      ON CONFLICT (symbol, trade_date) DO NOTHING
      RETURNING symbol, vol_ratio
    `, [SURGE_WINDOW, SURGE_HISTORY, SURGE_RATIO]);

    if (rows.length > 0) {
      rows.forEach(r => volumeSurgeToday.add(r.symbol));
      console.log(`[VolumeSurge] ${rows.length} new surge(s): ${rows.map(r => `${r.symbol}(${r.vol_ratio}x)`).join(', ')}`);
    }
  } catch (e) {
    console.error('[VolumeSurge] scan error:', e.message);
  }
}

// [FIX 7] HillMonitor 间隔 300s
const HILL_SCAN_INTERVAL = Number(process.env.HILL_SCAN_INTERVAL || 300000);

async function scanAndInsertHillAlerts() {
  try {
    const result = await getFlexibleHills(pool);
    if (!result || !result.data || result.data.length === 0) {
      console.log(`[HillMonitor] No hills detected (date: ${result && result.date ? new Date(result.date).toISOString().slice(0, 10) : 'unknown'}, count: ${result ? result.count : 0})`);
      return;
    }

    const insertSql = `
      INSERT INTO k_hill_alerts(symbol, bucket_time, volume, baseline_volume, breakout_ratio, hill_data)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (symbol, bucket_time) DO NOTHING
      RETURNING id;
    `;

    let inserted = 0;
    for (const item of result.data) {
      const hillDataJson = item.shape.map((v, i) => ({
        t: i === 0 ? item.startTime : (i === item.shape.length - 1 ? item.endTime : null),
        v
      }));
      const res = await pool.query(insertSql, [
        item.symbol,
        item.peakTime,
        item.peakVol,
        item.baseline,
        item.ratio,
        JSON.stringify(hillDataJson)
      ]);
      if (res.rowCount > 0) inserted++;
    }

    if (inserted > 0) {
      console.log(`[HillMonitor] Inserted ${inserted} hill alerts (date: ${new Date(result.date).toISOString().slice(0, 10)})`);
    }
  } catch (e) {
    console.error('[HillMonitor] Error:', e.message);
  }
}

function startAlertMonitor() {
  const runScan = async (name, fn, interval) => {
    while (true) {
      const start = Date.now();
      try {
        await fn();
      } catch (e) {
        console.error(`[${name}] Error:`, e.message);
      }
      const duration = Date.now() - start;
      if (duration > 1000) {
        console.log(`[${name}] Finished in ${duration}ms`);
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  };

  // ── 启动顺序说明（优化版：并行冷启动）────────────────────────────────────
  // 关键改动：
  //  1. warmUpPriceCache、initQuoteCache、updateWindow10m、updateWindow30m 并行执行
  //  2. RankingCache 不再等待 warmUpPriceCache 完成，立即启动（使用 ohlc_snapshot/last_price 数据）
  //  3. QuoteCache 不再延迟15s，与其他冷启动任务同时执行
  //  4. Window30m 不再延迟5s，直接并行
  //  总启动时间从 ~60s 降至 ~15-20s（取决于最慢的单个查询）
  // ──────────────────────────────────────────────────────────────────────────

  // ── 并行冷启动：所有重型预热查询同时执行 ─────────────────────────────────
  console.log(`[ColdStart] Parallel warm-up starting...`);
  const coldStartTime = Date.now();

  Promise.all([
    warmUpPriceCache().then(() => console.log(`[ColdStart] PriceCache done in ${Date.now() - coldStartTime}ms`)),
    initQuoteCache().then(() => console.log(`[ColdStart] QuoteCache done in ${Date.now() - coldStartTime}ms`)),
    updateWindow10m().then(() => console.log(`[ColdStart] Window10m done in ${Date.now() - coldStartTime}ms`)),
    updateWindow30m().then(() => console.log(`[ColdStart] Window30m done in ${Date.now() - coldStartTime}ms`)),
    refreshRankingCache().then(() => console.log(`[ColdStart] RankingCache done in ${Date.now() - coldStartTime}ms`)),
    updatePrice30mCache().then(() => console.log(`[ColdStart] Price30mCache done in ${Date.now() - coldStartTime}ms`)),
  ]).then(() => {
    serverReady = true;
    console.log(`[ColdStart] All warm-up complete in ${Date.now() - coldStartTime}ms — server ready`);
  }).catch(err => {
    // 即使部分失败也标记就绪，让增量更新接管
    serverReady = true;
    console.error(`[ColdStart] Warm-up had errors (non-fatal):`, err.message);
  });

  // ── 循环任务：冷启动后立即开始周期性刷新 ─────────────────────────────────
  console.log(`[ALERT monitor] starting, interval=30000ms, threshold=${(ALERT_THRESHOLD_PCT * 100).toFixed(1)}%`);
  runScan('PriceMonitor', scanAndInsertAlerts, 30000);

  console.log(`[PriceWindow] starting, interval=10s`);
  runScan('PriceCache', updatePriceCache, 10000);
  updatePriceWindow();
  runScan('PriceWindow', updatePriceWindow, 10000);

  // RankingCache：不再等待 warmUpPriceCache，首次已在并行冷启动中完成
  runScan('RankingCache', refreshRankingCache, 10000);

  console.log(`[Window10m] starting, interval=10s`);
  runScan('Window10m', updateWindow10m, 10000);

  console.log(`[Window30m] starting, interval=10s`);
  runScan('Window30m', updateWindow30m, 10000);

  console.log(`[Price30mCache] starting, interval=60s`);
  runScan('Price30mCache', updatePrice30mCache, 60000);

  console.log(`[QuoteCache] starting, interval=10s`);
  runScan('QuoteCache', updateQuoteCache, 10000);

  // ── t=12s：BoundaryAlerts（纯内存，10s，在 Window10m 首次刷新后执行）──────
  setTimeout(() => {
    console.log(`[BoundaryAlerts] starting, interval=10s`);
    scanBoundaryAlerts();
    runScan('BoundaryAlerts', scanBoundaryAlerts, 10000);
  }, 12000);

  // ── t=20s：OrderBookCache [DISABLED] ─────────────────────────────────────
  // /api/screener-large-orders（v1）无页面消费，v2已改用 l2_alert_history_bl 直查
  // _fetchOrderBook 每次超时15s+，持续占用 pricePool 连接拖慢其他任务，故停用
  // setTimeout(() => {
  //   warmUpOrderBookCache().then(() => {
  //     runScan('OrderBookCache', updateOrderBookCache, 10000);
  //   });
  // }, 20000);

  // ── t=0s：DailySummaryUpdater（主池，60s，最先启动）── [DISABLED] ─────────
  // 注：total_volume 已从此任务移除，仅负责 open/close/high/low 更新
  // console.log(`[DailySummaryUpdater] starting, interval=60s`);
  // runScan('DailySummaryUpdater', updateDailySummary, 60000);

  // ── OpenPrice：每60秒定期补写 open_price IS NULL 的行（主池）── [DISABLED] ──
  // 启动后立即执行一次，之后每60秒检查新股，有补写则打日志，无则静默
  // runScan('OpenPrice', initOpenPrice, 60000);

  // ── t=30s：IntradayAvgVol（主池，60s，延迟30s避开启动期高峰）────────────
  setTimeout(() => {
    console.log(`[IntradayAvgVol] starting, interval=60s`);
    refreshIntradayAvgVolCache();
    runScan('IntradayAvgVol', refreshIntradayAvgVolCache, 60000);

    runScan('DailyRangeCache', refreshDailyRangeCache, 60 * 60 * 1000);  // 启动立即执行，之后每小时刷新
  }, 30000);

  // ── t=45s：IntradayVolWriter [DISABLED] ────────────────────────────────
  // daily_intraday_vol 已改由 orderbook_processor_bl.py IntradayVolWriter 负责写入
  // setTimeout(() => {
  //   console.log(`[IntradayVolWriter] starting, interval=60s`);
  //   runScan('IntradayVolWriter', writeIntradayVolMinute, 60000);
  // }, 45000);

  // ── t=55s：StableSnapshot（主池，60s，在 Window10m 刷新后写入）────────────
  setTimeout(() => {
    console.log(`[StableSnapshot] starting, interval=60s`);
    runScan('StableSnapshot', writeStableSnapshot, 60000);
  }, 55000);

  // ── t=58s：BoundarySnapshot（主池，60s，边界预警历史快照）─────────────────
  setTimeout(() => {
    console.log(`[BoundarySnapshot] starting, interval=60s`);
    runScan('BoundarySnapshot', writeBoundarySnapshot, 60000);
  }, 58000);

  // ── t=15s：ScannerCache + ScannerPerfect（主池，30s/60s）────────────────
  setTimeout(() => {
    console.log(`[ScannerCache] starting, interval=30s`);
    runScan('ScannerCache', refreshScannerCache, 30000);
    console.log(`[ScannerPerfect] starting, interval=60s`);
    runScan('ScannerPerfect', refreshScannerPerfectCache, 60000);
  }, 15000);

  // ── t=0s：VolumeMonitor（主池，300s，立即启动）───────────────────────────
  console.log(`[VolumeMonitor] starting, interval=${VOLUME_SCAN_INTERVAL / 1000}s, ratio>=${VOLUME_RATIO_THRESHOLD}x OR z>=${VOLUME_Z_THRESHOLD}, default_history=${VOLUME_HISTORY_DAYS}d`);
  runScan('VolumeMonitor', scanAllVolumeAlerts, VOLUME_SCAN_INTERVAL);

  // ── t=60s：HillMonitor（主池，300s，延迟1分钟）───────────────────────────
  setTimeout(() => {
    console.log(`[HillMonitor] starting, interval=${HILL_SCAN_INTERVAL / 1000}s`);
    runScan('HillMonitor', scanAndInsertHillAlerts, HILL_SCAN_INTERVAL);
  }, 60000);

  // ── t=120s：VolumeSurge（主池，300s，延迟2分钟）──────────────────────────
  loadVolumeSurgeFromDB();
  const SURGE_SCAN_INTERVAL = Number(process.env.INTRADAY_SURGE_INTERVAL || 300000);
  setTimeout(() => {
    console.log(`[VolumeSurge] starting, interval=${SURGE_SCAN_INTERVAL / 1000}s, window=${process.env.INTRADAY_SURGE_WINDOW || 30}min, ratio>=${process.env.INTRADAY_SURGE_RATIO || 3}x`);
    runScan('VolumeSurge', scanIntradayVolumeSurge, SURGE_SCAN_INTERVAL);
  }, 120000);

  // 每天定时任务调度器（60s 心跳）
  // [DISABLED] 17:01 收盘快照 snapshotTodayAllMinutes —— 已由 orderbook_processor_bl.py 负责
  // [保留]     07:55 新交易日重置（stableHistory、DailySummary open_price flag）
  let lastHistoryClearDate = null;
  setInterval(() => {
    const bj = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const h  = bj.getHours();
    const m  = bj.getMinutes();
    const todayStr = bj.toISOString().slice(0, 10);
    if (h === 7 && m === 55 && lastHistoryClearDate !== todayStr) {
      lastHistoryClearDate = todayStr;
      stableHistory.clear();
      boundaryAlertMap.clear();
      boundaryHistory.clear();
      window30m.clear();
      window30mLastBucket = null;
      price30mCache.clear();
      price30mLastUpdate = 0;
      lastDailySummaryRunAt = null;
      scannerPerfectCache.BREAKOUT = [];
      scannerPerfectCache.RANGE = [];
      scannerCache.rows = [];
      console.log('[StableHistory] cleared for new trading day');
      console.log('[Window30m] cleared for new trading day');
      console.log('[Price30mCache] cleared for new trading day');
      console.log('[ScannerCache] cleared for new trading day');
      pruneStableSnapshot();
      pruneBoundarySnapshot();
      // initOpenPrice 已改为 runScan 定期补写，跨天自动恢复，无需手动触发
    }
  }, 60000);
}

// ══════════════════════════════════════════════════════════════
// 波动率 API
// ══════════════════════════════════════════════════════════════

// 当日股票汇总（按股票聚合）
// GET /api/volatility/today?date=YYYY-MM-DD&min_sigma=0&limit=200
app.get('/api/volatility/today', async (req, res) => {
  const date     = String(req.query.date     || '').trim() || new Date().toISOString().slice(0,10);
  const minSigma = parseFloat(req.query.min_sigma || '0') || 0;
  const limit    = Math.min(parseInt(req.query.limit  || '200'), 500);
  try {
    const { rows } = await pool.query(`
      SELECT
        vc.symbol,
        COUNT(*)                              AS cycle_count,
        ROUND(AVG(vc.sigma_pct)::numeric, 4) AS avg_sigma_pct,
        ROUND(MAX(vc.sigma_pct)::numeric, 4) AS max_sigma_pct,
        ROUND(MIN(vc.sigma_pct)::numeric, 4) AS min_sigma_pct,
        MIN(vc.cycle_start)                  AS first_cycle,
        MAX(vc.cycle_end)                    AS last_cycle,
        SUM(vc.total_vol)                    AS total_vol,
        vw.add_min_vol,
        vw.add_chg_pct,
        vw.added_at
      FROM market_data.volatility_cycles vc
      LEFT JOIN market_data.volatility_watched vw
             ON vw.symbol = vc.symbol AND vw.trade_date = vc.trade_date
      WHERE vc.trade_date = $1::date
        AND vc.sigma_pct  >= $2
      GROUP BY vc.symbol, vw.add_min_vol, vw.add_chg_pct, vw.added_at
      ORDER BY max_sigma_pct DESC
      LIMIT $3
    `, [date, minSigma, limit]);
    res.json(rows);
  } catch (e) {
    console.error('[volatility/today]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 单只股票当日时序（用于画图）
// GET /api/volatility/timeseries?symbol=SPCX.BL&date=YYYY-MM-DD
app.get('/api/volatility/timeseries', async (req, res) => {
  const symbol = String(req.query.symbol || '').trim().toUpperCase();
  const date   = String(req.query.date   || '').trim() || new Date().toISOString().slice(0,10);
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  try {
    const { rows } = await pool.query(`
      SELECT
        cycle_start, cycle_end,
        sigma_pct,
        r1, r2, r3, r4, r5,
        c0, c1, c2, c3, c4, c5,
        vol1, vol2, vol3, vol4, vol5,
        total_vol, price_change_pct
      FROM market_data.volatility_cycles
      WHERE symbol = $1 AND trade_date = $2::date
      ORDER BY cycle_end ASC
    `, [symbol, date]);
    res.json(rows);
  } catch (e) {
    console.error('[volatility/timeseries]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 最新N条记录（实时滚动用）
// GET /api/volatility/latest?date=YYYY-MM-DD&min_sigma=0&limit=100
app.get('/api/volatility/latest', async (req, res) => {
  const date     = String(req.query.date     || '').trim() || new Date().toISOString().slice(0,10);
  const minSigma = parseFloat(req.query.min_sigma || '0') || 0;
  const limit    = Math.min(parseInt(req.query.limit || '100'), 500);
  try {
    const { rows } = await pool.query(`
      SELECT
        symbol, cycle_start, cycle_end,
        sigma_pct, r1, r2, r3, r4, r5,
        c0, c5, price_change_pct, total_vol
      FROM market_data.volatility_cycles
      WHERE trade_date = $1::date
        AND sigma_pct  >= $2
      ORDER BY cycle_end DESC
      LIMIT $3
    `, [date, minSigma, limit]);
    res.json(rows);
  } catch (e) {
    console.error('[volatility/latest]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 历史多日统计
// GET /api/volatility/history?symbol=SPCX.BL&days=10
app.get('/api/volatility/history', async (req, res) => {
  const symbol = String(req.query.symbol || '').trim().toUpperCase();
  const days   = Math.min(parseInt(req.query.days || '10'), 30);
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  try {
    const { rows } = await pool.query(`
      SELECT
        trade_date,
        COUNT(*)                              AS cycle_count,
        ROUND(AVG(sigma_pct)::numeric, 4)    AS avg_sigma_pct,
        ROUND(MAX(sigma_pct)::numeric, 4)    AS max_sigma_pct,
        SUM(total_vol)                        AS total_vol
      FROM market_data.volatility_cycles
      WHERE symbol = $1
        AND trade_date >= CURRENT_DATE - $2
      GROUP BY trade_date
      ORDER BY trade_date DESC
    `, [symbol, days]);
    res.json(rows);
  } catch (e) {
    console.error('[volatility/history]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// Scanners API (Real-time from minute_indicators)
// ==========================================

function evaluateScanner(row, scannerType) {
  const close = parseFloat(row.close);
  const atr10 = parseFloat(row.atr10);
  const atr30 = parseFloat(row.atr30);
  const atr_day5 = parseFloat(row.atr_day5);
  const ma_atr15 = parseFloat(row.ma_atr15);
  const slope10 = parseFloat(row.slope10);
  const hv10 = parseFloat(row.hv10);
  const ma_hv15 = parseFloat(row.ma_hv15);
  const vol10 = parseFloat(row.vol10);
  const vol60 = parseFloat(row.vol60);
  const count_upper10 = parseInt(row.count_upper10);
  const count_lower10 = parseInt(row.count_lower10);
  const hh10 = parseFloat(row.hh10);
  const ll10 = parseFloat(row.ll10);
  const up_count20 = parseInt(row.up_count20);
  const dn_count20 = parseInt(row.dn_count20);

  let conditions = {};
  let passedCount = 0;
  
  const safeDiv = (a, b) => (b && b !== 0 ? a / b : null);

  if (scannerType === 'BREAKOUT') {
    const atrRatio = safeDiv(atr10, atr30);
    conditions.atr_compression = { actual: atrRatio, pass: atrRatio !== null && atrRatio < 0.5 };
    
    const dayAtrRatio = safeDiv(atr_day5, close);
    conditions.atr_not_expanded = { actual: dayAtrRatio, pass: dayAtrRatio !== null && dayAtrRatio > 0.02 };
    
    const atrStab = safeDiv(atr10, ma_atr15);
    conditions.atr_stable = { actual: atrStab, pass: atrStab !== null && atr10 < ma_atr15 * 1.3 };
    
    conditions.normalized_slope_flat = { actual: Math.abs(slope10), pass: !isNaN(slope10) && Math.abs(slope10) < 0.0025 };
    
    const hvRatio = safeDiv(hv10, ma_hv15);
    conditions.hv_compression = { actual: hvRatio, pass: hvRatio !== null && hvRatio < 0.5 };
    
    const volRatio = safeDiv(vol10, vol60);
    conditions.volume_compression = { actual: volRatio, pass: volRatio !== null && volRatio >= 0.3 && volRatio <= 0.7 };
    
    conditions.range_touch = { actual: `upper:${count_upper10}, lower:${count_lower10}`, pass: !isNaN(count_upper10) && !isNaN(count_lower10) && count_upper10 >= 2 && count_lower10 >= 2 && (count_upper10 + count_lower10) >= 5 };
    
    conditions.distribution_balance = { actual: `up:${up_count20}, dn:${dn_count20}`, pass: !isNaN(up_count20) && !isNaN(dn_count20) && up_count20 >= 6 && dn_count20 >= 6 };
  } else if (scannerType === 'RANGE') {
    const atrRatio = safeDiv(atr10, atr30);
    conditions.atr_ratio = { actual: atrRatio, pass: atrRatio !== null && atrRatio >= 0.3 && atrRatio <= 1.2 };
    
    const dayAtrRatio = safeDiv(atr_day5, close);
    conditions.day_atr_ratio = { actual: dayAtrRatio, pass: dayAtrRatio !== null && dayAtrRatio > 0.02 };
    
    const atrStab = safeDiv(atr10, ma_atr15);
    conditions.atr_stable = { actual: atrStab, pass: atrStab !== null && atr10 < ma_atr15 * 1.3 };
    
    const box = hh10 - ll10;
    const slopeBias = !isNaN(slope10) && !isNaN(box) && box !== 0 ? Math.abs(10 * slope10) / box : null;
    conditions.slope_bias = { actual: slopeBias, pass: slopeBias !== null && slopeBias <= 0.2 };
    
    const hvRatio = safeDiv(hv10, ma_hv15);
    conditions.hv_ratio = { actual: hvRatio, pass: hvRatio !== null && hvRatio < 0.7 };
    
    const volRatio = safeDiv(vol10, vol60);
    conditions.volume_ratio = { actual: volRatio, pass: volRatio !== null && volRatio >= 0.35 && volRatio <= 1.3 };
    
    conditions.range_touch = { actual: `upper:${count_upper10}, lower:${count_lower10}`, pass: !isNaN(count_upper10) && !isNaN(count_lower10) && (count_upper10 >= 2 || count_lower10 >= 2) };
    
    conditions.distribution_balance = { actual: `up:${up_count20}, dn:${dn_count20}`, pass: !isNaN(up_count20) && !isNaN(dn_count20) && up_count20 >= 6 && dn_count20 >= 6 };
  }

  for (const key in conditions) {
    if (conditions[key].pass) passedCount++;
  }

  const score = Math.round((passedCount / 8) * 100);
  return { score, conditions };
}

// ══════════════════════════════════════════════════════════════
// [PERF] Scanner 内存缓存：后台每 30s 刷新，API 直接返回缓存
// ══════════════════════════════════════════════════════════════
const scannerCache = {
  rows: [],            // 最新一条/symbol 的 indicator 行
  lastRefresh: 0,      // 上次刷新时间戳
  refreshing: false,   // 防止并发刷新
};

// 全天满分缓存：存储今日所有 bar 中 score=100 的记录（按时间倒序）
// 结构: { BREAKOUT: [{symbol, bar_time, close, volume, conditions}, ...], RANGE: [...] }
const scannerPerfectCache = { BREAKOUT: [], RANGE: [] };
let scannerPerfectRefreshing = false;

async function refreshScannerCache() {
  if (scannerCache.refreshing) return;
  scannerCache.refreshing = true;
  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 60000');
    const { rows } = await client.query(`
      SELECT 
        li.*, 
        COALESCE(os.volume, ds.total_volume, 0) AS current_total_volume
      FROM (
        SELECT DISTINCT ON (symbol) *
        FROM market_data.minute_indicators
        WHERE trade_date = CURRENT_DATE
        ORDER BY symbol, bar_time DESC
      ) li
      LEFT JOIN market_data.ohlc_snapshot os ON os.symbol = li.symbol AND os.trade_date = CURRENT_DATE
      LEFT JOIN market_data.daily_summary ds ON ds.symbol = li.symbol AND ds.trade_date = CURRENT_DATE
    `);
    scannerCache.rows = rows;
    scannerCache.lastRefresh = Date.now();
  } catch (err) {
    console.error('[ScannerCache] Refresh failed:', err.message);
  } finally {
    await client.query('SET statement_timeout = 0').catch(() => {});
    client.release();
    scannerCache.refreshing = false;
  }
}

// 全天满分扫描：拉取今日所有 bar，评估后只保留 score=100 的记录
async function refreshScannerPerfectCache() {
  if (scannerPerfectRefreshing) return;
  scannerPerfectRefreshing = true;
  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 90000');
    const { rows } = await client.query(`
      SELECT 
        li.*, 
        COALESCE(os.volume, ds.total_volume, 0) AS current_total_volume
      FROM market_data.minute_indicators li
      LEFT JOIN market_data.ohlc_snapshot os ON os.symbol = li.symbol AND os.trade_date = CURRENT_DATE
      LEFT JOIN market_data.daily_summary ds ON ds.symbol = li.symbol AND ds.trade_date = CURRENT_DATE
      WHERE li.trade_date = CURRENT_DATE
      ORDER BY li.bar_time DESC
    `);

    const breakoutItems = [];
    const rangeItems = [];

    for (const row of rows) {
      const bEval = evaluateScanner(row, 'BREAKOUT');
      if (bEval.score >= 100) {
        breakoutItems.push({
          symbol: row.symbol,
          signal: {
            score: bEval.score,
            type: 'BREAKOUT',
            bar_time: row.bar_time,
            stage: 'WATCH'
          },
          indicators: {
            close: row.close != null ? parseFloat(row.close) : null,
            volume: row.current_total_volume != null ? parseFloat(row.current_total_volume) : null,
            atr10: row.atr10 != null ? parseFloat(row.atr10) : null,
            atr30: row.atr30 != null ? parseFloat(row.atr30) : null,
            slope10: row.slope10 != null ? parseFloat(row.slope10) : null,
            range10: row.range10 != null ? parseFloat(row.range10) : null,
            hh20: row.hh20 != null ? parseFloat(row.hh20) : null,
            ll20: row.ll20 != null ? parseFloat(row.ll20) : null,
            up_count20: row.up_count20 != null ? parseInt(row.up_count20) : null,
            dn_count20: row.dn_count20 != null ? parseInt(row.dn_count20) : null
          },
          conditions: bEval.conditions
        });
      }

      const rEval = evaluateScanner(row, 'RANGE');
      if (rEval.score >= 100) {
        rangeItems.push({
          symbol: row.symbol,
          signal: {
            score: rEval.score,
            type: 'RANGE',
            bar_time: row.bar_time,
            stage: 'A'
          },
          indicators: {
            close: row.close != null ? parseFloat(row.close) : null,
            volume: row.current_total_volume != null ? parseFloat(row.current_total_volume) : null,
            atr10: row.atr10 != null ? parseFloat(row.atr10) : null,
            atr30: row.atr30 != null ? parseFloat(row.atr30) : null,
            slope10: row.slope10 != null ? parseFloat(row.slope10) : null,
            range10: row.range10 != null ? parseFloat(row.range10) : null,
            hh20: row.hh20 != null ? parseFloat(row.hh20) : null,
            ll20: row.ll20 != null ? parseFloat(row.ll20) : null,
            up_count20: row.up_count20 != null ? parseInt(row.up_count20) : null,
            dn_count20: row.dn_count20 != null ? parseInt(row.dn_count20) : null
          },
          conditions: rEval.conditions
        });
      }
    }

    // 已按 bar_time DESC 排序（SQL ORDER BY），直接使用
    scannerPerfectCache.BREAKOUT = breakoutItems;
    scannerPerfectCache.RANGE = rangeItems;
    console.log(`[ScannerPerfect] Refreshed: BREAKOUT=${breakoutItems.length}, RANGE=${rangeItems.length} perfect bars from ${rows.length} total`);
  } catch (err) {
    console.error('[ScannerPerfect] Refresh failed:', err.message);
  } finally {
    await client.query('SET statement_timeout = 0').catch(() => {});
    client.release();
    scannerPerfectRefreshing = false;
  }
}

// GET /api/scanners - Summary of all scanners
app.get('/api/scanners', async (req, res) => {
  try {
    const rows = scannerCache.rows;
    if (rows.length === 0) {
      // 缓存为空，尝试即时刷新一次
      await refreshScannerCache();
    }

    let breakoutCount = 0;
    let rangeCount = 0;
    
    for (const row of scannerCache.rows) {
      if (evaluateScanner(row, 'BREAKOUT').score >= 70) breakoutCount++;
      if (evaluateScanner(row, 'RANGE').score >= 70) rangeCount++;
    }
    
    res.json([
      { type: 'BREAKOUT', count: breakoutCount },
      { type: 'RANGE', count: rangeCount }
    ]);
  } catch (e) {
    console.error('[scanners/summary]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/scanners/:type/diagnose - Diagnose a specific symbol (returns all history for today)
app.get('/api/scanners/:type/diagnose', async (req, res) => {
  const scannerType = req.params.type.toUpperCase();
  const symbol = req.query.symbol?.toUpperCase();
  
  if (!symbol) {
    return res.status(400).json({ error: 'symbol is required' });
  }

  try {
    const { rows } = await pool.query(`
      WITH target_indicators AS (
        SELECT *
        FROM market_data.minute_indicators
        WHERE symbol = $1 AND trade_date = CURRENT_DATE
        ORDER BY bar_time DESC
      )
      SELECT 
        li.*, 
        COALESCE(os.volume, ds.total_volume, 0) AS current_total_volume
      FROM target_indicators li
      LEFT JOIN market_data.ohlc_snapshot os ON os.symbol = li.symbol AND os.trade_date = CURRENT_DATE
      LEFT JOIN market_data.daily_summary ds ON ds.symbol = li.symbol AND ds.trade_date = CURRENT_DATE
      ORDER BY li.bar_time DESC
    `, [symbol]);

    if (rows.length === 0) {
      return res.json({ found: false });
    }

    const history = rows.map(row => {
      const evaluation = evaluateScanner(row, scannerType);
      return {
        bar_time: row.bar_time,
        price: row.close != null ? parseFloat(row.close) : null,
        score: evaluation.score,
        conditions: evaluation.conditions
      };
    });
    
    res.json({
      found: true,
      symbol: symbol,
      history: history
    });
  } catch (e) {
    console.error(`[scanners/${scannerType}/diagnose]`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/scanners/:type - Detail of a specific scanner (from cache)
app.get('/api/scanners/:type', async (req, res) => {
  const scannerType = req.params.type.toUpperCase();
  const minScore = parseInt(req.query.min_score || '70');
  const limit = Math.min(parseInt(req.query.limit || '50'), 200);
  
  try {
    // min_score=100 时使用全天满分缓存（拉取今日所有 bar 评估的结果）
    if (minScore >= 100) {
      const perfectItems = scannerPerfectCache[scannerType] || [];
      // 已按 bar_time DESC 排序，直接截取
      const sliced = perfectItems.slice(0, limit);
      return res.json({
        scanner: scannerType,
        timestamp: new Date().toISOString(),
        count: sliced.length,
        items: sliced
      });
    }

    // min_score < 100 时使用最新一条/symbol 缓存
    if (scannerCache.rows.length === 0) {
      await refreshScannerCache();
    }

    let items = [];
    
    for (const row of scannerCache.rows) {
      const evaluation = evaluateScanner(row, scannerType);
      if (evaluation.score >= minScore) {
        items.push({
          symbol: row.symbol,
          signal: {
            score: evaluation.score,
            type: scannerType,
            bar_time: row.bar_time,
            stage: scannerType === 'BREAKOUT' ? 'WATCH' : 'A'
          },
          indicators: {
            close: row.close != null ? parseFloat(row.close) : null,
            volume: row.current_total_volume != null ? parseFloat(row.current_total_volume) : null,
            atr10: row.atr10 != null ? parseFloat(row.atr10) : null,
            atr30: row.atr30 != null ? parseFloat(row.atr30) : null,
            slope10: row.slope10 != null ? parseFloat(row.slope10) : null,
            range10: row.range10 != null ? parseFloat(row.range10) : null,
            hh20: row.hh20 != null ? parseFloat(row.hh20) : null,
            ll20: row.ll20 != null ? parseFloat(row.ll20) : null,
            up_count20: row.up_count20 != null ? parseInt(row.up_count20) : null,
            dn_count20: row.dn_count20 != null ? parseInt(row.dn_count20) : null
          },
          conditions: evaluation.conditions
        });
      }
    }
    
    items.sort((a, b) => {
      if (b.signal.score !== a.signal.score) {
        return b.signal.score - a.signal.score;
      }
      return new Date(b.signal.bar_time) - new Date(a.signal.bar_time);
    });
    items = items.slice(0, limit);

    res.json({
      scanner: scannerType,
      timestamp: new Date().toISOString(),
      count: items.length,
      items: items
    });
  } catch (e) {
    console.error(`[scanners/${scannerType}]`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// === Crossed Market Alert API ===
app.get('/api/crossed-market-alerts', async (req, res) => {
  try {
    const symbol = (req.query.symbol || '').trim().toUpperCase();
    const status = req.query.status || 'all'; // active | recovered | all
    const hours  = parseInt(req.query.hours) || 24;
    const limit  = Math.min(parseInt(req.query.limit) || 100, 500);
    const sort   = ['spread', 'duration_sec', 'detected_at', 'volume'].includes(req.query.sort)
      ? req.query.sort : 'detected_at';
    const order  = req.query.order === 'asc' ? 'ASC' : 'DESC';

    const conditions = [];
    const params = [];
    let paramIdx = 0;

    // 时间范围（仅对 recovered 和 all 生效）
    if (status !== 'active') {
      paramIdx++;
      conditions.push(`detected_at > NOW() - interval '1 hour' * $${paramIdx}`);
      params.push(hours);
    }

    // symbol 过滤
    if (symbol) {
      paramIdx++;
      conditions.push(`symbol ILIKE $${paramIdx}`);
      params.push(`%${symbol}%`);
    }

    // 成交量过滤 
    const minVol = parseFloat(req.query.min_volume); 
    const maxVol = parseFloat(req.query.max_volume); 
    if (!isNaN(minVol) && minVol > 0) { 
      paramIdx++; 
      conditions.push(`volume >= $${paramIdx}`); 
      params.push(minVol); 
    } 
    if (!isNaN(maxVol) && maxVol > 0) { 
      paramIdx++; 
      conditions.push(`volume <= $${paramIdx}`); 
      params.push(maxVol); 
    } 

    // 状态过滤
    if (status === 'active') {
      conditions.push('recovered_at IS NULL');
    } else if (status === 'recovered') {
      conditions.push('recovered_at IS NOT NULL');
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    paramIdx++;
    const sql = `
      SELECT id, symbol, bid, ask, spread, l2_best_bid, l2_best_ask, bid_mmids, ask_mmids, volume, detected_at, recovered_at, duration_sec
      FROM crossed_market_alert
      ${where}
      ORDER BY ${sort} ${order}
      LIMIT $${paramIdx}
    `;
    params.push(limit);

    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error('[crossed-market-alerts] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 静态文件服务
app.use(express.static(path.join(__dirname, '../public'), {
    setHeaders: (res) => {
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
}));

app.get('/alerts',          (req, res) => res.sendFile(path.join(__dirname, '../public/alerts.html')));
app.get('/volume-alerts',   (req, res) => res.sendFile(path.join(__dirname, '../public/volume-alerts.html')));
app.get('/hills',           (req, res) => res.sendFile(path.join(__dirname, '../public/hills.html')));
app.get('/hill-alerts',     (req, res) => res.sendFile(path.join(__dirname, '../public/hill-alerts.html')));
app.get('/ranking',         (req, res) => res.sendFile(path.join(__dirname, '../public/ranking.html')));
// /large-orders 页面已停用
app.get('/l2-alerts',       (req, res) => res.sendFile(path.join(__dirname, '../public/l2_alert_history.html')));
app.get('/swing-screener',  (req, res) => res.sendFile(path.join(__dirname, '../public/swing-screener.html')));
app.get('/screener',        (req, res) => res.sendFile(path.join(__dirname, '../public/screener.html')));
app.get('/stable-screener', (req, res) => res.sendFile(path.join(__dirname, '../public/screener-stable.html')));
app.get('/oscillator-screener', (req, res) => res.sendFile(path.join(__dirname, '../public/screener-oscillator.html')));
app.get('/boundary-alerts',     (req, res) => res.sendFile(path.join(__dirname, '../public/boundary-alerts.html')));
app.get('/volatility',          (req, res) => res.sendFile(path.join(__dirname, '../public/volatility.html')));
app.get('/active-trading',      (req, res) => res.sendFile(path.join(__dirname, '../public/active-trading.html')));
app.get('/abnormal-trades',     (req, res) => res.sendFile(path.join(__dirname, '../public/abnormal-trades.html')));
app.get('/volume-chart',        (req, res) => res.sendFile(path.join(__dirname, '../public/volume-chart.html')));
app.get('/screener-breakout',   (req, res) => res.sendFile(path.join(__dirname, '../public/screener-breakout.html')));
app.get('/screener-range',      (req, res) => res.sendFile(path.join(__dirname, '../public/screener-range.html')));
app.get('/crossed-market',      (req, res) => res.sendFile(path.join(__dirname, '../public/crossed-market.html')));
app.get('/rect-alerts',         (req, res) => res.sendFile(path.join(__dirname, '../public/rect-alerts.html')));

// [PERF] ensureTables 默认跳过（仅 ENSURE_TABLES=1 时执行 DDL），不阻塞 startAlertMonitor
ensureTables().then(() => {
  startAlertMonitor();
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const server = app.listen(PORT, HOST, () => console.log(`Server listening on http://${HOST}:${PORT}`));

// ═══ 矩形区间 WebSocket 推送 ═══
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ server, path: '/ws/rect-signals' });
const rectWsClients = new Set();

wss.on('connection', (ws) => {
  rectWsClients.add(ws);
  ws.on('close', () => rectWsClients.delete(ws));
  ws.on('error', () => rectWsClients.delete(ws));
});

function broadcastRectEvent(message) {
  const dead = [];
  for (const ws of rectWsClients) {
    if (ws.readyState === 1) {
      ws.send(message);
    } else {
      dead.push(ws);
    }
  }
  dead.forEach(ws => rectWsClients.delete(ws));
}

// ═══ Redis 订阅 rect:events ═══
const { createClient } = require('redis');

(async () => {
  try {
    const redisHost = process.env.REDIS_HOST || '127.0.0.1';
    const redisPort = process.env.REDIS_PORT || '6379';
    const redisSub = createClient({ url: `redis://${redisHost}:${redisPort}` });
    redisSub.on('error', (err) => console.error('[RectRedis] Error:', err.message));
    await redisSub.connect();
    await redisSub.subscribe('rect:events', (message) => {
      broadcastRectEvent(message);
    });
    console.log(`[RectRedis] Subscribed to rect:events (${redisHost}:${redisPort})`);
  } catch (err) {
    console.error('[RectRedis] Failed to connect:', err.message);
  }
})();
