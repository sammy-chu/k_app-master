const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function addIndexes() {
  const client = await pool.connect();
  try {
    console.log('Adding idx_scanner_results_latest...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_scanner_results_latest 
      ON market_data.scanner_results (scanner_type, symbol, bar_time DESC);
    `);
    console.log('Done.');

    console.log('Adding idx_minute_indicators_lookup...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_minute_indicators_lookup 
      ON market_data.minute_indicators (symbol, bar_time DESC);
    `);
    console.log('Done.');
  } catch (err) {
    console.error(err);
  } finally {
    client.release();
    await pool.end();
  }
}

addIndexes();
