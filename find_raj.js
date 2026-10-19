const { query } = require('../backend/src/db/db');

async function findRajendran() {
  try {
    const users = await query(`
      SELECT id, full_name, email, phone, role, password_hash, created_at 
      FROM users 
      WHERE LOWER(full_name) LIKE '%raj%' OR LOWER(email) LIKE '%raj%'
    `);
    
    const techs = await query(`
      SELECT id, full_name, email, phone, primary_trade, password_hash, created_at 
      FROM technicians 
      WHERE LOWER(full_name) LIKE '%raj%' OR LOWER(email) LIKE '%raj%'
    `);

    const bookings = await query(`
      SELECT id, customer_name, customer_phone, customer_otp, status, technician_name, service_id, scheduled_slot
      FROM bookings 
      WHERE LOWER(customer_name) LIKE '%raj%' OR LOWER(technician_name) LIKE '%raj%'
      LIMIT 10
    `);

    console.log(JSON.stringify({ users: users.rows, techs: techs.rows, bookings: bookings.rows }, null, 2));
  } catch (err) {
    console.error('Error querying DB:', err);
  } finally {
    process.exit(0);
  }
}

findRajendran();
