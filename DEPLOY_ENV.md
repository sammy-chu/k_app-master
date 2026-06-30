# Runtime Environment Variables

This file is the source-of-truth checklist for environment variables used by
`src/server.js`.

## Required For Aliyun Production

Set these explicitly on ECS or in the PM2 environment file:

```sh
NODE_ENV=production
HOST=127.0.0.1
PORT=3000

PGHOST=YOUR_RDS_INTERNAL_ENDPOINT
PGPORT=5432
PGDATABASE=ppro8_market_data
PGUSER=YOUR_RDS_USER
PGPASSWORD=YOUR_RDS_PASSWORD
PGSCHEMA=market_data
```

`PGHOST`, `PGUSER`, and `PGPASSWORD` must match the Alibaba Cloud RDS PostgreSQL
instance. Prefer the RDS internal endpoint when ECS and RDS are in the same VPC.

## Variables Used By `src/server.js`

| Variable | Default | Required in production | Purpose |
| --- | --- | --- | --- |
| `HOST` | `0.0.0.0` | Yes | Address the Express server binds to. Use `127.0.0.1` behind Nginx. |
| `PORT` | `8889` | Yes | Express listen port. Use `3000` behind Nginx to avoid local/default port conflicts. |
| `PGHOST` | `localhost` | Yes | PostgreSQL host. Use Aliyun RDS internal endpoint. |
| `PGPORT` | `5432` | Yes | PostgreSQL port. |
| `PGDATABASE` | `ppro8_market_data` | Yes | PostgreSQL database name. |
| `PGUSER` | `postgres` | Yes | PostgreSQL user. Do not rely on the default in production. |
| `PGPASSWORD` | `postgres` | Yes | PostgreSQL password. Do not rely on the default in production. |
| `PGSCHEMA` | `market_data` | Yes | PostgreSQL schema used by `SET search_path` and table checks. |
| `ALERT_THRESHOLD_PCT` | `0.01` | No | Price alert amplitude threshold. |
| `VOLUME_RATIO_THRESHOLD` | `1.5` | No | Volume alert ratio threshold. |
| `VOLUME_SCAN_INTERVAL` | `300000` | No | Volume scan interval in milliseconds. |
| `VOLUME_HISTORY_DAYS` | `20` | No | Historical days used for volume baselines. |
| `VOLUME_Z_THRESHOLD` | `2.0` | No | Z-score threshold for volume logic. |
| `HILL_SCAN_INTERVAL` | `300000` | No | Hill-pattern scan interval in milliseconds. |
| `INTRADAY_SURGE_WINDOW` | `30` | No | Intraday surge lookback window in minutes. |
| `INTRADAY_SURGE_RATIO` | `3` | No | Intraday surge ratio threshold. |
| `INTRADAY_SURGE_HISTORY` | `10` | No | Historical days used for intraday surge baselines. |
| `INTRADAY_SURGE_INTERVAL` | `300000` | No | Intraday surge scan interval in milliseconds. |

## Redis

Redis is not required by the current `src/server.js` runtime path.

The project has a `redis` dependency in `package.json`, but `src/server.js` does
not reference `REDIS_URL`, `REDIS_HOST`, `REDIS_PORT`, or create a Redis client.
Do not provision Alibaba Cloud Redis for the first deployment unless a later
feature adds a real runtime dependency.

## Recommended PM2 Environment File

Store this outside Git:

```text
/etc/k_app/k_app.env
```

Example:

```sh
NODE_ENV=production
HOST=127.0.0.1
PORT=3000

PGHOST=pgm-xxxxxxxx.pg.rds.aliyuncs.com
PGPORT=5432
PGDATABASE=ppro8_market_data
PGUSER=k_app_user
PGPASSWORD=replace_with_rds_password
PGSCHEMA=market_data

ALERT_THRESHOLD_PCT=0.01
VOLUME_RATIO_THRESHOLD=1.5
VOLUME_SCAN_INTERVAL=300000
VOLUME_HISTORY_DAYS=20
VOLUME_Z_THRESHOLD=2.0
HILL_SCAN_INTERVAL=300000
INTRADAY_SURGE_WINDOW=30
INTRADAY_SURGE_RATIO=3
INTRADAY_SURGE_HISTORY=10
INTRADAY_SURGE_INTERVAL=300000
```

Protect it:

```sh
chmod 600 /etc/k_app/k_app.env
```

Load it before running setup scripts or PM2 commands:

```sh
set -a
. /etc/k_app/k_app.env
set +a
```

## Notes

- `src/server.js` creates two PostgreSQL pools, both using the same PG variables.
- `PGSCHEMA` defaults to `market_data`, but production should set it explicitly.
- `NODE_ENV` is not read directly by `src/server.js`, but it is still useful for
  dependency installation, logging conventions, and PM2 process clarity.
- Do not commit `.env` or `/etc/k_app/k_app.env`.
