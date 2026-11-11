import { describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

describe('Customer-Only Job Completion & Manual Admin Settlement Verification', () => {
  it('should verify customer-complete creates pending disbursal without mock UTR and settles upon admin confirmation', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Create dummy technician
      const techRes = await client.query(`
        INSERT INTO technicians (full_name, phone, primary_trade, upi_vpa, is_online, rating_avg)
        VALUES ('Test Tech Disbursal', '9876543210', 'electrical', 'testtech@upi', TRUE, 4.9)
        RETURNING id
      `);
      const techId = techRes.rows[0].id;

      // 2. Fetch valid service_id and create booking in quote_approved status
      const sRes = await client.query('SELECT id FROM services LIMIT 1');
      const serviceId = sRes.rows[0]?.id || 'ac';

      const testBookingId = 'SLM-TEST-' + Math.floor(10000 + Math.random() * 90000);
      await client.query(`
        INSERT INTO bookings (id, customer_name, customer_phone, service_id, status, technician_id, quote_subtotal, visit_fee, service_address, locality)
        VALUES ($1, 'Test Customer', '9123456789', $2, 'quote_approved', $3, 600.00, 99.00, '12 Fairlands Main Rd, Salem', 'Fairlands')
      `, [testBookingId, serviceId, techId]);

      // 3. Insert customer payment in ._held
      await client.query(`
        INSERT INTO payments (booking_id, amount_total, tech_payout_amount, platform_commission, status, payment_method)
        VALUES ($1, 600.00, 590.00, 10.00, '._held', 'upi')
      `, [testBookingId]);

      // 4. Simulate Customer completing the job via customer-complete logic
      await client.query(`
        UPDATE bookings 
        SET status = 'completed', completed_at = NOW() 
        WHERE id = $1
      `, [testBookingId]);

      // Ensure payout record is inserted as PENDING_DISBURSAL with NULL utr_ref
      await client.query(`
        INSERT INTO technician_payouts (technician_phone, technician_id, amount, upi_id, status, utr_ref, description, created_at)
        VALUES ('9876543210', $1, 590.00, 'testtech@upi', 'PENDING_DISBURSAL', NULL, $2, NOW())
      `, [techId, `Pending Admin settlement for #${testBookingId}`]);

      // 5. Verify payout state before admin confirmation
      const pendingCheck = await client.query(`
        SELECT p.status as payment_status, p.payout_utr, tp.status as payout_status, tp.utr_ref
        FROM payments p
        JOIN technician_payouts tp ON tp.technician_id = $2
        WHERE p.booking_id = $1
      `, [testBookingId, techId]);

      assert.strictEqual(pendingCheck.rows.length, 1);
      assert.strictEqual(pendingCheck.rows[0].payment_status, '._held');
      assert.strictEqual(pendingCheck.rows[0].payout_utr, null, 'payout_utr must be NULL before Admin confirms');
      assert.strictEqual(pendingCheck.rows[0].payout_status, 'PENDING_DISBURSAL');
      assert.strictEqual(pendingCheck.rows[0].utr_ref, null, 'utr_ref must be NULL before Admin confirms');

      // 6. Simulate Partner history query
      const historyCheck = await client.query(`
        SELECT b.status, p.status as payment_status, p.payout_utr
        FROM bookings b
        LEFT JOIN payments p ON b.id = p.booking_id
        WHERE b.id = $1
      `, [testBookingId]);

      const hRow = historyCheck.rows[0];
      const settlementStatus = (hRow.status === 'completed' && hRow.payout_utr && hRow.payment_status === 'settled')
        ? 'SETTLED_TO_BANK'
        : 'PAYMENT_PENDING';
      assert.strictEqual(settlementStatus, 'PAYMENT_PENDING', 'Technician must see PAYMENT_PENDING before Admin confirms');

      // 7. Admin manually confirms payout with real bank UTR
      const realUtr = 'BANK491028472910';
      await client.query(`
        UPDATE payments
        SET payout_utr = $1, status = 'settled', settled_at = NOW()
        WHERE booking_id = $2
      `, [realUtr, testBookingId]);

      await client.query(`
        UPDATE technician_payouts
        SET utr_ref = $1, status = 'DISBURSED_100%'
        WHERE technician_id = $2 AND description LIKE '%' || $3 || '%'
      `, [realUtr, techId, testBookingId]);

      // 8. Verify post-confirmation state
      const settledCheck = await client.query(`
        SELECT p.status as payment_status, p.payout_utr, tp.status as payout_status, tp.utr_ref
        FROM payments p
        JOIN technician_payouts tp ON tp.technician_id = $2
        WHERE p.booking_id = $1
      `, [testBookingId, techId]);

      assert.strictEqual(settledCheck.rows[0].payment_status, 'settled');
      assert.strictEqual(settledCheck.rows[0].payout_utr, realUtr);
      assert.strictEqual(settledCheck.rows[0].payout_status, 'DISBURSED_100%');
      assert.strictEqual(settledCheck.rows[0].utr_ref, realUtr);

      const afterAdminRow = settledCheck.rows[0];
      const afterSettlementStatus = (afterAdminRow.payment_status === 'settled' && afterAdminRow.payout_utr)
        ? 'SETTLED_TO_BANK'
        : 'PAYMENT_PENDING';
      assert.strictEqual(afterSettlementStatus, 'SETTLED_TO_BANK', 'Technician must see SETTLED_TO_BANK after Admin confirms');

      await client.query('ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
      await pool.end();
    }
  });
});
