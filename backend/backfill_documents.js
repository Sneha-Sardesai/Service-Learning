const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const db = require('./database');

function cleanFilenameTitle(url) {
  try {
    const pathname = new URL(url).pathname;
    const filename = path.basename(pathname);
    const stem = path.parse(filename).name;
    const cleaned = stem.replace(/[-_]+/g, ' ').trim();
    if (cleaned.length >= 3 && !/^(report|download|document|file|pdf)$/i.test(cleaned)) {
      return cleaned;
    }
  } catch {}
  return null;
}

async function backfillDocs() {
  const [docs] = await db.getPool().query('SELECT id, title, source_url, link_text FROM documents');
  const generic = ['read the report', 'download report', 'download the report', 'leer el informe', 'read more', 'click here'];
  let updated = 0;
  for (const d of docs) {
    if (generic.includes(d.title.toLowerCase().trim())) {
      const newTitle = cleanFilenameTitle(d.source_url) || 'Untitled report';
      await db.getPool().query('UPDATE documents SET link_text = COALESCE(link_text, ?), title = ? WHERE id = ?', [d.title, newTitle, d.id]);
      console.log(`Doc ${d.id}: "${d.title}" -> "${newTitle}" (link_text: "${d.title}")`);
      updated++;
    }
  }
  console.log(`Backfilled ${updated} documents.`);
  await db.closePool();
}

backfillDocs().catch(console.error);
