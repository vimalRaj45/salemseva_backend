const { query } = require('./db');

async function runTruncate() {
  console.log('--- STARTING TRUNCATION OF TRANSACTIONS, CUSTOMERS, AND TECHNICIANS ---');
  try {
    // 1. Clear child transaction and booking activity tables
    console.log('Truncating payments, payouts, wallet, and bookings...');
    await query(`
      TRUNCATE TABLE payments CASCADE;
      TRUNCATE TABLE wallet_transactions CASCADE;
      TRUNCATE TABLE technician_payouts CASCADE;
      TRUNCATE TABLE technician_referrals CASCADE;
      TRUNCATE TABLE technician_rejected_leads CASCADE;
      TRUNCATE TABLE quote_items CASCADE;
      TRUNCATE TABLE call_logs CASCADE;
      TRUNCATE TABLE chat_messages CASCADE;
      TRUNCATE TABLE booking_reschedule_logs CASCADE;
      TRUNCATE TABLE reviews CASCADE;
      TRUNCATE TABLE support_tickets CASCADE;
      TRUNCATE TABLE bookings CASCADE;
      TRUNCATE TABLE otp_verifications CASCADE;
      TRUNCATE TABLE push_subscriptions CASCADE;
      TRUNCATE TABLE passkey_credentials CASCADE;
    `);

    // 2. Clear technicians
    console.log('Truncating technicians...');
    await query(`TRUNCATE TABLE technicians CASCADE;`);

    // 3. Clear non-admin customers/users
    console.log('Removing non-admin customer and technician users...');
    const delRes = await query(`DELETE FROM users WHERE role != 'admin' RETURNING id, phone, email, role;`);
    console.log(`Deleted ${delRes.rowCount} user(s):`, delRes.rows);

    // Verify remaining admin
    const remainingUsers = await query(`SELECT id, phone, email, role FROM users;`);
    console.log('Remaining admin users:', remainingUsers.rows);

    console.log('--- TRUNCATION COMPLETE SUCCESSFULLY ---');
  } catch (err) {
    console.error('Truncation error:', err);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

runTruncate();
