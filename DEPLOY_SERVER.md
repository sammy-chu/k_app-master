# Aliyun Server Deployment Guide

This guide deploys the clean branch to Alibaba Cloud with:

- ECS for the Node.js application
- ApsaraDB RDS for PostgreSQL
- PM2 for process management
- Nginx for reverse proxy

Current deployment branch:

```text
codex/deploy-clean
```

## 1. Prepare Alibaba Cloud Resources

Create these resources in the same Alibaba Cloud region:

```text
ECS instance
RDS PostgreSQL instance
```

Recommended first version:

```text
ECS OS: Ubuntu 22.04 LTS
Node.js: 20 LTS
RDS engine: PostgreSQL
RDS database: ppro8_market_data
RDS schema: market_data
App port: 3000 behind Nginx
Public port: 80/443 through Nginx
```

Redis is not required for the current runtime. The project has a `redis`
dependency, but the clean deployment code path does not currently create a Redis
client or require Redis environment variables.

## 2. Configure Network Access

In the ECS security group, allow:

```text
22/tcp   SSH, restrict to your own IP when possible
80/tcp   HTTP
443/tcp  HTTPS, when TLS is configured
```

Do not expose the Node.js app port directly to the public internet. Keep
`PORT=3000` bound behind Nginx.

In RDS PostgreSQL:

1. Create or choose a database account.
2. Add the ECS private IP or ECS security group to the RDS whitelist.
3. Prefer the RDS internal endpoint when ECS and RDS are in the same region/VPC.
4. Keep the RDS public endpoint disabled unless there is a clear operational need.

## 3. Create Database And Schema

In the Alibaba Cloud RDS console, create the database:

```text
ppro8_market_data
```

Connect to RDS with DMS, DataGrip, `psql`, or another PostgreSQL client and run:

```sql
CREATE SCHEMA IF NOT EXISTS market_data;
```

The app and setup scripts expect:

```text
PGDATABASE=ppro8_market_data
PGSCHEMA=market_data
```

The application creates several app-owned tables on startup if they are missing,
but market data source tables must already exist and contain data for the
business APIs to return meaningful results.

Important source tables used by the first deployment include:

```text
market_data.tos_trades
market_data.l1_quote_bl
market_data.l2_order_book_bl_default
market_data.active_trading_symbols
market_data.daily_summary
market_data.ohlc_snapshot
market_data.last_price
market_data.l2_active_orders_bl
market_data.l2_order_events_bl
market_data.l2_alert_history_bl
```

Some routes can still start without all source tables, but related APIs may
return empty data or errors until those tables are present.

## 4. Install Server Packages

SSH into ECS:

```sh
ssh root@YOUR_ECS_PUBLIC_IP
```

Install runtime packages:

```sh
apt update
apt install -y git curl nginx postgresql-client
```

Install Node.js 20 LTS using your preferred method. Example with NodeSource:

```sh
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v
npm -v
```

Install PM2:

```sh
npm install -g pm2
```

## 5. Upload Or Clone The Clean Branch

Recommended path:

```text
/opt/k_app
```

Clone from your Git remote:

```sh
mkdir -p /opt/k_app
cd /opt
git clone YOUR_GIT_REPO_URL k_app
cd /opt/k_app
git switch codex/deploy-clean
```

If you upload files manually, include the first deployment file set from
`DEPLOY_CLEAN.md`, including:

```text
package.json
package-lock.json
ETF.csv
src/server.js
src/config-manager.js
src/scan-flexible-hills.js
src/sql/**
public/**
```

Optional setup scripts for initial provisioning:

```text
scripts/setup_db.js
scripts/setup_settings_db.js
scripts/backfill_daily_volume.js
scripts/add_updated_at.js
src/init-alerts.js
```

## 6. Configure Environment Variables

See `DEPLOY_ENV.md` for the complete variable checklist extracted from
`src/server.js`.

Create an environment file outside Git:

```sh
mkdir -p /etc/k_app
nano /etc/k_app/k_app.env
```

