const { query } = require('../src/db/db');

async function verify() {
  try {
    console.log('--- 1. Verify daily_job_capacity column exists ---');
    const cols = await query(`
      SELECT column_name, data_type, column_default 
      FROM information_schema.columns 
      WHERE table_name = 'technicians' AND column_name = 'daily_job_capacity';
    `);
    console.log('Column details:', cols.rows);

    console.log('--- 2. Sample Technicians ---');
    const techs = await query(`
      SELECT id, full_name, primary_trade, daily_job_capacity 
      FROM technicians 
      LIMIT 3;
    `);
    console.log('Technicians:', techs.rows);

    console.log('--- 3. Test Capacity-Aware Allocation Query ---');
    const allocTest = await query(`
      SELECT id, full_name, primary_trade, COALESCE(daily_job_capacity, 4) as daily_cap,
        (
          SELECT COUNT(*)::int 
          FROM bookings b 
          WHERE b.technician_id = technicians.id 
            AND (b.created_at >= CURRENT_DATE OR b.scheduled_slot LIKE '%' || TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') || '%')
            AND b.status != 'cancelled'
        ) as today_jobs
      FROM technicians
      WHERE is_blocked = FALSE
      LIMIT 3;
    `);
    console.log('Allocation readiness:', allocTest.rows);

    console.log('All capacity & allocation checks verified successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Verification failed:', err.message);
    process.exit(1);
  }
}

verify();
