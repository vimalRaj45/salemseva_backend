const { query } = require('./db');
const { requireDestructive } = require('./destructive.guard');

async function reset() {
  requireDestructive('reset_test_bookings.js');
  const res = await query("UPDATE bookings SET status = 'completed'");
  console.log('Successfully marked all previous test bookings as completed:', res.rowCount);
  process.exit(0);
}

reset().catch(e => { console.error(e); process.exit(1); });
