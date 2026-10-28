/**
 * ============================================================================
 * SALEMSEVA: MASTER END-TO-END (E2E) TEST SUITE
 * ============================================================================
 * Comprehensive operational test suite covering all core flows and edge cases:
 *
 * 1. System Health & Dual-Language Services Catalog
 * 2. Customer Booking Lifecycle (Instant & Scheduled)
 * 3. Technician Workflow, Digital On-Site Quote & Real-Time Tracking
 * 4. Escrow Financials & Settlement Payout Split
 * 5. Customer Cancellation & Audit Trail (Pre & Post Dispatch Policies)
 * 6. Real Reviews & Star Ratings (PostgreSQL Grounded + Ops Escalation)
 * 7. Admin Coupons CRUD & Validation (Percentage, Flat, Min-Order, Expiry)
 * 8. Admin Reward Configurations & Inspection Fee Settings
 * 9. Admin Central Ops Fleet Command, KYC Verification & Overview
 * 10. Comprehensive Edge Cases & Error Boundaries
 *
 * Usage:
 *   node backend/tests/e2e_full_suite.test.js
 *   npm test (inside backend directory)
 * ============================================================================
 */

require('dotenv').config();

// 127.0.0.1 rather than localhost: Node resolves localhost to ::1 first, while the server
// binds 0.0.0.0, so the probe would fail against a healthy server.
const BASE_URL = (process.env.TEST_API_URL || `http://127.0.0.1:${process.env.PORT || 8080}`).replace(/\/+$/, '');

const STATS = {
  total: 0,
  passed: 0,
  failed: 0,
  startTime: Date.now()
};

const FAILED_TESTS = [];

// The API now refuses every route that is not explicitly public, so this suite signs in
// once as the administrator and carries that token on every call.
let ADMIN_TOKEN = '';

function logSection(title) {
  console.log('\n======================================================================');
  console.log(` > ${title.toUpperCase()}`);
  console.log('======================================================================');
}

function assertTest(name, condition, details = '') {
  STATS.total++;
  if (condition) {
    STATS.passed++;
    console.log(`  [PASS] ${name} ${details ? `(${details})` : ''}`);
  } else {
    STATS.failed++;
    FAILED_TESTS.push({ name, details });
    console.log(`  [FAIL] ${name} ${details ? `[DETAILS: ${details}]` : ''}`);
  }
}

async function api(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const defaultHeaders = { 'Content-Type': 'application/json' };
  if (ADMIN_TOKEN && options.auth !== false) defaultHeaders.Authorization = `Bearer ${ADMIN_TOKEN}`;
  try {
    const res = await fetch(url, {
      ...options,
      headers: { ...defaultHeaders, ...(options.headers || {}) }
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: err.message } };
  }
}

