const { query, pool } = require('./db');

async function fullSystemTruncate() {
  console.log('🔄 Executing FULL SYSTEM TRUNCATE (preserving only settings and admin data)...');
  try {
    // 1. Fetch all tables in public schema
    const tablesRes = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    const allTables = tablesRes.rows.map(r => r.table_name);

    // List of tables to truncate with CASCADE
    const tablesToWipe = [
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
      'wallet_transactions',
      'support_tickets',
      'otp_verifications',
      'push_subscriptions',
      'passkey_credentials',
      'technicians'
    ].filter(t => allTables.includes(t));

    if (tablesToWipe.length > 0) {
      console.log('🗑️ Truncating tables with CASCADE:', tablesToWipe.join(', '));
      await query(`TRUNCATE TABLE ${tablesToWipe.join(', ')} RESTART IDENTITY CASCADE;`);
      console.log('✅ Successfully truncated tables.');
    }

    // 2. Remove all non-admin users from users table
    if (allTables.includes('users')) {
      const deleteUsersRes = await query(`
        DELETE FROM users 
        WHERE role NOT IN ('admin', 'ops_manager');
      `);
      console.log(`✅ Removed non-admin users: ${deleteUsersRes.rowCount} users deleted.`);
    }

    // 3. Verification Report
    console.log('\n--- VERIFICATION OF PRESERVED SYSTEM STATE ---');
    for (const tbl of allTables) {
      const countRes = await query(`SELECT COUNT(*) FROM "${tbl}"`);
      console.log(`  - ${tbl}: ${countRes.rows[0].count} rows`);
    }

    console.log('\n🎉 FULL SYSTEM TRUNCATE COMPLETE: Ready for complete manual test from scratch.');
  } catch (err) {
    console.error('❌ Truncate failed:', err.message);
  } finally {
    await pool.end();
  }
}

fullSystemTruncate();
