// Every payment-ledger statement in the codebase, planned against the real database.
//
// EXPLAIN builds the plan without executing, so a column that does not exist or a status
// label outside the payment_status enum fails here instead of failing silently inside a
// .catch() while the endpoint still answers 200. That is exactly how the ledger went
// unwritten for so long: the inserts named `amount` and `transaction_id`, neither of which
// is a column on `payments`, and every error was swallowed.
//
// Run this after any change to a payments statement, before deploying:
//   node tests/sql_statement_check.js
require('dotenv').config();
const { query, pool } = require('../src/db/db');

const CASES = [
  ['webhook escrow insert', `
    INSERT INTO payments (booking_id, razorpay_order_id, razorpay_payment_id, amount_total, tech_payout_amount, platform_commission, status, payment_method, created_at)
    VALUES ($1, $2, $3, $4, 0.00, 0.00, 'escrow_held', 'RAZORPAY_ESCROW', NOW())
    ON CONFLICT (razorpay_order_id) DO UPDATE
      SET razorpay_payment_id = EXCLUDED.razorpay_payment_id,
          amount_total = EXCLUDED.amount_total,
          status = CASE WHEN payments.status = 'settled' THEN payments.status ELSE 'escrow_held' END`,
    ['probe-booking', 'order_probe', 'pay_probe', 99]],

  ['/payments/verify escrow insert', `
    INSERT INTO payments (booking_id, razorpay_order_id, razorpay_payment_id, amount_total, tech_payout_amount, platform_commission, status, payment_method, created_at)
    VALUES ($1, $2, $3, $4, 0.00, 0.00, 'escrow_held', 'RAZORPAY_ESCROW', NOW())
    ON CONFLICT (razorpay_order_id) DO UPDATE
      SET razorpay_payment_id = EXCLUDED.razorpay_payment_id,
          amount_total = EXCLUDED.amount_total,
          status = CASE WHEN payments.status = 'settled' THEN payments.status ELSE 'escrow_held' END
    RETURNING *`,
    ['probe-booking', 'order_probe', 'pay_probe', 99]],

  ['settlement update in place', `
    UPDATE payments
    SET status = 'settled',
        amount_total = $2,
        tech_payout_amount = $3,
        platform_commission = $4,
        payment_method = 'UPI (Instant Escrow Released)',
        payout_utr = $5,
        settled_at = NOW()
    WHERE id = (
      SELECT id FROM payments WHERE booking_id = $1
      ORDER BY created_at DESC NULLS LAST LIMIT 1
    )`,
    ['probe-booking', 250, 200, 50, 'UPI-1234567-OKAXIS']],

  ['settlement insert fallback', `
    INSERT INTO payments (booking_id, amount_total, tech_payout_amount, platform_commission, status, payment_method, payout_utr, settled_at)
    VALUES ($1, $2, $3, $4, 'settled', 'UPI (Instant Escrow Released)', $5, NOW())`,
    ['probe-booking', 250, 200, 50, 'UPI-1234567-OKAXIS']],

  ['admin travel allowance insert', `
    INSERT INTO payments (booking_id, amount_total, tech_payout_amount, platform_commission, status, payment_method, settled_at)
    VALUES ($1, 99.00, 99.00, 0.00, 'settled', 'admin_travel_allowance', NOW())`,
    ['probe-booking']],

  ['admin refund on cancel', `
    UPDATE payments
    SET status = 'refunded',
        settled_at = NOW()
    WHERE booking_id = $1 AND status <> 'refunded'`,
    ['probe-booking']],

  ['booking cancel refund ledger insert', `
    INSERT INTO payments (booking_id, amount_total, pg_fee, platform_commission, tech_payout_amount, status, payment_method, settled_at)
    VALUES ($1, $2, $3, $4, 0.00, 'refunded', 'Razorpay Gateway Refund', NOW())`,
    ['probe-booking', 99, 1.98, 1.98]],

  ['manual payment override upsert', `
    INSERT INTO payments (
      booking_id, razorpay_order_id, razorpay_payment_id, amount_total,
      tech_payout_amount, platform_commission, status, payment_method, payout_utr,
      settled_at, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::payment_status, $8, $9, CASE WHEN $7 = 'settled' THEN NOW() ELSE NULL END, NOW())
    RETURNING *`,
    ['probe-booking', 'manual_ord', 'manual_pay', 250, 200, 50, 'settled', 'Direct UPI (Company QR)', 'UTR123']]
];

(async () => {
  let failures = 0;

  for (const [label, sql, params] of CASES) {
    try {
      await query(`EXPLAIN ${sql}`, params);
      console.log(`PASS  ${label}`);
    } catch (err) {
      failures += 1;
      console.log(`FAIL  ${label}\n      ${err.message}`);
    }
  }

  // The enum labels every one of those statements writes must exist on this database.
  const labels = await query(`
    SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'payment_status' ORDER BY e.enumsortorder`);
  const present = labels.rows.map(r => r.enumlabel);
  const used = ['escrow_held', 'settled', 'refunded'];
  const missing = used.filter(l => !present.includes(l));
  console.log(`payment_status labels: ${present.join(', ')}`);
  if (missing.length) {
    failures += 1;
    console.log(`FAIL  enum labels missing: ${missing.join(', ')}`);
  } else {
    console.log('PASS  every status label written by the code exists in the enum');
  }

  await pool.end();
  console.log(failures === 0 ? '\nALL STATEMENTS PLAN' : `\n${failures} STATEMENT(S) STILL BROKEN`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('PROBE ERROR', err.message);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
