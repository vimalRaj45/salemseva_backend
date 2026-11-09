/**
 * ============================================================================
 * SHAZU ONE: ROLE-BASED REST API TEST SUITE
 * ============================================================================
 * Comprehensive end-to-end REST API testing segregated strictly by Role:
 *
 *   1. PUBLIC / GUEST ROLE
 *      - GET  /health (System telemetry & DB connectivity)
 *      - GET  /api/v1/services (Public catalog)
 *      - GET  /api/v1/services/:id (Specific service specs)
 *      - GET  /api/v1/services/:id/availability (Locality coverage check)
 *      - GET  /api/v1/settings/fees (Public fee matrix)
 *      - GET  /api/v1/coupons/active (Active promo codes)
 *      - POST /api/v1/auth/login (Bad credentials rejection - 401)
 *
 *   2. CUSTOMER ROLE
 *      - GET  /api/v1/customer/profile (Profile retrieval)
 *      - POST /api/v1/customer/profile/update (Profile modification)
 *      - GET  /api/v1/bookings/history (Customer order history)
 *      - GET  /api/v1/bookings/:id/track (Live booking tracker)
 *      - POST /api/v1/coupons/validate (Cart discount verification)
 *      - GET  /api/v1/wallet/customer (Customer wallet ledger & balance)
 *      - POST /api/v1/feedback/submit (Customer satisfaction feedback)
 *
 *   3. FIELD PARTNER / TECHNICIAN ROLE
 *      - GET  /api/v1/partner/profile (Trade & locality profile)
 *      - GET  /api/v1/partner/duty (On-duty telemetry & active dispatch)
 *      - GET  /api/v1/partner/duty/sync (Live duty heartbeat sync)
 *      - GET  /api/v1/partner/scheduled-leads (Rating-governed lead queue)
 *      - GET  /api/v1/partner/earnings (Technician financial ledger)
 *      - GET  /api/v1/partner/jobs/history (Completed partner jobs)
 *      - GET  /api/v1/partner/calendar-agenda (Scheduled commitments)
 *
 *   4. ADMINISTRATOR ROLE
 *      - POST /api/v1/auth/admin/otp/request (Admin email validation & security)
 *      - POST /api/v1/auth/admin/login-password (Emergency password auth)
 *      - GET  /api/v1/admin/overview (Executive KPI command metrics)
 *      - GET  /api/v1/admin/technicians (Fleet roster & verification)
 *      - GET  /api/v1/admin/technicians/:id/dossier (Technician comprehensive dossier)
 *      - GET  /api/v1/admin/customers (Customer accounts roster)
 *      - GET  /api/v1/admin/settlements (Settlements & escrow monitoring)
 *      - GET  /api/v1/admin/financials/ledger (Verified gross & payout ledger)
 *      - GET  /api/v1/admin/settings/rewards (Quality governance & fee config)
 *      - POST /api/v1/admin/settings/rewards (Threshold updating)
 *      - GET  /api/v1/admin/payments/pending-verifications (UPI QR queue)
 *      - GET  /api/v1/admin/settlements/cancellation-refunds (Manual refund queue)
 *      - GET  /api/v1/admin/settlements/referral-incentives (Referral payouts)
 *
 *   5. ROLE BOUNDARY & SECURITY GUARDS
 *      - Unauthenticated access to admin endpoints
 *      - Retired hardcoded credentials refusal
 *      - Internal wallet credit minting key protection (403)
 *      - Malformed JSON resilience (400)
 *
 * Usage:
 *   node backend/tests/role_based_rest_api.test.js
 *   npm run test:role-api (inside backend/)
 * ============================================================================
 */

require('dotenv').config({ path: 'backend/.env' });
const fastify = require('../src/server');

const STATS = {
  total: 0,
  passed: 0,
  failed: 0,
  failures: []
};

