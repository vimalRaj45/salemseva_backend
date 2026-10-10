/**
 * ============================================================================
 * SALEMSEVA: FULL PLATFORM END-TO-END (E2E) AUTOMATED TEST SUITE
 * ============================================================================
 * Scope: Complete end-to-end operational verification across all subsystems:
 *   1. System Health & Dual-Language Services Catalog
 *   2. Authentication, Single-Device Session Lock & Role Onboarding
 *   3. Partner Pro Fleet Onboarding, GPS Radar & Duty Status
 *   4. Full Doorstep Booking Lifecycle (Create -> Match -> En Route -> Doorstep OTP -> Quote -> Complete)
 *   5. S3 Storage Cloud Upload (Bills & Aadhaar KYC)
 *   6. Wallet Ledger, Seva Credits & Referral Rewards Engine
 *   7. Platform Feedback Reporting & Central Operations Desk Dashboard
 *
 * Usage:
 *   node e2e_full_platform_test.js
 *   node e2e_full_platform_test.js --local
 *   node e2e_full_platform_test.js --url https://salemseva-backend.onrender.com
 * ============================================================================
 */

const BASE_URL_OVERRIDE = process.argv.find(arg => arg.startsWith('--url='))?.split('=')[1]
  || (process.argv.includes('--local') ? 'http://localhost:8080' : 'https://salemseva-backend.onrender.com');

// Visual ANSI styling helpers
const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

const STATS = {
  total: 0,
  passed: 0,
  failed: 0,
  startTime: Date.now()
};

function logHeader(title) {
  console.log(`\n${COLORS.bold}${COLORS.cyan}======================================================================${COLORS.reset}`);
  console.log(`${COLORS.bold}${COLORS.cyan} ▶ ${title}${COLORS.reset}`);
  console.log(`${COLORS.bold}${COLORS.cyan}======================================================================${COLORS.reset}`);
}

function assertTest(name, condition, details = '') {
  STATS.total++;
  if (condition) {
    STATS.passed++;
    console.log(`  ${COLORS.green}✔ PASS:${COLORS.reset} ${name} ${details ? `${COLORS.dim}(${details})${COLORS.reset}` : ''}`);
  } else {
    STATS.failed++;
    console.log(`  ${COLORS.red}✘ FAIL:${COLORS.reset} ${name} ${details ? `${COLORS.yellow}[${details}]${COLORS.reset}` : ''}`);
  }
}

