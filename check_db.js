const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function checkDb() {
  const client = await pool.connect();
  try {
    // Check minute_indicators
    console.log('--- minute_indicators columns ---');
    let res = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_schema = 'market_data' AND table_name = 'minute_indicators';
    `);
    console.table(res.rows);

    // Check scanner_results
    console.log('--- scanner_results columns ---');
    res = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_schema = 'market_data' AND table_name = 'scanner_results';
    `);
    console.table(res.rows);

    // Check indexes
    console.log('--- Indexes ---');
    res = await client.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'market_data' AND tablename IN ('minute_indicators', 'scanner_results');
    `);
    console.table(res.rows);

  } catch (err) {
    console.error(err);
  } finally {
    client.release();
    await pool.end();
  }
}

checkDb();
