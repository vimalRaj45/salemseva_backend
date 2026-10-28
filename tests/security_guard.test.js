/**
 * ============================================================================
 * SALEMSEVA / SHAZU ONE - SECURITY GUARD TEST
 * ============================================================================
 *
 * Proves the controls that were added to close the "API accepts anything" class:
 *
 *   1. A public route answers without a token, including a parameterised one.
 *   2. A protected route refuses a request with no token and rejects a forged token.
 *   3. An administrator session reaches /admin; a customer session does not.
 *   4. The old hardcoded admin password no longer works.
 *   5. /payments/verify writes the escrow row and refuses a forged signature.
 *   6. The Razorpay webhook refuses an unsigned payload and does not duplicate the
 *      escrow row when it is delivered for an order already on file.
 *   7. A destructive maintenance script refuses to run without confirmation.
 *   8. Partner onboarding requires a password, stores it as a scrypt hash, refuses to
 *      rewrite an account that already exists, and never falls back to 'salem123'.
 *
 * Usage
 *   node tests/security_guard.test.js [--base=http://127.0.0.1:8080]
 *
 * Requires the backend running, ADMIN_PASSWORD in .env, and RAZORPAY_KEY_SECRET for the
 * signature checks (skipped with a WARN when the secret is absent).
 *
 * Every row this test creates is deleted again. Nothing is left behind.
 */

require('dotenv').config();
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const path = require('path');
const { query, pool } = require('../src/db/db');

const BASE = (() => {
  const flag = process.argv.find(a => a.startsWith('--base='));
  if (flag) return flag.split('=')[1].replace(/\/+$/, '');
  return (process.env.TEST_API_URL || `http://127.0.0.1:${process.env.PORT || 8080}`).replace(/\/+$/, '');
})();

const TAG = Date.now().toString().slice(-6);
const PROBE_PHONE = `9${TAG}7731`.slice(0, 10);
const PARTNER_PHONE = `9${TAG}4422`.slice(0, 10);
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || KEY_SECRET;

let pass = 0;
let fail = 0;
let warn = 0;
const failures = [];
const created = { bookingIds: [], phones: [PROBE_PHONE, PARTNER_PHONE] };

function ok(label, detail) {
  pass += 1;
  console.log(`PASS  ${label}${detail ? '  ' + detail : ''}`);
}

function bad(label, detail) {
  fail += 1;
  failures.push(`${label}${detail ? ': ' + detail : ''}`);
  console.log(`FAIL  ${label}${detail ? '  ' + detail : ''}`);
}

function skip(label, detail) {
  warn += 1;
  console.log(`WARN  ${label}${detail ? '  ' + detail : ''}`);
}

function expect(condition, label, detail) {
  if (condition) ok(label, detail);
  else bad(label, detail);
}

async function call(method, route, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch (_) { /* non-JSON response kept as text */ }
  return { status: res.status, data };
}

const is2xx = (r) => r.status >= 200 && r.status < 300;

async function waitForApi() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch (_) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

async function signIn() {
  if (!process.env.ADMIN_PASSWORD) {
    bad('admin sign-in', 'ADMIN_PASSWORD is not set in the backend environment');
    return null;
  }
  const res = await call('POST', '/api/v1/auth/login', {
    identifier: 'admin', password: process.env.ADMIN_PASSWORD, role: 'admin'
  });
  if (!is2xx(res) || !res.data?.sessionToken) {
    bad('admin sign-in', `HTTP ${res.status}: ${res.data?.error || 'no token'}`);
    return null;
  }
  ok('admin sign-in', 'session token issued');
  return res.data.sessionToken;
}

