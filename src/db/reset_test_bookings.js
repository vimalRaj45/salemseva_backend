const { query } = require('./db');

async function reset() {
  const res = await query("UPDATE bookings SET status = 'completed'");
  console.log('Successfully marked all previous test bookings as completed:', res.rowCount);
  process.exit(0);
}

reset().catch(e => { console.error(e); process.exit(1); });
