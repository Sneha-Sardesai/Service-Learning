const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const db = require('./database');

async function main() {
  const [rows] = await db.getPool().query(`
    SELECT
      c.id, c.company_name, c.normalized_name, c.cin, c.industry, c.city, c.headquarters,
      c.official_website, c.website_candidate, c.official_website_verified_at,
      c.research_status, c.notes,
      (SELECT GROUP_CONCAT(CONCAT(s.source_column, ':', s.original_value) SEPARATOR ' | ')
       FROM company_source_values s WHERE s.company_id = c.id) AS source_data
    FROM companies c
    WHERE c.official_website IS NULL OR c.official_website = '' OR c.official_website_verified_at IS NULL
    ORDER BY c.id
  `);
  fs.writeFileSync(path.resolve(__dirname, '../scratch_88.json'), JSON.stringify(rows, null, 2), 'utf8');
  console.log(`Wrote ${rows.length} rows to scratch_88.json`);
  await db.closePool();
}

main().catch(console.error);
