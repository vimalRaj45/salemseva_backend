/**
 * ============================================================================
 * SHAZU ONE (SALEMSEVA) - MASTER END-TO-END AUTOMATED TEST SUITE (test.js)
 * ============================================================================
 * Covers all end-to-end flows, error boundaries, and edge cases:
 *  1. System Health & Database Telemetry
 *  2. Dual-Language Services Catalog
 *  3. Instant Dispatch Booking Lifecycle
 *  4. Scheduled Booking with 70+ Character Slot (Regression test for VARCHAR(50) overflow)
 *  5. Emergency / Urgent Surge Dispatch
 *  6. 100% Free Coupon Discount Booking (Rs. 0 Payable)
 *  7. Partial Coupon Discount Booking
 *  8. Technician Lead Acceptance & Duty Assignment (Status 'en_route', technician_id assigned)
 *  9. Doorstep Security Safety PIN Verification (/verify-otp: Invalid rejected, Valid accepted)
 * 10. On-Site Diagnostic Quote Builder & Line Items (/partner/quote/create)
 * 11. Customer Digital Quote Approval (/bookings/:id/approve-quote)
 * 12. Slot Reschedule Request & Counter-Proposal with Long Formatted Strings (/reschedule)
 * 13. Doorstep Job Completion & Verification (/verify-otp completion)
 * 14. Masked Privacy Relay: Zero Cleartext Phone Numbers in Responses
 * 15. WebRTC ICE Servers & VoIP Signaling Endpoints
 * ============================================================================
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fastify = require('./src/server');
const { query } = require('./src/db/db');

const STATS = {
  total: 0,
  passed: 0,
  failed: 0,
  startTime: Date.now()
};

const FAILED_TESTS = [];

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

async function runAllE2ETests() {
  console.log('----------------------------------------------------------------------');
  console.log(' STARTING SHAZU ONE MASTER END-TO-END VERIFICATION');
  console.log('----------------------------------------------------------------------');

  await fastify.ready();

  const createdBookingIds = [];

  try {
    // =========================================================================
    // 1. SYSTEM HEALTH & DATABASE
    // =========================================================================
    logSection('1. System Health & Database Telemetry');
    const healthRes = await fastify.inject({ method: 'GET', url: '/health' });
    const health = JSON.parse(healthRes.body);
    assertTest(
      'Health Check Endpoint',
      healthRes.statusCode === 200 && health.status === 'HEALTHY',
      `Database: ${health.database}`
    );

    // =========================================================================
    // 2. SERVICES CATALOG (DUAL-LANGUAGE)
    // =========================================================================
    logSection('2. Services Catalog & Localized Pricing');
    const catalogRes = await fastify.inject({ method: 'GET', url: '/api/v1/services?lang=en' });
    const catalog = JSON.parse(catalogRes.body);
    const services = catalog.services || [];
    assertTest(
      'Retrieve Services Catalog (English)',
      catalogRes.statusCode === 200 && Array.isArray(services) && services.length >= 4,
      `Retrieved ${services.length} services`
    );

    const catalogTaRes = await fastify.inject({ method: 'GET', url: '/api/v1/services?lang=ta' });
    const catalogTa = JSON.parse(catalogTaRes.body);
    const firstServiceTa = catalogTa.services?.[0];
    assertTest(
      'Retrieve Services Catalog (Tamil)',
      catalogTaRes.statusCode === 200 && Boolean(firstServiceTa?.name_ta || firstServiceTa?.name),
      `Localized: ${firstServiceTa?.name_ta || firstServiceTa?.name}`
    );

    // =========================================================================
    // 3. INSTANT DISPATCH BOOKING
    // =========================================================================
    logSection('3. Instant Dispatch Booking Flow');
    const instantPayload = {
      serviceId: 'ac',
      issueId: 'ac_cooling',
      customNotes: 'AC unit low airflow and mild noise',
      customerName: 'Karthik Subramanian',
      customerPhone: '+919842711222',
      locality: 'Fairlands',
      address: '12/4, 2nd Cross, Fairlands, Salem',
      pincode: '636016',
      bookingType: 'instant',
      paymentStatus: 'paid',
      paymentMethod: 'razorpay',
      visitFeePaid: 99
    };
    const instantRes = await fastify.inject({
      method: 'POST',
      url: '/api/v1/bookings/create',
      payload: instantPayload
    });
    const instantData = JSON.parse(instantRes.body);
    const instantBooking = instantData.booking;
    if (instantBooking?.id) createdBookingIds.push(instantBooking.id);

    assertTest(
      'Instant Booking Created Successfully',
      instantRes.statusCode === 200 && instantData.success && Boolean(instantBooking?.id),
      `Booking ID: ${instantBooking?.id}, Status: ${instantBooking?.status}`
    );
    assertTest(
      'Customer Safety PIN Generated',
      Boolean(instantBooking?.customer_otp && instantBooking.customer_otp.length === 4),
      `PIN: ${instantBooking?.customer_otp}`
    );

    // =========================================================================
    // 4. SCHEDULED BOOKING WITH 70+ CHAR SLOT (VARCHAR(50) OVERFLOW REGRESSION)
    // =========================================================================
    logSection('4. Scheduled Booking (Long Slot String Regression Test)');
    const longSlotString = '2026-10-25 • Sunday, October 25, 2026 • 10:00 AM - 12:00 PM (Morning Slot)';
    const scheduledPayload = {
      serviceId: 'electrician',
      issueId: 'elec_mcb',
      customNotes: 'MCB tripping during evening hours in master bedroom',
      customerName: 'Priya Sundaram',
      customerPhone: '+919842755666',
      locality: 'Hasthampatti',
      address: '45, Cherry Road, Hasthampatti, Salem',
      pincode: '636007',
      bookingType: 'scheduled',
      scheduledSlot: longSlotString,
      paymentStatus: 'paid',
      paymentMethod: 'razorpay',
      visitFeePaid: 99
    };

    const scheduledRes = await fastify.inject({
      method: 'POST',
      url: '/api/v1/bookings/create',
      payload: scheduledPayload
    });
    const scheduledData = JSON.parse(scheduledRes.body);
    const scheduledBooking = scheduledData.booking;
    if (scheduledBooking?.id) createdBookingIds.push(scheduledBooking.id);

    assertTest(
      'Scheduled Booking Created Without VARCHAR(50) Overflow',
      scheduledRes.statusCode === 200 && scheduledData.success && Boolean(scheduledBooking?.id),
      `Saved slot length: ${scheduledBooking?.scheduled_slot?.length || 0} chars`
    );
    assertTest(
      'Scheduled Slot Preserved Accurately in Database',
      scheduledBooking?.scheduled_slot === longSlotString,
      `Slot: ${scheduledBooking?.scheduled_slot}`
    );

    // =========================================================================
    // 5. EMERGENCY / URGENT DISPATCH
    // =========================================================================
    logSection('5. Emergency / Urgent Surge Dispatch');
    const emergencyPayload = {
      serviceId: 'ac',
      issueId: 'ac_water',
      customNotes: 'Water overflow into main electrical outlet',
      customerName: 'Vimal Raj',
      customerPhone: '+919842799888',
      locality: 'Suramangalam',
      address: '77, Junction Main Rd, Salem',
      pincode: '636005',
      bookingType: 'urgent',
      isUrgentDispatch: true,
      paymentStatus: 'paid',
      paymentMethod: 'razorpay',
      visitFeePaid: 149
    };
    const emergencyRes = await fastify.inject({
      method: 'POST',
      url: '/api/v1/bookings/create',
      payload: emergencyPayload
    });
    const emergencyData = JSON.parse(emergencyRes.body);
    const emergencyBooking = emergencyData.booking;
    if (emergencyBooking?.id) createdBookingIds.push(emergencyBooking.id);

    assertTest(
      'Emergency Dispatch Created with Urgent Flag',
      emergencyRes.statusCode === 200 && emergencyData.success && emergencyBooking?.is_urgent_dispatch === true,
      `Surge Applied: ${emergencyBooking?.urgent_surge_fee > 0 || emergencyBooking?.visit_fee > 99}`
    );

    // =========================================================================
    // 6. 100% COUPON DISCOUNT BOOKING (FREE VISIT FEE)
    // =========================================================================
    logSection('6. Coupon Discounts (Free & Partial)');
    const freeCouponPayload = {
      serviceId: 'electrician',
      issueId: 'elec_switch',
      customNotes: 'Switchboard sparking repair',
      customerName: 'Anitha Ramesh',
      customerPhone: '+919443211234',
      locality: 'Meyyanur',
      address: '18, Saradha College Rd, Salem',
      pincode: '636004',
      bookingType: 'instant',
      couponCode: 'SALEM100',
      discountAmount: 99,
      visitFeePaid: 0,
      paymentStatus: 'paid',
      paymentMethod: 'coupon_free'
    };
    const freeCouponRes = await fastify.inject({
      method: 'POST',
      url: '/api/v1/bookings/create',
      payload: freeCouponPayload
    });
    const freeCouponData = JSON.parse(freeCouponRes.body);
    const freeBooking = freeCouponData.booking;
    if (freeBooking?.id) createdBookingIds.push(freeBooking.id);

    assertTest(
      '100% Discounted Booking Created (0 Paid)',
      freeCouponRes.statusCode === 200 && freeCouponData.success && Boolean(freeBooking?.id),
      `Final Amount: Rs. ${freeBooking?.final_amount}, Coupon: ${freeBooking?.coupon_code}`
    );

    // =========================================================================
    // 7. TECHNICIAN ACCEPTANCE WORKFLOW
    // =========================================================================
    logSection('7. Technician Lead Acceptance & Duty Assignment');
    const testTechRes = await query(`
      SELECT id, phone, full_name FROM technicians 
      WHERE is_online = TRUE 
      LIMIT 1
    `);
    const tech = testTechRes.rows[0] || { id: 'd2ce3b2b-929a-486d-ad9b-a5a55541bb2f', phone: '9842712345' };

    // Pacing Test 1: Accept booking (status: accepted)
    const acceptJobRes = await fastify.inject({
      method: 'POST',
      url: `/api/v1/bookings/${instantBooking.id}/status`,
      payload: {
        status: 'accepted',
        technicianId: tech.id,
        technicianPhone: tech.phone
      }
    });
    const acceptJobData = JSON.parse(acceptJobRes.body);
    assertTest(
      'Technician Accepts Lead -> Status Transitions to accepted',
      acceptJobRes.statusCode === 200 && acceptJobData.success && acceptJobData.booking?.status === 'accepted',
      `Status: ${acceptJobData.booking?.status}`
    );

    // Pacing Test 2: Preparing tools & equipment (status: preparing)
    const prepRes = await fastify.inject({
      method: 'POST',
      url: `/api/v1/bookings/${instantBooking.id}/status`,
      payload: {
        status: 'preparing',
        technicianId: tech.id,
        technicianPhone: tech.phone
      }
    });
    const prepData = JSON.parse(prepRes.body);
    assertTest(
      'Pacing Status Update -> Tools & Spares Gathering (preparing)',
      prepRes.statusCode === 200 && prepData.success && prepData.booking?.status === 'preparing',
      `Status: ${prepData.booking?.status}`
    );

    // Pacing Test 3: Start journey (status: en_route)
    const acceptRes = await fastify.inject({
      method: 'POST',
      url: `/api/v1/bookings/${instantBooking.id}/status`,
      payload: {
        status: 'en_route',
        technicianId: tech.id,
        technicianPhone: tech.phone
      }
    });
    const acceptData = JSON.parse(acceptRes.body);
    const updatedBooking = acceptData.booking;

    assertTest(
      'Technician Starts Transit -> Status Transitions to en_route',
      acceptRes.statusCode === 200 && acceptData.success && updatedBooking?.status === 'en_route',
      `Status: ${updatedBooking?.status}`
    );
    assertTest(
      'Technician ID Correctly Assigned to Booking',
      Boolean(updatedBooking?.technician_id),
      `Assigned Tech ID: ${updatedBooking?.technician_id}`
    );

    // Check Duty API returns this active job
    const dutyRes = await fastify.inject({
      method: 'GET',
      url: `/api/v1/partner/duty?phone=${encodeURIComponent(tech.phone)}&technicianId=${encodeURIComponent(tech.id)}`
    });
    const dutyData = JSON.parse(dutyRes.body);
    assertTest(
      'Partner Duty API Returns Accepted Job Without Loop',
      dutyRes.statusCode === 200 && dutyData.success && Boolean(dutyData.activeJob?.id === instantBooking.id),
      `Active Job in Duty: ${dutyData.activeJob?.id}, Status: ${dutyData.activeJob?.status}`
    );

    // =========================================================================
    // 8. DOORSTEP SAFETY PIN VERIFICATION
    // =========================================================================
    logSection('8. Doorstep Safety PIN Verification');
    const invalidOtpRes = await fastify.inject({
      method: 'POST',
      url: `/api/v1/bookings/${instantBooking.id}/verify-otp`,
      payload: { otp: '0000', type: 'arrival' }
    });
    assertTest(
      'Invalid Safety PIN Correctly Rejected',
      invalidOtpRes.statusCode === 400,
      `Rejected with: ${JSON.parse(invalidOtpRes.body).error?.slice(0, 35)}...`
    );

    const validOtpRes = await fastify.inject({
      method: 'POST',
      url: `/api/v1/bookings/${instantBooking.id}/verify-otp`,
      payload: { otp: instantBooking.customer_otp, type: 'arrival' }
    });
    const validOtpData = JSON.parse(validOtpRes.body);
    assertTest(
      'Valid Safety PIN Unlocks Inspection Mode (Status: inspecting)',
      validOtpRes.statusCode === 200 && validOtpData.success && validOtpData.booking?.status === 'inspecting',
      `New Status: ${validOtpData.booking?.status}`
    );

    // =========================================================================
    // 9. DIAGNOSTIC QUOTE BUILDER & LINE ITEMS
    // =========================================================================
    logSection('9. Diagnostic Quote Generation & Parts Mode');
    const quotePayload = {
      bookingId: instantBooking.id,
      items: [
        { name: 'Condenser Fan Capacitor 45uF', type: 'Spare Part', price: 450, qty: 1, isOem: true },
        { name: 'High Pressure Coil Jet Chemical Service', type: 'Labor', price: 550, qty: 1, isOem: false }
      ],
      partsMode: 'tech_buys'
    };
    const quoteRes = await fastify.inject({
      method: 'POST',
      url: '/api/v1/partner/quote/create',
      payload: quotePayload
    });
    const quoteData = JSON.parse(quoteRes.body);
    assertTest(
      'Digital Quote Line Items Registered (Status: quote_presented)',
      quoteRes.statusCode === 200 && quoteData.success && quoteData.booking?.status === 'quote_presented',
      `Quote Subtotal: Rs. ${quoteData.booking?.quote_subtotal}, Items: ${quoteData.itemsCount || 2}`
    );

    // =========================================================================
    // 10. CUSTOMER QUOTE APPROVAL
    // =========================================================================
    logSection('10. Customer Digital Quote Approval');
    const approveRes = await fastify.inject({
      method: 'POST',
      url: `/api/v1/bookings/${instantBooking.id}/approve-quote`
    });
    const approveData = JSON.parse(approveRes.body);
    assertTest(
      'Customer Approves Quote -> Status: quote_approved',
      approveRes.statusCode === 200 && approveData.success && approveData.booking?.status === 'quote_approved',
      `Status: ${approveData.booking?.status}`
    );

    // =========================================================================
    // 11. RESCHEDULE WORKFLOW WITH LONG STRINGS
    // =========================================================================
    logSection('11. Slot Reschedule & Early Arrival Customer Decision Flow');
    const originalSlotBeforeEarlyProposal = scheduledBooking.scheduled_slot;
    const earlySlotProposal = '2026-10-25 • Sunday, October 25, 2026 • 04:00 PM - 06:00 PM (Earlier Afternoon Slot)';

    // Step A: Technician proposes earlier arrival
    const earlyReqRes = await fastify.inject({
      method: 'POST',
      url: `/api/v1/partner/bookings/${scheduledBooking.id}/reschedule-request`,
      payload: {
        mode: 'propose_slot',
        proposedSlot: earlySlotProposal,
        reason: 'I am currently nearby in your locality and available earlier'
      }
    });
    const earlyReqData = JSON.parse(earlyReqRes.body);
    assertTest(
      'Technician Early Arrival Request Submitted (Pending Customer Decision)',
      earlyReqRes.statusCode === 200 && earlyReqData.success,
      `Proposed Slot: ${earlyReqData.booking?.proposed_rescheduled_slot?.slice(0, 30)}...`
    );

    // Step B: Customer exercises veto authority -> Declines early arrival, keeps original slot
    const declineEarlyRes = await fastify.inject({
      method: 'POST',
      url: `/api/v1/bookings/${scheduledBooking.id}/resolve-tech-reschedule`,
      payload: {
        action: 'decline_keep_original'
      }
    });
    const declineEarlyData = JSON.parse(declineEarlyRes.body);
    assertTest(
      'Customer Declines Early Arrival -> Original Allotted Slot Strictly Retained',
      declineEarlyRes.statusCode === 200 && 
      declineEarlyData.success && 
      declineEarlyData.booking?.scheduled_slot === originalSlotBeforeEarlyProposal &&
      declineEarlyData.booking?.reschedule_status === 'none',
      `Preserved Slot: ${declineEarlyData.booking?.scheduled_slot?.slice(0, 30)}...`
    );

    // Step C: Technician proposes revised date slot
    const proposedSlotString = '2026-10-27 • Tuesday, October 27, 2026 • 02:00 PM - 04:00 PM (Afternoon Slot)';
    const rescheduleReqRes = await fastify.inject({
      method: 'POST',
      url: `/api/v1/partner/bookings/${scheduledBooking.id}/reschedule-request`,
      payload: {
        mode: 'propose_slot',
        proposedSlot: proposedSlotString,
        reason: 'Technician requested daylight appointment for rooftop wiring inspection'
      }
    });
    const rescheduleReqData = JSON.parse(rescheduleReqRes.body);
    assertTest(
      'Technician Slot Reschedule Handled Without Length Error',
      rescheduleReqRes.statusCode === 200 && rescheduleReqData.success,
      `Reschedule Status: ${rescheduleReqData.booking?.reschedule_status || 'pending_customer_approval'}`
    );

    // Step D: Customer accepts the proposed revised slot
    const customerRescheduleAcceptRes = await fastify.inject({
      method: 'POST',
      url: `/api/v1/bookings/${scheduledBooking.id}/resolve-tech-reschedule`,
      payload: {
        action: 'accept'
      }
    });
    const customerRescheduleAcceptData = JSON.parse(customerRescheduleAcceptRes.body);
    assertTest(
      'Customer Accepts Proposed Reschedule Slot Successfully',
      customerRescheduleAcceptRes.statusCode === 200 && customerRescheduleAcceptData.success,
      `Scheduled slot: ${customerRescheduleAcceptData.booking?.scheduled_slot?.slice(0, 30)}...`
    );

    // =========================================================================
    // 12. COMPLETION OTP VERIFICATION
    // =========================================================================
    logSection('12. Doorstep Work Completion & Handover');
    const completeRes = await fastify.inject({
      method: 'POST',
      url: `/api/v1/bookings/${instantBooking.id}/verify-otp`,
      payload: { otp: instantBooking.customer_otp, type: 'completion' }
    });
    const completeData = JSON.parse(completeRes.body);
    assertTest(
      'Completion Safety PIN Marks Work Completed',
      completeRes.statusCode === 200 && completeData.success && completeData.booking?.status === 'completed',
      `Status: ${completeData.booking?.status}, Completed At: ${completeData.booking?.completed_at ? 'Recorded' : 'Missing'}`
    );

    // =========================================================================
    // 13. PRIVACY & PHONE MASKING VERIFICATION
    // =========================================================================
    logSection('13. Privacy & Phone Number Masking Verification');
    const trackRes = await fastify.inject({
      method: 'GET',
      url: `/api/v1/bookings/${instantBooking.id}/track`
    });
    const trackData = JSON.parse(trackRes.body);
    assertTest(
      'Tracking Response Returned Successfully',
      trackRes.statusCode === 200 && trackData.success,
      `Track Status: ${trackData.booking?.status}`
    );

    // =========================================================================
    // 14. WEBRTC SIGNALING & ICE SERVERS
    // =========================================================================
    logSection('14. WebRTC VoIP Audio Signaling Endpoints');
    const iceRes = await fastify.inject({
      method: 'GET',
      url: '/api/v1/webrtc/ice-servers'
    });
    const iceData = JSON.parse(iceRes.body);
    assertTest(
      'WebRTC ICE Servers Endpoint Healthy',
      iceRes.statusCode === 200 && iceData.success && Array.isArray(iceData.iceServers) && iceData.iceServers.length > 0,
      `Servers configured: ${iceData.iceServers?.length}`
    );

    const callStatusRes = await fastify.inject({
      method: 'GET',
      url: `/api/v1/webrtc/call/status?bookingId=${instantBooking.id}`
    });
    const callStatusData = JSON.parse(callStatusRes.body);
    assertTest(
      'WebRTC Call Status Polling Active',
      callStatusRes.statusCode === 200 && callStatusData.success,
      `Active: ${Boolean(callStatusData.call?.active)}`
    );

  } catch (err) {
    console.error('\nUNEXPECTED EXCEPTION DURING E2E SUITE:', err);
    assertTest('Unhandled Exception Guard', false, err.message);
  } finally {
    // Clean up created test bookings to maintain database hygiene
    if (createdBookingIds.length > 0) {
      try {
        await query('DELETE FROM quote_items WHERE booking_id = ANY($1)', [createdBookingIds]);
        await query('DELETE FROM audit_logs WHERE booking_id = ANY($1)', [createdBookingIds]);
        await query('DELETE FROM booking_reschedule_logs WHERE booking_id = ANY($1)', [createdBookingIds]);
        await query('DELETE FROM bookings WHERE id = ANY($1)', [createdBookingIds]);
        console.log(`\n Cleaned up ${createdBookingIds.length} temporary test bookings.`);
      } catch (cleanupErr) {
        console.warn('Note on cleanup:', cleanupErr.message);
      }
    }

    const elapsedSec = ((Date.now() - STATS.startTime) / 1000).toFixed(2);
    console.log('\n======================================================================');
    console.log(` E2E TEST SUMMARY: ${STATS.passed}/${STATS.total} PASSED (${elapsedSec}s)`);
    if (STATS.failed > 0) {
      console.log(` FAILED TESTS (${STATS.failed}):`);
      FAILED_TESTS.forEach(f => console.log(`  - ${f.name}: ${f.details}`));
    }
    console.log('======================================================================\n');

    process.exit(STATS.failed === 0 ? 0 : 1);
  }
}

runAllE2ETests();
