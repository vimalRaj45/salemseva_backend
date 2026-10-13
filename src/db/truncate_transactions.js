const { query, pool } = require('./db');

async function truncateTransactions() {
  console.log('--- Starting Database Truncation (Preserving Users & Technicians Master Data) ---');

  try {
    // 1. Check existing counts before truncation
    const tablesToCount = ['users', 'technicians', 'services', 'service_issues', 'bookings', 'quote_items', 'payments', 'audit_logs', 'reviews', 'chat_messages', 'call_logs'];
    
    console.log('\n[Before Truncation Record Counts]:');
    for (const table of tablesToCount) {
      try {
        const res = await query(`SELECT COUNT(*) as count FROM ${table}`);
        console.log(`  • ${table.padEnd(20)}: ${res.rows[0].count} rows`);
      } catch (e) {
        console.log(`  • ${table.padEnd(20)}: (table does not exist or empty)`);
      }
    }

    // 2. Truncate all transactional tables with CASCADE
    console.log('\nExecuting TRUNCATE on transactional & booking tables...');

    const tablesToTruncate = [
      'quote_items',
      'payments',
      'reviews',
      'chat_messages',
      'call_logs',
      'audit_logs',
      'technician_payouts',
      'technician_referrals',
      'wallet_transactions',
      'bookings'
    ];

    for (const table of tablesToTruncate) {
      try {
        await query(`TRUNCATE TABLE ${table} CASCADE;`);
        console.log(`   Truncated table: ${table}`);
      } catch (err) {
        console.warn(`  ! Note for ${table}:`, err.message);
      }
    }

    // 3. Reset technician online & active job state if needed
    try {
      await query(`UPDATE technicians SET is_online = TRUE WHERE is_kyc_verified = TRUE;`);
      console.log('   Set verified technicians to online duty readiness');
    } catch (e) {
      console.warn('  ! Technician online reset note:', e.message);
    }

    // 4. Verify post-truncation counts
    console.log('\n[After Truncation Record Counts]:');
    for (const table of tablesToCount) {
      try {
        const res = await query(`SELECT COUNT(*) as count FROM ${table}`);
        console.log(`  • ${table.padEnd(20)}: ${res.rows[0].count} rows`);
      } catch (e) {
        console.log(`  • ${table.padEnd(20)}: (table does not exist or empty)`);
      }
    }

    console.log('\n--- Truncation Complete! All transactional data cleared. Users, Technicians, Services, and Issues preserved! ---');
  } catch (err) {
    console.error('Truncation error:', err);
  } finally {
    await pool.end();
  }
}

truncateTransactions();