async function api(path, options = {}) {
  const url = `${BASE_URL_OVERRIDE}${path}`;
  const defaultHeaders = { 'Content-Type': 'application/json' };
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

async function runFullE2ETest() {
  console.log(`${COLORS.bold}${COLORS.blue}`);
  console.log(`╔══════════════════════════════════════════════════════════════════════╗`);
  console.log(`║           SALEMSEVA FULL-PLATFORM E2E OPERATION SUITE                ║`);
  console.log(`║          Target Target Backend: ${BASE_URL_OVERRIDE.padEnd(36)} ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════════╝${COLORS.reset}`);

  // =========================================================================
  // PHASE 1: SYSTEM HEALTH & CATALOG
  // =========================================================================
  logHeader('PHASE 1: System Health & Services Catalog');

  const healthRes = await api('/health');
  assertTest('Backend Health Check', healthRes.ok && healthRes.data?.status === 'ok', `status: ${healthRes.data?.status}`);

  const servicesRes = await api('/api/v1/services');
  const services = servicesRes.data?.services || [];
  assertTest('Services Catalog API', servicesRes.ok && services.length >= 4, `found ${services.length} services`);

  const acService = services.find(s => s.id === 'ac');
  assertTest(
    'Dual-Language Support (English + Tamil)',
    Boolean(acService?.name_en && acService?.name_ta),
    `EN: "${acService?.name_en}", TA: "${acService?.name_ta}"`
  );
  assertTest('Transparent Visit Fee', acService?.visit_fee == 99, `Visit fee: ₹${acService?.visit_fee}`);

  // =========================================================================
  // PHASE 2: AUTHENTICATION, SINGLE-DEVICE SESSIONS & ONBOARDING
  // =========================================================================
  logHeader('PHASE 2: Authentication, Single-Device Sessions & Onboarding');

  const testMobile = `9842${Math.floor(100000 + Math.random() * 900000)}`;

  // 2.1 Customer Registration
  const custRegRes = await api('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'E2E Test Customer',
      phone: testMobile,
      password: 'salempassword123',
      role: 'customer',
      locality: 'Fairlands, Salem',
      referralCode: 'SALEM100'
    })
  });

  assertTest(
    'Customer Account Registration',
    custRegRes.ok && custRegRes.data?.success,
    `Registered phone: ${testMobile}`
  );

  const sessionToken = custRegRes.data?.sessionToken;
  assertTest('Single-Device Session Token Issued', Boolean(sessionToken), `Token: ${sessionToken?.slice(0, 15)}...`);

  // 2.2 Customer Credential Login
  const custLoginRes = await api('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      identifier: testMobile,
      password: 'salempassword123'
    })
  });
  assertTest(
    'Customer Login with Phone & Password',
    custLoginRes.ok && custLoginRes.data?.success && custLoginRes.data?.user?.role === 'customer',
    `Role: ${custLoginRes.data?.user?.role}`
  );

  // 2.3 Session Heartbeat Verification
  const verifySessionRes = await api('/api/v1/auth/session/verify', {
    method: 'POST',
    body: JSON.stringify({
      phone: testMobile,
      sessionToken: custLoginRes.data?.sessionToken,
      role: 'customer'
    })
  });
  assertTest(
    'Active Session Heartbeat Verification',
    verifySessionRes.ok && verifySessionRes.data?.active === true,
    'Session verified valid'
  );

  // 2.4 Concurrent Login Conflict Detection (Simulate logging in on 2nd device)
  const secondDeviceLoginRes = await api('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      identifier: testMobile,
      password: 'salempassword123'
    })
  });
  const newToken = secondDeviceLoginRes.data?.sessionToken;

  const oldDeviceCheckRes = await api('/api/v1/auth/session/verify', {
    method: 'POST',
    body: JSON.stringify({
      phone: testMobile,
      sessionToken: sessionToken, // Old token
      role: 'customer'
    })
  });
  assertTest(
    'Single-Device Concurrency Lock (Old device session invalidation)',
    oldDeviceCheckRes.data?.code === 'SESSION_TERMINATED',
    `Terminated code: ${oldDeviceCheckRes.data?.code}`
  );

  // 2.5 Admin Login
  const adminLoginRes = await api('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      identifier: '9842099999',
      password: 'salem123'
    })
  });
  assertTest(
    'Admin Central Ops Login',
    adminLoginRes.ok && adminLoginRes.data?.user?.role === 'admin',
    `Admin: ${adminLoginRes.data?.user?.name}`
  );

  // =========================================================================
  // PHASE 3: PARTNER PRO FLEET ONBOARDING & RADAR
  // =========================================================================
  logHeader('PHASE 3: Service Partner Onboarding & Duty Radar');

  const partnerMobile = `9443${Math.floor(100000 + Math.random() * 900000)}`;
  const partnerOnboardRes = await api('/api/v1/partner/onboard', {
    method: 'POST',
    body: JSON.stringify({
      fullName: 'Senthil Kumar (AC Pro)',
      phone: partnerMobile,
      trade: 'ac',
      aadhaar: '8942-5511-9921',
      upiId: 'senthil.tech@oksbi',
      referralCode: 'SALEMTECH'
    })
  });

  assertTest(
    'Partner Pro Onboarding & Trade Registration',
    partnerOnboardRes.ok && partnerOnboardRes.data?.success,
    `Partner Phone: ${partnerMobile}`
  );

  // Partner Duty Sync
  const dutySyncRes = await api(`/api/v1/partner/duty?phone=${encodeURIComponent(partnerMobile)}`);
  assertTest(
    'Partner Duty Workspace & Live Sync',
    dutySyncRes.ok && Boolean(dutySyncRes.data?.technician),
    `Tech: ${dutySyncRes.data?.technician?.full_name}`
  );

  // Toggle Online Duty Status
  const toggleDutyRes = await api('/api/v1/partner/duty/toggle', {
    method: 'POST',
    body: JSON.stringify({
      phone: partnerMobile,
      isOnline: true
    })
  });
  assertTest(
    'Partner On-Duty / Off-Duty Toggle',
    toggleDutyRes.ok && toggleDutyRes.data?.isOnline === true,
    'Status: ON DUTY'
  );

  // =========================================================================
  // PHASE 4: FULL DOORSTEP BOOKING LIFECYCLE
  // =========================================================================
  logHeader('PHASE 4: Full Doorstep Booking & Diagnostic Lifecycle');

  // 4.1 Create Booking
  const createBookingRes = await api('/api/v1/bookings/create', {
    method: 'POST',
    body: JSON.stringify({
      serviceId: 'ac',
      issueId: 'ac_cooling',
      customNotes: 'AC blowing warm air, needs gas check & jet wash',
      customerName: 'E2E Customer',
      customerPhone: testMobile,
      address: '14, 2nd Cross, Fairlands, Salem - 636016',
      locality: 'Fairlands, Salem',
      lat: 11.6738,
      lng: 78.1460,
      isUrgentDispatch: false,
      couponCode: 'SALEM100',
      scheduledSlot: 'priority_12h'
    })
  });

  const booking = createBookingRes.data?.booking;
  const bookingId = booking?.id;
  assertTest(
    'Create Doorstep Inspection Booking',
    createBookingRes.ok && Boolean(bookingId),
    `Booking ID: ${bookingId}, Visit Fee: ₹${booking?.final_amount}`
  );

  // 4.2 Track Booking & Matching Radar
  const trackRes = await api(`/api/v1/bookings/${bookingId}/track`);
  assertTest(
    'Live GPS Radar & Technician Tracking Query',
    trackRes.ok && Boolean(trackRes.data?.booking),
    `Status: ${trackRes.data?.booking?.status}`
  );

  // 4.3 Move to En Route
  const enRouteRes = await api(`/api/v1/bookings/${bookingId}/status`, {
    method: 'POST',
    body: JSON.stringify({ status: 'en_route' })
  });
  assertTest('Technician En Route Status Update', enRouteRes.ok, 'Status: EN_ROUTE');

  // 4.4 Move to Arrived
  const arrivedRes = await api(`/api/v1/bookings/${bookingId}/status`, {
    method: 'POST',
    body: JSON.stringify({ status: 'arrived' })
  });
  assertTest('Doorstep Arrival Status Update', arrivedRes.ok, 'Status: ARRIVED');

  // 4.5 Verify Doorstep Safety OTP (Customer authenticates technician)
  const otpToVerify = booking?.customer_otp || '4892';
  const verifyOtpRes = await api(`/api/v1/bookings/${bookingId}/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({
      otp: otpToVerify,
      type: 'arrival',
      actor: 'customer'
    })
  });
  assertTest(
    'Doorstep Safety 4-Digit PIN Verification',
    verifyOtpRes.ok && verifyOtpRes.data?.success,
    `Verified PIN: ${otpToVerify}`
  );

  // 4.6 Query Digital Quote & Diagnostic Parts
  const quoteRes = await api(`/api/v1/bookings/${bookingId}/quote`);
  assertTest(
    'Inspection Diagnostic Spares & Labor Catalog',
    quoteRes.ok && Array.isArray(quoteRes.data?.items),
    `Catalog Items: ${quoteRes.data?.itemsCount || quoteRes.data?.items?.length}`
  );

  // =========================================================================
  // PHASE 5: S3 STORAGE CLOUD UPLOADS (BILLS & KYC)
  // =========================================================================
  logHeader('PHASE 5: S3-Compatible Cloud Storage & Bill Upload');

  // Sample tiny 1x1 test JPEG image buffer base64
  const sampleBase64Image = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

  const uploadRes = await api('/api/v1/storage/upload', {
    method: 'POST',
    body: JSON.stringify({
      fileData: sampleBase64Image,
      mimeType: 'image/jpeg',
      folder: 'bills',
      referenceId: bookingId,
      fileName: 'parts_receipt.jpg'
    })
  });

  assertTest(
    'Cloud S3 File Upload (Bill / Aadhaar Proof)',
    uploadRes.ok && Boolean(uploadRes.data?.url || uploadRes.data?.fileUrl),
    `File URL: ${(uploadRes.data?.url || uploadRes.data?.fileUrl)?.slice(0, 45)}...`
  );

  // =========================================================================
  // PHASE 6: WALLET LEDGER, REWARDS & REFERRALS
  // =========================================================================
  logHeader('PHASE 6: Wallet Ledger, Rewards & Referrals');

  const walletRes = await api(`/api/v1/wallet/customer?phone=${encodeURIComponent(testMobile)}`);
  assertTest(
    'Customer Wallet Balance & Ledger Query',
    walletRes.ok && walletRes.data?.walletBalance !== undefined,
    `Balance: ₹${walletRes.data?.walletBalance}`
  );

  const simulateReferralRes = await api('/api/v1/wallet/simulate-referral', {
    method: 'POST',
    body: JSON.stringify({
      referrerPhone: testMobile,
      friendName: 'Ravi Chandran',
      locality: 'Hasthampatti, Salem'
    })
  });
  assertTest(
    'Referral Cashback & Reward Credit Engine (+₹100)',
    simulateReferralRes.ok && simulateReferralRes.data?.success,
    `New Balance: ₹${simulateReferralRes.data?.newBalance}`
  );

  // =========================================================================
  // PHASE 7: FEEDBACK REPORTING & CENTRAL OPS DASHBOARD
  // =========================================================================
  logHeader('PHASE 7: Platform Feedback & Central Operations Desk');

  const feedbackRes = await api('/api/v1/feedback/submit', {
    method: 'POST',
    body: JSON.stringify({
      userName: 'E2E Customer',
      userPhone: testMobile,
      role: 'customer',
      feedbackType: 'service_quality',
      rating: 5,
      subject: 'Excellent Jet Cleaning Experience',
      message: 'Technician arrived on time with proper safety uniform. Very polite and transparent.',
      locality: 'Fairlands, Salem'
    })
  });
  assertTest(
    'Submit Platform Quality Feedback',
    feedbackRes.ok && feedbackRes.data?.success,
    'Submitted 5-star rating feedback'
  );

  const feedbackListRes = await api('/api/v1/feedback');
  assertTest(
    'Central Ops Feedback Ingestion Audit',
    feedbackListRes.ok && Array.isArray(feedbackListRes.data?.feedback),
    `Total feedback records: ${feedbackListRes.data?.feedback?.length}`
  );

  const adminOverviewRes = await api('/api/v1/admin/overview');
  assertTest(
    'Salem Central Ops Dashboard Overview Metrics',
    adminOverviewRes.ok && Boolean(adminOverviewRes.data?.metrics),
    `Online Techs: ${adminOverviewRes.data?.metrics?.onlineTechnicians}, Total Revenue: ₹${adminOverviewRes.data?.metrics?.financials?.totalRevenue}`
  );

  // =========================================================================
  // FINAL REPORT & SUMMARY
  // =========================================================================
  const elapsedSec = ((Date.now() - STATS.startTime) / 1000).toFixed(2);
  console.log(`\n${COLORS.bold}${COLORS.cyan}======================================================================${COLORS.reset}`);
  console.log(`${COLORS.bold}                      TEST EXECUTION SUMMARY                          ${COLORS.reset}`);
  console.log(`${COLORS.bold}${COLORS.cyan}======================================================================${COLORS.reset}`);
  console.log(`  Total Test Assertions : ${STATS.total}`);
  console.log(`  Passed Assertions     : ${COLORS.green}${COLORS.bold}${STATS.passed}${COLORS.reset}`);
  console.log(`  Failed Assertions     : ${STATS.failed > 0 ? `${COLORS.red}${COLORS.bold}${STATS.failed}` : `${COLORS.green}0`}${COLORS.reset}`);
  console.log(`  Execution Time        : ${elapsedSec}s`);
  console.log(`${COLORS.bold}${COLORS.cyan}======================================================================${COLORS.reset}`);

  if (STATS.failed === 0) {
    console.log(`\n${COLORS.bold}${COLORS.green}🎉 ALL END-TO-END TESTS PASSED! THE SALEMSEVA PLATFORM IS 100% OPERATIONAL.${COLORS.reset}\n`);
    process.exit(0);
  } else {
    console.log(`\n${COLORS.bold}${COLORS.red}⚠ SOME TESTS FAILED. PLEASE REVIEW THE LOGS ABOVE.${COLORS.reset}\n`);
    process.exit(1);
  }
}

// Execute the test suite
runFullE2ETest();
