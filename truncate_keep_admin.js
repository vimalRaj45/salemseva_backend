const { query, pool } = require('./src/db/db');

async function truncateKeepAdmin() {
  console.log('--- STARTING DATABASE TRUNCATION (KEEP ADMIN ONLY) ---');
  
  try {
    await query('BEGIN');

    // 1. Truncate dependent and transactional tables
    const tablesToTruncate = [
      'booking_reschedule_logs',
      'quote_items',
      'payments',
      'reviews',
      'chat_messages',
      'call_logs',
      'wallet_transactions',
      'technician_payouts',
      'technician_referrals',
      'technician_rejected_leads',
      'support_tickets',
      'platform_feedback',
      'bookings',
      'audit_logs',
      'otp_verifications',
      'passkey_credentials',
      'push_subscriptions',
      'technicians'
    ];

    console.log('Truncating tables:', tablesToTruncate.join(', '));
    await query(`TRUNCATE TABLE ${tablesToTruncate.join(', ')} CASCADE;`);
    console.log('✅ Transactional and technician tables truncated.');

    // 2. Delete all non-admin users
    const deleteUsersRes = await query(`
      DELETE FROM users 
      WHERE role != 'admin' 
        AND phone NOT IN ('+919842099999', '9842099999');
    `);
    console.log(`✅ Deleted ${deleteUsersRes.rowCount} non-admin user(s).`);

    await query('COMMIT');
    console.log('✅ Transaction committed successfully.\n');

    // 3. Verify counts in all tables
    console.log('--- VERIFYING TABLE ROW COUNTS ---');
    const tableListRes = await query(`
      SELECT tablename 
      FROM pg_catalog.pg_tables 
      WHERE schemaname = 'public' 
      ORDER BY tablename;
    `);

    for (const row of tableListRes.rows) {
      const countRes = await query(`SELECT count(*) FROM "${row.tablename}"`);
      console.log(`${row.tablename.padEnd(30)}: ${countRes.rows[0].count}`);
    }

    // 4. Verify remaining users & admin_team
    console.log('\n--- REMAINING USERS ---');
    const usersRes = await query('SELECT id, phone, full_name, role FROM users');
    console.table(usersRes.rows);

    console.log('\n--- ADMIN TEAM ---');
    const adminTeamRes = await query('SELECT id, name, email, phone, role FROM admin_team');
    console.table(adminTeamRes.rows);

  } catch (error) {
    await query('ROLLBACK');
    console.error('❌ Truncation failed, rolled back changes:', error);
  } finally {
    await pool.end();
  }
}

truncateKeepAdmin();
