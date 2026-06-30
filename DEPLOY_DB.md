# Database Initialization Checklist

This checklist is for the first Alibaba Cloud deployment using ApsaraDB RDS for
PostgreSQL.

The application can start only when PostgreSQL is reachable. Several tables are
created automatically by `src/server.js`, but many business APIs depend on
market data source tables that must already exist and contain data.

## 1. Required Database Settings

Use the environment variables documented in `DEPLOY_ENV.md`:

```sh
PGHOST=YOUR_RDS_INTERNAL_ENDPOINT
PGPORT=5432
PGDATABASE=ppro8_market_data
PGUSER=YOUR_RDS_USER
PGPASSWORD=YOUR_RDS_PASSWORD
PGSCHEMA=market_data
```

Create the database in the Alibaba Cloud RDS console:

```text
ppro8_market_data
```

Then create the schema before running any project SQL:

```sql
CREATE SCHEMA IF NOT EXISTS market_data;
```

This is important because existing SQL files and scripts reference
`market_data` directly, but `scripts/setup_db.js` does not create the schema.

## 2. Recommended First-Time Initialization

From the ECS project directory:

```sh
cd /opt/k_app
set -a
. /etc/k_app/k_app.env
set +a
```

Create the schema:

```sh
psql "host=$PGHOST port=$PGPORT dbname=$PGDATABASE user=$PGUSER password=$PGPASSWORD" \
  -c "CREATE SCHEMA IF NOT EXISTS market_data;"
```

Run app-owned table setup:

```sh
node scripts/setup_db.js
node scripts/setup_settings_db.js
```

Then start or restart the app once:

```sh
pm2 restart k-app
```

`src/server.js` also runs `ensureTables()` on startup, which creates or updates
additional app-owned tables that are not fully covered by the standalone setup
scripts.

## 3. App-Owned Tables

These tables are created by `src/server.js` at startup if missing:

```text
market_data.k_alerts
market_data.k_volume_alerts
market_data.tos_daily_volume
market_data.daily_summary
market_data.k_hill_alerts
market_data.intraday_volume_surge
market_data.app_settings
market_data.settings_change_log
market_data.stable_screener_snapshot
market_data.boundary_alert_snapshot
```

The setup scripts additionally cover:

```text
scripts/setup_db.js
  market_data.k_volume_alerts
  market_data.tos_daily_volume
  market_data.k_alerts

scripts/setup_settings_db.js
  market_data.app_settings
  market_data.settings_change_log
  default volume settings
```

Because startup initialization is more complete than the older standalone
scripts, keep this sequence:

```text
create schema -> run setup scripts -> start app -> verify APIs
```

## 4. Market Data Source Tables

These are not created by the deployment scripts. They must come from your data
ingestion pipeline, imported dump, or existing RDS data.

Core first-deployment source tables:

```text
market_data.tos_trades
market_data.l1_quote_bl
market_data.active_trading_symbols
market_data.daily_summary
market_data.ohlc_snapshot
market_data.last_price
market_data.l2_order_book_bl_default
market_data.l2_active_orders_bl
market_data.l2_order_events_bl
market_data.l2_alert_history_bl
```

Feature-specific optional source tables:

```text
market_data.volatility_cycles
market_data.volatility_watched
```

Dynamic L2 routes may also read tables following these patterns:

```text
market_data.l2_active_orders_<market>
market_data.l2_order_events_<market>
market_data.l2_alert_history_<market>
```

For the current first deployment, the default market appears to use `bl` tables.

## 5. Pre-Start Verification SQL

Run this against RDS before starting PM2:

```sql
SELECT current_database();
CREATE SCHEMA IF NOT EXISTS market_data;

SELECT to_regclass('market_data.tos_trades') AS tos_trades;
SELECT to_regclass('market_data.l1_quote_bl') AS l1_quote_bl;
SELECT to_regclass('market_data.active_trading_symbols') AS active_trading_symbols;
SELECT to_regclass('market_data.daily_summary') AS daily_summary;
SELECT to_regclass('market_data.ohlc_snapshot') AS ohlc_snapshot;
SELECT to_regclass('market_data.last_price') AS last_price;
SELECT to_regclass('market_data.l2_order_book_bl_default') AS l2_order_book_bl_default;
SELECT to_regclass('market_data.l2_active_orders_bl') AS l2_active_orders_bl;
SELECT to_regclass('market_data.l2_order_events_bl') AS l2_order_events_bl;
SELECT to_regclass('market_data.l2_alert_history_bl') AS l2_alert_history_bl;
```

