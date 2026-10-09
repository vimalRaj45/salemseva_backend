const { query } = require('./db');

async function cleanTechs() {
  await query("DELETE FROM technicians WHERE id != 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' AND REPLACE(phone, ' ', '') = '+919443288901'");
  await query("UPDATE technicians SET phone = '+919443288901', is_online = TRUE WHERE id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'");
  console.log('Cleaned up duplicate technicians successfully.');
  process.exit(0);
}

cleanTechs().catch(e => { console.error(e); process.exit(1); });