async function guardChecks(adminToken) {
  const health = await call('GET', '/health');
  expect(health.status === 200 && health.data?.status === 'HEALTHY', 'GET /health is public');

  const services = await call('GET', '/api/v1/services');
  expect(services.status === 200, 'GET /api/v1/services is public', `HTTP ${services.status}`);

  const firstService = services.data?.services?.[0]?.id;
  if (firstService) {
    const detail = await call('GET', `/api/v1/services/${firstService}`);
    expect(detail.status === 200, 'parameterised public route resolves without a token', `HTTP ${detail.status}`);
  }

  const anon = await call('GET', '/api/v1/admin/overview');
  expect(anon.status === 401, 'protected route refuses a missing token', `HTTP ${anon.status}`);

  const forged = await call('GET', '/api/v1/admin/overview', undefined, `sess_${Date.now()}_deadbeef`);
  expect(forged.status === 401, 'protected route refuses a forged token', `HTTP ${forged.status}`);

  const anonHistory = await call('GET', `/api/v1/bookings/history?phone=${PROBE_PHONE}`);
  expect(anonHistory.status === 401, 'customer history refuses a missing token', `HTTP ${anonHistory.status}`);

  if (adminToken) {
    const withAdmin = await call('GET', '/api/v1/admin/overview', undefined, adminToken);
    expect(is2xx(withAdmin), 'admin token reaches /admin/overview', `HTTP ${withAdmin.status}`);
  }

  const legacy = await call('POST', '/api/v1/auth/login', {
    identifier: 'admin', password: 'salem123', role: 'admin'
  });
  expect(legacy.status === 401, 'the retired hardcoded admin password is refused', `HTTP ${legacy.status}`);

  // A customer session must not reach the admin surface.
  const register = await call('POST', '/api/v1/auth/register', {
    name: `Guard Probe ${TAG}`,
    phone: PROBE_PHONE,
    password: 'GuardProbe@12345',
    role: 'customer'
  });
  if (!is2xx(register)) {
    skip('customer role guard', `registration failed: ${register.status} ${register.data?.error || ''}`);
    return;
  }

  const login = await call('POST', '/api/v1/auth/login', {
    identifier: PROBE_PHONE, password: 'GuardProbe@12345', role: 'customer'
  });
  if (!is2xx(login) || !login.data?.sessionToken) {
    skip('customer role guard', `customer login failed: ${login.status} ${login.data?.error || ''}`);
    return;
  }
  const customerToken = login.data.sessionToken;
  ok('customer sign-in', 'session token issued');

  const forbidden = await call('GET', '/api/v1/admin/overview', undefined, customerToken);
  expect(forbidden.status === 403, 'customer session cannot reach /admin', `HTTP ${forbidden.status}`);

  const whatsapp = await call('POST', '/api/v1/auth/whatsapp/disconnect', {}, customerToken);
  expect(whatsapp.status === 403, 'customer session cannot control the WhatsApp gateway', `HTTP ${whatsapp.status}`);

  const otherWallet = await call('GET', '/api/v1/wallet/customer?phone=9999999999', undefined, customerToken);
  expect(otherWallet.status === 403, 'customer session cannot read another wallet', `HTTP ${otherWallet.status}`);

  const ownWallet = await call('GET', `/api/v1/wallet/customer?phone=${PROBE_PHONE}`, undefined, customerToken);
  expect(is2xx(ownWallet), 'customer session can read its own wallet', `HTTP ${ownWallet.status}`);
}

