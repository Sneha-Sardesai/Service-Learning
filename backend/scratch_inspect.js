const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const db = require('./database');

async function main() {
  const [docs] = await db.getPool().query("SELECT id, company_id, title, source_url, processing_status, validation_result FROM documents WHERE title LIKE '%Leer%' OR title LIKE '%Read%' OR title LIKE '%Download%' OR title LIKE '%informe%'");
  console.log('DOCS WITH UNHELPFUL TITLES:', docs);
  await db.closePool();
}

main().catch(console.error);