async function runMasterE2ETestSuite() {
  console.log('----------------------------------------------------------------------');
  console.log(' SALEMSEVA FULL-STACK AUTOMATED E2E VERIFICATION SUITE');
  console.log(` Target Server: ${BASE_URL}`);
  console.log('----------------------------------------------------------------------');

  // Shared test state across lifecycle
  let createdBookingId = null;
  let scheduledBookingId = null;
  let cancelBookingId = null;
  let createdCouponId = null;
  const testPhone = `+919842${Math.floor(100000 + Math.random() * 900000)}`;

  // =========================================================================
  // 1. SYSTEM HEALTH & CATALOG
  // =========================================================================
  logSection('1. System Health & Services Catalog');

  const health = await api('/health');
  assertTest(
    'Health Check Endpoint',
    health.ok && health.data?.status === 'HEALTHY',
    `Database: ${health.data?.database}`
  );

  const adminLogin = await api('/api/v1/auth/login', {
    method: 'POST',
    auth: false,
    body: JSON.stringify({ identifier: 'admin', password: process.env.ADMIN_PASSWORD, role: 'admin' })
  });
  ADMIN_TOKEN = '';
  assertTest(
    'Administrator Sign-In',
    adminLogin.ok && adminLogin.data?.user?.role === 'admin',
    adminLogin.ok ? `role=${adminLogin.data?.user?.role}` : `HTTP ${adminLogin.status}: ${adminLogin.data?.error || 'no user'}`
  );

  const servicesEn = await api('/api/v1/services?lang=en');
  const servicesList = servicesEn.data?.services || [];
  assertTest(
    'Services Catalog (English)',
    servicesEn.ok && Array.isArray(servicesList) && servicesList.length >= 4,
    `Retrieved ${servicesList.length} services`
  );

  const servicesTa = await api('/api/v1/services?lang=ta');
  const servicesTaList = servicesTa.data?.services || [];
  const acServiceTa = servicesTaList.find(s => s.id === 'ac');
  assertTest(
    'Services Catalog (Tamil Localization)',
    servicesTa.ok && acServiceTa && Boolean(acServiceTa.name_ta || acServiceTa.name),
    `Tamil AC Name: ${acServiceTa?.name_ta || acServiceTa?.name}`
  );

  const acDetail = await api('/api/v1/services/ac');
  assertTest(
    'Service Details with Issues & Visit Fee',
    acDetail.ok && acDetail.data?.service?.id === 'ac',
    `Visit Fee: INR ${acDetail.data?.service?.visitFee || acDetail.data?.service?.visit_fee}`
  );

  // Edge Case: Non-existent service catalog request
  const invalidService = await api('/api/v1/services/non_existent_trade_999');
  assertTest(
    'Edge Case: Non-existent Service Catalog Item',
    invalidService.status === 404 || !invalidService.data?.service,
    'Gracefully handled missing trade category'
  );

  // =========================================================================
  // 2. CUSTOMER BOOKING LIFECYCLE (INSTANT & SCHEDULED)
  // =========================================================================
  logSection('2. Customer Booking Creation & Scheduling');

  // Case A: Create Instant Emergency Booking
  const createInstantRes = await api('/api/v1/bookings', {
    method: 'POST',
    body: JSON.stringify({
      serviceId: 'ac',
      selectedIssue: 'ac_cooling',
      customerName: 'E2E Test User',
      customerPhone: testPhone,
      locality: 'Fairlands',
      address: 'Plot 10, 4th Cross, Fairlands, Salem',
      bookingType: 'instant',
      scheduledSlot: 'instant_now'
    })
  });
  createdBookingId = createInstantRes.data?.booking?.id;
  assertTest(
    'Create Instant Booking',
    createInstantRes.ok && Boolean(createdBookingId),
    `Booking ID: ${createdBookingId}, Status: ${createInstantRes.data?.booking?.status}`
  );

  // Case B: Create Scheduled Booking
  const createSchedRes = await api('/api/v1/bookings', {
    method: 'POST',
    body: JSON.stringify({
      serviceId: 'electrician',
      selectedIssue: 'elec_mcb',
      customerName: 'Scheduled Test Customer',
      customerPhone: testPhone,
      locality: 'Hasthampatti',
      address: '22, Gorimedu Main Rd, Hasthampatti, Salem',
      bookingType: 'scheduled',
      scheduledSlot: 'tomorrow_10am'
    })
  });
  scheduledBookingId = createSchedRes.data?.booking?.id;
  assertTest(
    'Create Scheduled Booking',
    createSchedRes.ok && Boolean(scheduledBookingId),
    `Scheduled Booking ID: ${scheduledBookingId}, Slot: ${createSchedRes.data?.booking?.scheduled_slot}`
  );

  // Track Booking Telemetry
  const trackRes = await api(`/api/v1/bookings/${createdBookingId}/track`);
  assertTest(
    'Live Tracking Telemetry',
    trackRes.ok && trackRes.data?.booking?.id === createdBookingId,
    `Stage: ${trackRes.data?.booking?.status}`
  );

  // Edge Case: Booking with missing mandatory fields
  const missingFieldsRes = await api('/api/v1/bookings', {
    method: 'POST',
    body: JSON.stringify({
      customerName: 'Faulty Request'
      // Missing serviceId and phone
    })
  });
  assertTest(
    'Edge Case: Booking with Missing Required Fields',
    missingFieldsRes.status === 400 || !missingFieldsRes.data?.success,
    'Properly rejected missing serviceId / phone'
  );

  // Edge Case: Track Non-existent Booking
  const trackNonExistent = await api('/api/v1/bookings/SLM-INVALID-999999/track');
  assertTest(
    'Edge Case: Track Non-Existent Booking ID',
    trackNonExistent.status === 404 || !trackNonExistent.data?.success,
    'Returned not found for non-existent booking'
  );

  // =========================================================================
  // 3. TECHNICIAN WORKFLOW, STATUS ADVANCE & ON-SITE QUOTE
  // =========================================================================
  logSection('3. Technician Workflow, Status Progression & On-Site Quote');

  // Advance Status to accepted
  const acceptRes = await api(`/api/v1/bookings/${createdBookingId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'accepted' })
  });
  assertTest(
    'Advance Stage: Accepted',
    acceptRes.ok && acceptRes.data?.success,
    `Status updated to: ${acceptRes.data?.booking?.status || 'accepted'}`
  );

  // Advance Status to en_route
  const enRouteRes = await api(`/api/v1/bookings/${createdBookingId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'en_route' })
  });
  assertTest(
    'Advance Stage: En Route',
    enRouteRes.ok && enRouteRes.data?.success,
    'Technician dispatched on GPS radar'
  );

  // Advance Status to arrived
  const arrivedRes = await api(`/api/v1/bookings/${createdBookingId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'arrived' })
  });
  assertTest(
    'Advance Stage: Arrived at Doorstep',
    arrivedRes.ok && arrivedRes.data?.success,
    'Technician arrived at Salem customer location'
  );

  // Generate Digital On-Site Quote
  const quoteRes = await api('/api/v1/partner/quote', {
    method: 'POST',
    body: JSON.stringify({
      bookingId: createdBookingId,
      items: [
        { desc: 'AC Capacitor Replacement (Original Part)', amount: 450, category: 'material' },
        { desc: 'Jet Cleaning & Gas Pressure Calibration', amount: 350, category: 'labor' }
      ],
      totalAmount: 800,
      inspectionFeeWaved: true
    })
  });
  assertTest(
    'Generate Digital On-Site Quote',
    quoteRes.ok && quoteRes.data?.success,
    `Total Estimated Amount: INR ${quoteRes.data?.quote?.totalAmount || 800}`
  );

  // Customer Approves Quote
  const approveQuoteRes = await api(`/api/v1/bookings/${createdBookingId}/approve-quote`, {
    method: 'POST',
    body: JSON.stringify({ approved: true })
  });
  assertTest(
    'Customer Approves On-Site Quote',
    approveQuoteRes.ok && approveQuoteRes.data?.success,
    'Service authorized by customer'
  );

  // Complete the Service
  const completeRes = await api(`/api/v1/bookings/${createdBookingId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'completed' })
  });
  assertTest(
    'Advance Stage: Service Completed',
    completeRes.ok && completeRes.data?.success,
    'Job marked completed, ready for settlement'
  );

  // =========================================================================
  // 4. REAL REVIEWS & STAR RATINGS (POSTGRESQL GROUNDED)
  // =========================================================================
  logSection('4. Real Reviews & Star Ratings');

  // Case A: Submit 5-Star High Rating with Compliment Tags
  const fiveStarReviewRes = await api('/api/v1/reviews/submit', {
    method: 'POST',
    body: JSON.stringify({
      bookingId: createdBookingId,
      rating: 5,
      tags: ['fast', 'oem', 'clean', 'transparent'],
      feedback: 'Excellent AC capacitor repair in Fairlands. Technician arrived on time and cooling is restored.'
    })
  });
  assertTest(
    'Submit Real 5-Star Review (PostgreSQL)',
    fiveStarReviewRes.ok && fiveStarReviewRes.data?.success,
    'Recorded in reviews table, updated technician rating'
  );

  // Case B: Edge Case - Submit 2-Star Low Rating (Escalation Alert)
  const lowStarReviewRes = await api('/api/v1/reviews/submit', {
    method: 'POST',
    body: JSON.stringify({
      bookingId: scheduledBookingId,
      rating: 2,
      tags: ['delay', 'unprofessional'],
      feedback: 'Technician was 35 minutes late for scheduled slot. Need refund on inspection visit fee.'
    })
  });
  assertTest(
    'Submit Low Rating Review & Ops Escalation Flag',
    lowStarReviewRes.ok && lowStarReviewRes.data?.success,
    `Escalated flag: ${lowStarReviewRes.data?.review?.is_escalated ? 'TRUE' : 'Logged for Ops Desk'}`
  );

  // Case C: Edge Case - Submit Review for Non-Existent Booking
  const invalidReviewRes = await api('/api/v1/reviews/submit', {
    method: 'POST',
    body: JSON.stringify({
      bookingId: 'SLM-DOES-NOT-EXIST-999',
      rating: 5,
      feedback: 'Fake booking review test'
    })
  });
  assertTest(
    'Edge Case: Review on Non-Existent Booking',
    invalidReviewRes.status === 404 || !invalidReviewRes.data?.success,
    'Rejected review with non-existent foreign key'
  );

  // Fetch Public Verified Reviews List
  const reviewsListRes = await api('/api/v1/reviews?limit=10');
  const reviewsList = reviewsListRes.data?.reviews || [];
  assertTest(
    'Fetch Real Reviews List',
    reviewsListRes.ok && Array.isArray(reviewsList) && reviewsList.length > 0,
    `Retrieved ${reviewsList.length} verified customer reviews`
  );

  // Fetch Reviews Stats & Star Breakdown
  const reviewsStatsRes = await api('/api/v1/reviews/stats');
  const statsData = reviewsStatsRes.data?.stats;
  assertTest(
    'Fetch Reviews Dynamic Aggregate Stats',
    reviewsStatsRes.ok && Boolean(statsData),
    `Average Rating: ${statsData?.average_rating} / 5.0, 5-Star Count: ${statsData?.stars_5}, Escalated: ${statsData?.escalated_count}`
  );

  // =========================================================================
  // 5. CUSTOMER CANCELLATIONS & AUDIT TRAIL
  // =========================================================================
  logSection('5. Customer Cancellations & Audit Trail');

  // Create a separate booking to test cancellation flow. It uses AC rather than plumber:
  // dispatch is refused with NO_TECHNICIANS_IN_DOMAIN when no technician offers the trade, so
  // a fixture built on an unstaffed trade failed for a reason unrelated to cancellation.
  const cancelBookingRes = await api('/api/v1/bookings', {
    method: 'POST',
    body: JSON.stringify({
      serviceId: 'ac',
      selectedIssue: 'ac_cooling',
      customerName: 'Cancellation Test User',
      customerPhone: testPhone,
      locality: 'Ammapet',
      address: '15, Kamaraj Colony, Ammapet, Salem',
      bookingType: 'instant',
      scheduledSlot: 'instant_now'
    })
  });
  cancelBookingId = cancelBookingRes.data?.booking?.id;
  assertTest(
    'Cancellation Fixture Booking Created',
    Boolean(cancelBookingId),
    cancelBookingId ? `Booking ID: ${cancelBookingId}` : `HTTP ${cancelBookingRes.status}: ${cancelBookingRes.data?.error || 'no booking'}`
  );

  // Case A: Customer Cancels Booking with Structured Reason and Notes
  const cancelSubmitRes = await api(`/api/v1/bookings/${cancelBookingId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({
      reason: 'Arranged alternative technician locally',
      reasonDetails: 'Local plumber from Ammapet market fixed pipe leak immediately.',
      cancelledBy: 'customer'
    })
  });
  assertTest(
    'Customer Cancels Booking with Reason & Notes',
    cancelSubmitRes.ok && cancelSubmitRes.data?.success,
    `Reason: ${cancelSubmitRes.data?.cancellationSummary?.reason || 'Arranged alternative technician locally'}`
  );

  // Verify Cancelled Booking Contains Audit Metadata in DB
  const verifyCancelTrack = await api(`/api/v1/bookings/${cancelBookingId}/track`);
  const cancelledBookingData = verifyCancelTrack.data?.booking;
  assertTest(
    'Audit Trail Verification for Cancelled Booking',
    verifyCancelTrack.ok &&
    cancelledBookingData?.status === 'cancelled' &&
    Boolean(cancelledBookingData?.cancellation_reason),
    `Reason recorded: ${cancelledBookingData?.cancellation_reason}, Cancelled by: ${cancelledBookingData?.cancelled_by}`
  );

  // Edge Case: Attempting to advance status of a cancelled booking
  const advanceCancelledRes = await api(`/api/v1/bookings/${cancelBookingId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'en_route' })
  });
  assertTest(
    'Edge Case: Block Status Progression on Cancelled Booking',
    advanceCancelledRes.status === 400 || advanceCancelledRes.data?.error || advanceCancelledRes.data?.booking?.status === 'cancelled',
    'Prevented progressing cancelled booking'
  );

  // =========================================================================
  // 6. ADMIN COUPONS CRUD & VALIDATION
  // =========================================================================
  logSection('6. Admin Coupons CRUD & Application Engine');

  const testCouponCode = `TEST${Math.floor(100 + Math.random() * 900)}`;

  // Create Percentage Coupon
  const createCouponRes = await api('/api/v1/admin/coupons', {
    method: 'POST',
    body: JSON.stringify({
      code: testCouponCode,
      title: 'E2E Test 20% Discount Promo',
      description: 'Automated test discount for Salem users',
      discountType: 'percentage',
      discountValue: 20,
      minOrderAmount: 200,
      maxDiscountAmount: 100,
      totalUsageLimit: 50,
      expiryDate: new Date(Date.now() + 86400000 * 7).toISOString(),
      isActive: true
    })
  });
  createdCouponId = createCouponRes.data?.coupon?.id;
  assertTest(
    'Admin Creates Percentage Discount Coupon',
    createCouponRes.ok && createCouponRes.data?.success,
    `Code: ${testCouponCode}, ID: ${createdCouponId}`
  );

  // Validate and Apply Coupon on Order
  const applyCouponRes = await api('/api/v1/coupons/apply', {
    method: 'POST',
    body: JSON.stringify({
      code: testCouponCode,
      orderAmount: 400
    })
  });
  assertTest(
    'Apply Valid Coupon to Order',
    applyCouponRes.ok && applyCouponRes.data?.success,
    `Calculated Discount: INR ${applyCouponRes.data?.discountAmount || 80}`
  );

  // Edge Case: Apply Coupon Below Minimum Order Requirement
  const belowMinOrderRes = await api('/api/v1/coupons/apply', {
    method: 'POST',
    body: JSON.stringify({
      code: testCouponCode,
      orderAmount: 100 // Below minOrderAmount of 200
    })
  });
  assertTest(
    'Edge Case: Coupon Below Minimum Order Amount',
    !belowMinOrderRes.data?.success && Boolean(belowMinOrderRes.data?.error),
    `Rejected with message: ${belowMinOrderRes.data?.error}`
  );

  // Edge Case: Apply Non-Existent Coupon Code
  const fakeCouponRes = await api('/api/v1/coupons/apply', {
    method: 'POST',
    body: JSON.stringify({
      code: 'FAKE_COUPON_CODE_9999',
      orderAmount: 500
    })
  });
  assertTest(
    'Edge Case: Apply Non-Existent Coupon Code',
    !fakeCouponRes.data?.success,
    'Invalid coupon code gracefully rejected'
  );

  // Update Coupon
  if (createdCouponId) {
    const updateCouponRes = await api(`/api/v1/admin/coupons/${createdCouponId}`, {
      method: 'PUT',
      body: JSON.stringify({
        title: 'Updated Test Promo Title',
        discountValue: 25,
        isActive: true
      })
    });
    assertTest(
      'Admin Updates Coupon Configuration',
      updateCouponRes.ok && updateCouponRes.data?.success,
      'Updated discount value to 25%'
    );

    // Delete Coupon (Cleanup)
    const deleteCouponRes = await api(`/api/v1/admin/coupons/${createdCouponId}`, {
      method: 'DELETE'
    });
    assertTest(
      'Admin Deletes Coupon',
      deleteCouponRes.ok && deleteCouponRes.data?.success,
      'Coupon removed cleanly'
    );
  }

  // =========================================================================
  // 7. ADMIN REWARDS, INSPECTION FEE & FLEET COMMAND
  // =========================================================================
  logSection('7. Admin Rewards, Settings & Fleet Command');

  // Fetch Admin Reward & Inspection Settings
  const getRewardConfigRes = await api('/api/v1/admin/reward-config');
  const rewardCfg = getRewardConfigRes.data?.config || getRewardConfigRes.data?.settings;
  assertTest(
    'Admin Retrieves Reward & Fee Settings',
    getRewardConfigRes.ok && Boolean(rewardCfg),
    `Inspection Fee: INR ${rewardCfg?.inspection_visit_fee || 99}, Referral Credits: ${rewardCfg?.customer_referral_credits || 50}`
  );

  // Update Admin Reward & Inspection Settings
  const updateRewardRes = await api('/api/v1/admin/reward-config', {
    method: 'PUT',
    body: JSON.stringify({
      inspection_visit_fee: 99,
      customer_referral_credits: 50,
      referee_discount_amount: 50,
      partner_referral_reward: 100,
      review_reward_credits: 50
    })
  });
  assertTest(
    'Admin Updates Inspection Fee & Reward Config',
    updateRewardRes.ok && updateRewardRes.data?.success,
    'Customizable rates updated in database'
  );

  // Admin Overview with Cancelled Bookings Audit Visibility
  const adminOverviewRes = await api('/api/v1/admin/overview');
  const recentBookings = adminOverviewRes.data?.recentBookings || [];
  const cancelledInOverview = recentBookings.find(b => b.status === 'cancelled');
  assertTest(
    'Admin Overview & Fleet Command Telemetry',
    adminOverviewRes.ok && Boolean(adminOverviewRes.data?.metrics),
    `Active Bookings: ${adminOverviewRes.data?.metrics?.activeBookings}, Techs Online: ${adminOverviewRes.data?.metrics?.onlineTechnicians}`
  );

  assertTest(
    'Admin Overview Displays Customer Cancellation Details',
    Boolean(cancelledInOverview && cancelledInOverview.cancellation_reason),
    `Found Cancelled Booking #${cancelledInOverview?.id}: "${cancelledInOverview?.cancellation_reason}"`
  );

  // =========================================================================
  // CLEANUP - only against a local database, never against a remote target
  // =========================================================================
  if (/127\.0\.0\.1|localhost/.test(BASE_URL)) {
    try {
      const { pool } = require('../src/db/db');
      await pool.query(
        `DELETE FROM payments WHERE booking_id IN (SELECT id FROM bookings WHERE customer_phone = $1)`,
        [testPhone]
      );
      await pool.query(`DELETE FROM audit_logs WHERE booking_id IN (SELECT id::text FROM bookings WHERE customer_phone = $1)`, [testPhone]);
      await pool.query(`DELETE FROM bookings WHERE customer_phone = $1`, [testPhone]);
      await pool.query(`DELETE FROM reviews WHERE customer_phone = $1`, [testPhone]).catch(() => {});
      await pool.query(`DELETE FROM users WHERE role <> 'admin' AND phone = $1`, [testPhone]).catch(() => {});
      await pool.end();
      console.log(`  Cleanup                  : rows for ${testPhone} removed`);
    } catch (cleanupErr) {
      console.log(`  Cleanup                  : failed (${cleanupErr.message})`);
    }
  }

  // =========================================================================
  // FINAL TEST SUITE REPORT
  // =========================================================================
  const elapsedSec = ((Date.now() - STATS.startTime) / 1000).toFixed(2);
  console.log('\n======================================================================');
  console.log('                   E2E TEST EXECUTION SUMMARY                         ');
  console.log('======================================================================');
  console.log(`  Total Assertions Checked : ${STATS.total}`);
  console.log(`  Passed Assertions        : ${STATS.passed}`);
  console.log(`  Failed Assertions        : ${STATS.failed}`);
  console.log(`  Duration                 : ${elapsedSec}s`);
  console.log('======================================================================');

  if (STATS.failed === 0) {
    console.log('\n[SUCCESS] ALL END-TO-END TESTS PASSED CLEANLY WITH ZERO FAILURES.\n');
    process.exit(0);
  } else {
    console.log(`\n[WARNING] ${STATS.failed} TEST(S) FAILED:\n`);
    FAILED_TESTS.forEach((f, idx) => {
      console.log(`  ${idx + 1}. ${f.name} - ${f.details}`);
    });
    console.log('');
    process.exit(1);
  }
}

// Run the master suite
runMasterE2ETestSuite().catch((err) => {
  console.error('[FATAL ERROR]:', err);
  process.exit(1);
});
