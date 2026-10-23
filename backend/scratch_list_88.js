const fs = require('fs');
const path = require('path');
const list = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../scratch_88.json'), 'utf8'));
list.forEach(c => {
  console.log(`${c.id} | ${c.company_name} | ${c.industry || ''} | ${c.city || c.headquarters || ''}`);
});
