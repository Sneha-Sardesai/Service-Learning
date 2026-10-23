const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const db = require('./database');
const fs = require('fs');

async function main() {
  const [companies] = await db.getPool().query(`
    SELECT c.id, c.company_name, c.cin, c.industry, c.city, c.headquarters, c.turnover_original, c.notes
    FROM companies c
    WHERE c.official_website IS NULL OR c.official_website = '' OR c.official_website_verified_at IS NULL
    ORDER BY c.id
  `);

  const results = [];
  for (const c of companies) {
    const [sources] = await db.getPool().query(
      'SELECT source_workbook, source_worksheet, source_row, source_column, original_value FROM company_source_values WHERE company_id = ?',
      [c.id]
    );
    results.push({
      id: c.id,
      name: c.company_name,
      industry: c.industry,
      city: c.city,
      hq: c.headquarters,
      turnover: c.turnover_original,
      notes: c.notes,
      sources
    });
  }

  fs.writeFileSync(path.resolve(__dirname, '../scratch_88_detailed.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log(`Saved detailed info for ${results.length} companies`);
  await db.closePool();
}

main().catch(console.error);
