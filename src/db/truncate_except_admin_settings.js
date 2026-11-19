const { query, pool } = require('./db');

/**
 * Truncate all transactional and user data while strictly preserving:
 * 1. Admin team / admin credentials (admin_team, admin users in users table)
 * 2. System and platform configuration (platform_settings)
 * 3. Service catalog master data (services, service_issues, service_spares_catalog, coupons)
 *    (can be wiped with optional --wipe-catalog flag if bare minimum is desired)
 */

const PRESERVED_MASTER_TABLES = [
  'admin_team',
  'platform_settings'
];

const CATALOG_TABLES = [
  'services',
  'service_issues',
  'service_spares_catalog',
  'coupons'
];

async function runTruncate() {
  const args = process.argv.slice(2);
  const isConfirmed = args.includes('--confirm') || process.env.CONFIRM_DESTRUCTIVE === 'yes';
  const wipeCatalog = args.includes('--wipe-catalog');

  console.log('------------------------------------------------------------');
  console.log('SHAZU ONE: DATABASE TRUNCATE SCRIPT');
  console.log('Mode: Preserving Admin and Settings');
  console.log('------------------------------------------------------------');

  if (!isConfirmed) {
    console.log('[SAFETY NOTICE] Refusing to execute without explicit confirmation.');
    console.log('This script will wipe all customer bookings, technician accounts,');
    console.log('reviews, payments, legal acceptances, otp logs, and messages.');
    console.log('');
    console.log('Preserved by default:');
    console.log('  - admin_team (All administrative staff)');
    console.log('  - platform_settings (UPI, commissions, fee tiers, Telegram config)');
    console.log('  - users (Admin accounts only)');
    console.log('  - Master catalog (services, issues, spares, coupons)');
    console.log('');
    console.log('To execute truncation, run:');
    console.log('  node src/db/truncate_except_admin_settings.js --confirm');
    console.log('');
    console.log('To ALSO wipe the service catalog (retaining ONLY admin & settings):');
    console.log('  node src/db/truncate_except_admin_settings.js --confirm --wipe-catalog');
    console.log('------------------------------------------------------------');
    await pool.end();
    process.exit(0);
  }

  const client = await pool.connect();

  try {
    // 1. Fetch all existing public base tables
    const tablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `);

    const allTables = tablesRes.rows.map(r => r.table_name);

    // Whitelist tables to protect
    const protectedTables = new Set(PRESERVED_MASTER_TABLES);
    if (!wipeCatalog) {
      CATALOG_TABLES.forEach(t => protectedTables.add(t));
    }

    // Tables to truncate completely with CASCADE
    const tablesToTruncate = allTables.filter(t => !protectedTables.has(t) && t !== 'users');

    console.log('[1/4] Preparing truncation plan...');
    console.log('  Tables to truncate completely (' + tablesToTruncate.length + '):');
    tablesToTruncate.forEach(t => console.log('    - ' + t));
    console.log('  Tables preserved:');
    protectedTables.forEach(t => console.log('    + ' + t));
    console.log('  Users table: Preserving rows with role IN (admin, ops_manager)');

    await client.query('BEGIN');

    // 2. Truncate dynamic tables
    if (tablesToTruncate.length > 0) {
      const quoted = tablesToTruncate.map(t => '"' + t + '"').join(', ');
      console.log('[2/4] Executing TRUNCATE with CASCADE and RESTART IDENTITY...');
      await client.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE;`);
      console.log('  Truncation completed successfully.');
    } else {
      console.log('[2/4] No dynamic tables found to truncate.');
    }

    // 3. Clean users table, retaining admin staff if present
    if (allTables.includes('users')) {
      console.log('[3/4] Purging non-admin users from users table...');
      const deleteUsersRes = await client.query(`
        DELETE FROM users 
        WHERE role::text NOT IN ('admin', 'ops_manager');
      `);
      console.log(`  Purged ${deleteUsersRes.rowCount} non-admin user rows.`);
    }

    await client.query('COMMIT');
    console.log('[4/4] Changes committed successfully.');

    // 4. Verification Report
    console.log('\n============================================================');
    console.log('DATABASE STATE SUMMARY AFTER TRUNCATION');
    console.log('============================================================');

    for (const tbl of allTables) {
      try {
        const countRes = await client.query(`SELECT COUNT(*) AS c FROM "${tbl}"`);
        const rowCount = countRes.rows[0].c;
        const tag = protectedTables.has(tbl) || tbl === 'users' ? '[PRESERVED]' : '[CLEARED]';
        console.log(`  ${tag.padEnd(12)} ${tbl.padEnd(28)} : ${rowCount} rows`);
      } catch (err) {
        console.log(`  [ERROR]      ${tbl.padEnd(28)} : ${err.message}`);
      }
    }
    console.log('============================================================');
    console.log('Truncate completed. Ready for fresh operations or testing.');
    console.log('============================================================\n');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[FATAL] Truncate failed. Transaction rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runTruncate();
