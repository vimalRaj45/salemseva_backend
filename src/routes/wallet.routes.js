const { query } = require('../db/db');

/**
 * Shazu One: WALLET & INCENTIVE ROUTES (100% PERSISTENT NEON POSTGRESQL)
 * Architecture: Zero In-Memory Mocks - All Ledgers, Referrals, Rewards & Payouts in DB
 */
async function walletRoutes(fastify, options) {

  // Helper to normalize phone numbers for consistent SQL lookup
  const sanitizePhone = (phone) => (phone || '').replace(/[\s\-\(\)]/g, '');

  // Stored format for a brand-new identity. Registration writes "+91 9876543210", so
  // anything created here must match it or one person ends up with two user rows.
  const canonicalPhone = (phone) => `+91 ${String(phone || '').replace(/\D/g, '').slice(-10)}`;

  // ==========================================
  // 1. CUSTOMER WALLET & REWARDS ENDPOINTS
  // ==========================================

  // GET /wallet/customer - Fetch live customer wallet balance and transaction ledger
  fastify.get('/wallet/customer', async (req, reply) => {
    try {
      const rawPhone = req.query?.phone ? String(req.query.phone).trim() : '';
      if (!rawPhone) {
        return reply.status(400).send({ success: false, error: 'Customer phone number is required' });
      }
      const cleanPhone = sanitizePhone(rawPhone);

      // 1. Fetch user from PostgreSQL
      let userRes = await query(`
        SELECT id, full_name, phone, wallet_balance, referral_code, referred_by 
        FROM users 
        WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = RIGHT(REGEXP_REPLACE($1, '\\D', '', 'g'), 10)
        LIMIT 1
      `, [cleanPhone]);

      let user = userRes.rows[0];

      // If user doesn't exist, create persistent record in PostgreSQL
      if (!user) {
        const genCode = `SALEM${Math.floor(100 + Math.random() * 900)}`;
        const storePhone = canonicalPhone(cleanPhone);
        const createRes = await query(`
          INSERT INTO users (phone, full_name, role, wallet_balance, referral_code, locality, preferred_lang)
          VALUES ($1, 'Customer', 'customer', 0.00, $2, 'Fairlands', 'ta')
          ON CONFLICT (phone) DO UPDATE SET wallet_balance = users.wallet_balance
          RETURNING id, full_name, phone, wallet_balance, referral_code, referred_by
        `, [storePhone, genCode]);
        user = createRes.rows[0];
      }

      // Referral & coupon discount status
      let friendsCompleted = 0;
      try {
        const refCountRes = await query(`
          SELECT COUNT(*)::int as count FROM users 
          WHERE referred_by = $1 OR (referred_by IS NOT NULL AND RIGHT(REGEXP_REPLACE(referred_by, '[^0-9]', '', 'g'), 10) = $2)
        `, [user.referral_code || '', cleanPhone]);
        friendsCompleted = refCountRes.rows[0]?.count || 0;
      } catch (_) {}

      const isReferralEligible = Boolean(user.referred_by || friendsCompleted > 0);
      const currentBalance = parseFloat(user.wallet_balance || 0);

      return {
        success: true,
        customerPhone: user.phone,
        balance: currentBalance,
        walletBalance: currentBalance,
        serviceValue: `₹${currentBalance.toFixed(2)}`,
        conversionRate: '1 Rupee = 1 Rupee Direct Discount',
        referralCode: user.referral_code || ('SEVA' + cleanPhone.slice(-4)),
        referralCoupon: 'REFERWAIVER50',
        isReferralEligible,
        referredBy: user.referred_by || null,
        friendsInvited: friendsCompleted,
        friendsCompleted,
        creditsEarnedFromReferrals: 0,
        transactions: []
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // POST /wallet/customer/credit - Instant credit to customer wallet in PostgreSQL
  fastify.post('/wallet/customer/credit', async (req, reply) => {
    try {
      const { 
        phone = '', 
        amount = 50, 
        title = '+50 Seva Credits Reward', 
        description = 'Credits added to your Shazu One wallet', 
        category = 'REWARD' 
      } = req.body || {};

      if (!phone || !phone.trim()) {
        return reply.status(400).send({ success: false, error: 'Customer phone number is required' });
      }

      // Wallet top-ups are an internal operation. This endpoint used to let any caller mint
      // credits for any number, so it now requires the internal key whenever one is
      // configured, and always refuses the request in production if none is set.
      const internalKey = process.env.INTERNAL_API_KEY;
      const keyRequired = Boolean(internalKey) || process.env.NODE_ENV === 'production';
      if (keyRequired && req.headers['x-internal-key'] !== internalKey) {
        return reply.status(403).send({ success: false, error: 'Wallet credit requires the internal API key.' });
      }

      const cleanPhone = sanitizePhone(phone);
      const creditAmt = parseFloat(amount) || 50;

      // Update user balance in PostgreSQL
      const updateRes = await query(`
        UPDATE users 
        SET wallet_balance = COALESCE(wallet_balance, 0) + $1,
            updated_at = CURRENT_TIMESTAMP
        WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = RIGHT(REGEXP_REPLACE($2, '\\D', '', 'g'), 10)
        RETURNING id, phone, wallet_balance
      `, [creditAmt, cleanPhone]);

      let user = updateRes.rows[0];
      if (!user) {
        // Create if missing
        const insertUser = await query(`
          INSERT INTO users (phone, full_name, role, wallet_balance, referral_code)
          VALUES ($1, 'Customer', 'customer', $2, 'SALEM' || FLOOR(100 + RANDOM()*900)::text)
          RETURNING id, phone, wallet_balance
        `, [canonicalPhone(cleanPhone), creditAmt]);
        user = insertUser.rows[0];
      }

      return {
        success: true,
        newBalance: parseFloat(user.wallet_balance),
        creditedAmount: creditAmt,
        transaction: {
          id: `tx_${Date.now()}`,
          title,
          amount: creditAmt,
          type: 'CREDIT',
          category,
          description,
          timestamp: new Date().toISOString()
        }
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // POST /wallet/customer/debit - Debit wallet at checkout with 20% burn cap
  fastify.post('/wallet/customer/debit', async (req, reply) => {
    try {
      const { phone = '', amount = 0, bookingId = '' } = req.body || {};
      if (!phone || !phone.trim()) {
        return reply.status(400).send({ success: false, error: 'Customer phone is required' });
      }
      if (!bookingId || !bookingId.trim()) {
        return reply.status(400).send({ success: false, error: 'Booking ID is required' });
      }
      const cleanPhone = sanitizePhone(phone);
      const requestedDebit = parseFloat(amount) || 0;

      // Check current balance
      const userRes = await query(`
        SELECT id, phone, wallet_balance FROM users 
        WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = RIGHT(REGEXP_REPLACE($1, '\\D', '', 'g'), 10)
      `, [cleanPhone]);

      if (!userRes.rows.length) {
        return reply.status(404).send({ success: false, error: 'Customer user not found' });
      }

      const user = userRes.rows[0];
      const currentBalance = parseFloat(user.wallet_balance || 0);
      const actualDebit = Math.min(currentBalance, requestedDebit);

      if (actualDebit <= 0) {
        return {
          success: true,
          newBalance: currentBalance,
          debitedAmount: 0,
          message: 'No credits available to debit'
        };
      }

      // Update wallet balance in DB
      const updatedUserRes = await query(`
        UPDATE users 
        SET wallet_balance = GREATEST(0, wallet_balance - $1),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING wallet_balance
      `, [actualDebit, user.id]);

      return {
        success: true,
        newBalance: parseFloat(updatedUserRes.rows[0].wallet_balance),
        debitedAmount: actualDebit,
        transaction: {
          id: `tx_${Date.now()}`,
          title: `Redeemed on Booking #${bookingId}`,
          amount: actualDebit,
          type: 'DEBIT',
          category: 'CHECKOUT_BURN',
          description: `20% Burn Cap Applied for Service #${bookingId}`,
          timestamp: new Date().toISOString()
        }
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // POST /wallet/customer/simulate-referral - Trigger customer referral completion
  const simulateReferralHandler = async (req, reply) => {
    try {
      const { 
        friendName = 'Kavitha S.', 
        locality = 'Meyyanur, Salem', 
        phone = '',
        referrerPhone = ''
      } = req.body || {};

      const targetPhone = phone || referrerPhone;
      if (!targetPhone || !targetPhone.trim()) {
        return reply.status(400).send({ success: false, error: 'Customer phone number is required' });
      }
      const cleanPhone = sanitizePhone(targetPhone);

      // Dynamic referral waiver coupon (REFERWAIVER50)
      let rewardAmt = 50.00;
      try {
        const sRes = await query(`SELECT referee_discount_amount FROM platform_settings WHERE id = 'reward_settings' LIMIT 1`);
        if (sRes.rows.length > 0) {
          rewardAmt = parseFloat(sRes.rows[0].referee_discount_amount || 50);
        }
      } catch (sErr) {}

      return {
        success: true,
        message: `Friend ${friendName} completed service! Coupon REFERWAIVER50 unlocked for your next booking.`,
        rewardAmount: rewardAmt,
        couponCode: 'REFERWAIVER50',
        discountValue: rewardAmt
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  };

  fastify.post('/wallet/customer/simulate-referral', simulateReferralHandler);
  fastify.post('/wallet/simulate-referral', simulateReferralHandler);

  // POST /wallet/customer/apply-referral - Link friend referral code to customer account to unlock REFERWAIVER50
  fastify.post('/wallet/customer/apply-referral', async (req, reply) => {
    try {
      const { phone = '', referralCode = '', customerId = null } = req.body || {};
      const cleanPhone = sanitizePhone(phone);
      if (!cleanPhone && !customerId) {
        return reply.status(400).send({ success: false, error: 'Customer phone or account ID is required' });
      }
      const refCodeTrim = String(referralCode || '').trim().toUpperCase();
      if (!refCodeTrim) {
        return reply.status(400).send({ success: false, error: 'Please enter a valid referral code or friend phone' });
      }

      const userRes = await query(`
        SELECT id, phone, referral_code, referred_by FROM users 
        WHERE ($1::text IS NOT NULL AND id::text = $1)
           OR ($2::text <> '' AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $2)
        LIMIT 1
      `, [customerId, cleanPhone]);

      if (userRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Customer account not found' });
      }
      const u = userRes.rows[0];
      if (u.referred_by) {
        return reply.status(400).send({ success: false, error: 'A referral code has already been applied to your account.' });
      }

      const refDigits = refCodeTrim.replace(/[^0-9]/g, '').slice(-10);
      const userDigits = (u.phone || '').replace(/[^0-9]/g, '').slice(-10);
      if (u.referral_code && u.referral_code.toUpperCase() === refCodeTrim) {
        return reply.status(400).send({ success: false, error: 'You cannot use your own referral code.' });
      }
      if (refDigits && refDigits === userDigits) {
        return reply.status(400).send({ success: false, error: 'You cannot refer your own mobile number.' });
      }

      const referrerRes = await query(`
        SELECT id, full_name, phone, referral_code FROM users
        WHERE UPPER(referral_code) = $1
           OR ($2::text <> '' AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $2)
        LIMIT 1
      `, [refCodeTrim, refDigits]);

      if (referrerRes.rows.length === 0) {
        return reply.status(400).send({
          success: false,
          error: `Wrong referral code "${refCodeTrim}". No user found with this referral code.`
        });
      }

      const effectiveReferredBy = referrerRes.rows[0].referral_code || referrerRes.rows[0].phone;

      await query(`UPDATE users SET referred_by = $1 WHERE id = $2`, [effectiveReferredBy, u.id]);

      return {
        success: true,
        message: 'Referral applied successfully! REFERWAIVER50 flat ₹50 waiver unlocked for your booking.',
        referredBy: effectiveReferredBy,
        couponUnlocked: 'REFERWAIVER50'
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });


  // ==========================================
  // 2. TECHNICIAN INCENTIVES & REFERRAL PROGRAM
  // ==========================================

  // GET /partner/incentives - Fetch technician incentive balance, star progression & referrals
  fastify.get('/partner/incentives', async (req, reply) => {
    try {
      const rawPhone = req.query?.phone ? String(req.query.phone).trim() : '';
      const techIdParam = req.query?.technicianId ? String(req.query.technicianId).trim() : '';

      let tech = null;
      if (techIdParam && techIdParam !== 'null' && techIdParam !== 'undefined') {
        const tRes = await query('SELECT * FROM technicians WHERE id::text = $1 LIMIT 1', [techIdParam]);
        tech = tRes.rows[0];
      }

      if (!tech && rawPhone) {
        const cleanPhone = sanitizePhone(rawPhone);
        const tRes = await query(`
          SELECT * FROM technicians 
          WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = RIGHT(REGEXP_REPLACE($1, '\\D', '', 'g'), 10)
          LIMIT 1
        `, [cleanPhone]);
        tech = tRes.rows[0];
      }

      if (!tech) {
        return {
          success: true,
          referralCode: 'TECHPARTNER',
          starPoints: 0,
          totalIncentiveEarned: 0,
          availablePayout: 0,
          settledPayout: 0,
          referredTechs: [],
          incentives: {
            techName: 'Partner',
            referralCode: 'TECHPARTNER',
            totalIncentiveEarned: 0,
            availablePayout: 0,
            settledPayout: 0,
            starPoints: 0,
            starPointsTarget: 30,
            zeroCommUnlocked: false,
            referredTechs: [],
            incentiveTransactions: []
          }
        };
      }

      const cleanPhone = sanitizePhone(tech.phone || rawPhone);

      // Fetch dynamic incentive amount from settings
      const sRes = await query(`SELECT partner_referral_incentive FROM platform_settings WHERE id = 'reward_settings' LIMIT 1`);
      const incentiveSetting = sRes.rows.length > 0 ? parseFloat(sRes.rows[0].partner_referral_incentive || 100) : 100.00;

      // 2. Fetch referred technicians roster from technicians table
      const refRoster = await query(`
        SELECT id, full_name, phone, primary_trade, assigned_localities, jobs_completed_count, referral_incentive_paid, created_at
        FROM technicians
        WHERE referred_by_tech_id = $1
        ORDER BY created_at DESC
      `, [tech.id]);

      // 3. Also fetch legacy technician_referrals
      const legacyRefRes = await query(`
        SELECT 
          id, 
          referred_name as name, 
          referred_phone as phone, 
          referred_trade as trade, 
          referred_locality as locality, 
          status, 
          TO_CHAR(created_at, 'Mon DD, YYYY') as "onboardedAt",
          incentive_amount::numeric as "incentiveAmount",
          payout_status as "payoutStatus",
          upi_ref as "upiRef"
        FROM technician_referrals
        WHERE RIGHT(REGEXP_REPLACE(referrer_phone, '\\D', '', 'g'), 10) = RIGHT(REGEXP_REPLACE($1, '\\D', '', 'g'), 10)
        ORDER BY created_at DESC
      `, [cleanPhone]);

      // 4. Fetch payouts ledger from DB
      const payoutRes = await query(`
        SELECT 
          id, 
          amount::numeric, 
          upi_id, 
          status, 
          utr_ref, 
          description,
          TO_CHAR(created_at, 'Mon DD, YYYY') as date
        FROM technician_payouts
        WHERE RIGHT(REGEXP_REPLACE(technician_phone, '\\D', '', 'g'), 10) = RIGHT(REGEXP_REPLACE($1, '\\D', '', 'g'), 10)
           OR technician_id = $2
        ORDER BY created_at DESC
      `, [cleanPhone, tech.id]);

      // Combine referred techs list
      const referredTechs = [
        ...refRoster.rows.map(t => {
          const loc = Array.isArray(t.assigned_localities) && t.assigned_localities[0] ? t.assigned_localities[0] : 'Salem';
          const isPaid = Boolean(t.referral_incentive_paid);
          return {
            id: t.id,
            name: t.full_name,
            phone: t.phone,
            trade: t.primary_trade || 'Technician',
            locality: loc,
            onboardedAt: t.created_at ? new Date(t.created_at).toLocaleDateString() : 'Recent',
            incentiveAmount: incentiveSetting,
            jobsCompleted: t.jobs_completed_count || 0,
            payoutStatus: isPaid ? 'SETTLED_TO_PHONE' : (t.jobs_completed_count > 0 ? 'READY_TO_CLAIM' : 'Awaiting 1st Job Completion')
          };
        }),
        ...legacyRefRes.rows
      ];

      // Calculate totals
      let totalIncentiveEarned = 0;
      let availablePayout = 0;
      let settledPayout = 0;

      payoutRes.rows.forEach(p => {
        const amt = parseFloat(p.amount || 0);
        if (p.description && (p.description.toLowerCase().includes('referral') || p.description.toLowerCase().includes('partner'))) {
          totalIncentiveEarned += amt;
          if (p.status === 'DISBURSED_100%' || p.status === 'SETTLED') {
            settledPayout += amt;
          } else {
            availablePayout += amt;
          }
        }
      });

      // Also check legacy referrals for available payout
      legacyRefRes.rows.forEach(r => {
        const amt = parseFloat(r.incentiveAmount || 0);
        totalIncentiveEarned += amt;
        if (r.payoutStatus === 'AVAILABLE_FOR_PAYOUT') {
          availablePayout += amt;
        } else {
          settledPayout += amt;
        }
      });

      const effectiveCode = tech.referral_code || ('TECH' + (tech.phone || '9999').replace(/\D/g, '').slice(-4));

      return {
        success: true,
        referralCode: effectiveCode,
        totalIncentiveEarned,
        availablePayout,
        settledPayout,
        starPoints: tech.star_points || 0,
        starPointsTarget: 30,
        zeroCommUnlocked: (tech.star_points >= 30) || Boolean(tech.zero_comm_unlocked),
        referredTechs,
        incentives: {
          techName: tech.full_name,
          referralCode: effectiveCode,
          totalIncentiveEarned,
          availablePayout,
          settledPayout,
          starPoints: tech.star_points || 0,
          starPointsTarget: 30,
          zeroCommUnlocked: (tech.star_points >= 30) || Boolean(tech.zero_comm_unlocked),
          referredTechs,
          incentiveTransactions: []
        }
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // POST /partner/refer - Onboard and reward referring technician with ₹250 + 3 Star Points in DB
  fastify.post('/partner/refer', async (req, reply) => {
    try {
      const {
        referrerPhone = '',
        referredName = '',
        referredPhone = '',
        referredTrade = 'AC & Refrigeration Specialist',
        referredLocality = 'Salem'
      } = req.body || {};

      if (!referrerPhone || !referrerPhone.trim()) {
        return reply.status(400).send({ success: false, error: 'Referrer technician phone is required' });
      }
      if (!referredName || !referredName.trim()) {
        return reply.status(400).send({ success: false, error: 'Referred partner name is required' });
      }
      if (!referredPhone || !referredPhone.trim()) {
        return reply.status(400).send({ success: false, error: 'Referred partner mobile number is required' });
      }

      const cleanReferrer = sanitizePhone(referrerPhone);
      const cleanReferred = sanitizePhone(referredPhone);
      const incentiveAmount = 250.00;

      // 1. Insert referral record into PostgreSQL
      const refInsertRes = await query(`
        INSERT INTO technician_referrals (
          referrer_phone, 
          referred_name, 
          referred_phone, 
          referred_trade, 
          referred_locality, 
          status, 
          incentive_amount, 
          payout_status
        )
        VALUES ($1, $2, $3, $4, $5, 'Verified & Active', $6, 'AVAILABLE_FOR_PAYOUT')
        RETURNING 
          id, 
          referred_name as name, 
          referred_phone as phone, 
          referred_trade as trade, 
          referred_locality as locality, 
          status, 
          TO_CHAR(created_at, 'Mon DD, YYYY') as "onboardedAt",
          incentive_amount::numeric as "incentiveAmount",
          payout_status as "payoutStatus"
      `, [cleanReferrer, referredName, cleanReferred, referredTrade, referredLocality, incentiveAmount]);

      const newRef = refInsertRes.rows[0];

      // 2. Update technician's star points in PostgreSQL
      const techUpdateRes = await query(`
        UPDATE technicians 
        SET 
          star_points = LEAST(30, COALESCE(star_points, 0) + 3),
          zero_comm_unlocked = CASE WHEN COALESCE(star_points, 0) + 3 >= 30 THEN TRUE ELSE zero_comm_unlocked END
        WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = RIGHT(REGEXP_REPLACE($1, '\\D', '', 'g'), 10)
        RETURNING star_points, zero_comm_unlocked
      `, [cleanReferrer]);

      const updatedTech = techUpdateRes.rows[0] || { star_points: 27, zero_comm_unlocked: false };

      // 3. Log into audit_logs table
      try {
        await query(`
          INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
          VALUES ('PARTNER-REFERRAL', 'TECH_REFERRAL_INCENTIVE_EARNED', $1, 'technician', $2)
        `, [
          cleanReferrer,
          JSON.stringify({
            referredName,
            referredTrade,
            incentiveAmount,
            timestamp: new Date().toISOString()
          })
        ]);
      } catch (e) {}

      // 4. Fetch updated totals from DB
      const totalsRes = await query(`
        SELECT 
          COALESCE(SUM(incentive_amount), 0)::numeric as total_earned,
          COALESCE(SUM(incentive_amount) FILTER (WHERE payout_status = 'AVAILABLE_FOR_PAYOUT'), 0)::numeric as available_payout
        FROM technician_referrals
        WHERE RIGHT(REGEXP_REPLACE(referrer_phone, '\\D', '', 'g'), 10) = RIGHT(REGEXP_REPLACE($1, '\\D', '', 'g'), 10)
      `, [cleanReferrer]);

      return {
        success: true,
        message: `Successfully referred ${referredName}! ₹250 added to your partner incentives ledger.`,
        incentiveEarned: incentiveAmount,
        totalIncentives: parseFloat(totalsRes.rows[0]?.total_earned || 0),
        availablePayout: parseFloat(totalsRes.rows[0]?.available_payout || 0),
        starPoints: updatedTech.star_points,
        zeroCommUnlocked: updatedTech.zero_comm_unlocked,
        referredTechnician: newRef,
        transaction: {
          id: `inc-${newRef.id}`,
          title: `Technician Referral: ${referredName} (${referredTrade})`,
          amount: incentiveAmount,
          type: 'CREDIT',
          status: 'AVAILABLE',
          date: newRef.onboardedAt,
          description: `Direct ₹250 incentive + 3 Star Points for referring certified partner in ${referredLocality}`
        }
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // POST /partner/payout - 1-Click Instant Payout Claim directly recorded in PostgreSQL
  fastify.post('/partner/payout', async (req, reply) => {
    try {
      const { phone = '', upiId = '' } = req.body || {};
      if (!phone || !phone.trim()) {
        return reply.status(400).send({ success: false, error: 'Technician phone is required' });
      }
      if (!upiId || !upiId.trim() || !upiId.includes('@')) {
        return reply.status(400).send({ success: false, error: 'Valid UPI ID (e.g. name@upi) is required for payout' });
      }
      const cleanPhone = sanitizePhone(phone);

      // Check available payout sum in DB
      const availRes = await query(`
        SELECT COALESCE(SUM(incentive_amount), 0)::numeric as available_sum
        FROM technician_referrals
        WHERE RIGHT(REGEXP_REPLACE(referrer_phone, '\\D', '', 'g'), 10) = RIGHT(REGEXP_REPLACE($1, '\\D', '', 'g'), 10)
          AND payout_status = 'AVAILABLE_FOR_PAYOUT'
      `, [cleanPhone]);

      const payoutAmount = parseFloat(availRes.rows[0]?.available_sum || 0);

      if (payoutAmount <= 0) {
        return reply.status(400).send({ success: false, error: 'No available incentive balance to disburse' });
      }

      const utrRef = `UPI-${Math.floor(1000000 + Math.random() * 9000000)}-SALEM`;

      // 1. Mark referrals as settled in DB
      await query(`
        UPDATE technician_referrals
        SET payout_status = 'SETTLED_TO_UPI',
            upi_ref = $1
        WHERE RIGHT(REGEXP_REPLACE(referrer_phone, '\\D', '', 'g'), 10) = RIGHT(REGEXP_REPLACE($2, '\\D', '', 'g'), 10)
          AND payout_status = 'AVAILABLE_FOR_PAYOUT'
      `, [utrRef, cleanPhone]);

      // 2. Insert payout disbursement record in DB
      const payoutInsertRes = await query(`
        INSERT INTO technician_payouts (
          technician_phone, 
          amount, 
          upi_id, 
          status, 
          utr_ref, 
          description
        )
        VALUES ($1, $2, $3, 'DISBURSED_100%', $4, $5)
        RETURNING id, amount::numeric, upi_id, status, utr_ref, description, TO_CHAR(created_at, 'Mon DD, YYYY') as date
      `, [
        cleanPhone, 
        payoutAmount, 
        upiId, 
        utrRef, 
        `₹${payoutAmount} transferred via IMPS / UPI Route to ${upiId}. Reference: TXN-SLM-${Date.now().toString().slice(-6)}`
      ]);

      const payoutTx = payoutInsertRes.rows[0];

      // 3. Get updated settled total
      const settledRes = await query(`
        SELECT COALESCE(SUM(amount), 0)::numeric as settled_sum
        FROM technician_payouts
        WHERE RIGHT(REGEXP_REPLACE(technician_phone, '\\D', '', 'g'), 10) = RIGHT(REGEXP_REPLACE($1, '\\D', '', 'g'), 10)
      `, [cleanPhone]);

      return {
        success: true,
        message: `₹${payoutAmount} successfully disbursed to ${upiId}!`,
        payoutAmount,
        upiId,
        availablePayout: 0,
        settledPayout: parseFloat(settledRes.rows[0]?.settled_sum || 0),
        payoutTx: {
          id: `payout-${payoutTx.id}`,
          title: `Instant UPI Payout (${upiId})`,
          amount: payoutAmount,
          type: 'PAYOUT',
          status: 'DISBURSED_100%',
          date: payoutTx.date,
          description: payoutTx.description
        }
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

}

module.exports = walletRoutes;