async function paymentChecks(adminToken) {
  if (!adminToken) {
    skip('payment ledger checks', 'no admin token');
    return;
  }
  if (!KEY_SECRET) {
    skip('payment ledger checks', 'RAZORPAY_KEY_SECRET is not set, so no signature can be produced');
    return;
  }

  const created_ = await call('POST', '/api/v1/bookings/create', {
    serviceId: 'ac',
    issueId: 'ac_cooling',
    customIssueText: `Security guard probe ${TAG}`,
    customerName: `Guard Probe ${TAG}`,
    customerPhone: PROBE_PHONE,
    address: '12 Fairlands, Salem - 636016',
    locality: 'Fairlands, Salem',
    lat: 11.6738,
    lng: 78.146,
    isUrgentDispatch: false
  }, adminToken);

  const bookingId = created_.data?.booking?.id || created_.data?.bookingId || created_.data?.id;
  if (!bookingId) {
    bad('create booking for payment checks', `HTTP ${created_.status}: ${JSON.stringify(created_.data).slice(0, 200)}`);
    return;
  }
  created.bookingIds.push(bookingId);
  ok('create booking for payment checks', String(bookingId));

  const orderId = `order_guard_${TAG}`;
  const paymentId = `pay_guard_${TAG}`;
  const signature = crypto.createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');

  const verify = await call('POST', '/api/v1/payments/verify', {
    bookingId, razorpay_order_id: orderId, razorpay_payment_id: paymentId,
    razorpay_signature: signature, amount: 99
  }, adminToken);
  expect(is2xx(verify), '/payments/verify accepts a correctly signed payment', `HTTP ${verify.status}`);

  const row = (await query('SELECT * FROM payments WHERE booking_id = $1', [bookingId])).rows[0];
  if (!row) {
    bad('escrow row written to the ledger', 'no payments row for the booking');
  } else {
    const amountOk = Number(row.amount_total) === 99;
    const notNullOk = row.tech_payout_amount !== null && row.platform_commission !== null;
    expect(amountOk && notNullOk && row.status === 'escrow_held',
      'escrow row written to the ledger',
      `status=${row.status} total=${row.amount_total} payout=${row.tech_payout_amount} commission=${row.platform_commission}`);
  }

  const forgedSignature = crypto.createHmac('sha256', 'not-the-secret').update(`${orderId}|${paymentId}`).digest('hex');
  const forged = await call('POST', '/api/v1/payments/verify', {
    bookingId, razorpay_order_id: `${orderId}_forged`, razorpay_payment_id: `${paymentId}_forged`,
    razorpay_signature: forgedSignature, amount: 99
  }, adminToken);
  expect(forged.status === 400, '/payments/verify refuses a forged signature', `HTTP ${forged.status}`);

  const unsigned = await call('POST', '/api/v1/payments/verify', {
    bookingId, razorpay_order_id: `${orderId}_unsigned`, razorpay_payment_id: `${paymentId}_unsigned`, amount: 99
  }, adminToken);
  expect(unsigned.status === 400, '/payments/verify refuses a payment with no signature', `HTTP ${unsigned.status}`);

  const webhookBody = JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: paymentId, order_id: orderId, amount: 9900, notes: { bookingId } } } }
  });
  const webhookSignature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(webhookBody).digest('hex');

  const signedWebhook = await fetch(`${BASE}/api/v1/payments/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': webhookSignature },
    body: webhookBody
  });
  expect(signedWebhook.ok, 'webhook accepts a correctly signed delivery', `HTTP ${signedWebhook.status}`);

  const unsignedWebhook = await fetch(`${BASE}/api/v1/payments/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: webhookBody
  });
  expect(unsignedWebhook.status === 400, 'webhook refuses an unsigned delivery', `HTTP ${unsignedWebhook.status}`);

  const rows = (await query('SELECT id FROM payments WHERE booking_id = $1', [bookingId])).rows;
  expect(rows.length === 1, 'a repeated webhook does not duplicate the escrow row', `${rows.length} row(s)`);
}

async function partnerOnboardChecks(adminToken) {
  if (!adminToken) {
    skip('partner onboarding checks', 'no admin token');
    return;
  }

  const noPassword = await call('POST', '/api/v1/partner/onboard', {
    fullName: `Guard Partner ${TAG}`, phone: PARTNER_PHONE, trade: 'ac'
  }, adminToken);
  expect(noPassword.status === 400, 'partner onboarding refuses a missing password', `HTTP ${noPassword.status}`);

  const first = await call('POST', '/api/v1/partner/onboard', {
    fullName: `Guard Partner ${TAG}`, phone: PARTNER_PHONE, password: 'PartnerProbe@123', trade: 'ac'
  }, adminToken);
  expect(is2xx(first), 'partner onboarding creates an account', `HTTP ${first.status}`);

  const readHash = async () => (await query(
    `SELECT password_hash FROM technicians
     WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1 LIMIT 1`, [PARTNER_PHONE]
  )).rows[0]?.password_hash;

  const before = await readHash();
  expect(Boolean(before) && String(before).startsWith('scrypt$'),
    'the partner password is stored as a scrypt hash', String(before || 'no row').slice(0, 12) + '...');

  const second = await call('POST', '/api/v1/partner/onboard', {
    fullName: 'Guard Partner Hijack', phone: PARTNER_PHONE, password: 'Attacker@123456', trade: 'plumber'
  }, adminToken);
  expect(second.status === 409, 're-onboarding an existing partner is refused', `HTTP ${second.status}`);

  const after = await readHash();
  expect(after === before, 're-onboarding cannot rewrite the stored password');

  const own = await call('POST', '/api/v1/auth/login', {
    identifier: PARTNER_PHONE, password: 'PartnerProbe@123', role: 'technician'
  });
  expect(is2xx(own), 'the partner signs in with the password set at onboarding', `HTTP ${own.status}`);

  const legacy = await call('POST', '/api/v1/auth/login', {
    identifier: PARTNER_PHONE, password: 'salem123', role: 'technician'
  });
  expect(legacy.status === 401, 'the retired partner default password is refused', `HTTP ${legacy.status}`);
}

