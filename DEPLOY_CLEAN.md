# Deploy Clean Plan

This project should be deployed from a small runtime file set first. Keep local
development notes, one-off scripts, and duplicate server snapshots out of the
cloud package until they are explicitly needed.

## Production Entry

- `npm start`
- `node src/server.js`

For Linux cloud servers, use:

```sh
npm ci --omit=dev
npm run start:prod
```

Before uploading or restarting:

```sh
npm run check
```

## First Deployment File Set

Upload or include these files/directories:

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

`ETF.csv` is included because `src/server.js` looks for it at runtime to apply
ETF exclusion logic. The app can start without it, but production behavior is
cleaner and closer to the full local project when the file is present.

Optional database/setup files for initial server provisioning:

```text
scripts/setup_db.js
scripts/setup_settings_db.js
scripts/backfill_daily_volume.js
scripts/add_updated_at.js
src/init-alerts.js
```

Do not upload `node_modules`; install dependencies on the server with
`npm ci --omit=dev`.

## Verification Status

This branch was verified as an independent clean deployment candidate:

```text
Branch: codex/deploy-clean
Working tree: clean
npm ci --omit=dev: passed
npm run check: passed
Local start: passed with PORT=3000 because port 8889 was already in use
/health: 200
Core pages: 200
Core APIs: 200
Clean package simulation: passed with only the first deployment file set
```

The clean package simulation also passed without `ETF.csv`, but logged
`ETF.csv not found, skipping ETF exclusion`. Include `ETF.csv` in the first
deployment so ETF exclusion remains active in production.

## First Deployment Features

Keep these user-facing routes in the first deployment:

```text
/
/alerts
/volume-alerts
/hills
/hill-alerts
/ranking
/l2-alerts
/screener
/stable-screener
/swing-screener
/oscillator-screener
/boundary-alerts
/active-trading
/abnormal-trades
```

These pages can wait until they are confirmed useful again:

```text
public/large-orders.html
public/volume-surge.html
```

## Keep Out Of The Runtime Package

These are development, diagnostic, local Windows, historical notes, or duplicate
files. They should stay out of the deploy artifact:

```text
node_modules/
.git/
.vercel/
*.md
*.txt
*.bat
test*.js
check*.js
debug*.js
fix*.js
add*.js
src/server1.js
src/server_runtime.js
src/analyzeAMD.js
src/check-trades.js
src/checkSchema.js
src/cron-job.js
src/queryMinute.js
src/scan-gradual-hills.js
src/scan-volume-hills.js
src/test-alert-sql.js
src/verify-alerts.js
```

## Suggested Cleanup Order

1. Deploy with `.deployignore` or `.dockerignore` first.
2. Verify `/health` and the first deployment routes.
3. Move unused files to an `archive/` folder only after the cloud version runs.
4. Delete archived files in a later commit after there is no runtime usage.
