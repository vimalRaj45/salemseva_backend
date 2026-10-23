const { query, pool } = require('./db');

async function migratePushSubscriptions() {
  console.log('--- Migrating push_subscriptions table ---');
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        user_phone VARCHAR(20),
        user_role VARCHAR(20) DEFAULT 'customer',
        booking_id VARCHAR(64),
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_push_sub_phone ON push_subscriptions(user_phone);
      CREATE INDEX IF NOT EXISTS idx_push_sub_role ON push_subscriptions(user_role);
      CREATE INDEX IF NOT EXISTS idx_push_sub_booking ON push_subscriptions(booking_id);
    `);
    console.log('push_subscriptions table and indexes verified successfully!');
  } catch (err) {
    console.error('Migration error:', err);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  migratePushSubscriptions();
}

module.exports = { migratePushSubscriptions };
