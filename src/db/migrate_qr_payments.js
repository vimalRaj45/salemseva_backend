const { query, pool } = require('./db');

async function migrateQrPayments() {
  console.log('--- Migrating database for Dynamic UPI QR & Manual Verification ---');
  try {
    // 1. Update payments table with verification & OCR columns
    await query(`
      ALTER TABLE payments
        ADD COLUMN IF NOT EXISTS customer_utr VARCHAR(64),
        ADD COLUMN IF NOT EXISTS ocr_detected_utr VARCHAR(64),
        ADD COLUMN IF NOT EXISTS screenshot_url TEXT,
        ADD COLUMN IF NOT EXISTS verification_status VARCHAR(30) DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS verified_by VARCHAR(64),
        ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

      CREATE INDEX IF NOT EXISTS idx_payments_verification_status ON payments(verification_status);
      CREATE INDEX IF NOT EXISTS idx_payments_customer_utr ON payments(customer_utr);
    `);
    console.log('Payments table columns and indexes verified successfully.');

    // 2. Update platform_settings table with business UPI VPA and gateway mode
    await query(`
      ALTER TABLE platform_settings
        ADD COLUMN IF NOT EXISTS business_upi_id VARCHAR(100) DEFAULT 'shazuone.pay@icici',
        ADD COLUMN IF NOT EXISTS business_merchant_name VARCHAR(150) DEFAULT 'Shazu One Home Services',
        ADD COLUMN IF NOT EXISTS payment_gateway_mode VARCHAR(50) DEFAULT 'DYNAMIC_QR';

      UPDATE platform_settings
      SET 
        business_upi_id = COALESCE(business_upi_id, 'shazuone.pay@icici'),
        business_merchant_name = COALESCE(business_merchant_name, 'Shazu One Home Services'),
        payment_gateway_mode = COALESCE(payment_gateway_mode, 'DYNAMIC_QR')
      WHERE id = 'reward_settings';
    `);
    console.log('Platform settings updated with business UPI configuration.');

    const res = await query(`SELECT business_upi_id, business_merchant_name, payment_gateway_mode FROM platform_settings WHERE id = 'reward_settings'`);
    console.log('Current payment config in DB:', res.rows[0]);

  } catch (err) {
    console.error('Migration error:', err.message);
  } finally {
    await pool.end();
  }
}

migrateQrPayments();