Any required table returning `NULL` should be created or imported before public
traffic is opened.

After the app has started once, verify app-owned tables:

```sql
SELECT to_regclass('market_data.k_alerts') AS k_alerts;
SELECT to_regclass('market_data.k_volume_alerts') AS k_volume_alerts;
SELECT to_regclass('market_data.tos_daily_volume') AS tos_daily_volume;
SELECT to_regclass('market_data.k_hill_alerts') AS k_hill_alerts;
SELECT to_regclass('market_data.intraday_volume_surge') AS intraday_volume_surge;
SELECT to_regclass('market_data.app_settings') AS app_settings;
SELECT to_regclass('market_data.settings_change_log') AS settings_change_log;
SELECT to_regclass('market_data.stable_screener_snapshot') AS stable_screener_snapshot;
SELECT to_regclass('market_data.boundary_alert_snapshot') AS boundary_alert_snapshot;
```

## 6. API-To-Table Risk Map

Use this map when an endpoint returns 500 after deployment:

| Route/API | Main tables needed |
| --- | --- |
| `/health` | PostgreSQL connection only |
| `/api/test-db` | `market_data.tos_trades` |
| `/api/ohlcv` | `market_data.tos_trades` |
| `/api/alerts` | `market_data.k_alerts` |
| `/api/volume-alerts-data` | `market_data.k_volume_alerts` |
| `/api/ranking` | `market_data.tos_trades`, `market_data.daily_summary` |
| `/api/price-swing-screener` | `market_data.daily_summary`, `market_data.ohlc_snapshot`, `market_data.last_price` |
| `/api/screener` | `market_data.tos_trades`, `market_data.daily_summary` |
| `/api/screener-large-orders-v2` | L2 order/event/history tables |
| `/api/screener-stable` | `market_data.daily_summary`, `market_data.ohlc_snapshot`, `market_data.last_price`, `market_data.stable_screener_snapshot` |
| `/api/boundary-alerts` | `market_data.daily_summary`, `market_data.ohlc_snapshot`, `market_data.last_price`, `market_data.boundary_alert_snapshot` |
| `/api/active-trading` | `market_data.active_trading_symbols` |
| `/api/intra-spread-trades` | `market_data.tos_trades`, quote/order-book source tables |
| `/api/slip-trades` | `market_data.tos_trades`, quote/order-book source tables |
| `/api/l2-active-orders` | `market_data.l2_active_orders_bl` or market-specific L2 table |
| `/api/l2-order-events` | `market_data.l2_order_events_bl` or market-specific L2 table |
| `/api/l2-alert-history` | `market_data.l2_alert_history_bl` or market-specific L2 table |
| `/api/patterns/flexible-hills` | `market_data.tos_trades` |
| `/api/hill-alerts` | `market_data.k_hill_alerts` |
| `/api/volatility/*` | `market_data.volatility_cycles`, optionally `market_data.volatility_watched` |

## 7. Post-Start HTTP Verification

After PM2 and Nginx are running:

```sh
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/api/test-db
curl http://127.0.0.1:3000/api/ranking
curl "http://127.0.0.1:3000/api/alerts?limit=5"
curl http://127.0.0.1:3000/api/active-trading
curl http://127.0.0.1:3000/api/intra-spread-trades
```

Expected:

```text
/health returns 200 and ok=true
Core APIs return 200
Empty arrays are acceptable if source data is empty
500 responses usually mean missing source tables, bad credentials, or RDS whitelist issues
```

## 8. First Deployment Decision

For the first deployment, do not require volatility tables unless the
`/volatility` page is part of the public launch. The rest of the first deployment
should focus on the tables listed in the core source table section.
