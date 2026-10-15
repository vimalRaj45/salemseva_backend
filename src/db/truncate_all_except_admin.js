const { query, pool } = require('./db');

async function truncateAllExceptAdmin() {
  console.log('--- Starting complete database purge (retaining only Admin ID) ---');
  try {
    // 1. Check all existing tables in public schema
    const tablesRes = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    const allTables = tablesRes.rows.map(r => r.table_name);
    console.log('Existing tables:', allTables.join(', '));

    // Tables to purge completely
    const tablesToPurge = [
      'audit_logs',
      'reviews',
      'payments',
      'quote_items',
      'bookings',
      'store_bills',
      'chat_messages',
      'messages',
      'feedback',
      'technicians',
      'users'
    ].filter(t => allTables.includes(t));

    if (tablesToPurge.length > 0) {
      console.log('Truncating tables with cascade:', tablesToPurge.join(', '));
      await query(`TRUNCATE TABLE ${tablesToPurge.join(', ')} RESTART IDENTITY CASCADE;`);
      console.log('Tables successfully truncated.');
    }

    // 2. Insert the single official Admin Account into users table
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
        'Salem Central Ops Admin',
        'ops.admin@salemseva.in',
        'admin',
        'Salem Central Operations HQ, Fairlands, Salem - 636016',
        'Fairlands',
        0.00
      ) RETURNING *;
    `;

    const adminRes = await query(adminSql);
    console.log('Created single Admin account:', adminRes.rows[0]);

    // 3. Verify counts
    const [uRes, tRes, bRes, sRes] = await Promise.all([
      query('SELECT COUNT(*) FROM users'),
      query('SELECT COUNT(*) FROM technicians'),
      query('SELECT COUNT(*) FROM bookings'),
      query('SELECT COUNT(*) FROM services')
    ]);

    console.log('--- Verification Summary ---');
    console.log(`- Users count: ${uRes.rows[0].count} (Only Admin)`);
    console.log(`- Technicians count: ${tRes.rows[0].count} (Purged)`);
    console.log(`- Bookings count: ${bRes.rows[0].count} (Purged)`);
    console.log(`- Services catalog: ${sRes.rows[0].count} (Preserved for bookings)`);
    console.log('Purge completed successfully.');
  } catch (err) {
    console.error('Error during purge:', err);
  } finally {
    await pool.end();
  }
}

truncateAllExceptAdmin();
