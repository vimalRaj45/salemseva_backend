const { query, pool } = require('./db');

async function truncateTransactionalData() {
  console.log('⚡ SalemSeva: Truncating all transactional test data...');
  try {
    // Truncate transactional tables in cascade order (preserves users, technicians, services, service_issues, service_spares_catalog)
    await query(`
      TRUNCATE TABLE 
        audit_logs,
        reviews,
        payments,
        quote_items,
        bookings 
      RESTART IDENTITY CASCADE;
    `);

    console.log('✅ Successfully truncated all transactions!');
    console.log('📦 Master data preserved:');
    
    const [uCount, tCount, sCount] = await Promise.all([
      query('SELECT COUNT(*) FROM users'),
      query('SELECT COUNT(*) FROM technicians'),
      query('SELECT COUNT(*) FROM services')
    ]);

    console.log(` - Users: ${uCount.rows[0].count}`);
    console.log(` - Verified Technicians: ${tCount.rows[0].count}`);
    console.log(` - Service Categories: ${sCount.rows[0].count}`);
    console.log(' - Bookings: 0 (Fresh Clean State)');
  } catch (err) {
    console.error('❌ Error truncating data:', err.message);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

truncateTransactionalData();
