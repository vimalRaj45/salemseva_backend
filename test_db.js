const { pool, query } = require('./src/db/db');

async function testDb() {
  try {
    console.log('Testing Neon DB connection...');
    const res = await query('SELECT NOW() as current_time, current_database() as db_name;');
    console.log('✅ Neon DB Connected:', res.rows[0]);

    const tables = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    console.log('📊 Active Tables in Neon DB:', tables.rows.map(r => r.table_name));

    const services = await query('SELECT count(*) FROM services;');
    console.log('🔧 Services count:', services.rows[0].count);

    const techs = await query('SELECT count(*) FROM technicians;');
    console.log('👨‍🔧 Technicians count:', techs.rows[0].count);

  } catch (err) {
    console.error('❌ DB Test Error:', err);
  } finally {
    await pool.end();
  }
}

testDb();
