const { query, pool } = require('./db');

async function truncateTransactionalData() {
  console.log('SalemSeva: Truncating all transactional test data...');
  try {
    // 1. Fetch all existing tables in public schema
    const tablesRes = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    const allTables = tablesRes.rows.map(r => r.table_name);

    // List of transactional tables to truncate
    const transactionalCandidateTables = [
      'booking_reschedule_logs',
      'audit_logs',
      'reviews',
      'payments',
      'quote_items',
      'bookings',
      'chat_messages',
      'call_logs',
      'technician_payouts',
      'technician_referrals',
      'technician_rejected_leads',
      'platform_feedback',
      'wallet_transactions'
    ];

    const tablesToTruncate = transactionalCandidateTables.filter(t => allTables.includes(t));

    if (tablesToTruncate.length > 0) {
      console.log('Truncating tables with cascade:', tablesToTruncate.join(', '));
      await query(`TRUNCATE TABLE ${tablesToTruncate.join(', ')} RESTART IDENTITY CASCADE;`);
      console.log('Successfully truncated all transactional tables.');
    } else {
      console.log('No transactional tables found to truncate.');
    }

    // 2. Reset technician active duty flags
    if (allTables.includes('technicians')) {
      await query(`
        UPDATE technicians 
        SET is_online = TRUE, 
            jobs_completed_count = 0 
        WHERE id IS NOT NULL;
      `);
      console.log('Reset technician duty state and completed job counters.');
    }

    // 3. Master data summary
    console.log('--- Master Data Verification ---');
    const [uCount, tCount, sCount, bCount] = await Promise.all([
      allTables.includes('users') ? query('SELECT COUNT(*) FROM users') : { rows: [{ count: 0 }] },
      allTables.includes('technicians') ? query('SELECT COUNT(*) FROM technicians') : { rows: [{ count: 0 }] },
      allTables.includes('services') ? query('SELECT COUNT(*) FROM services') : { rows: [{ count: 0 }] },
      allTables.includes('bookings') ? query('SELECT COUNT(*) FROM bookings') : { rows: [{ count: 0 }] }
    ]);

    console.log(`- Users: ${uCount.rows[0].count}`);
    console.log(`- Technicians: ${tCount.rows[0].count}`);
    console.log(`- Service Categories: ${sCount.rows[0].count}`);
    console.log(`- Bookings: ${bCount.rows[0].count} (Clean State)`);
  } catch (err) {
    console.error('Error truncating transactional data:', err.message);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

truncateTransactionalData();
