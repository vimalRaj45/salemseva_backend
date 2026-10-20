const { query, pool } = require('./db');

async function truncateAllExceptAdmin() {
  console.log('--- Shazu One: Starting full database purge (keeping Admin + config only) ---');
  try {
    // 1. Discover all existing tables in the public schema
    const tablesRes = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    const allTables = tablesRes.rows.map(r => r.table_name);
    console.log('Found tables:', allTables.join(', '));

    // Tables to keep untouched (config / catalog data)
    const preservedTables = [
      'services',
      'service_issues',
      'service_spares_catalog',
    ];

    // All transactional tables in safe truncation order
    // (children before parents so CASCADE handles the rest)
    const tablesToPurge = [
      'booking_reschedule_logs',
      'audit_logs',
      'chat_messages',
      'call_logs',
      'reviews',
      'quote_items',
      'payments',
      'wallet_transactions',
      'technician_payouts',
      'technician_referrals',
      'technician_rejected_leads',
      'platform_feedback',
      'bookings',
      'technicians',
      'users',
      // Extra tables that may exist
      'store_bills',
      'messages',
      'feedback',
      'tickets',
      'support_tickets',
      'coupons',
    ].filter(t => allTables.includes(t));

    if (tablesToPurge.length > 0) {
      console.log('\nTruncating with CASCADE:', tablesToPurge.join(', '));
      await query(
        `TRUNCATE TABLE ${tablesToPurge.join(', ')} RESTART IDENTITY CASCADE;`
      );
      console.log('All transactional tables truncated successfully.');
    } else {
      console.log('No matching transactional tables found.');
    }

    // 2. Re-insert the single official Admin account
    const adminSql = `
      INSERT INTO users (
        id,
        phone,
        full_name,
        email,
        role,
        default_address,
        locality,
        wallet_balance
      ) VALUES (
        '00000000-0000-0000-0000-000000000001',
        '+919842099999',
        'Shazu One Central Ops Admin',
        'ops.admin@shazuone.in',
        'admin',
        'Shazu One Central Operations HQ, Fairlands, Salem - 636016',
        'Fairlands',
        0.00
      ) RETURNING id, phone, full_name, role;
    `;
    const adminRes = await query(adminSql);
    console.log('\nAdmin account recreated:', adminRes.rows[0]);

    // 3. Verification summary
    const checks = await Promise.all([
      query('SELECT COUNT(*) FROM users'),
      query('SELECT COUNT(*) FROM technicians'),
      query('SELECT COUNT(*) FROM bookings'),
      query('SELECT COUNT(*) FROM services'),
      query('SELECT COUNT(*) FROM service_issues'),
    ]);

    console.log('\n--- Final State ---');
    console.log(`  users              : ${checks[0].rows[0].count}  (Admin only)`);
    console.log(`  technicians        : ${checks[1].rows[0].count}  (Purged)`);
    console.log(`  bookings           : ${checks[2].rows[0].count}  (Purged)`);
    console.log(`  services (config)  : ${checks[3].rows[0].count}  (Preserved)`);
    console.log(`  service_issues     : ${checks[4].rows[0].count}  (Preserved)`);
    console.log('\nPurge completed. Database is clean and production-ready.');
  } catch (err) {
    console.error('\nError during purge:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

truncateAllExceptAdmin();
