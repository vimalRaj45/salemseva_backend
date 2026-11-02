const { query, pool } = require('./db');

async function migrateAdvancePaymentColumns() {
  try {
    console.log('🔄 Running migration: advance_amount_paid and advance_coupon_discount in bookings table...');

    await query(`
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS advance_amount_paid NUMERIC(10,2) DEFAULT 0.00;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS advance_coupon_discount NUMERIC(10,2) DEFAULT 0.00;
    `);

    // Backfill historical rows:
    // If advance_amount_paid is 0 or null:
    // For bookings where quote_subtotal > 0, the advance paid was visit_fee - coupon_discount.
    // For other bookings, it's final_amount or visit_fee - coupon_discount.
    await query(`
      UPDATE bookings
      SET 
        advance_amount_paid = GREATEST(0.00, COALESCE(visit_fee, 99.00) - COALESCE(coupon_discount, 0.00)),
        advance_coupon_discount = COALESCE(coupon_discount, 0.00)
      WHERE advance_amount_paid IS NULL OR advance_amount_paid = 0.00;
    `);

    console.log('✅ Successfully added and backfilled advance payment columns in bookings table.');

    const sample = await query(`
      SELECT id, visit_fee, coupon_discount, advance_amount_paid, advance_coupon_discount, quote_subtotal, final_amount, status
      FROM bookings 
      ORDER BY created_at DESC 
      LIMIT 3
    `);
    console.log('📊 Sample verified bookings:', sample.rows);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
  } finally {
    await pool.end();
  }
}

migrateAdvancePaymentColumns();