function destructiveGuardCheck() {
  const script = path.join(__dirname, '..', 'src', 'db', 'truncate_all_except_admin.js');
  const result = spawnSync(process.execPath, [script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'development', CONFIRM_DESTRUCTIVE: '' },
    encoding: 'utf8',
    timeout: 30000
  });
  const refused = result.status !== 0 && /Refusing to run without confirmation/.test(result.stderr || '');
  expect(refused, 'the destructive purge script refuses to run unconfirmed',
    refused ? 'exited ' + result.status : `exited ${result.status} without refusing`);
}

async function cleanup() {
  const digits = created.phones.map(p => String(p).replace(/\D/g, '').slice(-10)).filter(Boolean);

  for (const bookingId of created.bookingIds) {
    await query('DELETE FROM payments WHERE booking_id = $1', [bookingId]).catch(() => {});
    await query('DELETE FROM audit_logs WHERE booking_id = $1', [bookingId]).catch(() => {});
    await query('DELETE FROM bookings WHERE id = $1', [bookingId]).catch(() => {});
  }
  await query(
    `DELETE FROM wallet_transactions WHERE RIGHT(REGEXP_REPLACE(user_phone, '\\D', '', 'g'), 10) = ANY($1)`,
    [digits]
  ).catch(() => {});
  await query(
    `DELETE FROM users WHERE role <> 'admin' AND RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = ANY($1)`,
    [digits]
  ).catch(() => {});
  await query(
    `DELETE FROM technicians WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = ANY($1)`,
    [digits]
  ).catch(() => {});

  const left = await query(
    `SELECT (SELECT COUNT(*) FROM users WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = ANY($1)) AS users,
            (SELECT COUNT(*) FROM bookings WHERE customer_phone = ANY($2)) AS bookings`,
    [digits, created.phones]
  );
  const remaining = Number(left.rows[0].users) + Number(left.rows[0].bookings);
  expect(remaining === 0, 'cleanup left no rows behind', `users+bookings = ${remaining}`);
}

async function main() {
  console.log('');
  console.log('======================================================================');
  console.log(' SHAZU ONE - SECURITY GUARD TEST');
  console.log('======================================================================');
  console.log(` target ${BASE}`);
  console.log('');

  if (!(await waitForApi())) {
    console.log(`FAIL  the API at ${BASE} did not become healthy`);
    process.exit(2);
  }

  try {
    const adminToken = await signIn();
    await guardChecks(adminToken);
    await paymentChecks(adminToken);
    await partnerOnboardChecks(adminToken);
    destructiveGuardCheck();
  } catch (err) {
    bad('run', err.stack || err.message);
  } finally {
    try { await cleanup(); } catch (err) { skip('cleanup', err.message); }
    try { await pool.end(); } catch (_) { /* already closed */ }
  }

  console.log('');
  console.log('======================================================================');
  console.log(` Checks: ${pass} passed, ${fail} failed, ${warn} warnings`);
  if (failures.length) {
    console.log(' Failures:');
    failures.forEach(f => console.log(`   - ${f}`));
  }
  console.log(` Verdict: ${fail === 0 ? 'PASS' : 'FAIL'}`);
  console.log('======================================================================');
  console.log('');

  process.exit(fail === 0 ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { main };
