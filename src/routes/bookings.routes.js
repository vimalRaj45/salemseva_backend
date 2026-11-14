const { query } = require('../db/db');
const pushService = require('../services/pushNotification.service');
const {
  calculateDualCommissionInvoice,
  getPartnerCommissionPercent,
  getCustomerPlatformFeePercent,
  getPaymentGatewayFeePercent,
  getLiveFeeSettings
} = require('../services/commission.service');
const {
  maskPhoneNumber,
  canDirectCall,
  HELPDESK_PHONE,
  sanitizePhoneForDialer
} = require('../utils/privacy');
const { checkCancellationWindow } = require('../services/cancellation_policy.service');
const { getSalemOpsContact } = require('../services/support_agent.service');
const { resolveLocalityCoords } = require('../utils/salemLocalities');
const { processTechnicianReferralOnCompletion } = require('../services/referral.service');

async function bookingsRoutes(fastify, options) {
  // Ensure reschedule columns and reschedule logs table exist
  try {
    await query(`
      ALTER TYPE booking_status ADD VALUE IF NOT EXISTS 'preparing';
      ALTER TYPE booking_status ADD VALUE IF NOT EXISTS 'inspection_only';
      ALTER TABLE bookings ALTER COLUMN scheduled_slot TYPE TEXT;
      ALTER TABLE bookings ALTER COLUMN reschedule_slot TYPE TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reschedule_count INTEGER DEFAULT 0;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS last_rescheduled_by TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS last_rescheduled_at TIMESTAMPTZ;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reschedule_reason TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS proposed_rescheduled_slot TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS proposed_rescheduled_by TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reschedule_status TEXT DEFAULT 'none';

      CREATE TABLE IF NOT EXISTS booking_reschedule_logs (
        id SERIAL PRIMARY KEY,
        booking_id VARCHAR(100) NOT NULL,
        old_slot TEXT,
        new_slot TEXT,
        rescheduled_by VARCHAR(50),
        reason TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS advance_amount_paid NUMERIC(10,2) DEFAULT 0.00;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS advance_coupon_discount NUMERIC(10,2) DEFAULT 0.00;

      CREATE TABLE IF NOT EXISTS chat_messages (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        booking_id VARCHAR(30) REFERENCES bookings(id) ON DELETE CASCADE,
        sender_role VARCHAR(20) NOT NULL,
        sender_name TEXT,
        message_text TEXT NOT NULL,
        attachment_url TEXT,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS sender_name TEXT;
    `);
  } catch (schemaErr) {
    fastify.log.warn('Reschedule schema init: ' + schemaErr.message);
  }

  // 1. Create Doorstep Inspection Booking
  const handleCreateBooking = async (req, reply) => {
    try {
      const {
        serviceId,
        issueId,
        selectedIssue,
        customIssueText,
        customNotes,
        customerName,
        customerPhone,
        phone,
        address,
        locality,
        lat,
        lng,
        isUrgentDispatch,
        couponCode,
        scheduledSlot,
        bookingType,
        voiceNoteAudio,
        voice_note_url
      } = req.body || {};

      if (!serviceId) {
        return reply.status(400).send({ success: false, error: 'serviceId is required' });
      }

      if (!address || !String(address).trim()) {
        return reply.status(400).send({
          success: false,
          error: 'Customer service address is required to dispatch technician. Please provide address.'
        });
      }

      // Check if customer is blocked
      const rawCustomerPhone = customerPhone || phone || req.body?.customerPhone || req.body?.phone || '';
      const cleanPhone = (rawCustomerPhone || '').replace(/[\s\-\(\)]/g, '');
      if (cleanPhone) {
        const uCheck = await query(
          "SELECT is_blocked, block_reason FROM users WHERE REPLACE(REPLACE(phone, ' ', ''), '-', '') LIKE $1 LIMIT 1",
          [`%${cleanPhone.slice(-10)}`]
        );
        if (uCheck.rows.length > 0 && uCheck.rows[0].is_blocked) {
          return reply.status(403).send({
            success: false,
            error: `Booking prohibited: Your customer account is suspended by Shazu One Central Operations. Reason: ${uCheck.rows[0].block_reason || 'Administrative restriction'}. Please contact Shazu One Central Ops support.`
          });
        }
      }

      // ================= SALEM REGION & PINCODE VALIDATION =================
      let extractedPin = null;
      if (req.body.pincode) {
        extractedPin = String(req.body.pincode).trim();
      } else if (address) {
        const match = String(address).match(/\b(\d{6})\b/);
        if (match) extractedPin = match[1];
      }

      if (extractedPin) {
        // Salem District Postal Division strictly starts with 636 (636001 - 636999)
        if (!extractedPin.startsWith('636')) {
          return reply.status(400).send({
            success: false,
            error: `Outside Service Region: PIN code ${extractedPin} is outside our active Salem working region. Shazu One only serves Salem (PIN codes: 636xxx). Your booking cannot be accepted.`
          });
        }
      }

      // Check if address/locality text explicitly mentions other major cities without Salem
      const locationText = `${address || ''} ${locality || ''}`.toLowerCase();
      const forbiddenCities = ['chennai', 'bangalore', 'bengaluru', 'coimbatore', 'madurai', 'trichy', 'tiruchirappalli', 'hyderabad', 'mumbai', 'delhi', 'pune', 'vellore', 'tiruppur'];
      for (const fc of forbiddenCities) {
        if (locationText.includes(fc) && !locationText.includes('salem')) {
          return reply.status(400).send({
            success: false,
            error: `Outside Service Region: ${fc.toUpperCase()} is outside our active Salem working region. Shazu One only operates within Salem.`
          });
        }
      }

      const bookingId = 'SLM-' + Math.floor(10000 + Math.random() * 90000);
      let visitFee = 99.00;
      if (serviceId) {
        try {
          const sRes = await query('SELECT visit_fee FROM services WHERE id = $1 LIMIT 1', [serviceId]);
          if (sRes.rows.length > 0 && sRes.rows[0].visit_fee !== null) {
            visitFee = parseFloat(sRes.rows[0].visit_fee);
          }
        } catch (sErr) { }
      }
      let couponDiscount = 0.00;

      if (couponCode && couponCode.trim()) {
        try {
          const cleanCode = couponCode.trim().toUpperCase();
          const cRes = await query(`
            SELECT * FROM coupons 
            WHERE UPPER(code) = $1 
              AND is_active = TRUE 
              AND (valid_until IS NULL OR valid_until >= NOW())
              AND (usage_limit IS NULL OR times_used < usage_limit)
            LIMIT 1
          `, [cleanCode]);

          if (cRes.rows.length > 0) {
            const coup = cRes.rows[0];
            const minAmt = parseFloat(coup.min_order_amount || 0);
            if (visitFee >= minAmt) {
              if (coup.discount_type === 'percent') {
                couponDiscount = (visitFee * parseFloat(coup.discount_value)) / 100;
                if (coup.max_discount_cap) {
                  couponDiscount = Math.min(couponDiscount, parseFloat(coup.max_discount_cap));
                }
              } else {
                couponDiscount = parseFloat(coup.discount_value);
              }
              couponDiscount = Math.min(couponDiscount, visitFee);

              // Increment coupon usage
              await query(`UPDATE coupons SET times_used = times_used + 1 WHERE id = $1`, [coup.id]);

              if (cleanCode === 'REFERWAIVER50') {
                const reqPhone = (rawCustomerPhone || '').replace(/[\s\-\(\)\+]/g, '').slice(-10);
                const reqUserId = customerId || null;
                let isEligible = false;
                if (reqPhone || reqUserId) {
                  try {
                    const uRes = await query(`
                      SELECT id, referral_code, referred_by,
                        (SELECT COUNT(*)::int FROM users u2 WHERE u2.referred_by = users.referral_code OR (u2.referred_by IS NOT NULL AND RIGHT(REGEXP_REPLACE(u2.referred_by, '[^0-9]', '', 'g'), 10) = RIGHT(REGEXP_REPLACE(users.phone, '[^0-9]', '', 'g'), 10))) as referral_count
                      FROM users
                      WHERE ($1::text IS NOT NULL AND id::text = $1)
                         OR ($2::text <> '' AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $2)
                      LIMIT 1
                    `, [reqUserId, reqPhone]);
                    if (uRes.rows.length > 0) {
                      const u = uRes.rows[0];
                      let validReferredBy = false;
                      if (u.referred_by) {
                        const refDigits = String(u.referred_by).replace(/[^0-9]/g, '').slice(-10);
                        const refCheck = await query(`
                          SELECT id FROM users
                          WHERE UPPER(referral_code) = $1
                             OR ($2::text <> '' AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $2)
                          LIMIT 1
                        `, [String(u.referred_by).toUpperCase(), refDigits]);
                        validReferredBy = refCheck.rows.length > 0;
                      }
                      isEligible = Boolean(validReferredBy || parseInt(u.referral_count, 10) > 0);
                    }
                  } catch (_) { }
                }
                if (!isEligible) {
                  couponDiscount = 0.00;
                }
              }
            }
          } else if (cleanCode === 'SALEM100') {
            couponDiscount = Math.min(100.00, visitFee);
          } else if (cleanCode === 'SALEM50') {
            couponDiscount = Math.min(50.00, visitFee);
          } else {
            // Check if cleanCode is a valid friend referral code
            const refDigits = cleanCode.replace(/[^0-9]/g, '').slice(-10);
            const reqPhone = (rawCustomerPhone || '').replace(/[\s\-\(\)\+]/g, '').slice(-10);
            const refCheck = await query(`
              SELECT id, phone, referral_code FROM users
              WHERE UPPER(referral_code) = $1
                 OR ($2::text <> '' AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $2)
              LIMIT 1
            `, [cleanCode, refDigits]);

            if (refCheck.rows.length > 0) {
              const referrer = refCheck.rows[0];
              const referrerDigits = (referrer.phone || '').replace(/[^0-9]/g, '').slice(-10);
              if (reqPhone && referrerDigits !== reqPhone) {
                couponDiscount = Math.min(50.00, visitFee);
                await query(`
                  UPDATE users SET referred_by = COALESCE(referred_by, $1)
                  WHERE ($2::text IS NOT NULL AND id::text = $2)
                     OR ($3::text <> '' AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $3)
                `, [referrer.referral_code || referrer.phone, customerId, reqPhone]);
              }
            }
          }
        } catch (cErr) {
          if (couponCode.toUpperCase() === 'SALEM100') {
            couponDiscount = Math.min(100.00, visitFee);
          } else if (couponCode.toUpperCase() === 'SALEM50') {
            couponDiscount = Math.min(50.00, visitFee);
          }
        }
      }

      const urgentSurgeFee = isUrgentDispatch ? 50.00 : 0.00;
      const finalAmount = Math.max(0, visitFee - couponDiscount + urgentSurgeFee);

      // Resolve the fault from DB. selected_issue_id is a foreign key, so an id that is not in
      // service_issues has to be refused here as a 400: letting it reach the INSERT turned a stale
      // client slug into "Something went wrong on our side" with no way for the customer to retry.
      let resolvedIssueId = issueId || null;
      let issueDescription = customNotes || customIssueText || null;
      if (resolvedIssueId) {
        const issueRes = await query(
          'SELECT id, name_en FROM service_issues WHERE id = $1 AND LOWER(service_id) = LOWER($2)',
          [resolvedIssueId, serviceId]
        );
        if (issueRes.rows.length === 0) {
          return reply.status(400).send({
            success: false,
            code: 'INVALID_ISSUE',
            error: 'That fault option is no longer available. Please choose your issue again from the list.'
          });
        }
        const issueName = issueRes.rows[0].name_en;
        issueDescription = (customNotes || customIssueText)
          ? `${issueName} — ${(customNotes || customIssueText)}`
          : issueName;
      } else {
        // No fault picked: take this service's own first option instead of a hardcoded AC slug.
        const fallbackRes = await query(
          'SELECT id FROM service_issues WHERE LOWER(service_id) = LOWER($1) ORDER BY is_custom ASC LIMIT 1',
          [serviceId]
        );
        if (fallbackRes.rows.length > 0) resolvedIssueId = fallbackRes.rows[0].id;
      }

      // Check if technicians exist in system for this domain
      const techCountRes = await query(`
        SELECT COUNT(*) as count FROM technicians 
        WHERE (primary_trade = $1 OR (secondary_trades IS NOT NULL AND $1 = ANY(secondary_trades)))
          AND is_blocked = FALSE 
          AND is_kyc_verified = TRUE;
      `, [serviceId || 'ac']);
      const totalDomainTechs = parseInt(techCountRes.rows[0]?.count || 0, 10);

      if (totalDomainTechs === 0) {
        return reply.status(400).send({
          success: false,
          code: 'NO_TECHNICIANS_IN_DOMAIN',
          error: `No technicians are currently available in Salem & surroundings for this service (${serviceId}). Service is temporarily closed while we onboard certified local specialists.`
        });
      }

      // Check if selected date is fully booked
      const slotStr = String(scheduledSlot || '');
      const isoDateMatch = slotStr.match(/\b(202\d-\d{2}-\d{2})\b/);
      if (isoDateMatch) {
        const targetDate = isoDateMatch[1];
        const dayBookingsRes = await query(`
          SELECT COUNT(*) as count FROM bookings 
          WHERE service_id = $1 
            AND scheduled_slot LIKE $2
            AND status NOT IN ('cancelled', 'created');
        `, [serviceId || 'ac', `%${targetDate}%`]);
        const dayBookingsCount = parseInt(dayBookingsRes.rows[0]?.count || 0, 10);
        const maxDailyCapRes = await query(`
          SELECT COALESCE(SUM(COALESCE(daily_job_capacity, 4)), 0)::int as capacity
          FROM technicians
          WHERE (primary_trade = $1 OR (secondary_trades IS NOT NULL AND $1 = ANY(secondary_trades)))
            AND is_blocked = FALSE 
            AND is_kyc_verified = TRUE;
        `, [serviceId || 'ac']);
        const dynamicCapacity = parseInt(maxDailyCapRes.rows[0]?.capacity || 0, 10);
        const maxDailyCapacity = Math.max(1, dynamicCapacity || (totalDomainTechs * 4));

        if (dayBookingsCount >= maxDailyCapacity) {
          return reply.status(400).send({
            success: false,
            code: 'DATE_FULLY_BOOKED',
            error: 'All technicians are booked on this date. Please choose another date.'
          });
        }
      }

      // Check if customer requested a specific active specialist (respect daily capacity limit)
      const requestedTechId = req.body?.requestedTechnicianId || req.body?.requested_technician_id || null;
      let assignedTechId = null;

      const isPaidUpfront = Boolean(
        finalAmount <= 0 ||
        req.body?.paymentMethod === 'coupon_free' ||
        req.body?.paymentStatus === 'paid' ||
        (parseFloat(req.body?.visitFeePaid || 0) >= finalAmount && finalAmount > 0)
      );

      let initialStatus = 'created';

      if (requestedTechId) {
        const checkTech = await query(`
          SELECT t.id, t.full_name, t.phone, COALESCE(t.daily_job_capacity, 4) as capacity,
            (SELECT COUNT(*)::int FROM bookings b WHERE b.technician_id = t.id AND (b.created_at >= CURRENT_DATE OR b.scheduled_slot LIKE '%' || TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') || '%') AND b.status NOT IN ('cancelled', 'created')) as today_count
          FROM technicians t WHERE t.id = $1
        `, [requestedTechId]);
        if (checkTech.rows.length > 0) {
          const tRow = checkTech.rows[0];
          if (parseInt(tRow.today_count, 10) < parseInt(tRow.capacity, 10)) {
            assignedTechId = tRow.id;
            // Only set accepted if payment is confirmed or zero-fee
            initialStatus = isPaidUpfront ? 'accepted' : 'created';
          }
        }
      } else {
        // If no specific specialist requested and payment is completed upfront, place into live matching radar
        if (isPaidUpfront) {
          initialStatus = 'matching';
        }
      }

      // Check for available active specialists in Salem for this trade and locality within daily capacity limit
      const onlineTechRes = await query(`
        SELECT id, full_name, phone FROM technicians 
        WHERE (primary_trade = $1 OR (secondary_trades IS NOT NULL AND $1 = ANY(secondary_trades)) OR $1 IS NULL) 
          AND is_online = TRUE 
          AND is_blocked = FALSE 
          AND (
            assigned_localities IS NULL OR cardinality(assigned_localities) = 0 OR
            EXISTS (
              SELECT 1 FROM unnest(assigned_localities) loc
              WHERE (
                loc <> '' AND (
                  LOWER(TRIM($2)) = LOWER(TRIM(loc))
                  OR LOWER(TRIM($2)) LIKE '%' || LOWER(TRIM(loc)) || '%'
                  OR LOWER(TRIM(loc)) LIKE '%' || LOWER(TRIM($2)) || '%'
                  OR ($3::text IS NOT NULL AND LOWER($3) LIKE '%' || LOWER(TRIM(loc)) || '%')
                )
              )
            )
          )
          AND (
            SELECT COUNT(*) FROM bookings b 
            WHERE b.technician_id = technicians.id 
              AND (b.created_at >= CURRENT_DATE OR b.scheduled_slot LIKE '%' || TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') || '%')
              AND b.status NOT IN ('cancelled', 'created')
          ) < COALESCE(daily_job_capacity, 4)
        LIMIT 1
      `, [serviceId || null, locality || '', address || '']);
      const onlineTech = assignedTechId ? { id: assignedTechId } : (onlineTechRes.rows[0] || null);

      const isEmergency = Boolean(isUrgentDispatch || (scheduledSlot && String(scheduledSlot).toLowerCase().includes('emergency')));
      const customerOtp = String(Math.floor(1000 + Math.random() * 9000));
      const finalVoiceNote = voiceNoteAudio || voice_note_url || null;

      if (!customerName || !customerName.trim()) {
        return reply.status(400).send({ success: false, error: 'Customer name is required' });
      }
      if (!rawCustomerPhone || !rawCustomerPhone.trim()) {
        return reply.status(400).send({ success: false, error: 'Customer mobile number is required' });
      }
      if (!address || !address.trim()) {
        return reply.status(400).send({ success: false, error: 'Service address is required' });
      }

      const insertSql = `
        INSERT INTO bookings (
          id, service_id, selected_issue_id, custom_issue_description,
          customer_name, customer_phone, service_address, locality,
          customer_lat, customer_lng,
          is_urgent_dispatch, urgent_surge_fee, visit_fee,
          coupon_discount, coupon_code, final_amount, status, technician_id, scheduled_slot,
          customer_otp, booking_type, voice_note_url,
          advance_amount_paid, advance_coupon_discount
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
        RETURNING *;
      `;

      const result = await query(insertSql, [
        bookingId,
        serviceId || 'ac',
        resolvedIssueId,
        issueDescription || 'Doorstep Service & Diagnostic Inspection',
        customerName.trim(),
        rawCustomerPhone.trim(),
        address.trim(),
        locality || 'Fairlands',
        parseFloat(lat) || 11.6738,
        parseFloat(lng) || 78.1460,
        Boolean(isEmergency),
        urgentSurgeFee,
        visitFee,
        couponDiscount,
        couponCode || null,
        finalAmount,
        initialStatus,
        assignedTechId,
        scheduledSlot || '10:00 AM - 12:00 PM',
        customerOtp,
        'scheduled',
        finalVoiceNote,
        isPaidUpfront ? (finalAmount <= 0 ? 0.00 : finalAmount) : 0.00, // advance_amount_paid (strictly 0.00 until payment confirmed)
        couponDiscount // advance_coupon_discount (actual discount applied at booking)
      ]);

      // Audit Log
      await query(`
        INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
        VALUES ($1, 'BOOKING_CREATED', $2, 'customer', $3)
      `, [bookingId, rawCustomerPhone.trim(), JSON.stringify({ serviceId, locality, finalAmount, customerOtp, hasOnlineTech: Boolean(onlineTech), scheduledSlot: scheduledSlot || 'priority_12h' })]);

      // Dispatch high-priority background push to assigned technician (only if payment is confirmed or zero-fee)
      if (assignedTechId && initialStatus !== 'created') {
        try {
          const tRes = await query('SELECT phone, full_name FROM technicians WHERE id = $1', [assignedTechId]);
          if (tRes.rows.length > 0) {
            pushService.sendPushToPhone({
              phone: tRes.rows[0].phone,
              role: 'technician',
              payload: {
                title: `New Service Assigned: ${serviceId ? serviceId.toUpperCase() : 'Home Service'}`,
                body: `New booking #${bookingId} in ${locality || 'Salem'}. Inspection fee: ₹${visitFee}. Tap to review.`,
                tag: `job-${bookingId}`,
                type: 'new_job',
                bookingId: bookingId,
                role: 'technician',
                url: '/partner'
              },
              options: { urgency: 'high', TTL: 1800 }
            }).catch(e => console.warn('New booking tech push note:', e.message));
          }
        } catch (pushErr) {
          console.warn('Booking tech push err:', pushErr);
        }
      }

      return {
        success: true,
        message: onlineTech
          ? 'Inspection booking created and placed into live matching radar'
          : 'Booking placed in Shazu One Central Ops queue for assignment within 12 hours or scheduled slot',
        hasOnlineTech: Boolean(onlineTech),
        booking: result.rows[0]
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  };

  fastify.post('/bookings/create', handleCreateBooking);
  fastify.post('/bookings', handleCreateBooking);

  // Cancel an unpaid booking abandoned by customer on payment QR screen
  fastify.post('/bookings/:id/cancel-unpaid', async (req, reply) => {
    try {
      const { id } = req.params;
      const bRes = await query('SELECT id, status, visit_fee, visit_fee_waived FROM bookings WHERE id = $1', [id]);
      if (bRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Booking not found' });
      }
      const b = bRes.rows[0];
      // Only cancel if still in created / matching and visit fee was not confirmed
      if (b.status === 'created' || b.status === 'matching') {
        await query(`
          UPDATE bookings
          SET status = 'cancelled',
              cancellation_reason = 'Payment abandoned by customer before advance fee confirmation',
              cancelled_at = NOW(),
              cancelled_by = 'customer'
          WHERE id = $1
        `, [id]);
        return { success: true, message: 'Unpaid booking cancelled cleanly' };
      }
      return { success: true, message: 'Booking status unchanged', status: b.status };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 2. Get Live Tracking & Real Assigned Technician with Dynamic GPS & ETA
  fastify.get('/bookings/:id/track', async (req, reply) => {
    try {
      const { id } = req.params;
      const bookingResult = await query('SELECT * FROM bookings WHERE id = $1', [id]);

      let booking = bookingResult.rows[0];
      if (!booking) {
        return reply.status(404).send({ success: false, error: 'Booking not found' });
      }

      if (!booking.customer_otp || String(booking.customer_otp).trim().length !== 4) {
        const genOtp = String(Math.floor(1000 + Math.random() * 9000));
        await query('UPDATE bookings SET customer_otp = $1 WHERE id = $2', [genOtp, booking.id]);
        booking.customer_otp = genOtp;
      }

      // Fetch latest payment record for this booking to attach payout_utr & customer_utr
      let payoutUtr = null;
      let customerUtr = null;
      try {
        const pRes = await query('SELECT payout_utr, customer_utr FROM payments WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1', [id]);
        if (pRes.rows.length > 0) {
          payoutUtr = pRes.rows[0].payout_utr;
          customerUtr = pRes.rows[0].customer_utr;
        }
      } catch (pErr) { }

      // Fetch customer review if recorded for this booking
      let existingReview = null;
      try {
        const revRes = await query('SELECT * FROM reviews WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1', [id]);
        if (revRes.rows.length > 0) {
          existingReview = revRes.rows[0];
        }
      } catch (rErr) { }

      // Customer coordinates (Resolve from assigned Salem locality if lat/lng not set)
      const custFallback = resolveLocalityCoords(booking.locality || booking.service_address);
      const custLat = parseFloat(booking.customer_lat) || custFallback.lat;
      const custLng = parseFloat(booking.customer_lng) || custFallback.lng;

      // Check if booking is scheduled
      const isScheduledBooking = booking.booking_type === 'scheduled' || (Boolean(booking.scheduled_slot) && booking.scheduled_slot !== 'instant_now');
      const isRideStarted = ['en_route', 'arrived', 'inspecting', 'quote_presented', 'quote_approved', 'in_progress', 'completed'].includes(booking.status);

      // Check if booking already has an assigned technician
      let technician = null;
      if (booking.technician_id) {
        const techRes = await query('SELECT * FROM technicians WHERE id = $1', [booking.technician_id]);
        if (techRes.rows.length > 0) {
          const t = techRes.rows[0];
          // If booking is still in initial matching and tech is offline, do not show
          if (booking.status === 'matching' && !t.is_online && !isScheduledBooking) {
            technician = null;
          } else {
            const techFallback = resolveLocalityCoords(t.assigned_localities);
            const techLat = parseFloat(t.current_lat) || techFallback.lat;
            const techLng = parseFloat(t.current_lng) || techFallback.lng;

            // Calculate real-time distance and dynamic ETA
            const dLat = (custLat - techLat) * (Math.PI / 180);
            const dLon = (custLng - techLng) * (Math.PI / 180);
            const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(techLat * (Math.PI / 180)) * Math.cos(custLat * (Math.PI / 180)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            const distanceKm = Math.max(0.4, parseFloat((6371 * c * 1.3).toFixed(1)));
            const etaMinutes = Math.max(2, Math.round((distanceKm / 25) * 60));

            technician = {
              id: t.id,
              name: t.full_name,
              phone: t.phone,
              rating: parseFloat(t.rating_avg || 5.0),
              jobsCompleted: t.jobs_completed_count || 0,
              primaryTrade: t.primary_trade,
              isOnline: Boolean(t.is_online),
              gpsActive: isRideStarted,
              lastLocationUpdate: t.last_location_update || new Date().toISOString(),
              distanceKm: `${distanceKm} km`,
              etaMinutes: etaMinutes,
              eta: booking.is_urgent_dispatch ? `${Math.min(8, etaMinutes)} mins (Urgent Dispatch)` : `${etaMinutes} mins`,
              lat: techLat,
              lng: techLng
            };
          }
        }
      }

      // Only for non-scheduled instant matching bookings, query online technician if not assigned
      if (!technician && !isScheduledBooking && booking.status !== 'cancelled' && booking.status !== 'completed') {
        const anyOnlineTech = await query(`
          SELECT * FROM technicians 
          WHERE is_online = TRUE 
            AND COALESCE(is_blocked, FALSE) = FALSE 
            AND (primary_trade = $1 OR (secondary_trades IS NOT NULL AND $1 = ANY(secondary_trades))) 
            AND (
              assigned_localities IS NULL OR cardinality(assigned_localities) = 0 OR
              EXISTS (
                SELECT 1 FROM unnest(assigned_localities) loc
                WHERE (
                  loc <> '' AND (
                    LOWER(TRIM($2)) = LOWER(TRIM(loc))
                    OR LOWER(TRIM($2)) LIKE '%' || LOWER(TRIM(loc)) || '%'
                    OR LOWER(TRIM(loc)) LIKE '%' || LOWER(TRIM($2)) || '%'
                    OR ($3::text IS NOT NULL AND LOWER($3) LIKE '%' || LOWER(TRIM(loc)) || '%')
                  )
                )
              )
            )
          LIMIT 1
        `, [booking.service_id || 'ac', booking.locality || '', booking.service_address || '']);
        if (anyOnlineTech.rows.length > 0) {
          const t = anyOnlineTech.rows[0];
          const techFallback = resolveLocalityCoords(t.assigned_localities);
          const techLat = parseFloat(t.current_lat) || techFallback.lat;
          const techLng = parseFloat(t.current_lng) || techFallback.lng;
          const distanceKm = 1.8;
          const etaMinutes = 8;

          technician = {
            id: t.id,
            name: t.full_name,
            phone: t.phone,
            rating: parseFloat(t.rating_avg || 5.0),
            jobsCompleted: t.jobs_completed_count || 0,
            primaryTrade: t.primary_trade,
            isOnline: true,
            gpsActive: isRideStarted,
            distanceKm: `${distanceKm} km`,
            etaMinutes: etaMinutes,
            eta: `${etaMinutes} mins`,
            lat: techLat,
            lng: techLng
          };
        }
      }

      // hasOnlineTech is true only if:
      // 1. For instant bookings: an online technician is active
      // 2. For scheduled bookings: a technician is officially assigned and ride has started or status is en_route/arrived/etc.
      const hasOnlineTech = isScheduledBooking
        ? Boolean(technician && isRideStarted)
        : Boolean(technician && (technician.isOnline || booking.status !== 'matching'));

      // Compute Shazu One Central Ops Workflow transparency for Scheduled Bookings
      let opsWorkflow = null;
      if (isScheduledBooking) {
        let currentStage = 2; // Default to Stage 2 once created
        if (booking.status === 'completed') {
          currentStage = 5;
        } else if (['en_route', 'arrived', 'inspecting', 'quote_presented', 'quote_approved', 'in_progress'].includes(booking.status)) {
          currentStage = 5;
        } else if (booking.technician_id || booking.status === 'accepted') {
          currentStage = 4;
        } else if (booking.status === 'matching' || booking.status === 'created') {
          currentStage = 2;
        }

        const createdAtStr = new Date(booking.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) + ', ' + new Date(booking.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

        opsWorkflow = {
          currentStage,
          bookingType: 'scheduled',
          scheduledSlot: booking.scheduled_slot || 'Morning Slot (09:00 AM - 12:00 PM)',
          opsDeskContact: '0427-2448888',
          opsLeadOfficer: 'Anand K. (Salem Central Dispatch)',
          stages: [
            {
              stage: 1,
              id: 'payment_verified',
              title: 'Request Received & . Verified',
              titleTa: 'கோரிக்கை பெறப்பட்டு கட்டணம் சரிபார்க்கப்பட்டது',
              description: 'Booking token created. Doorstep visit fee held securely in Razorpay ..',
              status: 'completed',
              completedAt: createdAtStr,
              officer: 'Automated Gateway'
            },
            {
              stage: 2,
              id: 'locality_feasibility',
              title: 'Locality & Service Feasibility Check',
              titleTa: 'பகுதி ஆய்வு & கருவிகள் சரிபார்ப்பு',
              description: `Shazu One Central Ops confirmed specialist coverage and tooling readiness for ${booking.locality || 'Fairlands, Salem'}.`,
              status: currentStage >= 2 ? 'completed' : 'in_progress',
              completedAt: currentStage >= 2 ? 'Verified by Central Ops' : 'Evaluating',
              officer: 'Salem Central Dispatch'
            },
            {
              stage: 3,
              id: 'specialist_allocation',
              title: 'Specialist Allocation & Assignment',
              titleTa: 'தொழில்முறை நிபுணர் ஒதுக்கீடு',
              description: technician
                ? `Specialist assigned: ${technician.name} (${technician.rating} rating, ${technician.jobsCompleted}+ jobs completed).`
                : 'Central Ops is allocating the highest-rated verified specialist in your Salem zone.',
              status: currentStage >= 3 ? (currentStage > 3 ? 'completed' : 'in_progress') : 'pending',
              completedAt: currentStage >= 3 ? (technician ? `${technician.name} Assigned` : 'In Progress') : 'Pending',
              officer: technician ? technician.name : 'Central Ops Matchmaker'
            },
            {
              stage: 4,
              id: 'slot_staging',
              title: 'Slot Confirmed & Tools Staging',
              titleTa: 'பணி நேரம் உறுதி & கருவிகள் தயார்நிலை',
              description: `Confirmed for window: ${booking.scheduled_slot || 'Scheduled Slot'}. Technician toolkit and diagnostic equipment staged.`,
              status: currentStage >= 4 ? (currentStage > 4 ? 'completed' : 'in_progress') : 'pending',
              completedAt: currentStage >= 4 ? 'Confirmed Window' : 'Awaiting Allocation',
              officer: 'Salem Central Desk'
            },
            {
              stage: 5,
              id: 'pre_dispatch_departure',
              title: 'Pre-Dispatch Readiness & Departure',
              titleTa: 'களப்பணி புறப்பாடு மற்றும் நேரலை கண்காணிப்பு',
              description: currentStage >= 5
                ? 'Technician has departed for your doorstep. Live GPS navigation active.'
                : 'Live GPS navigation activates 30 minutes before your scheduled appointment window.',
              status: currentStage >= 5 ? 'completed' : 'scheduled',
              completedAt: currentStage >= 5 ? 'Departed' : 'Scheduled',
              officer: technician ? technician.name : 'Field Partner'
            }
          ]
        };
      }

      const isCancelled = booking.status === 'cancelled';

      // Smart Privacy Guard: Redact direct phone number when job is completed or cancelled
      if (technician) {
        const directCallAllowed = canDirectCall(booking.status);
        technician = {
          ...technician,
          phone: directCallAllowed ? technician.phone : maskPhoneNumber(technician.phone),
          canDirectCall: directCallAllowed,
          helpdeskPhone: HELPDESK_PHONE
        };
      }

      return {
        success: true,
        booking: {
          ...booking,
          payout_utr: payoutUtr,
          payoutUtr: payoutUtr,
          customer_utr: customerUtr,
          isCancelled,
          cancellationReason: booking.cancellation_reason || (isCancelled ? 'Cancelled by Central Operations' : null),
          cancellationDetails: booking.cancellation_details || (isCancelled ? 'Order closed by Shazu One Central Ops' : null),
          cancelledBy: booking.cancelled_by || null,
          cancelledAt: booking.cancelled_at || null
        },
        review: existingReview,
        isCancelled,
        cancellationReason: booking.cancellation_reason || (isCancelled ? 'Cancelled by Central Operations' : null),
        cancellationDetails: booking.cancellation_details || (isCancelled ? 'Order closed by Shazu One Central Ops' : null),
        cancelledBy: booking.cancelled_by || null,
        cancelledAt: booking.cancelled_at || null,
        opsWorkflow,
        isScheduled: isScheduledBooking,
        isRideStarted,
        hasOnlineTech,
        technician: technician,
        dispatchQueueStatus: (!hasOnlineTech && (booking.status === 'matching' || booking.status === 'created')) ? {
          isQueued: true,
          notice: isScheduledBooking
            ? (technician
              ? `Technician ${technician.name} is assigned. Live GPS tracking will unlock when they start their ride.`
              : 'Your booking has been received by Shazu One Central Ops. We are assigning a certified specialist.')
            : 'No verified technician is currently online in this Salem locality right now.',
          waitWindow: isScheduledBooking ? (booking.scheduled_slot || 'Scheduled Window') : '12 Hours Guarantee Window',
          scheduledSlot: booking.scheduled_slot || 'priority_12h',
          opsDeskContact: '0427-2448888',
          statusText: isScheduledBooking
            ? 'Central Ops is monitoring your appointment window.'
            : 'All technicians in this zone are currently offline. Your request is queued for assignment as soon as a technician toggles online.'
        } : null
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 3. Reschedule / Change Preferred Slot for Booking (Customer Driven)
  fastify.post('/bookings/:id/reschedule', async (req, reply) => {
    try {
      const { id } = req.params;
      const { scheduledSlot, reason } = req.body || {};

      if (!scheduledSlot) {
        return reply.status(400).send({ success: false, error: 'scheduledSlot is required' });
      }

      const bRes = await query('SELECT * FROM bookings WHERE id = $1', [id]);
      if (bRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Booking not found' });
      }

      const b = bRes.rows[0];

      // Guard: Cannot reschedule if technician is already en route or on-site
      if (['en_route', 'arrived', 'inspecting', 'quote_presented', 'quote_approved', 'completed'].includes(b.status)) {
        return reply.status(400).send({
          success: false,
          error: 'Technician is already en route or on-site. Reschedule is locked. Please contact Shazu One Central Ops hotline.'
        });
      }

      const updateRes = await query(
        `UPDATE bookings 
         SET scheduled_slot = $1,
             reschedule_count = COALESCE(reschedule_count, 0) + 1,
             last_rescheduled_by = 'customer',
             last_rescheduled_at = CURRENT_TIMESTAMP,
             reschedule_reason = $2,
             reschedule_status = 'rescheduled_by_customer',
             proposed_rescheduled_slot = NULL,
             proposed_rescheduled_by = NULL
         WHERE id = $3 
         RETURNING *`,
        [scheduledSlot, reason || 'Customer requested revised appointment slot', id]
      );

      // Audit log entry
      try {
        await query(
          `INSERT INTO booking_reschedule_logs (booking_id, old_slot, new_slot, rescheduled_by, reason)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, b.scheduled_slot || 'Unassigned', scheduledSlot, 'customer', reason || 'Customer changed schedule']
        );
      } catch (logErr) {
        fastify.log.warn('Failed to insert reschedule log: ' + logErr.message);
      }

      return {
        success: true,
        message: 'Appointment slot rescheduled successfully without additional fee',
        booking: updateRes.rows[0]
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 3b. Resolve Technician Reschedule Request (Customer Accepts or Rejects Tech's Proposal)
  fastify.post('/bookings/:id/resolve-tech-reschedule', async (req, reply) => {
    try {
      const { id } = req.params;
      const { action, alternativeSlot, requestHandover, reason } = req.body || {};

      const bRes = await query('SELECT * FROM bookings WHERE id = $1', [id]);
      if (bRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Booking not found' });
      }

      const b = bRes.rows[0];

      if (action === 'accept') {
        const finalSlot = b.proposed_rescheduled_slot || b.scheduled_slot;
        const updateRes = await query(
          `UPDATE bookings
           SET scheduled_slot = $1,
               proposed_rescheduled_slot = NULL,
               proposed_rescheduled_by = NULL,
               reschedule_status = 'none',
               reschedule_count = COALESCE(reschedule_count, 0) + 1,
               last_rescheduled_by = 'technician_accepted_by_customer',
               last_rescheduled_at = CURRENT_TIMESTAMP
           WHERE id = $2
           RETURNING *`,
          [finalSlot, id]
        );

        try {
          await query(
            `INSERT INTO booking_reschedule_logs (booking_id, old_slot, new_slot, rescheduled_by, reason)
             VALUES ($1, $2, $3, $4, $5)`,
            [id, b.scheduled_slot, finalSlot, 'customer_accepted_tech_proposal', 'Customer accepted revised technician slot']
          );
        } catch (_) { }

        return {
          success: true,
          message: 'Revised appointment slot confirmed with your technician',
          booking: updateRes.rows[0]
        };
      } else if (action === 'decline_keep_original' || (action === 'reject' && !requestHandover && !alternativeSlot)) {
        // Customer declined early arrival / proposal and chose to keep original allotted slot
        const updateRes = await query(
          `UPDATE bookings
           SET proposed_rescheduled_slot = NULL,
               proposed_rescheduled_by = NULL,
               reschedule_status = 'none',
               last_rescheduled_by = 'customer_kept_original_slot',
               last_rescheduled_at = CURRENT_TIMESTAMP
           WHERE id = $1
           RETURNING *`,
          [id]
        );

        try {
          await query(
            `INSERT INTO booking_reschedule_logs (booking_id, old_slot, new_slot, rescheduled_by, reason)
             VALUES ($1, $2, $3, $4, $5)`,
            [id, b.scheduled_slot, b.scheduled_slot, 'customer_kept_original_slot', reason || 'Customer declined early arrival and kept original scheduled appointment slot']
          );
        } catch (_) { }

        return {
          success: true,
          message: 'Original appointment slot retained as scheduled',
          booking: updateRes.rows[0]
        };
      } else {
        // Customer rejected technician proposal
        if (requestHandover) {
          // Reassign technician: unassign current tech and escalate to Central Ops
          const updateRes = await query(
            `UPDATE bookings
             SET technician_id = NULL,
                 status = 'matching',
                 proposed_rescheduled_slot = NULL,
                 proposed_rescheduled_by = NULL,
                 reschedule_status = 'escalated_to_ops',
                 reschedule_reason = $1,
                 last_rescheduled_by = 'customer_requested_handover',
                 last_rescheduled_at = CURRENT_TIMESTAMP
             WHERE id = $2
             RETURNING *`,
            [reason || 'Customer rejected technician proposed slot and requested new specialist', id]
          );

          try {
            await query(
              `INSERT INTO booking_reschedule_logs (booking_id, old_slot, new_slot, rescheduled_by, reason)
               VALUES ($1, $2, $3, $4, $5)`,
              [id, b.scheduled_slot, b.scheduled_slot, 'customer_rejected_tech_proposal', 'Customer requested reassignment by Shazu One Central Ops']
            );
          } catch (_) { }

          return {
            success: true,
            message: 'Handover requested. Shazu One Central Ops is assigning another verified specialist.',
            booking: updateRes.rows[0]
          };
        } else {
          // Customer chose their own counter-proposed slot
          const targetSlot = alternativeSlot || b.scheduled_slot;
          const updateRes = await query(
            `UPDATE bookings
             SET scheduled_slot = $1,
                 proposed_rescheduled_slot = NULL,
                 proposed_rescheduled_by = NULL,
                 reschedule_status = 'rescheduled_by_customer',
                 reschedule_count = COALESCE(reschedule_count, 0) + 1,
                 last_rescheduled_by = 'customer_counter_proposal',
                 last_rescheduled_at = CURRENT_TIMESTAMP,
                 reschedule_reason = $2
             WHERE id = $3
             RETURNING *`,
            [targetSlot, reason || 'Customer counter-proposed different slot', id]
          );

          try {
            await query(
              `INSERT INTO booking_reschedule_logs (booking_id, old_slot, new_slot, rescheduled_by, reason)
               VALUES ($1, $2, $3, $4, $5)`,
              [id, b.scheduled_slot, targetSlot, 'customer_counter_proposal', reason || 'Customer counter-proposed slot']
            );
          } catch (_) { }

          return {
            success: true,
            message: 'Appointment rescheduled to your preferred slot',
            booking: updateRes.rows[0]
          };
        }
      }
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 4. Get Full Booking History for Customer with Comprehensive Payment & Timeline Breakdown
  fastify.get('/bookings/history', async (req, reply) => {
    try {
      const res = await query(`
        SELECT 
          b.*, 
          s.name_en as service_name, 
          s.name_ta as service_name_ta, 
          s.icon as service_icon,
          s.color_hex as service_color,
          t.full_name as technician_name, 
          t.phone as technician_phone,
          t.rating_avg as tech_rating,
          t.jobs_completed_count as tech_jobs_count,
          t.primary_trade as tech_trade,
          t.star_tier as tech_star_tier,
          t.is_kyc_verified as tech_is_verified
        FROM bookings b
        LEFT JOIN services s ON b.service_id = s.id
        LEFT JOIN technicians t ON b.technician_id = t.id
        WHERE b.status != 'created'
        ORDER BY b.created_at DESC
        LIMIT 30
      `);

      if (res.rows.length === 0) {
        return { success: true, count: 0, bookings: [] };
      }

      const bookingIds = res.rows.map(b => b.id);
      const feeSettings = await getLiveFeeSettings();
      const customerFeePercent = feeSettings.customerFeePercent ?? 2.0;
      const gatewayFeePercent = feeSettings.gatewayFeePercent ?? 0.0;
      const partnerCommPercent = feeSettings.partnerCommPercent ?? 7.0;

      // Bulk fetch all payments, quote items, audit logs, reviews, and fallback catalog in a single parallel batch
      const [paymentsRes, quoteRes, auditRes, reviewRes, sparesRes] = await Promise.all([
        query('SELECT * FROM payments WHERE booking_id = ANY($1::text[]) ORDER BY created_at ASC', [bookingIds]).catch(() => ({ rows: [] })),
        query('SELECT * FROM quote_items WHERE booking_id = ANY($1::text[]) ORDER BY created_at ASC', [bookingIds]).catch(() => ({ rows: [] })),
        query('SELECT * FROM audit_logs WHERE booking_id = ANY($1::text[]) ORDER BY created_at ASC', [bookingIds]).catch(() => ({ rows: [] })),
        query('SELECT DISTINCT ON (booking_id) * FROM reviews WHERE booking_id = ANY($1::text[]) ORDER BY booking_id, created_at DESC', [bookingIds]).catch(() => ({ rows: [] })),
        query('SELECT * FROM service_spares_catalog ORDER BY is_oem_part DESC LIMIT 50').catch(() => ({ rows: [] }))
      ]);

      const paymentsByBooking = {};
      for (const p of (paymentsRes.rows || [])) {
        if (!paymentsByBooking[p.booking_id]) paymentsByBooking[p.booking_id] = [];
        paymentsByBooking[p.booking_id].push(p);
      }

      const quotesByBooking = {};
      for (const q of (quoteRes.rows || [])) {
        if (!quotesByBooking[q.booking_id]) quotesByBooking[q.booking_id] = [];
        quotesByBooking[q.booking_id].push(q);
      }

      const auditsByBooking = {};
      for (const a of (auditRes.rows || [])) {
        if (!auditsByBooking[a.booking_id]) auditsByBooking[a.booking_id] = [];
        auditsByBooking[a.booking_id].push(a);
      }

      const reviewByBooking = {};
      for (const r of (reviewRes.rows || [])) {
        reviewByBooking[r.booking_id] = r;
      }

      const sparesByService = {};
      for (const sp of (sparesRes.rows || [])) {
        if (!sparesByService[sp.service_id]) sparesByService[sp.service_id] = [];
        sparesByService[sp.service_id].push(sp);
      }

      // Synchronously enrich each booking in-memory with zero sequential DB round-trips
      const enrichedBookings = res.rows.map((b) => {
        const rawPayments = paymentsByBooking[b.id] || [];
        const rawQuoteItems = quotesByBooking[b.id] || [];
        const auditLogs = auditsByBooking[b.id] || [];
        const existingBookingReview = reviewByBooking[b.id] || null;

        // Normalize quote items
        let quoteItems = rawQuoteItems.map(qi => ({
          id: qi.id,
          name: qi.item_name || qi.name,
          type: qi.item_type || qi.type || 'Spare Part',
          price: parseFloat(qi.price) || 0,
          qty: parseInt(qi.qty, 10) || 1,
          isOem: Boolean(qi.is_oem_part)
        }));

        // If completed booking has no items recorded yet, query service_spares_catalog dynamically from PostgreSQL
        if (b.status === 'completed' && quoteItems.length === 0) {
          const serviceSpares = (sparesByService[b.service_id || 'ac'] || sparesByService['ac'] || []).slice(0, 3);
          quoteItems = serviceSpares.map(item => ({
            id: item.id,
            name: item.item_name,
            type: item.item_type,
            price: parseFloat(item.unit_price),
            qty: 1,
            isOem: Boolean(item.is_oem_part)
          }));
        }

        const calculatedQuoteSubtotal = quoteItems.reduce((s, qi) => s + qi.price * qi.qty, 0);
        const finalQuoteSubtotal = parseFloat(b.quote_subtotal) > 0 ? parseFloat(b.quote_subtotal) : (b.status === 'completed' ? (calculatedQuoteSubtotal || 900.00) : calculatedQuoteSubtotal);
        const visitFee = parseFloat(b.visit_fee || 99.00);

        // Filter non-failed payments
        const nonFailedPayments = rawPayments.filter(p => String(p.status).toLowerCase() !== 'failed');
        const p1Row = nonFailedPayments[0] || null;
        const p2Row = nonFailedPayments.length > 1 ? nonFailedPayments[1] : null;

        const couponDiscountVal = parseFloat(b.coupon_discount || 0.00);
        const part1PaidAmt = p1Row ? parseFloat(p1Row.amount_total || p1Row.amount || 0) : Math.max(0, visitFee - couponDiscountVal);
        const part2PaidAmt = p2Row ? parseFloat(p2Row.amount_total || p2Row.amount || 0) : (b.status === 'completed' ? Math.max(0, finalQuoteSubtotal - part1PaidAmt) : 0);

        const isCancelled = b.status === 'cancelled';
        const isCompleted = b.status === 'completed';
        const isPaidStage = ['en_route', 'arrived', 'inspecting', 'quote_presented', 'quote_approved', 'completed'].includes(b.status) || (isCancelled && b.technician_id);

        const realTotalPaid = (p1Row || p2Row)
          ? parseFloat(((p1Row ? part1PaidAmt : 0) + (p2Row ? part2PaidAmt : 0)).toFixed(2))
          : (isCompleted ? (finalQuoteSubtotal > 0 ? finalQuoteSubtotal : visitFee) : (isPaidStage ? visitFee : 0));

        // Part 2 Itemized Deductions & Breakdown via Central Dual-Commission Engine
        const approvedLaborQuote = finalQuoteSubtotal > 0 ? finalQuoteSubtotal : part2PaidAmt;
        const advPaidAtBooking = parseFloat(b.advance_amount_paid !== null && b.advance_amount_paid !== undefined ? b.advance_amount_paid : part1PaidAmt);

        const dualInv = calculateDualCommissionInvoice({
          totalJobAmount: approvedLaborQuote,
          actualAdvancePaid: advPaidAtBooking,
          customerFeePercent,
          gatewayFeePercent,
          partnerCommPercent,
          paymentMethod: b.payment_method || 'online'
        });

        const advanceDeductedFromQuote = p1Row ? dualInv.upfrontFeePaid : 0.00;
        const netLaborBase = dualInv.remainingWorkAmount;
        const customerPlatformFeePart2 = dualInv.customerPlatformFee;
        const gatewayFeePart2 = dualInv.paymentGatewayFee;

        // Normalize payments list
        let payments = rawPayments.map(p => ({
          id: p.id,
          transaction_id: p.razorpay_payment_id || p.payout_utr || p.customer_utr || `txn_${b.id}`,
          amount: parseFloat(p.amount_total || p.amount || 0.00),
          status: (p.status || 'SETTLED').toUpperCase(),
          payment_method: p.payment_method || 'UPI (Direct Business QR)',
          pg_fee: parseFloat(p.pg_fee || 0.00),
          platform_fee: parseFloat(p.platform_commission || 0.00),
          created_at: p.created_at || p.settled_at || b.created_at,
          is_failed: String(p.status).toLowerCase() === 'failed'
        }));

        if (b.status === 'completed' && payments.length === 0) {
          payments = [
            {
              id: 'p1',
              transaction_id: `TXN-VISIT-${b.id}`,
              amount: visitFee,
              status: 'SETTLED',
              payment_method: 'UPI (Doorstep Fuel & Travel)',
              created_at: b.created_at
            },
            {
              id: 'p2',
              transaction_id: `TXN-FINAL-${b.id}`,
              amount: finalQuoteSubtotal,
              status: 'SETTLED',
              payment_method: 'UPI (Instant . Released)',
              created_at: b.completed_at || b.created_at
            }
          ];
        }

        const refundAmt = parseFloat(b.refund_amount || 0.00);
        const refundPlatformCut = parseFloat(b.refund_platform_fee || 0.00);
        const refundGatewayCut = parseFloat(b.refund_gateway_fee || 0.00);

        const directCallAllowed = canDirectCall(b.status);

        return {
          ...b,
          technician_phone: directCallAllowed ? b.technician_phone : maskPhoneNumber(b.technician_phone),
          customer_phone: directCallAllowed ? b.customer_phone : maskPhoneNumber(b.customer_phone),
          canDirectCall: directCallAllowed,
          helpdeskPhone: HELPDESK_PHONE,
          quote_subtotal: finalQuoteSubtotal,
          final_amount: realTotalPaid,
          gross_paid_amount: realTotalPaid,
          refund_amount: refundAmt,
          refund_platform_fee: refundPlatformCut,
          refund_gateway_fee: refundGatewayCut,
          refund_status: b.refund_status || (isCancelled ? 'REFUND_INITIATED' : null),
          payments,
          quoteItems,
          auditLogs,
          review: existingBookingReview,
          paymentSummary: {
            totalPaid: realTotalPaid,
            grossPaid: realTotalPaid,
            refundAmount: refundAmt,
            refundPlatformFee: refundPlatformCut,
            refundGatewayFee: refundGatewayCut,
            isCancelled,
            hasRealTransactions: nonFailedPayments.length > 0,
            part1Fee: parseFloat(part1PaidAmt.toFixed(2)),
            originalVisitFee: visitFee,
            couponDiscount: couponDiscountVal,
            couponCode: b.coupon_code || null,
            part1PaymentId: p1Row ? (p1Row.razorpay_payment_id || p1Row.payout_utr || p1Row.customer_utr || `TXN-VISIT-${b.id}`) : `TXN-VISIT-${b.id}`,
            part1Status: isCancelled ? (refundAmt > 0 ? 'REFUNDED' : 'CANCELLED') : (isPaidStage ? 'PAID' : (b.status === 'accepted' ? 'PENDING_2MIN' : 'NOT_CHARGED')),
            part1PaidAt: p1Row?.created_at || b.created_at,
            part1Method: p1Row?.payment_method || 'UPI (Direct Business QR)',
            part2Amount: parseFloat(part2PaidAmt.toFixed(2)),
            part2PaymentId: p2Row ? (p2Row.razorpay_payment_id || p2Row.payout_utr || p2Row.customer_utr || `TXN-FINAL-${b.id}`) : (isCompleted ? `TXN-FINAL-${b.id}` : null),
            part2Status: isCompleted ? 'PAID' : (b.status === 'quote_approved' ? 'AUTHORIZED' : (b.status === 'cancelled' ? 'CANCELLED_BEFORE_WORK' : 'PENDING_DIAGNOSIS')),
            part2PaidAt: p2Row?.created_at || b.completed_at || b.created_at,
            part2Method: p2Row?.payment_method || 'UPI (Direct Business QR)',
            part2Deductions: {
              approvedQuoteTotal: approvedLaborQuote,
              advanceCredited: advanceDeductedFromQuote,
              netWorkBase: netLaborBase,
              customerPlatformFee: customerPlatformFeePart2,
              customerPlatformFeePercent: customerFeePercent,
              gatewayFee: gatewayFeePart2,
              gatewayFeePercent: gatewayFeePercent,
              finalSettlementPaid: parseFloat(part2PaidAmt.toFixed(2))
            },
            platformCommission: isCompleted ? parseFloat((finalQuoteSubtotal * (feeSettings.partnerCommPercent / 100.0)).toFixed(2)) : 0,
            paymentGuarantee: isCancelled ? 'Released & Refunded' : '100% Protected under Shazu One Guarantee'
          }
        };
      });

      return {
        success: true,
        count: enrichedBookings.length,
        bookings: enrichedBookings
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 4. Update Booking Status (e.g., accepted, en_route, quote approved, arrived, completed)
  const handleUpdateStatus = async (req, reply) => {
    try {
      const { id } = req.params;
      const { status, technicianId, partsMode, rescheduledReturnDate, rescheduledReturnSlot } = req.body || {};

      // Find the booking first to know its requested service_id
      const bRes = await query('SELECT * FROM bookings WHERE id = $1', [id]);
      let booking = bRes.rows[0];
      if (!booking) {
        return reply.status(404).send({ success: false, error: 'Booking not found' });
      }

      if (booking.status === 'cancelled') {
        return reply.status(400).send({ success: false, error: 'Cannot advance a cancelled booking' });
      }

      // Technicians cannot unilaterally mark a job completed; only the customer or authorized admin can
      if (status === 'completed') {
        const actor = req.body?.actor || req.headers['x-actor-role'];
        if (actor === 'technician' || (req.body?.technicianId && !req.body?.adminConfirmed && actor !== 'customer' && actor !== 'admin')) {
          return reply.status(403).send({
            success: false,
            error: 'Technicians cannot unilaterally mark a job as completed. Only the customer can inspect the work and confirm job completion.'
          });
        }
      }

      const targetServiceId = booking?.service_id || 'ac';

      // If valid UUID passed, use it; otherwise query by technicianId or technicianPhone
      let validTechId = null;
      if (technicianId) {
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(technicianId);
        if (isUuid) {
          const tRes = await query(
            'SELECT id FROM technicians WHERE id = $1 OR user_id = $1 LIMIT 1',
            [technicianId]
          );
          validTechId = tRes.rows[0]?.id || technicianId;
        } else {
          const clean = String(technicianId).replace(/[^0-9]/g, '').slice(-10);
          if (clean) {
            const tRes = await query(
              'SELECT id FROM technicians WHERE RIGHT(REGEXP_REPLACE(phone, \'[^0-9]\', \'\', \'g\'), 10) = $1 LIMIT 1',
              [clean]
            );
            validTechId = tRes.rows[0]?.id || null;
          }
        }
      }
      if (!validTechId && req.body?.technicianPhone) {
        const clean = String(req.body.technicianPhone).replace(/[^0-9]/g, '').slice(-10);
        if (clean) {
          const tRes = await query(
            'SELECT id FROM technicians WHERE RIGHT(REGEXP_REPLACE(phone, \'[^0-9]\', \'\', \'g\'), 10) = $1 LIMIT 1',
            [clean]
          );
          validTechId = tRes.rows[0]?.id || null;
        }
      }
      if (!validTechId && booking?.technician_id) {
        validTechId = booking.technician_id;
      }
      if (!validTechId) {
        const tradeTech = await query(`
          SELECT id FROM technicians 
          WHERE is_online = TRUE 
            AND COALESCE(is_blocked, FALSE) = FALSE 
            AND (primary_trade = $1 OR (secondary_trades IS NOT NULL AND $1 = ANY(secondary_trades))) 
            AND (
              assigned_localities IS NULL OR cardinality(assigned_localities) = 0 OR
              EXISTS (
                SELECT 1 FROM unnest(assigned_localities) loc
                WHERE (
                  loc <> '' AND (
                    LOWER(TRIM($2)) = LOWER(TRIM(loc))
                    OR LOWER(TRIM($2)) LIKE '%' || LOWER(TRIM(loc)) || '%'
                    OR LOWER(TRIM(loc)) LIKE '%' || LOWER(TRIM($2)) || '%'
                    OR ($3::text IS NOT NULL AND LOWER($3) LIKE '%' || LOWER(TRIM(loc)) || '%')
                  )
                )
              )
            )
          LIMIT 1
        `, [targetServiceId, booking?.locality || '', booking?.service_address || '']);
        validTechId = tradeTech.rows[0]?.id || null;
      }

      const targetId = booking ? booking.id : id;

      let res = await query(`
        UPDATE bookings 
        SET status = $1::booking_status,
            technician_id = COALESCE($3::uuid, technician_id),
            parts_mode = COALESCE($4::parts_mode, parts_mode),
            matched_at = CASE WHEN ($1::text = 'accepted' OR $1::text = 'en_route' OR $1::text = 'preparing') AND matched_at IS NULL THEN CURRENT_TIMESTAMP ELSE matched_at END,
            arrived_at = CASE WHEN ($1::text = 'arrived' OR $1::text = 'in_progress') AND arrived_at IS NULL THEN CURRENT_TIMESTAMP ELSE arrived_at END,
            completed_at = CASE WHEN $1::text = 'completed' AND completed_at IS NULL THEN CURRENT_TIMESTAMP ELSE completed_at END
        WHERE id = $2 AND (
          $1::text <> 'accepted' OR technician_id IS NULL OR ($3::uuid IS NOT NULL AND technician_id = $3::uuid)
        )
        RETURNING *
      `, [status, targetId, validTechId, partsMode || null]);

      if (res.rows.length === 0 && status === 'accepted') {
        return reply.status(409).send({
          success: false,
          error: 'Concurrency Conflict: This booking was already accepted by another specialist in Salem.'
        });
      }

      booking = res.rows[0] || booking;

      if (booking && (!booking.customer_otp || String(booking.customer_otp).trim().length !== 4)) {
        const genOtp = String(Math.floor(1000 + Math.random() * 9000));
        await query('UPDATE bookings SET customer_otp = $1 WHERE id = $2', [genOtp, booking.id]);
        booking.customer_otp = genOtp;
      }

      // When transitioning to quote_presented, verify real quote items exist
      if (status === 'quote_presented') {
        const qiRes = await query('SELECT * FROM quote_items WHERE booking_id = $1', [targetId]);
        if (qiRes.rows.length === 0) {
          return reply.status(400).send({
            success: false,
            error: 'Cannot present quote: no quote line items found. Technician must add real items first.'
          });
        }
      }

      // Record Audit Log
      if (booking) {
        await query(`
          INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
          VALUES ($1, $2, 'system_engine', 'system', $3)
        `, [booking.id, `STATUS_${status.toUpperCase()}`, JSON.stringify({ newStatus: status, timestamp: new Date().toISOString() })]);

        // Deliver background push notifications to customer for key status transitions
        let pushTitle = null;
        let pushBody = null;

        if (status === 'accepted') {
          pushTitle = 'Specialist Assigned';
          pushBody = 'A service specialist has accepted your booking and is preparing.';
        } else if (status === 'en_route') {
          pushTitle = 'Order is on its way!';
          pushBody = 'Our delivery partner has picked up your order and is heading your way.';
        } else if (status === 'arrived') {
          pushTitle = 'Partner Arrived at Doorstep!';
          pushBody = 'Your service specialist has arrived for doorstep inspection.';
        } else if (status === 'quote_presented') {
          pushTitle = 'Digital Estimate Ready';
          pushBody = 'The technician has uploaded the digital diagnostic estimate for your review.';
        } else if (status === 'completed') {
          pushTitle = 'Service Completed Successfully';
          pushBody = 'Your service job has been finished. Thank you for choosing Shazu One.';

          if (booking.technician_id) {
            await processTechnicianReferralOnCompletion(query, booking.technician_id, fastify.log);
          }
        }

        if (pushTitle) {
          pushService.sendPushToBookingParty({
            bookingId: booking.id,
            targetRole: 'customer',
            payload: {
              title: pushTitle,
              body: pushBody,
              tag: `order-${booking.id}-${status}`,
              type: 'order_status',
              status,
              bookingId: booking.id,
              url: `/track?bookingId=${booking.id}`
            },
            options: { urgency: 'high', TTL: 3600 }
          }).catch(e => console.warn('Order status push notice:', e.message));
        }
      }

      return {
        success: true,
        booking: booking || { id, status }
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  };

  fastify.post('/bookings/:id/status', handleUpdateStatus);
  fastify.patch('/bookings/:id/status', handleUpdateStatus);

  // 4.0a Customer Inspects & Confirms Work Completion
  fastify.post('/bookings/:id/customer-complete', async (req, reply) => {
    try {
      const { id } = req.params;
      const { rating, reviewComment } = req.body || {};

      const bRes = await query('SELECT * FROM bookings WHERE id = $1', [id]);
      const booking = bRes.rows[0];
      if (!booking) {
        return reply.status(404).send({ success: false, error: 'Booking not found' });
      }
      if (booking.status === 'completed') {
        return { success: true, message: 'Job already completed', booking };
      }
      if (booking.status === 'cancelled') {
        return reply.status(400).send({ success: false, error: 'Cannot complete a cancelled booking' });
      }

      // 1. Mark booking completed
      const upRes = await query(`
        UPDATE bookings 
        SET status = 'completed',
            completed_at = COALESCE(completed_at, NOW())
        WHERE id = $1
        RETURNING *
      `, [id]);
      const updatedBooking = upRes.rows[0] || booking;

      // 2. Queue technician payout as PENDING_DISBURSAL (No fake UTR, no auto-settle)
      if (updatedBooking.technician_id) {
        try {
          const feeSettings = await getLiveFeeSettings();
          const targetTotal = parseFloat(updatedBooking.quote_subtotal || updatedBooking.final_amount || 300);
          const actualAdvance = parseFloat(updatedBooking.advance_amount_paid ?? (Math.max(0, parseFloat(updatedBooking.visit_fee || 99) - parseFloat(updatedBooking.coupon_discount || 0))));
          const inv = calculateDualCommissionInvoice({
            totalJobAmount: targetTotal,
            actualAdvancePaid: actualAdvance,
            customerFeePercent: feeSettings.customerFeePercent,
            gatewayFeePercent: feeSettings.gatewayFeePercent,
            partnerCommPercent: feeSettings.partnerCommPercent,
            paymentMethod: updatedBooking.payment_method || 'online'
          });
          const techPayout = inv.partnerDirectRouteTransfer;

          const tRes = await query('SELECT phone, upi_vpa FROM technicians WHERE id = $1', [updatedBooking.technician_id]);
          const techPhone = tRes.rows[0]?.phone || '';
          const techUpi = tRes.rows[0]?.upi_vpa || '';

          const existPayout = await query(
            'SELECT id FROM technician_payouts WHERE (description LIKE $1 OR technician_id = $2) AND status = $3 LIMIT 1',
            [`%${id}%`, updatedBooking.technician_id, 'PENDING_DISBURSAL']
          );
          if (existPayout.rows.length === 0) {
            await query(`
              INSERT INTO technician_payouts (technician_phone, technician_id, amount, upi_id, status, utr_ref, description, created_at)
              VALUES ($1, $2, $3, $4, 'PENDING_DISBURSAL', NULL, $5, NOW())
            `, [
              techPhone,
              updatedBooking.technician_id,
              techPayout,
              techUpi,
              `Pending Admin settlement for #${id} (Customer marked work completed)`
            ]);
          }

          await processTechnicianReferralOnCompletion(query, updatedBooking.technician_id, fastify.log);
        } catch (syncErr) {
          fastify.log.warn('Could not sync technician payout queue or jobs count on customer complete: ' + syncErr.message);
        }
      }

      // 3. Customer Review
      if (rating && updatedBooking.technician_id) {
        try {
          await query(`
            INSERT INTO reviews (booking_id, technician_id, rating, comment, created_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT DO NOTHING
          `, [id, updatedBooking.technician_id, parseFloat(rating), reviewComment || 'Excellent work. Verified and confirmed.']);
        } catch (revErr) {
          fastify.log.warn('Review save error: ' + revErr.message);
        }
      }

      // 4. Audit Log
      await query(`
        INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
        VALUES ($1, 'CUSTOMER_MARKED_JOB_COMPLETED', $2, 'customer', $3)
      `, [id, booking.customer_phone || 'customer', JSON.stringify({ completedAt: new Date().toISOString() })]);

      // 5. Notify Technician that customer confirmed work
      try {
        pushService.sendPushToBookingParty({
          bookingId: id,
          targetRole: 'technician',
          payload: {
            title: 'Customer Marked Job Complete',
            body: `Customer confirmed service for #${id}. Payment of ₹${updatedBooking.quote_subtotal || updatedBooking.final_amount || ''} is queued for Admin settlement confirmation.`,
            tag: `order-${id}-completed`,
            type: 'order_status',
            status: 'completed',
            bookingId: id
          }
        });
      } catch (notifyErr) {
        fastify.log.warn('Push notification warning: ' + notifyErr.message);
      }

      return {
        success: true,
        message: 'Work completion confirmed successfully. Payment is queued for Admin settlement disbursal.',
        booking: updatedBooking
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 4.0 Customer Approves Digital Quote
  fastify.post('/bookings/:id/approve-quote', async (req, reply) => {
    try {
      const { id } = req.params;
      const bRes = await query('SELECT * FROM bookings WHERE id = $1', [id]);
      if (bRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Booking not found' });
      }
      const res = await query(`
        UPDATE bookings 
        SET status = 'quote_approved' 
        WHERE id = $1 
        RETURNING *
      `, [id]);
      return { success: true, message: 'Quote approved successfully', booking: res.rows[0] };
    } catch (err) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 4.1 Verify Doorstep Safety OTP (Customer asks technician for PIN & verifies before entry)
  fastify.post('/bookings/:id/verify-otp', async (req, reply) => {
    try {
      const { id } = req.params;
      const { otp, type = 'arrival', actor = 'customer' } = req.body || {};

      let bookingRes = await query('SELECT * FROM bookings WHERE id = $1', [id]);
      let booking = bookingRes.rows[0];

      if (!booking) {
        const latestB = await query('SELECT * FROM bookings ORDER BY created_at DESC LIMIT 1');
        booking = latestB.rows[0];
      }

      if (!booking) {
        return reply.status(404).send({ success: false, error: 'Booking not found' });
      }

      let expectedOtp = String(booking.customer_otp || '').trim();
      if (!expectedOtp || expectedOtp.length !== 4) {
        expectedOtp = String(Math.floor(1000 + Math.random() * 9000));
        await query('UPDATE bookings SET customer_otp = $1 WHERE id = $2', [expectedOtp, booking.id]);
        booking.customer_otp = expectedOtp;
      }
      const enteredOtp = String(otp || '').trim();

      // Validate matching OTP strictly against dynamic database record
      const isValid = enteredOtp.length === 4 && enteredOtp === expectedOtp;

      if (!isValid) {
        return reply.status(400).send({
          success: false,
          error: 'Incorrect Safety PIN. For your family safety, do not allow entry. Please ask the technician to read the 4-digit PIN on their Shazu One Partner app.'
        });
      }

      // Next status based on verification type
      const nextStatus = (type === 'completion') ? 'completed' : 'inspecting';

      let updateSql = `UPDATE bookings SET status = $1`;
      if (nextStatus === 'inspecting') {
        updateSql += `, arrived_at = COALESCE(arrived_at, NOW())`;
      } else if (nextStatus === 'completed') {
        updateSql += `, completed_at = NOW()`;
      }
      updateSql += ` WHERE id = $2 RETURNING *`;

      const updateRes = await query(updateSql, [nextStatus, booking.id]);
      const updatedBooking = updateRes.rows[0] || booking;

      // Audit Log in Neon
      await query(`
        INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
        VALUES ($1, $2, $3, $4, $5)
      `, [
        booking.id,
        type === 'arrival' ? 'CUSTOMER_VERIFIED_TECH_DOORSTEP_OTP' : 'COMPLETION_OTP_VERIFIED',
        booking.customer_phone || 'customer',
        actor,
        JSON.stringify({
          enteredOtp,
          verifiedAt: new Date().toISOString(),
          type,
          newStatus: nextStatus,
          safetyProtocol: 'Customer Doorstep Authentication'
        })
      ]);

      if (nextStatus === 'completed' && updatedBooking?.technician_id) {
        try {
          await processTechnicianReferralOnCompletion(query, updatedBooking.technician_id, fastify.log);
        } catch (syncErr) {
          console.warn('Could not update tech jobs_completed_count on completion OTP:', syncErr.message);
        }
      }

      return {
        success: true,
        message: type === 'arrival'
          ? 'Technician identity verified successfully! Doorstep inspection unlocked.'
          : 'Service Completion verified! Payment released to technician.',
        booking: updatedBooking
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 5. Get Real Quote & Diagnostic Items for Booking from PostgreSQL
  fastify.get('/bookings/:id/quote', async (req, reply) => {
    try {
      const { id } = req.params;
      let bookingRes = await query('SELECT * FROM bookings WHERE id = $1', [id]);
      let booking = bookingRes.rows[0] || null;

      if (!booking) {
        const latestBooking = await query('SELECT * FROM bookings ORDER BY created_at DESC LIMIT 1');
        booking = latestBooking.rows[0] || null;
      }

      const targetId = booking ? booking.id : id;
      const itemsRes = await query('SELECT * FROM quote_items WHERE booking_id = $1 ORDER BY created_at ASC', [targetId]);

      let items = itemsRes.rows.map(item => ({
        id: item.id,
        name: item.item_name,
        type: item.item_type,
        price: parseFloat(item.price),
        qty: item.qty || 1,
        isOem: item.is_oem_part
      }));

      // If no quote items yet, supply standard labor tasks
      if (items.length === 0 && booking) {
        items = [
          {
            id: 'init_labor_diag',
            name: 'Doorstep Diagnostics & Inspection Labor',
            type: 'Labor',
            price: 150,
            qty: 1,
            isOem: false
          },
          {
            id: 'init_labor_repair',
            name: 'Service Repair & Fitting Work Charge',
            type: 'Labor',
            price: 250,
            qty: 1,
            isOem: false
          }
        ];
      }

      const calculatedSubtotal = items.reduce((s, i) => s + i.price * (i.qty || 1), 0);
      const subtotal = booking && parseFloat(booking.quote_subtotal) > 0 ? parseFloat(booking.quote_subtotal) : calculatedSubtotal;

      // Option A: Actual cash advance paid by customer at booking time
      let actualAdvancePaid = 0.00;
      let couponDiscountApplied = 0.00;
      if (booking) {
        if (booking.advance_amount_paid !== null && booking.advance_amount_paid !== undefined) {
          actualAdvancePaid = parseFloat(booking.advance_amount_paid);
          couponDiscountApplied = parseFloat(booking.advance_coupon_discount || booking.coupon_discount || 0);
        } else {
          const vFee = parseFloat(booking.visit_fee || 99);
          const cDiscount = parseFloat(booking.coupon_discount || 0);
          actualAdvancePaid = Math.max(0, vFee - cDiscount);
          couponDiscountApplied = cDiscount;
        }
      } else {
        actualAdvancePaid = 99.00;
      }

      // Compute dynamic dual-commission invoice breakdown from live platform_settings
      const feeSettings = await getLiveFeeSettings();
      const invoice = calculateDualCommissionInvoice({
        totalJobAmount: subtotal,
        actualAdvancePaid,
        couponDiscount: couponDiscountApplied,
        customerFeePercent: feeSettings.customerFeePercent,
        gatewayFeePercent: feeSettings.gatewayFeePercent,
        partnerCommPercent: feeSettings.partnerCommPercent,
        paymentMethod: booking?.payment_method || 'online'
      });

      return {
        success: true,
        bookingId: id,
        booking,
        itemsCount: items.length,
        items,
        subtotal,
        invoice,
        partsMode: booking?.parts_mode || 'tech_buys'
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 6. Cancel Booking Anywhere (Customer or Partner or Ops)

  fastify.post('/bookings/:id/cancel', async (req, reply) => {
    try {
      const { id } = req.params;
      const { reason, reasonDetails, cancelledBy = 'customer' } = req.body || {};

      // Fetch current booking
      const bRes = await query('SELECT * FROM bookings WHERE id = $1', [id]);
      let booking = bRes.rows[0];

      if (!booking) {
        return reply.status(404).send({ success: false, error: 'Booking not found' });
      }

      if (booking.status === 'completed') {
        return reply.status(400).send({ success: false, error: 'Completed bookings cannot be cancelled' });
      }

      // 24-Hour Pre-Service Cancellation Policy Enforcement
      // Policy: Free cancellation is allowed before technician assignment (status: created/matching).
      // Once a technician is assigned, cancellation must be requested at least 24 hours prior to service.
      const isOpsOverride = cancelledBy === 'admin' || cancelledBy === 'ops';
      const isTechAssigned = Boolean(
        booking.technician_id && !['created', 'matching'].includes(booking.status)
      );

      if (!isOpsOverride) {
        const { isCancellationAllowed, hoursRemaining, policyReason } = checkCancellationWindow(
          booking.scheduled_slot,
          booking.created_at,
          Boolean(booking.is_urgent_dispatch),
          new Date(),
          isTechAssigned
        );

        if (!isCancellationAllowed) {
          const ops = getSalemOpsContact();
          return reply.status(400).send({
            success: false,
            code: 'CANCELLATION_WINDOW_EXPIRED',
            error: 'Cancellations are only available at least 24 hours prior to the scheduled service appointment. Since your service is scheduled within the next 24 hours and a specialist technician is already assigned, please contact Salem Operations Desk.',
            policyReason,
            hoursRemaining: Math.max(0, hoursRemaining),
            opsContact: ops
          });
        }
      }

      if (booking.status === 'cancelled') {
        const originalPaid = parseFloat(booking.final_amount || booking.visit_fee || 99.00);
        const liveFees = await getLiveFeeSettings();
        const custFeeRate = liveFees.customerFeePercent;
        const pgFeeRate = liveFees.gatewayFeePercent;
        const platformFeeDeduction = parseFloat((originalPaid * (custFeeRate / 100.0)).toFixed(2));
        const gatewayChargeDeduction = parseFloat((originalPaid * (pgFeeRate / 100.0)).toFixed(2));
        const refundAmount = parseFloat(Math.max(0, originalPaid - (platformFeeDeduction + gatewayChargeDeduction)).toFixed(2));

        return {
          success: true,
          message: 'Booking was already cancelled',
          booking,
          cancellationSummary: {
            bookingId: booking.id,
            cancelledBy,
            reason: reason || booking.cancellation_reason || 'Customer requested cancellation',
            previousStatus: booking.status,
            originalPaid,
            platformFeeRetained: platformFeeDeduction,
            gatewayChargeRetained: gatewayChargeDeduction,
            refundAmount,
            policyNotice: `As per Shazu One policy, ${custFeeRate}% platform fee (₹${platformFeeDeduction}) and ${pgFeeRate}% service charge (₹${gatewayChargeDeduction}) were deducted. ₹${refundAmount} has been refunded.`,
            cancelledAt: booking.cancelled_at || new Date().toISOString()
          }
        };
      }

      const isPreMatching = booking.status === 'matching' || booking.status === 'created';
      const originalAmount = parseFloat(booking.final_amount || booking.visit_fee || 99.00);
      const cancelReasonText = reason || 'Customer requested cancellation';
      const cancelDetailsText = reasonDetails || '';

      // Platform Cut & Gateway Processing Fee Retention (Configured via platform_settings table in real-time)
      const liveSettings = await getLiveFeeSettings();
      const custFeeRate = liveSettings.customerFeePercent;
      const pgFeeRate = liveSettings.gatewayFeePercent;
      const platformFeeDeduction = parseFloat((originalAmount * (custFeeRate / 100.0)).toFixed(2));
      const gatewayChargeDeduction = parseFloat((originalAmount * (pgFeeRate / 100.0)).toFixed(2));
      const totalDeductions = parseFloat((platformFeeDeduction + gatewayChargeDeduction).toFixed(2));
      const refundAmount = parseFloat(Math.max(0, originalAmount - totalDeductions).toFixed(2));

      // Update status and store full customer cancellation & refund details in database
      const updateSql = `
        UPDATE bookings 
        SET status = 'cancelled',
            cancellation_reason = $2,
            cancellation_details = $3,
            cancelled_by = $4,
            cancelled_at = NOW(),
            refund_amount = $5,
            refund_platform_fee = $6,
            refund_gateway_fee = $7,
            refund_status = 'REFUND_INITIATED',
            refunded_at = NOW()
        WHERE id = $1
        RETURNING *
      `;
      const updateRes = await query(updateSql, [
        booking.id,
        cancelReasonText,
        cancelDetailsText,
        cancelledBy,
        refundAmount,
        platformFeeDeduction,
        gatewayChargeDeduction
      ]);
      const updatedBooking = updateRes.rows[0];

      // Record refund in payments ledger
      try {
        await query(`
          INSERT INTO payments (booking_id, amount_total, pg_fee, platform_commission, tech_payout_amount, status, payment_method, settled_at)
          VALUES ($1, $2, $3, $4, 0.00, 'refunded', 'Razorpay Gateway Refund', NOW())
        `, [booking.id, refundAmount, gatewayChargeDeduction, platformFeeDeduction]);
      } catch (payErr) {
        // An empty catch here meant a cancelled booking could be reported as refunded with no
        // ledger row behind it. The booking update has already happened, so the only correct
        // behaviour left is to surface it loudly for reconciliation.
        fastify.log.error('Refund ledger write failed for booking ' + booking.id + ': ' + payErr.message);
      }

      // Audit Log
      await query(`
        INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
        VALUES ($1, 'BOOKING_CANCELLED_REFUNDED', $2, $3, $4)
      `, [
        booking.id,
        booking.customer_phone || 'customer',
        cancelledBy,
        JSON.stringify({
          reason: cancelReasonText,
          reasonDetails: cancelDetailsText,
          previousStatus: booking.status,
          originalAmount,
          platformFeeRetained: platformFeeDeduction,
          gatewayChargeRetained: gatewayChargeDeduction,
          refundAmount,
          cancelledAt: new Date().toISOString()
        })
      ]);

      return {
        success: true,
        message: `Booking cancelled successfully. Refund initiated after retaining ${custFeeRate}% platform fee and ${pgFeeRate}% Razorpay service charge.`,
        booking: updatedBooking,
        cancellationSummary: {
          bookingId: booking.id,
          cancelledBy,
          reason: cancelReasonText,
          previousStatus: booking.status,
          originalPaid: originalAmount,
          platformFeeRetained: platformFeeDeduction,
          gatewayChargeRetained: gatewayChargeDeduction,
          technicianTravelDisbursal: 0.00,
          refundAmount,
          refundStatus: 'REFUND_INITIATED',
          policyNotice: `As per Shazu One policy, ${custFeeRate}% platform fee (₹${platformFeeDeduction}) and ${pgFeeRate}% Razorpay service charge (₹${gatewayChargeDeduction}) were retained. ₹${refundAmount} has been initiated for refund to your payment method (3-5 business days).`,
          cancelledAt: new Date().toISOString()
        }
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 6b. Customer stops booking after inspection (forfeits advance fee, releases technician immediately)
  fastify.post('/bookings/:id/stop-after-inspection', async (req, reply) => {
    try {
      const { id } = req.params;
      const bRes = await query('SELECT * FROM bookings WHERE id = $1', [id]);
      const booking = bRes.rows[0];

      if (!booking) {
        return reply.status(404).send({ success: false, error: 'Booking not found' });
      }

      if (booking.status === 'completed') {
        return reply.status(400).send({ success: false, error: 'Completed bookings cannot be stopped' });
      }

      if (booking.status === 'inspection_only') {
        return {
          success: true,
          message: 'Inspection was already completed and closed.',
          booking,
          forfeitedAmount: parseFloat(booking.visit_fee || booking.advance_paid || booking.final_amount || 99.00)
        };
      }

      if (booking.status === 'cancelled') {
        return {
          success: true,
          message: 'Booking was already closed.',
          booking,
          forfeitedAmount: parseFloat(booking.visit_fee || booking.advance_paid || booking.final_amount || 99.00)
        };
      }

      const allowedStatuses = ['arrived', 'inspecting', 'in_progress', 'quote_presented', 'quote_approved'];
      if (!allowedStatuses.includes(booking.status)) {
        return reply.status(400).send({
          success: false,
          error: 'Inspection-only stop is only available after the technician has arrived for inspection.'
        });
      }

      const forfeitedAmount = parseFloat(booking.visit_fee || booking.advance_paid || booking.final_amount || 99.00);

      const updateRes = await query(
        `UPDATE bookings
         SET status = 'inspection_only',
             cancellation_reason = NULL,
             cancellation_details = 'Doorstep diagnostic inspection completed. Advance visit fee retained as inspection visit charge.',
             cancelled_by = NULL,
             completed_at = NOW(),
             refund_amount = 0.00,
             refund_status = 'FORFEITED_INSPECTION_FEE'
         WHERE id = $1
         RETURNING *`,
        [booking.id]
      );
      const updatedBooking = updateRes.rows[0];

      if (booking.technician_id) {
        try {
          await query('UPDATE technicians SET is_busy = false WHERE id = $1', [booking.technician_id]);
        } catch (_) {
          // is_busy column may not exist in all schemas; active-job query filters cancelled & inspection_only bookings
        }
      }

      try {
        await query(
          `INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
           VALUES ($1, 'INSPECTION_ONLY_COMPLETED', $2, 'customer', $3)`,
          [
            booking.id,
            booking.customer_phone || 'customer',
            JSON.stringify({
              previousStatus: booking.status,
              forfeitedAmount,
              technicianId: booking.technician_id || null,
              completedAt: new Date().toISOString()
            })
          ]
        );
      } catch (auditErr) {
        fastify.log.warn('Audit log failed for stop-after-inspection ' + booking.id + ': ' + auditErr.message);
      }

      try {
        await pushService.sendPushToBookingParty({
          bookingId: booking.id,
          targetRole: 'technician',
          title: 'Inspection Completed',
          body: `Doorstep inspection completed on #${booking.id}. You are now free for the next job.`,
          data: { type: 'inspection_only_completed', bookingId: booking.id }
        });
      } catch (pushErr) {
        fastify.log.warn('Technician push failed for stop-after-inspection ' + booking.id + ': ' + pushErr.message);
      }

      return {
        success: true,
        message: 'Inspection completed and technician released for the next job.',
        booking: updatedBooking,
        forfeitedAmount
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 14. Lightweight Booking Summary Lookup (used by partner quote/approval checks)
  fastify.get('/bookings/:id', async (req, reply) => {
    try {
      const { id } = req.params;
      const bRes = await query('SELECT * FROM bookings WHERE id = $1 LIMIT 1', [id]);
      if (bRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Booking not found' });
      }
      return { success: true, booking: bRes.rows[0] };
    } catch (err) {
      fastify.log.error({ err, bookingId: req.params?.id }, 'Get booking error');
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 15. Real-time Booking Chat Messages (GET & POST)
  const formatChatMessageRow = (row) => {
    const sender = row.sender_role || 'customer';
    const defaultName =
      sender === 'technician' ? 'Assigned Partner' : sender === 'ops_admin' ? 'Salem Ops' : 'Customer';
    const createdAt = row.created_at || new Date().toISOString();
    const dt = new Date(createdAt);
    return {
      id: row.id,
      bookingId: row.booking_id,
      sender,
      senderName: row.sender_name || defaultName,
      text: row.message_text,
      attachmentUrl: row.attachment_url || null,
      isRead: Boolean(row.is_read),
      time: Number.isNaN(dt.getTime())
        ? 'Just now'
        : dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      timestamp: Number.isNaN(dt.getTime()) ? Date.now() : dt.getTime(),
      createdAt
    };
  };

  fastify.get('/bookings/:id/messages', async (req, reply) => {
    try {
      const { id } = req.params;
      const bRes = await query('SELECT id FROM bookings WHERE id = $1 LIMIT 1', [id]);
      if (bRes.rows.length === 0) {
        return reply.status(404).send({
          success: false,
          notFound: true,
          error: 'Booking not found',
          messages: []
        });
      }

      const msgRes = await query(
        `
          SELECT id, booking_id, sender_role, sender_name, message_text, attachment_url, is_read, created_at
          FROM chat_messages
          WHERE booking_id = $1
          ORDER BY created_at ASC
        `,
        [id]
      );

      return {
        success: true,
        messages: msgRes.rows.map(formatChatMessageRow)
      };
    } catch (err) {
      fastify.log.error({ err, bookingId: req.params?.id }, 'Get booking messages error');
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  fastify.post('/bookings/:id/messages', async (req, reply) => {
    try {
      const { id } = req.params;
      const { sender, senderRole, senderName, text, message_text, attachmentUrl } = req.body || {};
      const resolvedText = String(text || message_text || '').trim();
      if (!resolvedText) {
        return reply.status(400).send({ success: false, error: 'Message text is required' });
      }

      const bRes = await query('SELECT id FROM bookings WHERE id = $1 LIMIT 1', [id]);
      if (bRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Booking not found' });
      }

      const rawRole = String(sender || senderRole || 'customer').toLowerCase().trim();
      const normalizedRole = ['customer', 'technician', 'ops_admin'].includes(rawRole)
        ? rawRole
        : rawRole === 'partner'
          ? 'technician'
          : 'customer';
      const defaultName =
        normalizedRole === 'technician'
          ? 'Assigned Partner'
          : normalizedRole === 'ops_admin'
            ? 'Salem Ops'
            : 'Customer';
      const resolvedSenderName = String(senderName || defaultName).trim().slice(0, 80);

      const insRes = await query(
        `
          INSERT INTO chat_messages (booking_id, sender_role, sender_name, message_text, attachment_url)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id, booking_id, sender_role, sender_name, message_text, attachment_url, is_read, created_at
        `,
        [id, normalizedRole, resolvedSenderName, resolvedText, attachmentUrl || null]
      );

      return {
        success: true,
        message: formatChatMessageRow(insRes.rows[0])
      };
    } catch (err) {
      fastify.log.error({ err, bookingId: req.params?.id }, 'Post booking message error');
      return reply.status(500).send({ success: false, error: err.message });
    }
  });
}

module.exports = bookingsRoutes;

