const { pool } = require('./db');

/**
 * Full Truncate Script — Preserves ONLY `platform_settings` and `users`.
 * Every other table in `public` is truncated with RESTART IDENTITY CASCADE.
 *
 * Usage:
 *   Dry-run preview : node src/db/truncate_except_settings_and_users.js
 *   Execute truncate: node src/db/truncate_except_settings_and_users.js --confirm
 */

const PRESERVED_TABLES = new Set([
  'platform_settings',
  'users'
]);

async function runTruncate() {
  const args = process.argv.slice(2);
  const isConfirmed = args.includes('--confirm') || process.env.CONFIRM_DESTRUCTIVE === 'yes';

  const client = await pool.connect();

  try {
    const tablesRes = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `);

    const allTables = tablesRes.rows.map(r => r.table_name);
    const tablesToTruncate = allTables.filter(t => !PRESERVED_TABLES.has(t));
    const preservedFound = allTables.filter(t => PRESERVED_TABLES.has(t));

    console.log('============================================================');
    console.log('SHAZU ONE: FULL DATABASE TRUNCATE');
    console.log('Mode: Preserve ONLY platform_settings & users');
    console.log('============================================================');
    console.log(`Preserved tables (${preservedFound.length}): ${preservedFound.join(', ')}`);
    console.log(`Tables to truncate (${tablesToTruncate.length}):`);
    tablesToTruncate.forEach(t => console.log(`  - ${t}`));

    if (!isConfirmed) {
      console.log('\n[DRY RUN] No data was modified.');
      console.log('To execute this truncation, run:');
      console.log('  node src/db/truncate_except_settings_and_users.js --confirm');
      console.log('============================================================\n');
      return;
    }

    if (tablesToTruncate.length === 0) {
      console.log('\nNo tables to truncate.');
      return;
    }

    await client.query('BEGIN');
    const quoted = tablesToTruncate.map(t => `"${t}"`).join(', ');
    console.log('\nExecuting TRUNCATE TABLE ... RESTART IDENTITY CASCADE...');
    await client.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE;`);
    await client.query('COMMIT');
    console.log('Truncation committed successfully.');

    console.log('\n============================================================');
    console.log('POST-TRUNCATION ROW COUNTS');
    console.log('============================================================');
    for (const tbl of allTables) {
      const countRes = await client.query(`SELECT COUNT(*)::int AS c FROM "${tbl}"`);
      const tag = PRESERVED_TABLES.has(tbl) ? '[PRESERVED]' : '[CLEARED]';
      console.log(`  ${tag.padEnd(12)} ${tbl.padEnd(28)} : ${countRes.rows[0].c} rows`);
    }
    console.log('============================================================\n');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[FATAL] Truncate failed (rolled back):', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runTruncate();