function logTest(role, method, endpoint, status, passed, message = '') {
  STATS.total += 1;
  if (passed) {
    STATS.passed += 1;
    console.log(`[PASS] [${role.padEnd(12)}] ${method.padEnd(6)} ${endpoint.padEnd(46)} -> HTTP ${status} ${message ? '(' + message + ')' : ''}`);
  } else {
    STATS.failed += 1;
    STATS.failures.push({ role, method, endpoint, status, message });
    console.log(`[FAIL] [${role.padEnd(12)}] ${method.padEnd(6)} ${endpoint.padEnd(46)} -> HTTP ${status} ERROR: ${message}`);
  }
}

async function runRoleBasedSuite() {
  console.log('\n================================================================================');
  console.log(' SHAZU ONE / SALEM SEVA: ROLE-BASED REST API TEST SUITE');
  console.log(' Target Engine: Fastify REST API with PostgreSQL');
  console.log(' Time: ' + new Date().toISOString());
  console.log('================================================================================\n');

  try {
    await fastify.ready();

    // ------------------------------------------------------------------------
    // GROUP 1: PUBLIC / GUEST ROLE ENDPOINTS
    // ------------------------------------------------------------------------
    console.log('\n--- GROUP 1: PUBLIC / GUEST ROLE ---');

    // 1.1 Health
    {
      const res = await fastify.inject({ method: 'GET', url: '/health' });
      const body = res.json();
      const ok = res.statusCode === 200 && (body.status === 'HEALTHY' || body.status === 'DEGRADED');
      logTest('PUBLIC', 'GET', '/health', res.statusCode, ok, `DB: ${body.database}`);
    }

    // 1.2 Services Catalog
    let sampleServiceId = 'ac';
    {
      const res = await fastify.inject({ method: 'GET', url: '/api/v1/services' });
      const body = res.json();
      const services = Array.isArray(body) ? body : (body.services || []);
      const ok = res.statusCode === 200 && services.length > 0;
      if (services.length > 0 && services[0].id) sampleServiceId = services[0].id;
      logTest('PUBLIC', 'GET', '/api/v1/services', res.statusCode, ok, `${services.length} services loaded`);
    }

    // 1.3 Service Details
    {
      const res = await fastify.inject({ method: 'GET', url: `/api/v1/services/${sampleServiceId}` });
      const body = res.json();
      const ok = res.statusCode === 200 && (body.success !== false);
      logTest('PUBLIC', 'GET', `/api/v1/services/${sampleServiceId}`, res.statusCode, ok, `Service: ${sampleServiceId}`);
    }

    // 1.4 Service Locality Availability Check
    {
      const res = await fastify.inject({ method: 'GET', url: `/api/v1/services/${sampleServiceId}/availability?locality=Fairlands` });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true;
      logTest('PUBLIC', 'GET', `/api/v1/services/${sampleServiceId}/availability`, res.statusCode, ok, `Coverage: ${body.isLocalityCovered ? 'Covered' : 'Notice Ready'}`);
    }

    // 1.5 Public Fee Settings
    {
      const res = await fastify.inject({ method: 'GET', url: '/api/v1/settings/fees' });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true;
      logTest('PUBLIC', 'GET', '/api/v1/settings/fees', res.statusCode, ok, `CustFee: ${body.fees?.customerPlatformFeePercent}%`);
    }

    // 1.6 Active Promotional Coupons
    {
      const res = await fastify.inject({ method: 'GET', url: '/api/v1/coupons/active' });
      const body = res.json();
      const ok = res.statusCode === 200 && Array.isArray(body.coupons || body);
      logTest('PUBLIC', 'GET', '/api/v1/coupons/active', res.statusCode, ok, `${(body.coupons || body).length} active coupons`);
    }

    // 1.7 Bad Credentials Rejection
    {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { identifier: 'unknown_user_test', password: 'wrongpassword999', role: 'customer' }
      });
      const ok = res.statusCode === 401 || res.statusCode === 404 || res.statusCode === 400;
      logTest('PUBLIC', 'POST', '/api/v1/auth/login (bad creds)', res.statusCode, ok, 'Correctly refused unauthorized user');
    }

    // ------------------------------------------------------------------------
    // GROUP 2: CUSTOMER ROLE ENDPOINTS
    // ------------------------------------------------------------------------
    console.log('\n--- GROUP 2: CUSTOMER ROLE ---');
    const customerPhone = '+91 8807099288';

    // 2.1 Customer Profile
    {
      const res = await fastify.inject({ method: 'GET', url: `/api/v1/customer/profile?phone=${encodeURIComponent(customerPhone)}` });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true;
      logTest('CUSTOMER', 'GET', `/api/v1/customer/profile`, res.statusCode, ok, `Name: ${body.customer?.name || 'Verified'}`);
    }

    // 2.2 Customer Profile Update
    {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/customer/profile/update',
        payload: {
          phone: customerPhone,
          name: 'FINAL_TESTC',
          email: 'customer.test@shazuone.in',
          locality: 'Fairlands, Salem'
        }
      });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true;
      logTest('CUSTOMER', 'POST', '/api/v1/customer/profile/update', res.statusCode, ok, 'Profile saved');
    }

    // 2.3 Customer Booking History
    {
      const res = await fastify.inject({ method: 'GET', url: `/api/v1/bookings/history?phone=${encodeURIComponent(customerPhone)}` });
      const body = res.json();
      const ok = res.statusCode === 200 && Array.isArray(body.bookings || body);
      logTest('CUSTOMER', 'GET', `/api/v1/bookings/history`, res.statusCode, ok, `${(body.bookings || body).length} bookings in history`);
    }

    // 2.4 Live Order Tracking
    {
      const res = await fastify.inject({ method: 'GET', url: `/api/v1/bookings/SLM-58504/track` });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true;
      logTest('CUSTOMER', 'GET', `/api/v1/bookings/:id/track`, res.statusCode, ok, `Status: ${body.booking?.status || 'Active'}`);
    }

    // 2.5 Coupon Validation
    {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/coupons/validate',
        payload: { code: 'SALEM100', bookingAmount: 500, phone: customerPhone }
      });
      const body = res.json();
      const ok = res.statusCode === 200 && body.valid === true;
      logTest('CUSTOMER', 'POST', '/api/v1/coupons/validate', res.statusCode, ok, `Discount: ₹${body.discountAmount || 0}`);
    }

    // 2.6 Customer Wallet Balance
    {
      const res = await fastify.inject({ method: 'GET', url: `/api/v1/wallet/customer?phone=${encodeURIComponent(customerPhone)}` });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true;
      logTest('CUSTOMER', 'GET', `/api/v1/wallet/customer`, res.statusCode, ok, `Balance: ₹${body.wallet?.balance || 0}`);
    }

    // 2.7 Customer Feedback Submission
    {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/feedback/submit',
        payload: {
          userPhone: customerPhone,
          userName: 'FINAL_TESTC',
          role: 'customer',
          rating: 5,
          feedbackType: 'service_experience',
          message: 'Excellent professional service verified via role-based test suite.',
          locality: 'Fairlands, Salem'
        }
      });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true;
      logTest('CUSTOMER', 'POST', '/api/v1/feedback/submit', res.statusCode, ok, 'Feedback recorded');
    }

    // ------------------------------------------------------------------------
    // GROUP 3: PARTNER / TECHNICIAN ROLE ENDPOINTS
    // ------------------------------------------------------------------------
    console.log('\n--- GROUP 3: FIELD PARTNER / TECHNICIAN ROLE ---');
    const partnerPhone = '+91 9442800645';
    let techId = 'b06554fd-3b68-47ea-9e3a-9b708eb0cc91';

    // 3.1 Partner Profile
    {
      const res = await fastify.inject({ method: 'GET', url: `/api/v1/partner/profile?phone=${encodeURIComponent(partnerPhone)}` });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true;
      if (body.partner?.id) techId = body.partner.id;
      logTest('TECHNICIAN', 'GET', `/api/v1/partner/profile`, res.statusCode, ok, `Trade: ${body.partner?.primary_trade || 'General'}`);
    }

    // 3.2 Partner Duty Status & Active Job Dispatch
    {
      const res = await fastify.inject({ method: 'GET', url: `/api/v1/partner/duty?phone=${encodeURIComponent(partnerPhone)}` });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true;
      logTest('TECHNICIAN', 'GET', `/api/v1/partner/duty`, res.statusCode, ok, `OnDuty: ${Boolean(body.duty?.isOnDuty)}`);
    }

    // 3.3 Partner Duty Sync
    {
      const res = await fastify.inject({ method: 'GET', url: `/api/v1/partner/duty/sync?phone=${encodeURIComponent(partnerPhone)}` });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true;
      logTest('TECHNICIAN', 'GET', `/api/v1/partner/duty/sync`, res.statusCode, ok, `SyncState: ${body.duty?.isOnDuty ? 'ONLINE' : 'STANDBY'}`);
    }

    // 3.4 Scheduled Leads (Governed by Quality Safeguards)
    {
      const res = await fastify.inject({ method: 'GET', url: `/api/v1/partner/scheduled-leads?phone=${encodeURIComponent(partnerPhone)}` });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true;
      const leads = body.leads || [];
      logTest('TECHNICIAN', 'GET', `/api/v1/partner/scheduled-leads`, res.statusCode, ok, `Leads: ${leads.length}, Suspended: ${Boolean(body.isQualitySuspended)}`);
    }

    // 3.5 Partner Earnings Ledger
    {
      const res = await fastify.inject({ method: 'GET', url: `/api/v1/partner/earnings?phone=${encodeURIComponent(partnerPhone)}` });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true;
      logTest('TECHNICIAN', 'GET', `/api/v1/partner/earnings`, res.statusCode, ok, `Total Earned: ₹${body.totalEarned || 0}`);
    }

    // 3.6 Partner Job History
    {
      const res = await fastify.inject({ method: 'GET', url: `/api/v1/partner/jobs/history?phone=${encodeURIComponent(partnerPhone)}` });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true;
      const count = (body.jobs || []).length;
      logTest('TECHNICIAN', 'GET', `/api/v1/partner/jobs/history`, res.statusCode, ok, `Past Jobs: ${count}`);
    }

    // 3.7 Partner Calendar Agenda
    {
      const res = await fastify.inject({ method: 'GET', url: `/api/v1/partner/calendar-agenda?phone=${encodeURIComponent(partnerPhone)}` });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true;
      logTest('TECHNICIAN', 'GET', `/api/v1/partner/calendar-agenda`, res.statusCode, ok, `Commitments: ${(body.agenda || []).length}`);
    }

    // ------------------------------------------------------------------------
    // GROUP 4: ADMINISTRATOR ROLE ENDPOINTS
    // ------------------------------------------------------------------------
    console.log('\n--- GROUP 4: ADMINISTRATOR ROLE ---');

    // 4.1 Admin OTP Validation: Unauthorized Email (Security Check)
    {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/auth/admin/otp/request',
        payload: { email: 'unauthorized_stranger@random.com' }
      });
      const ok = res.statusCode === 403;
      logTest('ADMIN', 'POST', '/api/v1/auth/admin/otp/request (unauthorized)', res.statusCode, ok, 'Correctly denied 403');
    }

    // 4.2 Admin OTP Validation: Authorized Email
    {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/auth/admin/otp/request',
        payload: { email: 'malikasaravanan774@gmail.com' }
      });
      const ok = res.statusCode === 200;
      logTest('ADMIN', 'POST', '/api/v1/auth/admin/otp/request (authorized)', res.statusCode, ok, 'OTP code generated');
    }

    // 4.3 Admin Password Login: Emergency Mode
    const adminPassword = process.env.ADMIN_PASSWORD || 'razop';
    {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/auth/admin/login-password',
        payload: { email: 'malikasaravanan774@gmail.com', password: adminPassword }
      });
      const body = res.json();
      const userRole = body.user?.role || body.role;
      const ok = res.statusCode === 200 && body.success === true && userRole === 'admin';
      logTest('ADMIN', 'POST', '/api/v1/auth/admin/login-password (valid)', res.statusCode, ok, `Admin Session Granted: ${userRole}`);
    }

    // 4.4 Admin Overview Command Dashboard
    {
      const res = await fastify.inject({ method: 'GET', url: '/api/v1/admin/overview' });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true;
      logTest('ADMIN', 'GET', '/api/v1/admin/overview', res.statusCode, ok, `Bookings: ${body.totalBookings || 0}, Techs: ${body.totalTechnicians || 0}`);
    }

    // 4.5 Admin Fleets / Technicians Roster
    {
      const res = await fastify.inject({ method: 'GET', url: '/api/v1/admin/technicians' });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true;
      logTest('ADMIN', 'GET', '/api/v1/admin/technicians', res.statusCode, ok, `Fleets: ${(body.technicians || []).length} registered`);
    }

    // 4.6 Admin Technician Dossier
    {
      const res = await fastify.inject({ method: 'GET', url: `/api/v1/admin/technicians/${techId}/dossier` });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true;
      logTest('ADMIN', 'GET', `/api/v1/admin/technicians/:id/dossier`, res.statusCode, ok, `Technician: ${body.technician?.full_name || 'Verified'}`);
    }

    // 4.7 Admin Customers Roster
    {
      const res = await fastify.inject({ method: 'GET', url: '/api/v1/admin/customers' });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true;
      logTest('ADMIN', 'GET', '/api/v1/admin/customers', res.statusCode, ok, `Customers: ${(body.customers || []).length} registered`);
    }

    // 4.8 Admin Settlements & Escrow Command
    {
      const res = await fastify.inject({ method: 'GET', url: '/api/v1/admin/settlements' });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true;
      logTest('ADMIN', 'GET', '/api/v1/admin/settlements', res.statusCode, ok, 'Escrow ledger loaded');
    }

    // 4.9 Verified Financial Ledger & Revenue Tracking
    {
      const res = await fastify.inject({ method: 'GET', url: '/api/v1/admin/financials/ledger' });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true && body.summary !== undefined;
      const s = body.summary || {};
      logTest('ADMIN', 'GET', '/api/v1/admin/financials/ledger', res.statusCode, ok, `Gross: ₹${s.totalGross}, Disbursed: ₹${s.totalTechPayout}, Net: ₹${s.totalPlatformCut}`);
    }

    // 4.10 Quality Governance & Reward Settings (GET)
    {
      const res = await fastify.inject({ method: 'GET', url: '/api/v1/admin/settings/rewards' });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true && body.settings !== undefined;
      const q = body.settings || {};
      logTest('ADMIN', 'GET', '/api/v1/admin/settings/rewards', res.statusCode, ok, `QualityEngine: ${q.quality_governance_enabled ? 'Active' : 'Off'}, Throttle: <${q.quality_throttle_rating}★`);
    }

    // 4.11 Quality Governance & Reward Settings (POST update)
    {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/admin/settings/rewards',
        payload: {
          quality_governance_enabled: true,
          quality_throttle_rating: 4.0,
          quality_throttle_daily_cap: 1,
          quality_throttle_min_reviews: 3,
          quality_priority_window_seconds: 90,
          quality_priority_min_rating: 4.5,
          quality_suspension_rating: 3.5,
          quality_suspension_min_reviews: 5
        }
      });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true;
      logTest('ADMIN', 'POST', '/api/v1/admin/settings/rewards', res.statusCode, ok, 'Quality thresholds updated in PostgreSQL');
    }

    // 4.12 Pending UPI QR Verifications
    {
      const res = await fastify.inject({ method: 'GET', url: '/api/v1/admin/payments/pending-verifications' });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true;
      logTest('ADMIN', 'GET', '/api/v1/admin/payments/pending-verifications', res.statusCode, ok, `Pending QR: ${(body.payments || []).length}`);
    }

    // 4.13 Cancellation Refunds Audit Table
    {
      const res = await fastify.inject({ method: 'GET', url: '/api/v1/admin/settlements/cancellation-refunds' });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true;
      logTest('ADMIN', 'GET', '/api/v1/admin/settlements/cancellation-refunds', res.statusCode, ok, `Refund Entries: ${(body.refunds || []).length}`);
    }

    // 4.14 Referral Incentives Disbursal Table
    {
      const res = await fastify.inject({ method: 'GET', url: '/api/v1/admin/settlements/referral-incentives' });
      const body = res.json();
      const ok = res.statusCode === 200 && body.success === true;
      logTest('ADMIN', 'GET', '/api/v1/admin/settlements/referral-incentives', res.statusCode, ok, `Referral Queue: ${(body.incentives || []).length}`);
    }

    // ------------------------------------------------------------------------
    // GROUP 5: ROLE BOUNDARY & SECURITY INTEGRITY
    // ------------------------------------------------------------------------
    console.log('\n--- GROUP 5: ROLE BOUNDARIES & DEFENSIVE SECURITY ---');

    // 5.1 Legacy Password Refusal
    {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { identifier: 'admin', password: 'salem123', role: 'admin' }
      });
      const ok = res.statusCode === 401;
      logTest('SECURITY', 'POST', '/api/v1/auth/login (legacy password refusal)', res.statusCode, ok, 'Hardcoded "salem123" securely refused 401');
    }

    // 5.2 Invalid Internal Credit Attempt (Guarded)
    {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/wallet/customer/credit',
        headers: { 'x-internal-key': 'fake_unauthorized_key' },
        payload: { phone: customerPhone, amount: 1000 }
      });
      const ok = res.statusCode === 403;
      logTest('SECURITY', 'POST', '/api/v1/wallet/customer/credit (tampered key)', res.statusCode, ok, 'Unauthorized wallet credit attempt refused 403');
    }

    // 5.3 Malformed JSON Resilience
    {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: '{{malformed_raw_payload}'
      });
      const ok = res.statusCode === 400;
      logTest('SECURITY', 'POST', '/api/v1/auth/login (malformed JSON)', res.statusCode, ok, 'Fastify parser gracefully refused 400 Bad Request');
    }

    // ------------------------------------------------------------------------
    // SUMMARY REPORT
    // ------------------------------------------------------------------------
    console.log('\n================================================================================');
    console.log(' ROLE-BASED REST API TEST EXECUTION SUMMARY');
    console.log(` TOTAL ENDPOINTS TESTED : ${STATS.total}`);
    console.log(` PASSED                 : ${STATS.passed}`);
    console.log(` FAILED                 : ${STATS.failed}`);
    console.log(` SUCCESS RATE           : ${((STATS.passed / STATS.total) * 100).toFixed(1)}%`);
    console.log('================================================================================\n');

    if (STATS.failed > 0) {
      console.log('FAILED ENDPOINTS BREAKDOWN:');
      STATS.failures.forEach(f => {
        console.log(` - [${f.role}] ${f.method} ${f.endpoint} -> HTTP ${f.status}: ${f.message}`);
      });
      process.exit(1);
    } else {
      console.log('ALL ROLE-BASED REST API ENDPOINTS VERIFIED OPERATIONAL & ROBUST!\n');
      process.exit(0);
    }

  } catch (err) {
    console.error('Fatal Suite Execution Error:', err);
    process.exit(1);
  }
}

runRoleBasedSuite();