Example:

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

Protect the file:

```sh
chmod 600 /etc/k_app/k_app.env
```

## 7. Install Dependencies And Check Code

From the project directory:

```sh
cd /opt/k_app
npm ci --omit=dev
npm run check
```

## 8. Initialize App-Owned Tables

See `DEPLOY_DB.md` for the complete database initialization checklist, including
which tables are app-owned and which source tables must already exist in RDS.

Load the environment:

```sh
set -a
. /etc/k_app/k_app.env
set +a
```

Create the schema first if it has not already been created:

```sh
psql "host=$PGHOST port=$PGPORT dbname=$PGDATABASE user=$PGUSER password=$PGPASSWORD" \
  -c "CREATE SCHEMA IF NOT EXISTS market_data;"
```

Run setup scripts if they are included in the deployment package:

```sh
node scripts/setup_db.js
node scripts/setup_settings_db.js
```

If the setup scripts are not included, start the server once; `src/server.js`
also creates several app-owned tables on startup.

## 9. Start With PM2

Use PM2 with environment variables loaded from `/etc/k_app/k_app.env`:

```sh
cd /opt/k_app
set -a
. /etc/k_app/k_app.env
set +a
pm2 start src/server.js --name k-app
pm2 save
pm2 startup
```

After `pm2 startup`, PM2 prints one command. Run that command exactly once so the
app restarts after ECS reboot.

Useful PM2 commands:

```sh
pm2 status
pm2 logs k-app
pm2 restart k-app
pm2 stop k-app
```

## 10. Configure Nginx

Create an Nginx site:

```sh
nano /etc/nginx/sites-available/k_app
```

Example HTTP config:

```nginx
server {
    listen 80;
    server_name YOUR_DOMAIN_OR_ECS_PUBLIC_IP;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable it:

```sh
ln -s /etc/nginx/sites-available/k_app /etc/nginx/sites-enabled/k_app
nginx -t
systemctl reload nginx
```

For a real domain, configure DNS to point to the ECS public IP, then add HTTPS
with Certbot or Alibaba Cloud SSL Certificate Service.

## 11. Verify Deployment

On the ECS instance:

```sh
curl http://127.0.0.1:3000/health
```

Through Nginx:

```sh
curl http://YOUR_DOMAIN_OR_ECS_PUBLIC_IP/health
```

Expected result:

```json
{"ok":true}
```

Then verify core routes:

```text
/
/alerts
/volume-alerts
/ranking
/screener
/boundary-alerts
/active-trading
/abnormal-trades
```

Verify core APIs:

```text
/api/test-db
/api/ranking
/api/alerts?limit=5
/api/active-trading
/api/intra-spread-trades
```

If `/health` works but business APIs fail, check:

```text
RDS whitelist
PGHOST / PGUSER / PGPASSWORD
market_data schema
missing source tables
empty source data
```

## 12. Update Deployment

For normal updates:

```sh
cd /opt/k_app
git fetch
git switch codex/deploy-clean
git pull
npm ci --omit=dev
npm run check
pm2 restart k-app
curl http://127.0.0.1:3000/health
```

## 13. Roll Back

List recent commits:

```sh
git log --oneline -5
```

Roll back to a known good commit:

```sh
git switch codex/deploy-clean
git checkout GOOD_COMMIT_SHA
npm ci --omit=dev
npm run check
pm2 restart k-app
curl http://127.0.0.1:3000/health
```

After rollback, leave the app running on the detached commit only temporarily.
Create a rollback branch or revert commit when you decide the rollback should
become permanent.

## 14. Production Checklist

Before opening traffic:

```text
ECS security group only exposes 22, 80, and 443
RDS whitelist allows ECS private IP or security group
App uses RDS internal endpoint
/etc/k_app/k_app.env exists and is chmod 600
npm ci --omit=dev passed
npm run check passed
PM2 process is online
Nginx config passed nginx -t
/health returns 200 through Nginx
Core pages return 200
Core APIs return 200
ETF.csv is present in the app directory
```
