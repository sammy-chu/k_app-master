const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost', port: 5432, database: 'ppro8_market_data',
  user: 'postgres', password: 'postgres'
});

function parseCsv(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const match = line.match(/^"([^"]+)","(\d+)","(\d+)","(.+)"$/);
    if (match) {
      rows.push({ symbol: match[1], volume: parseInt(match[3], 10) });
    }
  }
  return rows;
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('SET search_path TO market_data');

    const filePath = path.join(__dirname, '..', '0604.csv');
    const rows = parseCsv(filePath);
    console.log(`Found ${rows.length} rows`);

    const chunkSize = 200;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const placeholders = chunk.map((_, j) => {
        const base = j * 3;
        return `($${base + 1}, $${base + 2}::date, $${base + 3})`;
      }).join(', ');
      const values = [];
      for (const r of chunk) {
        values.push(r.symbol, '2026-06-04', r.volume);
      }
      await client.query(`
        INSERT INTO daily_summary (symbol, trade_date, total_volume)
        VALUES ${placeholders}
        ON CONFLICT (symbol, trade_date)
        DO UPDATE SET total_volume = EXCLUDED.total_volume
      `, values);
      console.log(`  ${Math.min(i + chunkSize, rows.length)} / ${rows.length}`);
    }
    console.log('Done: 2026-06-04');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); pool.end(); process.exit(1); });
