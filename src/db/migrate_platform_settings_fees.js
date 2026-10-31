const { query, pool } = require('./db');

async function migrateFees() {
  try {
    await query(`
      ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS customer_platform_fee_percent NUMERIC(5,2) DEFAULT 2.00;
      ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS gateway_fee_percent NUMERIC(5,2) DEFAULT 2.00;
      ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS payment_gateway_fee_percent NUMERIC(5,2) DEFAULT 2.00;
      ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS partner_commission_percent NUMERIC(5,2) DEFAULT 2.00;
      ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS platform_commission_percent NUMERIC(5,2) DEFAULT 2.00;

      UPDATE platform_settings SET 
        customer_platform_fee_percent = 2.00,
        gateway_fee_percent = 2.00,
        payment_gateway_fee_percent = 2.00,
        partner_commission_percent = 2.00,
        platform_commission_percent = 2.00
      WHERE id = 'reward_settings';
    `);
    console.log('✅ Migrated platform_settings: Fee matrix fully consolidated in database.');
    
    const res = await query(`SELECT * FROM platform_settings WHERE id = 'reward_settings'`);
    console.log('📊 Consolidated platform_settings row:', res.rows[0]);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
  } finally {
    await pool.end();
  }
}

migrateFees();
