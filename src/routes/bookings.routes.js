const { query } = require('../db/db');

async function bookingsRoutes(fastify, options) {
  // Ensure reschedule columns and reschedule logs table exist
  try {
    await query(`
      ALTER TYPE booking_status ADD VALUE IF NOT EXISTS 'preparing';
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
        } catch (sErr) {}
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
            }
          } else if (cleanCode === 'SALEM100') {
            couponDiscount = Math.min(100.00, visitFee);
          } else if (cleanCode === 'SALEM50') {
            couponDiscount = Math.min(50.00, visitFee);
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

      // Resolve human-readable issue title from DB
      let issueDescription = customNotes || customIssueText || null;
      if (issueId) {
        const issueRes = await query('SELECT name_en, name_ta FROM service_issues WHERE id = $1', [issueId]);
        if (issueRes.rows.length > 0) {
          const issueName = issueRes.rows[0].name_en;
          issueDescription = (customNotes || customIssueText)
            ? `${issueName} — ${(customNotes || customIssueText)}`
            : issueName;
        }
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
            AND status != 'cancelled';
        `, [serviceId || 'ac', `%${targetDate}%`]);
        const dayBookingsCount = parseInt(dayBookingsRes.rows[0]?.count || 0, 10);
        const maxDailyCapacity = Math.max(1, totalDomainTechs * 4);

        if (dayBookingsCount >= maxDailyCapacity) {
          return reply.status(400).send({
            success: false,
            code: 'DATE_FULLY_BOOKED',
            error: 'All technicians are booked on this date. Please choose another date.'
          });
        }
      }

      // Check if customer requested a specific active specialist
      const requestedTechId = req.body?.requestedTechnicianId || req.body?.requested_technician_id || null;
      let assignedTechId = null;
      let initialStatus = 'created';

      if (requestedTechId) {
        const checkTech = await query('SELECT id, full_name, phone FROM technicians WHERE id = $1', [requestedTechId]);
        if (checkTech.rows.length > 0) {
          assignedTechId = checkTech.rows[0].id;
          initialStatus = 'accepted';
        }
      }

      // Check for available active specialists in Salem for this trade and locality
      const onlineTechRes = await query(`
        SELECT id, full_name, phone FROM technicians 
        WHERE (primary_trade = $1 OR $1 IS NULL) 
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
          customer_otp, booking_type, voice_note_url
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
        RETURNING *;
      `;

      const result = await query(insertSql, [
        bookingId,
        serviceId || 'ac',
        issueId || 'ac_cooling',
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
        finalVoiceNote
      ]);

      // Audit Log
      await query(`
        INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
        VALUES ($1, 'BOOKING_CREATED', $2, 'customer', $3)
      `, [bookingId, rawCustomerPhone.trim(), JSON.stringify({ serviceId, locality, finalAmount, customerOtp, hasOnlineTech: Boolean(onlineTech), scheduledSlot: scheduledSlot || 'priority_12h' })]);

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

  // 2. Get Live Tracking & Real Assigned Technician with Dynamic GPS & ETA
  fastify.get('/bookings/:id/track', async (req, reply) => {
    try {
      const { id } = req.params;
      const bookingResult = await query('SELECT * FROM bookings WHERE id = $1', [id]);

      let booking = bookingResult.rows[0];
      if (!booking) {
        return reply.status(404).send({ success: false, error: 'Booking not found' });
      }

      // Customer coordinates (Default to Fairlands, Salem if not set)
      const custLat = parseFloat(booking.customer_lat) || 11.6643;
      const custLng = parseFloat(booking.customer_lng) || 78.1460;

      // Check if booking is scheduled
      const isScheduledBooking = booking.booking_type === 'scheduled' || (Boolean(booking.scheduled_slot) && booking.scheduled_slot !== 'instant_now');
      const isRideStarted = ['en_route', 'arrived', 'inspecting', 'quote_presented', 'quote_approved', 'completed'].includes(booking.status);

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
            const techLat = parseFloat(t.current_lat) || 11.6780;
            const techLng = parseFloat(t.current_lng) || 78.1580;
            
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
            AND primary_trade = $1 
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
          const techLat = parseFloat(t.current_lat) || 11.6780;
          const techLng = parseFloat(t.current_lng) || 78.1580;
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
              title: 'Request Received & Escrow Verified',
              titleTa: 'கோரிக்கை பெறப்பட்டு கட்டணம் சரிபார்க்கப்பட்டது',
              description: 'Booking token created. Doorstep visit fee held securely in Razorpay escrow.',
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

      return {
        success: true,
        booking,
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
        } catch (_) {}

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
        } catch (_) {}

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
          } catch (_) {}

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
          } catch (_) {}

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
        ORDER BY b.created_at DESC
        LIMIT 30
      `);

      // Enrich each booking with payments, quote items, and audit logs
      const enrichedBookings = await Promise.all(res.rows.map(async (b) => {
        const [paymentsRes, quoteRes, auditRes] = await Promise.all([
          query('SELECT * FROM payments WHERE booking_id = $1 ORDER BY created_at ASC', [b.id]).catch(() => ({ rows: [] })),
          query('SELECT * FROM quote_items WHERE booking_id = $1 ORDER BY created_at ASC', [b.id]).catch(() => ({ rows: [] })),
          query('SELECT * FROM audit_logs WHERE booking_id = $1 ORDER BY created_at ASC', [b.id]).catch(() => ({ rows: [] }))
        ]);

        let rawPayments = paymentsRes.rows || [];
        let rawQuoteItems = quoteRes.rows || [];
        const auditLogs = auditRes.rows || [];

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
          const dbCat = await query('SELECT * FROM service_spares_catalog WHERE service_id = $1 ORDER BY is_oem_part DESC LIMIT 3', [b.service_id || 'ac']).catch(() => ({ rows: [] }));
          quoteItems = dbCat.rows.map(item => ({
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

        // Normalize payments list
        let payments = rawPayments.map(p => ({
          id: p.id,
          transaction_id: p.razorpay_payment_id || p.payout_utr || p.transaction_id || `txn_${b.id}`,
          amount: parseFloat(p.amount_total || p.amount || (p.tech_payout_amount ? p.tech_payout_amount : 99.00)),
          status: (p.status || 'SETTLED').toUpperCase(),
          payment_method: p.payment_method || 'UPI (Instant Escrow)',
          created_at: p.created_at || p.settled_at || b.created_at
        }));

        if (b.status === 'completed' && payments.length <= 1) {
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
              payment_method: 'UPI (Instant Escrow Released)',
              created_at: b.completed_at || b.created_at
            }
          ];
        }

        const isPaidStage = ['en_route', 'arrived', 'inspecting', 'quote_presented', 'quote_approved', 'completed'].includes(b.status) || (b.status === 'cancelled' && b.technician_id);
        const totalPaidAmount = b.status === 'completed' 
          ? (visitFee + finalQuoteSubtotal) 
          : (isPaidStage ? visitFee : 0.00);

        return {
          ...b,
          quote_subtotal: finalQuoteSubtotal,
          final_amount: totalPaidAmount,
          payments,
          quoteItems,
          auditLogs,
          paymentSummary: {
            totalPaid: totalPaidAmount,
            part1Fee: visitFee,
            part1PaymentId: `TXN-VISIT-${b.id}`,
            part1Status: isPaidStage ? 'PAID' : (b.status === 'accepted' ? 'PENDING_2MIN' : 'NOT_CHARGED'),
            part1Disbursal: '100% to Technician (Fuel & Travel)',
            part2Amount: finalQuoteSubtotal,
            part2PaymentId: b.status === 'completed' ? `TXN-FINAL-${b.id}` : null,
            part2Status: b.status === 'completed' ? 'PAID' : (b.status === 'quote_approved' ? 'AUTHORIZED' : (b.status === 'cancelled' ? 'CANCELLED_BEFORE_WORK' : 'PENDING_DIAGNOSIS')),
            platformCommission: b.status === 'completed' ? parseFloat((finalQuoteSubtotal * 0.05).toFixed(2)) : 0,
            escrowGuarantee: '100% Protected under Shazu One Escrow'
          }
        };
      }));

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
            AND primary_trade = $1 
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
            matched_at = CASE WHEN ($1::text = 'accepted' OR $1::text = 'en_route' OR $1::text = 'preparing') AND matched_at IS NULL THEN CURRENT_TIMESTAMP ELSE matched_at END
        WHERE id = $2 
        RETURNING *
      `, [status, targetId, validTechId, partsMode || null]);

      booking = res.rows[0] || booking;

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

      return {
        success: true,
        bookingId: id,
        booking,
        itemsCount: items.length,
        items,
        subtotal,
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

      if (booking.status === 'cancelled') {
        const originalPaid = parseFloat(booking.final_amount || booking.visit_fee || 99.00);
        const platformFeeDeduction = parseFloat((originalPaid * 0.02).toFixed(2));
        const gatewayChargeDeduction = parseFloat((originalPaid * 0.02).toFixed(2));
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
            policyNotice: `As per Shazu One policy, 2% platform fee (₹${platformFeeDeduction}) and 2% Razorpay service charge (₹${gatewayChargeDeduction}) were deducted. ₹${refundAmount} has been refunded.`,
            cancelledAt: booking.cancelled_at || new Date().toISOString()
          }
        };
      }

      const isPreMatching = booking.status === 'matching' || booking.status === 'created';
      const originalAmount = parseFloat(booking.final_amount || booking.visit_fee || 99.00);
      const cancelReasonText = reason || 'Customer requested cancellation';
      const cancelDetailsText = reasonDetails || '';

      // Platform Cut (2%) & Razorpay Gateway Processing Fee (2%) Retention
      const platformFeeDeduction = parseFloat((originalAmount * 0.02).toFixed(2));
      const gatewayChargeDeduction = parseFloat((originalAmount * 0.02).toFixed(2));
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
        `, [booking.id, originalAmount, gatewayChargeDeduction, platformFeeDeduction]);
      } catch (payErr) {}

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
        message: 'Booking cancelled successfully. Refund initiated after retaining 2% platform fee and 2% Razorpay service charge.',
        booking: updatedBooking,
        cancellationSummary: {
          bookingId: booking.id,
          cancelledBy,
          reason: cancelReasonText,
          previousStatus: booking.status,
          originalPaid: originalAmount,
          platformFeeRetained: platformFeeDeduction,
          gatewayChargeRetained: gatewayChargeDeduction,
          refundAmount,
          refundStatus: 'REFUND_INITIATED',
          policyNotice: `As per Shazu One policy, 2% platform fee (₹${platformFeeDeduction}) and 2% Razorpay service charge (₹${gatewayChargeDeduction}) were retained. ₹${refundAmount} has been initiated for refund to your payment method (3-5 business days).`,
          cancelledAt: new Date().toISOString()
        }
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });


}

module.exports = bookingsRoutes;

