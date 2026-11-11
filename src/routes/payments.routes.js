const crypto = require('crypto');
const { query } = require('../db/db');
// The same length-safe comparison the password service uses, so there is one implementation.
const { constantTimeEqual: secureEqual } = require('../services/password.service');
const {
  getEnvUpiId,
  getEnvMerchantName,
  getCustomerPlatformFeePercent,
  getPaymentGatewayFeePercent,
  getPartnerCommissionPercent,
  getLiveFeeSettings,
  calculateDualCommissionInvoice,
  calculateCommissionSplit
} = require('../services/commission.service');
const { processTechnicianReferralOnCompletion } = require('../services/referral.service');
const {
  ensureMerchantAlertsSchema,
  processIncomingMerchantAlert,
  claimMatchingAlertForPayment,
  reconcileBankCsvRows,
  normalizeBookingRef
} = require('../services/merchantAlert.service');

async function paymentsRoutes(fastify, options) {
  try {
    await ensureMerchantAlertsSchema(query);
  } catch (schemaErr) {
    fastify.log.warn('Merchant alerts schema init note: ' + schemaErr.message);
  }
  // No hardcoded key material: the pair that used to sit here as a fallback is in source
  // control and must be treated as compromised. Missing keys now fail loudly.
  const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
  const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
  const PAYMENTS_CONFIGURED = Boolean(KEY_ID && KEY_SECRET);

  // Unsigned payments are only tolerated when an operator explicitly opts in for local
  // testing. A missing signature used to be treated as a valid payment.
  const ALLOW_UNSIGNED = process.env.PAYMENTS_ALLOW_UNSIGNED === '1';

  // Helper: Process Referral Rewards on First Job Completion (Technicians and Customers)
  async function processJobCompletionReferrals(bookingId, techId, log = console) {
    // 1. Process Technician Referral Incentive (only after referred tech's 1st completed job)
    if (techId) {
      await processTechnicianReferralOnCompletion(query, techId, log);
    }

    // 2. Process Customer Referral Direct Cash Reward (1 Rupee = 1 Rupee direct discount, no virtual credits)
    try {
      const custRes = await query(`
        SELECT u.id, u.full_name, u.phone, u.locality, u.referred_by,
               (SELECT count(*)::int FROM bookings WHERE (customer_id = u.id OR customer_phone = u.phone) AND status = 'completed') as completed_count
        FROM users u
        WHERE u.id = (SELECT customer_id FROM bookings WHERE id = $1)
           OR RIGHT(REGEXP_REPLACE(u.phone, '\\D', '', 'g'), 10) = (
                SELECT RIGHT(REGEXP_REPLACE(customer_phone, '\\D', '', 'g'), 10)
                FROM bookings WHERE id = $1
              )
        LIMIT 1
      `, [bookingId]);

      if (custRes.rows.length > 0) {
        const customer = custRes.rows[0];
        // Only trigger once when this referred customer completes their first job
        if (customer.referred_by && customer.completed_count <= 1) {
          const referrerRes = await query(`
            SELECT id, phone, full_name 
            FROM users 
            WHERE referral_code = $1 
            LIMIT 1
          `, [customer.referred_by]);

          if (referrerRes.rows.length > 0) {
            // Customer referral rewards are coupon-based (REFERWAIVER50) on bookings, no virtual wallet credits needed
          }
        }
      }
    } catch (custRefErr) {
      if (log && log.warn) log.warn('Could not process customer referral reward: ' + custRefErr.message);
    }
  }

  // 1. Create Real Razorpay Order for . Deposit
  fastify.post('/payments/create-order', async (req, reply) => {
    try {
      const { bookingId, amount, currency = 'INR', isDiagnosticOnly = false } = req.body || {};
      if (!bookingId) {
        return reply.status(400).send({ success: false, error: 'Booking ID is required to create payment order' });
      }
      if (!amount || parseFloat(amount) <= 0) {
        return reply.status(400).send({ success: false, error: 'Valid payment amount is required' });
      }
      const orderAmountInPaise = Math.round(parseFloat(amount) * 100);

      if (!PAYMENTS_CONFIGURED) {
        return reply.status(503).send({
          success: false,
          error: 'Razorpay is not configured on this server (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing).'
        });
      }

      try {
        // Call Razorpay Orders API
        const authHeader = 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
        const rzpResponse = await fetch('https://api.razorpay.com/v1/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader
          },
          body: JSON.stringify({
            amount: orderAmountInPaise,
            currency: currency,
            receipt: `rcpt_${bookingId}`,
            notes: {
              bookingId: bookingId,
              type: isDiagnosticOnly ? 'DIAGNOSTIC_.' : 'FINAL_SETTLEMENT',
              platform: 'Shazu One .'
            }
          })
        });

        const orderData = await rzpResponse.json();

        if (rzpResponse.ok && orderData.id) {
          return {
            success: true,
            keyId: KEY_ID,
            order: {
              id: orderData.id,
              amount: orderData.amount,
              currency: orderData.currency,
              receipt: orderData.receipt,
              status: orderData.status
            }
          };
        }
      } catch (e) {
        fastify.log.warn('Razorpay API direct connect note:', e.message);
      }

      // Seamless fallback order for dev/sandbox verification
      const fallbackOrderId = `order_${bookingId || 'SLM'}_${Date.now()}`;
      return {
        success: true,
        keyId: KEY_ID,
        order: {
          id: fallbackOrderId,
          amount: orderAmountInPaise,
          currency: currency,
          receipt: `rcpt_${bookingId || Date.now()}`,
          status: 'created'
        }
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 1b. Asynchronous Razorpay Webhook Handler (Catches Payments if Customer Closes App or Drops Connection)
  fastify.post('/payments/webhook', async (req, reply) => {
    try {
      const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || KEY_SECRET;
      const signature = req.headers['x-razorpay-signature'];
      const payload = req.body;

      // Fail closed. Previously a request that simply omitted the signature header was
      // processed, so anyone could post a fake payment.captured and advance a booking.
      if (!ALLOW_UNSIGNED) {
        if (!signature) {
          fastify.log.warn('[Razorpay Webhook] Rejected: missing x-razorpay-signature header');
          return reply.status(400).send({ error: 'Missing webhook signature' });
        }
        if (!webhookSecret) {
          fastify.log.error('[Razorpay Webhook] Rejected: no webhook secret configured');
          return reply.status(503).send({ error: 'Webhook verification is not configured' });
        }
        const signedBody = req.rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
        const expectedSignature = crypto.createHmac('sha256', webhookSecret).update(signedBody).digest('hex');
        if (!secureEqual(expectedSignature, signature)) {
          fastify.log.warn('[Razorpay Webhook] Rejected: signature mismatch');
          return reply.status(400).send({ error: 'Invalid webhook signature' });
        }
      } else {
        fastify.log.warn('[Razorpay Webhook] Signature check bypassed because PAYMENTS_ALLOW_UNSIGNED=1');
      }

      const event = payload?.event;
      fastify.log.info(`[Razorpay Webhook] Received event: ${event}`);

      if (event === 'payment.captured' || event === 'order.paid') {
        const paymentEntity = payload?.payload?.payment?.entity || {};
        const paymentId = paymentEntity.id;
        const orderId = paymentEntity.order_id;
        const amountPaise = paymentEntity.amount;
        const bookingId = paymentEntity.notes?.bookingId;

        if (bookingId) {
          const parsedAmount = (parseFloat(amountPaise) || 9900) / 100;

          // Record the . deposit against the columns that actually exist. The previous
          // statement named transaction_id and a status label that is not in the payment_status
          // enum, and the error was swallowed, so no payment was ever recorded here.
          // tech_payout_amount and platform_commission are NOT NULL with no default, so both
          // have to be supplied even though the split is only decided at settlement.
          // Keep the order id exactly as Razorpay sent it. It used to be prefixed with
          // `order_`, which never matched the id stored by /payments/verify, so the conflict
          // target missed and every webhook added a second . row for the same money.
          const ledgerOrderId = orderId || `order_${paymentId || Date.now()}`;
          await query(`
            INSERT INTO payments (booking_id, razorpay_order_id, razorpay_payment_id, amount_total, tech_payout_amount, platform_commission, status, payment_method, created_at)
            VALUES ($1, $2, $3, $4, 0.00, 0.00, '._held', 'RAZORPAY_.', NOW())
            ON CONFLICT (razorpay_order_id) DO UPDATE
              SET razorpay_payment_id = EXCLUDED.razorpay_payment_id,
                  amount_total = EXCLUDED.amount_total,
                  status = CASE WHEN payments.status = 'settled' THEN payments.status ELSE '._held' END
          `, [bookingId, ledgerOrderId, paymentId || `pay_${Date.now()}`, parsedAmount]);

          // Check if this was a diagnostic advance or quote approval
          const isQuoteApproval = paymentEntity.notes?.type === 'FINAL_SETTLEMENT';
          const bRes = await query('SELECT technician_id FROM bookings WHERE id = $1', [bookingId]);
          const hasTech = Boolean(bRes.rows[0]?.technician_id);
          const nextStatus = isQuoteApproval ? 'quote_approved' : (hasTech ? 'en_route' : 'matching');

          await query(`
            UPDATE bookings 
            SET status = $1
            WHERE id = $2 AND status IN ('created', 'matching', 'quote_presented');
          `, [nextStatus, bookingId]).catch(err => {
            fastify.log.warn('Webhook booking status update note:', err.message);
          });

          await query(`
            INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
            VALUES ($1, 'WEBHOOK_PAYMENT_CAPTURED', $2, 'razorpay', $3)
          `, [bookingId, paymentId || 'rzp_webhook', JSON.stringify({ amount: parsedAmount, orderId, event })]).catch(() => { });
        }
      }

      return reply.send({ status: 'ok', received: true });
    } catch (err) {
      fastify.log.error('Razorpay Webhook Error:', err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 1c. Reconcile Payment Status (Polled by Mobile App after UPI App Switching or Merchant Alert)
  fastify.get('/payments/status/:bookingId', async (req, reply) => {
    try {
      const { bookingId } = req.params;
      const expectedAmount = req.query?.amount ? parseFloat(req.query.amount) : null;
      const bRes = await query('SELECT id, status, visit_fee, final_amount, quote_subtotal, advance_amount_paid FROM bookings WHERE id = $1', [bookingId]);
      const booking = bRes.rows[0] || null;

      const pRes = await query('SELECT * FROM payments WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1', [bookingId]);
      const payment = pRes.rows[0] || null;

      let matchedAlert = null;
      try {
        const normRef = normalizeBookingRef(bookingId);
        if (normRef) {
          const alertParams = [normRef];
          let alertSql = `
            SELECT id, source_app, amount, utr, booking_ref, created_at
            FROM merchant_credit_alerts
            WHERE matched_payment_id IS NULL
              AND booking_ref = $1
              AND created_at >= NOW() - INTERVAL '24 hours'
          `;
          if (Number.isFinite(expectedAmount) && expectedAmount > 0) {
            alertParams.push(expectedAmount);
            alertSql += ` AND ABS(COALESCE(amount, 0) - $2) <= 0.50`;
          }
          alertSql += ` ORDER BY created_at DESC LIMIT 1`;
          const aRes = await query(alertSql, alertParams);
          if (aRes.rows.length > 0) {
            const a = aRes.rows[0];
            matchedAlert = {
              id: a.id,
              sourceApp: a.source_app,
              amount: parseFloat(a.amount),
              utr: a.utr || null,
              bookingRef: a.booking_ref
            };
          }
        }
      } catch (alertErr) { }

      if (!booking && !payment && !matchedAlert) {
        return reply.status(404).send({ success: false, error: 'Booking not found' });
      }

      const isPaid = (booking && ['en_route', 'arrived', 'inspecting', 'quote_presented', 'quote_approved', 'completed'].includes(booking.status))
        || (payment && (payment.status === '._held' || payment.status === 'captured' || payment.status === 'settled'));

      const verificationStatus = payment?.verification_status || null;
      const verifiedBy = payment?.verified_by || null;

      return {
        success: true,
        bookingId: booking ? booking.id : bookingId,
        status: booking ? booking.status : 'created',
        isPaid: Boolean(isPaid),
        verificationStatus,
        verifiedBy,
        autoVerified: verificationStatus === 'verified' && ['AUTO_BANK_EMAIL_ALERT', 'BANK_CSV_RECONCILED', 'AUTO_MERCHANT_ALERT'].includes(verifiedBy),
        matchedAlert,
        payment
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 2. Verify Razorpay Payment Signature and Record in Neon DB . Ledger
  fastify.post('/payments/verify', async (req, reply) => {
    try {
      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        bookingId,
        amount = 99.00,
        techId,
        payment_method
      } = req.body;

      if (payment_method === 'cash' || req.body.paymentMethod === 'cash') {
        return reply.status(400).send({
          success: false,
          error: 'Cash payments are not allowed. Shazu One requires 100% digital . payments (UPI / Cards / Net Banking).'
        });
      }

      let isSignatureValid = false;
      if (razorpay_signature) {
        const body = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSignature = crypto
          .createHmac('sha256', KEY_SECRET)
          .update(body.toString())
          .digest('hex');
        isSignatureValid = secureEqual(expectedSignature, razorpay_signature);
      } else if (ALLOW_UNSIGNED) {
        // Local testing only, and always logged.
        isSignatureValid = true;
        fastify.log.warn('[payments/verify] accepting an unsigned payment because PAYMENTS_ALLOW_UNSIGNED=1');
      } else {
        return reply.status(400).send({
          success: false,
          error: 'Razorpay signature is required to confirm a payment.'
        });
      }

      if (!isSignatureValid) {
        fastify.log.warn('[payments/verify] signature mismatch for payment ' + (razorpay_payment_id || 'unknown'));
        return reply.status(400).send({ success: false, error: 'Invalid Razorpay payment signature.' });
      }

      const paymentTxId = razorpay_payment_id || `pay_${Date.now()}`;
      const orderTxId = razorpay_order_id || `order_${Date.now()}`;
      const parsedAmount = parseFloat(amount) || 99.00;

      // Record in Neon DB Payments . Ledger
      const insertSql = `
        INSERT INTO payments (booking_id, razorpay_order_id, razorpay_payment_id, amount_total, tech_payout_amount, platform_commission, status, payment_method, created_at)
        VALUES ($1, $2, $3, $4, 0.00, 0.00, '._held', 'RAZORPAY_.', NOW())
        ON CONFLICT (razorpay_order_id) DO UPDATE
          SET razorpay_payment_id = EXCLUDED.razorpay_payment_id,
              amount_total = EXCLUDED.amount_total,
              status = CASE WHEN payments.status = 'settled' THEN payments.status ELSE '._held' END
        RETURNING *;
      `;

      // A failed ledger write must stop the flow. This used to be caught and logged, then
      // the booking was advanced anyway, leaving a paid booking with no payment row.
      let dbRecord = null;
      try {
        const dbRes = await query(insertSql, [
          bookingId,
          orderTxId,
          paymentTxId,
          parsedAmount
        ]);
        dbRecord = dbRes.rows[0];
      } catch (dbErr) {
        fastify.log.error('[payments/verify] could not record the payment ledger row: ' + dbErr.message);
        return reply.status(500).send({
          success: false,
          error: 'Payment was received but could not be recorded. Please contact support with your payment id.'
        });
      }

      // Automatically advance booking to 'en_route' upon Part 1 payment or 'quote_approved' upon Part 2 payment
      let dualInvoice = null;
      let routeTransferResult = null;

      try {
        const bRes = await query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
        const currentB = bRes.rows[0];

        if (currentB) {
          const isQuoteApproval = currentB.status === 'quote_presented' || parsedAmount > 100;
          const nextStatus = isQuoteApproval ? 'quote_approved' : (currentB.technician_id ? 'en_route' : 'matching');

          await query(`
            UPDATE bookings 
            SET status = $1, advance_amount_paid = COALESCE(advance_amount_paid, 0) + $3
            WHERE id = $2 AND status IN ('created', 'accepted', 'matching', 'quote_presented')
          `, [nextStatus, bookingId, parsedAmount]);

          const quoteSub = parseFloat(currentB.quote_subtotal) || parsedAmount;
          const actualAdvance = parseFloat(currentB.advance_amount_paid ?? (Math.max(0, parseFloat(currentB.visit_fee || 99) - parseFloat(currentB.coupon_discount || 0))));
          const settings = await getLiveFeeSettings();

          dualInvoice = calculateDualCommissionInvoice({
            totalJobAmount: quoteSub,
            actualAdvancePaid: actualAdvance,
            customerFeePercent: settings.customerFeePercent,
            gatewayFeePercent: settings.gatewayFeePercent,
            partnerCommPercent: settings.partnerCommPercent,
            paymentMethod: currentB.payment_method || 'online'
          });

          // Razorpay Route Automated Split to Partner Account
          const routeEnabled = process.env.RAZORPAY_ROUTE_ENABLED === 'true' || process.env.RAZORPAY_ROUTE_ENABLED === '1';
          if (routeEnabled && currentB.technician_id && dualInvoice.partnerDirectRouteTransfer > 0) {
            const techRes = await query('SELECT razorpay_account_id, name FROM technicians WHERE id = $1', [currentB.technician_id]);
            const techObj = techRes.rows[0];
            if (techObj?.razorpay_account_id && !paymentTxId.startsWith('pay_dummy')) {
              try {
                const authHeader = 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
                const rzpRouteRes = await fetch(`https://api.razorpay.com/v1/payments/${paymentTxId}/transfers`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': authHeader
                  },
                  body: JSON.stringify({
                    transfers: [
                      {
                        account: techObj.razorpay_account_id,
                        amount: Math.round(dualInvoice.partnerDirectRouteTransfer * 100),
                        currency: 'INR',
                        notes: {
                          booking_id: bookingId,
                          partner_name: techObj.name,
                          payout_type: 'partner_share'
                        },
                        on_hold: 0
                      }
                    ]
                  })
                });
                routeTransferResult = await rzpRouteRes.json();
              } catch (rErr) {
                fastify.log.warn('Razorpay Route Transfer dispatch note:', rErr.message);
              }
            }
          }

          await query(`
            INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
            VALUES ($1, 'PAYMENT_VERIFIED_SPLIT_RECORDED', 'customer', 'customer', $2)
          `, [
            bookingId,
            JSON.stringify({
              amount: parsedAmount,
              paymentId: paymentTxId,
              orderId: orderTxId,
              gateway: 'Razorpay',
              dualInvoice,
              routeTransferResult,
              timestamp: new Date().toISOString()
            })
          ]);
        }
      } catch (statusErr) {
        fastify.log.warn('Booking status update on payment note:', statusErr.message);
      }

      return {
        success: true,
        verified: true,
        paymentId: paymentTxId,
        orderId: orderTxId,
        paymentStatus: 'HELD_IN_PROTECTION',
        guarantee: '100% Protected under Shazu One Policy',
        invoice: dualInvoice,
        routeTransfer: routeTransferResult,
        disbursalSummary: {
          part1Fee: parsedAmount,
          technicianShare: dualInvoice ? dualInvoice.partnerDirectRouteTransfer : parsedAmount,
          platformCut: dualInvoice ? (dualInvoice.customerPlatformFee + dualInvoice.partnerCommissionAmount) : 0.00,
          notice: 'Dual-commission processed transparently per .env configuration.'
        },
        dbRecord
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 3. Dynamic Dual-Commission & Partner Split Calculation
  fastify.post('/payments/calculate-split', async (req, reply) => {
    const { grossAmount, visitFee = 99.00, actualAdvancePaid } = req.body || {};
    const total = parseFloat(grossAmount) || 1000.00;
    const upfront = parseFloat(visitFee) || 99.00;
    const adv = actualAdvancePaid !== undefined ? parseFloat(actualAdvancePaid) : upfront;
    const settings = await getLiveFeeSettings();

    const invoice = calculateDualCommissionInvoice({
      totalJobAmount: total,
      upfrontFeePaid: upfront,
      actualAdvancePaid: adv,
      customerFeePercent: settings.customerFeePercent,
      gatewayFeePercent: settings.gatewayFeePercent,
      partnerCommPercent: settings.partnerCommPercent
    });

    return {
      success: true,
      keyId: KEY_ID,
      breakdown: {
        totalGrossBill: total,
        visitFee: upfront,
        remainingWorkAmount: invoice.remainingWorkAmount,
        customerFeePercent: invoice.customerFeePercent,
        customerPlatformFee: invoice.customerPlatformFee,
        gatewayFeePercent: invoice.gatewayFeePercent,
        paymentGatewayFee: invoice.paymentGatewayFee,
        customerFinalPayable: invoice.customerFinalPayable,
        partnerCommPercent: invoice.partnerCommPercent,
        partnerCommissionAmount: invoice.partnerCommissionAmount,
        partnerNetEarnings: invoice.partnerNetEarnings,
        partnerDirectRouteTransfer: invoice.partnerDirectRouteTransfer,
        platformTotalRetained: invoice.platformTotalRetained,
        // Backward-compatibility keys
        techPayout: {
          percentage: `${100 - invoice.partnerCommPercent}%`,
          amount: invoice.partnerDirectRouteTransfer
        },
        platformRevenue: {
          percentage: `${invoice.customerFeePercent + invoice.partnerCommPercent}%`,
          amount: invoice.platformTotalRetained
        },
        pgFee: invoice.paymentGatewayFee,
        settlementAccount: 'acc_Shazu One_Main'
      }
    };
  });

  // 4. Customer Confirms Work Finished & Authorizes Partner Settlement
  fastify.post('/payments/./release', async (req, reply) => {
    try {
      const { bookingId, customerOtp, rating = 5, reviewComment } = req.body;

      if (!bookingId) {
        return reply.status(400).send({ success: false, error: 'Booking ID is required to authorize partner settlement.' });
      }

      // Releasing payment moves funds to the partner, so it must be tied to one booking that
      // the customer has actually accepted. The old version released the newest booking when
      // the supplied id did not match, and never checked the completion OTP.
      const bRes = await query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
      const booking = bRes.rows[0];

      if (!booking) {
        return reply.status(404).send({ success: false, error: 'Booking not found' });
      }

      if (!booking.customer_otp) {
        return reply.status(409).send({
          success: false,
          error: 'This booking has no completion OTP on file, so partner settlement cannot be authorized.'
        });
      }

      if (!customerOtp || !secureEqual(String(customerOtp).trim(), String(booking.customer_otp).trim())) {
        return reply.status(403).send({
          success: false,
          error: 'A valid completion OTP is required to authorize settlement.'
        });
      }

      const alreadySettled = await query(`
        SELECT 1 FROM payments WHERE booking_id = $1 AND status = 'settled' LIMIT 1
      `, [booking.id]);
      if (alreadySettled.rows.length > 0) {
        return reply.status(409).send({ success: false, error: 'Settlement for this booking has already been processed.' });
      }

      const targetId = booking.id;
      const quoteSubtotal = parseFloat(booking.quote_subtotal) || 250.00;
      const actualAdvance = parseFloat(booking.advance_amount_paid ?? (Math.max(0, parseFloat(booking.visit_fee || 99) - parseFloat(booking.coupon_discount || 0))));
      const settings = await getLiveFeeSettings();

      const invoice = calculateDualCommissionInvoice({
        totalJobAmount: quoteSubtotal,
        actualAdvancePaid: actualAdvance,
        customerFeePercent: settings.customerFeePercent,
        gatewayFeePercent: settings.gatewayFeePercent,
        partnerCommPercent: settings.partnerCommPercent,
        paymentMethod: booking.payment_method || 'online'
      });

      const totalTechPayout = invoice.partnerDirectRouteTransfer;
      const platformCut = invoice.partnerCommissionAmount + invoice.customerPlatformFee;

      // 1. Update booking status to completed
      const upRes = await query(`
        UPDATE bookings 
        SET status = 'completed', 
            completed_at = NOW(),
            final_amount = $1
        WHERE id = $2
        RETURNING *
      `, [invoice.totalJobAmount, targetId]);

      const completedBooking = upRes.rows[0] || booking;

      // 2. Fetch assigned technician for UPI details
      let techUpi = '';
      let techPhone = '';
      let techId = completedBooking.technician_id;
      if (techId) {
        const tRes = await query('SELECT phone, upi_vpa FROM technicians WHERE id = $1', [techId]);
        if (tRes.rows.length > 0) {
          techUpi = tRes.rows[0].upi_vpa || '';
          techPhone = tRes.rows[0].phone || '';
        }
      }

      // 3. Queue Technician Payout as PENDING_DISBURSAL (No fake UTR, awaiting manual Admin settlement)
      await query(`
        INSERT INTO technician_payouts (technician_phone, technician_id, amount, upi_id, status, utr_ref, description, created_at)
        VALUES ($1, $2, $3, $4, 'PENDING_DISBURSAL', NULL, $5, NOW())
      `, [
        techPhone,
        techId,
        totalTechPayout,
        techUpi,
        `Pending Admin settlement for #${targetId} (₹${invoice.totalJobAmount} labor - ₹${invoice.partnerCommissionAmount} partner comm = ₹${totalTechPayout})`
      ]);

      if (techId) {
        try {
          await query(`
            UPDATE technicians 
            SET jobs_completed_count = (
              SELECT count(*)::int FROM bookings WHERE technician_id = $1 AND status = 'completed'
            )
            WHERE id = $1
          `, [techId]);
        } catch (syncErr) {
          console.warn('Could not update tech jobs_completed_count in settle-payout:', syncErr.message);
        }
      }

      // 4. Record Payment in payments table as ._held (awaiting Admin disbursal confirmation)
      const settledRes = await query(`
        UPDATE payments
        SET status = '._held',
            amount_total = $2,
            tech_payout_amount = $3,
            platform_commission = $4,
            payment_method = 'UPI (Pending Partner Disbursal)',
            payout_utr = NULL,
            settled_at = NULL
        WHERE id = (
          SELECT id FROM payments WHERE booking_id = $1
          ORDER BY created_at DESC NULLS LAST LIMIT 1
        )
      `, [targetId, invoice.totalJobAmount, totalTechPayout, platformCut]);

      if (settledRes.rowCount === 0) {
        await query(`
          INSERT INTO payments (booking_id, amount_total, tech_payout_amount, platform_commission, status, payment_method, payout_utr, settled_at)
          VALUES ($1, $2, $3, $4, '._held', 'UPI (Pending Partner Disbursal)', NULL, NULL)
        `, [targetId, invoice.totalJobAmount, totalTechPayout, platformCut]);
      }

      // 5. Record Review if provided
      if (rating) {
        await query(`
          INSERT INTO reviews (booking_id, technician_id, rating, comment, created_at)
          VALUES ($1, $2, $3, $4, NOW())
        `, [targetId, techId, parseFloat(rating), reviewComment || 'Excellent on-time service & genuine spare parts fitted.']);
      }

      // 6. Process Technician & Customer Referral Incentives (No points, direct rupee settlement)
      await processJobCompletionReferrals(targetId, techId, fastify.log);

      // 7. Audit Log
      await query(`
        INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
        VALUES ($1, 'SERVICE_COMPLETED_PAYOUT_PENDING_ADMIN', 'customer', 'customer', $2)
      `, [targetId, JSON.stringify({ totalTechPayout, techUpi, status: 'completed', payoutStatus: 'PENDING_DISBURSAL' })]);

      return {
        success: true,
        message: 'Customer confirmed work completion. Payment captured and queued for partner contractor settlement.',
        booking: completedBooking,
        settlement: {
          totalAmount: invoice.totalJobAmount,
          technicianPayout: totalTechPayout,
          platformCommission: platformCut,
          techUpi,
          payoutStatus: 'PENDING_DISBURSAL',
          status: 'PENDING_ADMIN_CONFIRMATION'
        }
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // ==========================================
  // DYNAMIC BUSINESS UPI QR PAYMENTS & OCR
  // ==========================================

  // 1. Get Payment Configuration (Active mode: DYNAMIC_QR vs RAZORPAY, Business VPA)
  fastify.get('/payments/qr-config', async (req, reply) => {
    try {
      const sRes = await query(`
        SELECT business_upi_id, business_merchant_name, payment_gateway_mode,
               customer_platform_fee_percent, gateway_fee_percent
        FROM platform_settings 
        WHERE id = 'reward_settings' 
        LIMIT 1
      `);
      const row = sRes.rows[0] || {};
      const businessUpiId = getEnvUpiId() || row.business_upi_id || '';
      const businessMerchantName = getEnvMerchantName() || row.business_merchant_name || '';
      console.log('[BACKEND /payments/qr-config] Env UPI ID:', businessUpiId, '| Env Merchant Name:', businessMerchantName);
      return {
        success: true,
        businessUpiId,
        businessMerchantName,
        paymentGatewayMode: row.payment_gateway_mode || process.env.PAYMENT_GATEWAY_MODE || 'DYNAMIC_QR',
        platformFeePercent: parseFloat(row.customer_platform_fee_percent || 2.0),
        gatewayFeePercent: parseFloat(row.gateway_fee_percent || 2.0)
      };
    } catch (err) {
      fastify.log.error('QR Config fetch error:', err);
      return {
        success: true,
        businessUpiId: getEnvUpiId(),
        businessMerchantName: getEnvMerchantName(),
        paymentGatewayMode: process.env.PAYMENT_GATEWAY_MODE || 'DYNAMIC_QR'
      };
    }
  });

  // 2. Generate Dynamic UPI Intent & URI
  fastify.get('/payments/qr-intent', async (req, reply) => {
    try {
      const { bookingId, amount, paymentType = 'ADVANCE_FEE' } = req.query;
      if (!amount || parseFloat(amount) <= 0) {
        return reply.status(400).send({ success: false, error: 'Valid amount is required' });
      }

      const sRes = await query(`
        SELECT business_upi_id, business_merchant_name 
        FROM platform_settings 
        WHERE id = 'reward_settings' 
        LIMIT 1
      `);
      const vpa = getEnvUpiId() || sRes.rows[0]?.business_upi_id || '';
      const merchantName = getEnvMerchantName() || sRes.rows[0]?.business_merchant_name || '';
      console.log('[BACKEND /payments/qr-intent] Env UPI ID:', vpa, '| Env Merchant Name:', merchantName);

      if (!vpa) {
        return reply.status(500).send({
          success: false,
          error: 'Business UPI ID is not configured. Please set BUSINESS_UPI_ID or UPI_ID in the backend .env file.'
        });
      }

      const cleanAmount = parseFloat(amount).toFixed(2);
      const bId = bookingId || `SLM-${Date.now()}`;
      const suffix = paymentType === 'FINAL_SETTLEMENT' ? 'FIN' : 'ADV';
      const txnRef = `${bId}-${suffix}`;
      const txnNote = `${merchantName || 'Order'} ${bId}`;

      // Standard Indian UPI Intent URI
      const upiUri = `upi://pay?pa=${encodeURIComponent(vpa)}&pn=${encodeURIComponent(merchantName)}&am=${cleanAmount}&tr=${encodeURIComponent(txnRef)}&tn=${encodeURIComponent(txnNote)}&cu=INR`;

      return {
        success: true,
        upiUri,
        businessUpiId: vpa,
        businessMerchantName: merchantName,
        amount: parseFloat(cleanAmount),
        transactionRef: txnRef,
        transactionNote: txnNote
      };
    } catch (err) {
      fastify.log.error('QR intent error:', err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 3. Submit Manual Dynamic QR Payment with Screenshot & UTR
  fastify.post('/payments/submit-manual-qr', async (req, reply) => {
    try {
      const {
        bookingId,
        amount,
        customerUtr,
        screenshotUrl,
        ocrDetectedUtr,
        paymentType = 'ADVANCE_FEE',
        notes
      } = req.body || {};

      if (!bookingId) {
        return reply.status(400).send({ success: false, error: 'Booking ID is required' });
      }
      if (!amount || parseFloat(amount) <= 0) {
        return reply.status(400).send({ success: false, error: 'Valid payment amount is required' });
      }
      const cleanUtr = String(customerUtr || '').trim().replace(/\s+/g, '');
      if (!cleanUtr || cleanUtr.length < 6) {
        return reply.status(400).send({ success: false, error: 'Please provide a valid transaction reference / UTR number (at least 6 characters)' });
      }

      // Duplicate UTR anti-fraud guard
      const dupUtrRes = await query(`
        SELECT id, booking_id
        FROM payments
        WHERE REGEXP_REPLACE(COALESCE(customer_utr, ''), '\\s', '', 'g') = $1
          AND COALESCE(verification_status, 'pending') <> 'rejected'
        LIMIT 1
      `, [cleanUtr]);
      if (dupUtrRes.rows.length > 0) {
        return reply.status(409).send({
          success: false,
          error: `Duplicate UTR ${cleanUtr}: This transaction reference was already submitted for booking #${dupUtrRes.rows[0].booking_id}.`
        });
      }

      const parsedAmount = parseFloat(amount);

      // Check if booking exists
      let bRes = await query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
      if (bRes.rows.length === 0) {
        // If this is an advance fee reservation with a client-generated booking token (e.g. SCHED-1793523...)
        if (String(bookingId).startsWith('SCHED-') || String(bookingId).startsWith('TEMP-') || paymentType === 'ADVANCE_FEE') {
          try {
            await query(`
              INSERT INTO bookings (
                id, service_id, customer_name, customer_phone, service_address,
                locality, visit_fee, final_amount, status, scheduled_slot,
                customer_otp, booking_type
              ) VALUES (
                $1, 'ac', 'Salem Customer', '+91 9842099999', 'Fairlands, Salem - 636016',
                'Fairlands', $2, $2, 'created', 'Doorstep Inspection',
                '1234', 'scheduled'
              )
              ON CONFLICT (id) DO NOTHING;
            `, [bookingId, parsedAmount]);
            bRes = await query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
          } catch (initErr) {
            fastify.log.warn('Auto-init advance booking error: ' + initErr.message);
          }
        }
      }

      if (bRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Booking not found' });
      }
      const booking = bRes.rows[0];

      const isFinalSettlement = paymentType === 'FINAL_SETTLEMENT' || booking.status === 'quote_approved' || booking.status === 'quote_presented';
      const feeSettings = await getLiveFeeSettings();

      const advancePaid = parseFloat(
        booking.advance_amount_paid !== null && booking.advance_amount_paid !== undefined
          ? booking.advance_amount_paid
          : Math.max(0, parseFloat(booking.visit_fee || 99) - parseFloat(booking.coupon_discount || 0))
      );

      // Total job amount is the full quote (including the booking fee)
      const targetJobTotal = isFinalSettlement
        ? parseFloat(booking.quote_subtotal || (parsedAmount + advancePaid))
        : parsedAmount;

      const inv = calculateDualCommissionInvoice({
        totalJobAmount: targetJobTotal,
        actualAdvancePaid: advancePaid,
        customerFeePercent: feeSettings.customerFeePercent,
        gatewayFeePercent: feeSettings.gatewayFeePercent,
        partnerCommPercent: feeSettings.partnerCommPercent,
        paymentMethod: booking.payment_method || 'online'
      });

      // Total customer payment across advance booking fee + final step
      const totalCustomerPaid = isFinalSettlement ? (advancePaid + parsedAmount) : parsedAmount;

      // Query prior non-failed payments for this booking to attribute incremental splits
      const priorPaymentsRes = await query(`
        SELECT 
          COALESCE(SUM(tech_payout_amount), 0) as prior_tech_payout,
          COALESCE(SUM(platform_commission), 0) as prior_platform_comm
        FROM payments 
        WHERE booking_id = $1 AND status != 'failed'
      `, [bookingId]);
      const priorTechPayout = parseFloat(priorPaymentsRes.rows[0]?.prior_tech_payout || 0);
      const priorPlatformComm = parseFloat(priorPaymentsRes.rows[0]?.prior_platform_comm || 0);

      // In final settlement, parsedAmount is the actual cash collected in this second transaction.
      // Never store cumulative totalCustomerPaid into an individual transaction's amount_total column.
      const txnAmount = parsedAmount;
      const techPayout = isFinalSettlement
        ? Math.max(0, parseFloat((inv.partnerDirectRouteTransfer - priorTechPayout).toFixed(2)))
        : parseFloat((parsedAmount * (100 - feeSettings.partnerCommPercent) / 100).toFixed(2));
      const platformComm = isFinalSettlement
        ? Math.max(0, parseFloat((inv.platformTotalRetained - priorPlatformComm).toFixed(2)))
        : parseFloat((parsedAmount * (feeSettings.partnerCommPercent / 100)).toFixed(2));

      const ledgerOrderId = `qr_ord_${bookingId}_${Date.now()}`;
      const ledgerPaymentId = `qr_pay_${cleanUtr}_${Date.now()}`;

      // Insert or update payment record
      const insertRes = await query(`
        INSERT INTO payments (
          booking_id, razorpay_order_id, razorpay_payment_id, amount_total,
          tech_payout_amount, platform_commission, status, payment_method,
          customer_utr, ocr_detected_utr, screenshot_url, verification_status,
          created_at
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, '._held', 'DYNAMIC_UPI_QR',
          $7, $8, $9, 'pending',
          NOW()
        )
        RETURNING *;
      `, [
        bookingId,
        ledgerOrderId,
        ledgerPaymentId,
        txnAmount,
        techPayout,
        platformComm,
        cleanUtr,
        ocrDetectedUtr || null,
        screenshotUrl || null
      ]);

      let finalPaymentRow = insertRes.rows[0];
      let autoVerified = false;
      try {
        const alertMatch = await claimMatchingAlertForPayment(query, {
          paymentId: finalPaymentRow.id,
          bookingId,
          amount: txnAmount,
          utr: cleanUtr
        });
        if (alertMatch.matched && alertMatch.payment) {
          finalPaymentRow = alertMatch.payment;
          autoVerified = true;
        }
      } catch (claimErr) {
        fastify.log.warn('Merchant alert pre-claim check note: ' + claimErr.message);
      }

      const nextBookingStatus = isFinalSettlement
        ? 'completed'
        : (booking.status === 'created'
          ? (booking.technician_id ? 'accepted' : 'matching')
          : booking.status);

      if (isFinalSettlement) {
        await query(`
          UPDATE bookings
          SET status = 'completed',
              completed_at = NOW(),
              final_amount = $1
          WHERE id = $2;
        `, [targetJobTotal, bookingId]);

        // Disburse technician payout in database
        try {
          const totalTechPayout = inv.partnerDirectRouteTransfer;
          let techId = booking.technician_id;
          let techPhone = '';
          let techUpi = '';
          if (techId) {
            const tRes = await query('SELECT phone, upi_vpa FROM technicians WHERE id = $1', [techId]);
            if (tRes.rows.length > 0) {
              techUpi = tRes.rows[0].upi_vpa || '';
              techPhone = tRes.rows[0].phone || '';
            }
            await query(`
              INSERT INTO technician_payouts (technician_phone, technician_id, amount, upi_id, status, utr_ref, description, created_at)
              VALUES ($1, $2, $3, $4, 'PENDING_DISBURSAL', NULL, $5, NOW())
            `, [
              techPhone,
              techId,
              totalTechPayout,
              techUpi,
              `Pending Admin settlement for #${bookingId} (Total Job: ₹${targetJobTotal} incl booking fee - ₹${inv.partnerCommissionAmount} partner comm = ₹${totalTechPayout})`
            ]);
            await query(`
              UPDATE technicians 
              SET jobs_completed_count = (
                SELECT count(*)::int FROM bookings WHERE technician_id = $1 AND status = 'completed'
              )
              WHERE id = $1
            `, [techId]);
          }

          // Process technician referral incentive and customer referral cash reward
          await processJobCompletionReferrals(bookingId, techId, fastify.log);
        } catch (paySyncErr) {
          fastify.log.warn('Could not auto-disburse tech payout on final settlement: ' + paySyncErr.message);
        }
      } else {
        await query(`
          UPDATE bookings
          SET status = $1, advance_amount_paid = COALESCE(advance_amount_paid, 0) + $2
          WHERE id = $3 AND status IN ('created', 'matching');
        `, [nextBookingStatus, parsedAmount, bookingId]);

        // If booking had an assigned technician and was waiting for advance payment, dispatch high-priority push now
        if (booking.technician_id && booking.status === 'created') {
          try {
            const pushService = require('../services/pushNotification.service');
            const tRes = await query('SELECT phone, full_name FROM technicians WHERE id = $1', [booking.technician_id]);
            if (tRes.rows.length > 0) {
              pushService.sendPushToPhone({
                phone: tRes.rows[0].phone,
                role: 'technician',
                payload: {
                  title: `New Service Assigned: ${booking.service_id ? booking.service_id.toUpperCase() : 'Home Service'}`,
                  body: `Customer paid advance inspection fee for #${bookingId} in ${booking.locality || 'Salem'}. Tap to review.`,
                  tag: `job-${bookingId}`,
                  type: 'new_job',
                  bookingId: bookingId,
                  role: 'technician',
                  url: '/partner'
                },
                options: { urgency: 'high', TTL: 1800 }
              }).catch(e => fastify.log.warn('Paid booking tech push note: ' + e.message));
            }
          } catch (pErr) {
            fastify.log.warn('Push dispatch error on paid QR: ' + pErr.message);
          }
        }
      }

      // Insert audit log
      try {
        await query(`
          INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
          VALUES ($1, 'MANUAL_QR_PAYMENT_SUBMITTED', 'customer', 'customer', $2)
        `, [
          bookingId,
          JSON.stringify({
            amount: parsedAmount,
            customerUtr: cleanUtr,
            ocrDetectedUtr,
            hasScreenshot: Boolean(screenshotUrl),
            paymentType,
            status: autoVerified ? 'verified' : 'pending_admin_verification',
            autoVerified
          })
        ]);
      } catch (aErr) { }

      return {
        success: true,
        autoVerified,
        verificationStatus: finalPaymentRow?.verification_status || (autoVerified ? 'verified' : 'pending'),
        message: autoVerified
          ? 'Payment verified automatically via bank credit email alert!'
          : 'Payment proof submitted successfully! Verified via bank email alert or end-of-day bank CSV.',
        payment: finalPaymentRow,
        bookingId,
        nextStatus: nextBookingStatus
      };
    } catch (err) {
      fastify.log.error('Submit manual QR error:', err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 3b. Partner Physical Confirmation for 2nd (Doorstep Final Settlement) Payment via Partner-Phone QR
  fastify.post('/payments/partner-confirm-doorstep', async (req, reply) => {
    try {
      const {
        bookingId,
        technicianId,
        amount,
        customerUtr = ''
      } = req.body || {};

      if (!bookingId) {
        return reply.status(400).send({ success: false, error: 'Booking ID is required' });
      }

      const parsedAmount = parseFloat(amount);
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        return reply.status(400).send({ success: false, error: 'Valid doorstep collection amount is required' });
      }

      const bRes = await query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
      if (bRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Booking not found' });
      }
      const booking = bRes.rows[0];

      if (technicianId && booking.technician_id && String(booking.technician_id) !== String(technicianId)) {
        return reply.status(403).send({ success: false, error: 'Only the assigned technician can confirm doorstep collection for this booking.' });
      }

      const cleanOptionalUtr = String(customerUtr || '').trim().replace(/\s+/g, '');
      if (cleanOptionalUtr && cleanOptionalUtr.length < 6) {
        return reply.status(400).send({ success: false, error: 'If entering a UTR / Ref No, please enter at least 6 characters.' });
      }

      if (cleanOptionalUtr) {
        const dupRes = await query(`
          SELECT id, booking_id
          FROM payments
          WHERE REGEXP_REPLACE(COALESCE(customer_utr, ''), '\\s', '', 'g') = $1
            AND COALESCE(verification_status, 'pending') <> 'rejected'
          LIMIT 1
        `, [cleanOptionalUtr]);
        if (dupRes.rows.length > 0) {
          return reply.status(409).send({
            success: false,
            error: `Duplicate UTR ${cleanOptionalUtr}: Already recorded on booking #${dupRes.rows[0].booking_id}.`
          });
        }
      }

      const feeSettings = await getLiveFeeSettings();
      const advancePaid = parseFloat(
        booking.advance_amount_paid !== null && booking.advance_amount_paid !== undefined
          ? booking.advance_amount_paid
          : Math.max(0, parseFloat(booking.visit_fee || 99) - parseFloat(booking.coupon_discount || 0))
      );
      const targetJobTotal = parseFloat(booking.quote_subtotal || (parsedAmount + advancePaid));

      const inv = calculateDualCommissionInvoice({
        totalJobAmount: targetJobTotal,
        actualAdvancePaid: advancePaid,
        customerFeePercent: feeSettings.customerFeePercent,
        gatewayFeePercent: feeSettings.gatewayFeePercent,
        partnerCommPercent: feeSettings.partnerCommPercent,
        paymentMethod: booking.payment_method || 'online'
      });

      const priorPaymentsRes = await query(`
        SELECT 
          COALESCE(SUM(tech_payout_amount), 0) as prior_tech_payout,
          COALESCE(SUM(platform_commission), 0) as prior_platform_comm
        FROM payments 
        WHERE booking_id = $1 AND status != 'failed'
      `, [bookingId]);
      const priorTechPayout = parseFloat(priorPaymentsRes.rows[0]?.prior_tech_payout || 0);
      const priorPlatformComm = parseFloat(priorPaymentsRes.rows[0]?.prior_platform_comm || 0);

      const techPayout = Math.max(0, parseFloat((inv.partnerDirectRouteTransfer - priorTechPayout).toFixed(2)));
      const platformComm = Math.max(0, parseFloat((inv.platformTotalRetained - priorPlatformComm).toFixed(2)));
      const storedUtr = cleanOptionalUtr || `TECH-${String(bookingId).slice(-6).toUpperCase()}-${Date.now().toString().slice(-6)}`;

      const insertRes = await query(`
        INSERT INTO payments (
          booking_id, razorpay_order_id, razorpay_payment_id, amount_total,
          tech_payout_amount, platform_commission, status, payment_method,
          customer_utr, ocr_detected_utr, screenshot_url, verification_status, verified_by,
          created_at
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, '._held', 'DYNAMIC_UPI_QR',
          $7, $8, NULL, 'tech_confirmed', 'PARTNER_PHYSICAL_CHECK',
          NOW()
        )
        RETURNING *;
      `, [
        bookingId,
        `qr_door_${bookingId}_${Date.now()}`,
        `qr_door_pay_${storedUtr}`,
        parsedAmount,
        techPayout,
        platformComm,
        storedUtr,
        cleanOptionalUtr || null
      ]);

      let finalPaymentRow = insertRes.rows[0];
      let autoVerified = false;
      try {
        const alertMatch = await claimMatchingAlertForPayment(query, {
          paymentId: finalPaymentRow.id,
          bookingId,
          amount: parsedAmount,
          utr: cleanOptionalUtr || null
        });
        if (alertMatch.matched && alertMatch.payment) {
          finalPaymentRow = alertMatch.payment;
          autoVerified = true;
        }
      } catch (claimErr) {
        fastify.log.warn('Doorstep merchant alert claim note: ' + claimErr.message);
      }

      await query(`
        UPDATE bookings
        SET status = 'completed',
            completed_at = COALESCE(completed_at, NOW()),
            final_amount = $1
        WHERE id = $2
      `, [targetJobTotal, bookingId]);

      const techId = booking.technician_id || technicianId || null;
      if (techId) {
        try {
          const totalTechPayout = inv.partnerDirectRouteTransfer;
          let techPhone = '';
          let techUpi = '';
          const tRes = await query('SELECT phone, upi_vpa FROM technicians WHERE id = $1', [techId]);
          if (tRes.rows.length > 0) {
            techUpi = tRes.rows[0].upi_vpa || '';
            techPhone = tRes.rows[0].phone || '';
          }
          await query(`
            INSERT INTO technician_payouts (technician_phone, technician_id, amount, upi_id, status, utr_ref, description, created_at)
            VALUES ($1, $2, $3, $4, 'PENDING_DISBURSAL', NULL, $5, NOW())
          `, [
            techPhone,
            techId,
            totalTechPayout,
            techUpi,
            `Pending Admin settlement for #${bookingId} (Doorstep QR Final ₹${parsedAmount.toFixed(2)}, Status: ${autoVerified ? 'AUTO_BANK_EMAIL_ALERT' : 'PARTNER_PHYSICAL_CHECK'})`
          ]);
        } catch (payoutErr) {
          fastify.log.warn('Could not queue payout on partner doorstep confirm: ' + payoutErr.message);
        }

        await processJobCompletionReferrals(bookingId, techId, fastify.log);
      }

      try {
        await query(`
          INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
          VALUES ($1, $2, $3, 'technician', $4)
        `, [
          bookingId,
          autoVerified ? 'DOORSTEP_PAYMENT_AUTO_VERIFIED' : 'DOORSTEP_PAYMENT_TECH_CONFIRMED',
          String(techId || 'technician'),
          JSON.stringify({ amount: parsedAmount, utr: storedUtr, autoVerified })
        ]);
      } catch (aErr) { }

      return {
        success: true,
        autoVerified,
        verificationStatus: finalPaymentRow?.verification_status || (autoVerified ? 'verified' : 'tech_confirmed'),
        message: autoVerified
          ? 'Doorstep payment confirmed and verified automatically via bank credit alert!'
          : 'Doorstep collection recorded! Payment will clear once verified via bank email alert or end-of-day CSV.',
        payment: finalPaymentRow,
        bookingId
      };
    } catch (err) {
      fastify.log.error('Partner doorstep confirm error:', err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 3c. Bank Credit Email Alert Webhook (forwards HDFC/ICICI/SBI/Axis/bank credit alert emails)
  const handleBankAlertWebhook = async (req, reply) => {
    try {
      const configuredSecret = process.env.BANK_EMAIL_WEBHOOK_SECRET || process.env.MERCHANT_ALERT_WEBHOOK_SECRET || '';
      if (!configuredSecret) {
        return reply.status(503).send({
          success: false,
          error: 'BANK_EMAIL_WEBHOOK_SECRET is not configured in the backend environment.'
        });
      }

      const providedSecret = req.headers['x-bank-webhook-secret'] || req.headers['x-merchant-webhook-secret'] || req.headers['x-webhook-secret'] || '';
      if (!providedSecret || !secureEqual(String(providedSecret), String(configuredSecret))) {
        return reply.status(401).send({ success: false, error: 'Unauthorized bank credit webhook secret.' });
      }

      const result = await processIncomingMerchantAlert(query, req.body || {}, fastify.log);
      return {
        success: true,
        ...result
      };
    } catch (err) {
      fastify.log.error('Bank email alert webhook error:', err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  };
  fastify.post('/payments/bank-email-alert', handleBankAlertWebhook);
  fastify.post('/payments/merchant-notification', handleBankAlertWebhook);

  // 3d. Admin: View Recent Bank Credit Email & CSV Alerts
  const handleGetBankAlerts = async (req, reply) => {
    try {
      const res = await query(`
        SELECT id, source_app, amount, utr, booking_ref, sender_label, raw_message, matched_payment_id, matched_at, created_at
        FROM merchant_credit_alerts
        ORDER BY created_at DESC
        LIMIT 50
      `);
      return {
        success: true,
        webhookConfigured: Boolean(process.env.BANK_EMAIL_WEBHOOK_SECRET || process.env.MERCHANT_ALERT_WEBHOOK_SECRET),
        count: res.rows.length,
        alerts: res.rows
      };
    } catch (err) {
      fastify.log.error('Fetch bank alerts error:', err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  };
  fastify.get('/admin/payments/bank-alerts', handleGetBankAlerts);
  fastify.get('/admin/payments/merchant-alerts', handleGetBankAlerts);

  // 3e. Admin: End-of-Day Bank Statement CSV Bulk Reconciliation & Verify
  fastify.post('/admin/payments/reconcile-csv', async (req, reply) => {
    try {
      const csvText = typeof req.body === 'string' ? req.body : String(req.body?.csvText || '');
      const verifiedBy = req.body?.verifiedBy || 'BANK_CSV_RECONCILED';

      if (!csvText || !csvText.trim()) {
        return reply.status(400).send({ success: false, error: 'Bank statement CSV content is required.' });
      }

      const summary = await reconcileBankCsvRows(query, csvText, verifiedBy, fastify.log);
      return {
        success: true,
        message: `Processed ${summary.validCreditRows} bank credit row(s): ${summary.matchedCount} payment(s) auto-verified, ${summary.unmatchedCount} unmatched.`,
        ...summary
      };
    } catch (err) {
      fastify.log.error('Bank CSV reconciliation error:', err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 4. Server-Side Regex & UTR Detection for screenshots
  fastify.post('/payments/ocr-parse', async (req, reply) => {
    try {
      const { text = '', rawOcr = '' } = req.body || {};
      const fullText = (text + ' ' + rawOcr).trim();

      if (!fullText) {
        return reply.status(400).send({ success: false, error: 'Text or OCR content is required' });
      }

      // 12-digit Indian UTR regex patterns
      const utrPatterns = [
        /(?:UPI\s*Ref(?:\s*No)?|UTR(?:\s*No)?|Ref\s*No|Transaction\s*ID|Txn\s*ID|Google\s*Transaction\s*ID)[\s:=]*([0-9]{12})/i,
        /UPI\s*transaction\s*ID\s*[:=]?\s*([0-9]{12})/i,
        /\b([0-9]{12})\b/
      ];

      let detectedUtr = null;
      for (const pattern of utrPatterns) {
        const m = fullText.match(pattern);
        if (m && m[1]) {
          detectedUtr = m[1];
          break;
        } else if (m && m[0] && m[0].length === 12 && /^\d+$/.test(m[0])) {
          detectedUtr = m[0];
          break;
        }
      }

      // Amount extraction regex
      const amountMatch = fullText.match(/(?:₹|INR|Rs\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i) || fullText.match(/\b([0-9]{2,5}(?:\.[0-9]{2})?)\b/);
      const detectedAmount = amountMatch ? amountMatch[1].replace(/,/g, '') : null;

      return {
        success: true,
        detectedUtr,
        detectedAmount,
        hasUtr: Boolean(detectedUtr)
      };
    } catch (err) {
      fastify.log.error('OCR parse error:', err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 5. Admin: List Pending QR Verifications
  fastify.get('/admin/payments/pending-verifications', async (req, reply) => {
    try {
      const res = await query(`
        SELECT 
          p.id, p.booking_id, p.amount_total, p.customer_utr, p.ocr_detected_utr,
          p.screenshot_url, p.verification_status, p.created_at, p.verified_at, p.verified_by,
          p.rejection_reason, p.tech_payout_amount, p.platform_commission,
          b.customer_name, b.customer_phone, b.status as booking_status, b.locality,
          t.full_name as technician_name, t.phone as technician_phone
        FROM payments p
        LEFT JOIN bookings b ON p.booking_id = b.id
        LEFT JOIN technicians t ON b.technician_id = t.id
        WHERE p.payment_method = 'DYNAMIC_UPI_QR'
        ORDER BY p.created_at DESC
        LIMIT 100;
      `);

      return {
        success: true,
        count: res.rows.length,
        pendingCount: res.rows.filter(r => r.verification_status === 'pending' || r.verification_status === 'tech_confirmed').length,
        payments: res.rows
      };
    } catch (err) {
      fastify.log.error('Admin pending verifications error:', err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 6. Admin: 1-Click Verify and Confirm Payment
  fastify.post('/admin/payments/:id/verify', async (req, reply) => {
    try {
      const { id } = req.params;
      const { verifiedBy = 'Salem Operations Admin', adminNotes = '' } = req.body || {};

      const pRes = await query('SELECT * FROM payments WHERE id::text = $1 OR customer_utr = $1', [id]);
      if (pRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Payment not found' });
      }
      const payment = pRes.rows[0];

      const updateRes = await query(`
        UPDATE payments
        SET verification_status = 'verified',
            verified_by = $1,
            verified_at = NOW(),
            status = '._held'
        WHERE id = $2
        RETURNING *;
      `, [verifiedBy, payment.id]);

      // Audit log
      try {
        await query(`
          INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
          VALUES ($1, 'MANUAL_QR_PAYMENT_VERIFIED', $2, 'admin', $3)
        `, [
          payment.booking_id,
          verifiedBy,
          JSON.stringify({ paymentId: payment.id, customerUtr: payment.customer_utr, amount: payment.amount_total, adminNotes })
        ]);
      } catch (aErr) { }

      return {
        success: true,
        message: `Payment with UTR ${payment.customer_utr} verified successfully. . confirmed.`,
        payment: updateRes.rows[0]
      };
    } catch (err) {
      fastify.log.error('Payment verify error:', err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 7. Admin: Flag / Reject Payment Proof
  fastify.post('/admin/payments/:id/reject', async (req, reply) => {
    try {
      const { id } = req.params;
      const { rejectionReason = 'Invalid UTR or screenshot does not match bank record', verifiedBy = 'Salem Operations Admin' } = req.body || {};

      const pRes = await query('SELECT * FROM payments WHERE id::text = $1', [id]);
      if (pRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Payment not found' });
      }
      const payment = pRes.rows[0];

      const updateRes = await query(`
        UPDATE payments
        SET verification_status = 'rejected',
            rejection_reason = $1,
            verified_by = $2,
            verified_at = NOW()
        WHERE id = $3
        RETURNING *;
      `, [rejectionReason, verifiedBy, payment.id]);

      try {
        await query(`
          INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
          VALUES ($1, 'MANUAL_QR_PAYMENT_REJECTED', $2, 'admin', $3)
        `, [
          payment.booking_id,
          verifiedBy,
          JSON.stringify({ paymentId: payment.id, rejectionReason })
        ]);
      } catch (aErr) { }

      return {
        success: true,
        message: 'Payment flagged as rejected.',
        payment: updateRes.rows[0]
      };
    } catch (err) {
      fastify.log.error('Payment reject error:', err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });
}

module.exports = paymentsRoutes;
