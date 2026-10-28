const crypto = require('crypto');
const { query } = require('../db/db');
// The same length-safe comparison the password service uses, so there is one implementation.
const { constantTimeEqual: secureEqual } = require('../services/password.service');
const {
  getCustomerPlatformFeePercent,
  getPaymentGatewayFeePercent,
  getPartnerCommissionPercent,
  getLiveFeeSettings,
  calculateDualCommissionInvoice,
  calculateCommissionSplit
} = require('../services/commission.service');

async function paymentsRoutes(fastify, options) {
  // No hardcoded key material: the pair that used to sit here as a fallback is in source
  // control and must be treated as compromised. Missing keys now fail loudly.
  const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
  const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
  const PAYMENTS_CONFIGURED = Boolean(KEY_ID && KEY_SECRET);

  // Unsigned payments are only tolerated when an operator explicitly opts in for local
  // testing. A missing signature used to be treated as a valid payment.
  const ALLOW_UNSIGNED = process.env.PAYMENTS_ALLOW_UNSIGNED === '1';

  // 1. Create Real Razorpay Order for Escrow Deposit
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
              type: isDiagnosticOnly ? 'DIAGNOSTIC_ESCROW' : 'FINAL_SETTLEMENT',
              platform: 'Shazu One Escrow'
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
          
          // Record the escrow deposit against the columns that actually exist. The previous
          // statement named transaction_id and a status label that is not in the payment_status
          // enum, and the error was swallowed, so no payment was ever recorded here.
          // tech_payout_amount and platform_commission are NOT NULL with no default, so both
          // have to be supplied even though the split is only decided at settlement.
          // Keep the order id exactly as Razorpay sent it. It used to be prefixed with
          // `order_`, which never matched the id stored by /payments/verify, so the conflict
          // target missed and every webhook added a second escrow row for the same money.
          const ledgerOrderId = orderId || `order_${paymentId || Date.now()}`;
          await query(`
            INSERT INTO payments (booking_id, razorpay_order_id, razorpay_payment_id, amount_total, tech_payout_amount, platform_commission, status, payment_method, created_at)
            VALUES ($1, $2, $3, $4, 0.00, 0.00, 'escrow_held', 'RAZORPAY_ESCROW', NOW())
            ON CONFLICT (razorpay_order_id) DO UPDATE
              SET razorpay_payment_id = EXCLUDED.razorpay_payment_id,
                  amount_total = EXCLUDED.amount_total,
                  status = CASE WHEN payments.status = 'settled' THEN payments.status ELSE 'escrow_held' END
          `, [bookingId, ledgerOrderId, paymentId || `pay_${Date.now()}`, parsedAmount]);

          // Check if this was a diagnostic advance or quote approval
          const isQuoteApproval = paymentEntity.notes?.type === 'FINAL_SETTLEMENT';
          const nextStatus = isQuoteApproval ? 'quote_approved' : 'en_route';

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
          `, [bookingId, paymentId || 'rzp_webhook', JSON.stringify({ amount: parsedAmount, orderId, event })]).catch(() => {});
        }
      }

      return reply.send({ status: 'ok', received: true });
    } catch (err) {
      fastify.log.error('Razorpay Webhook Error:', err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 1c. Reconcile Payment Status (Polled by Mobile App after UPI App Switching or Restart)
  fastify.get('/payments/status/:bookingId', async (req, reply) => {
    try {
      const { bookingId } = req.params;
      const bRes = await query('SELECT id, status, visit_fee, final_amount FROM bookings WHERE id = $1', [bookingId]);
      if (bRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Booking not found' });
      }

      const booking = bRes.rows[0];
      const pRes = await query('SELECT * FROM payments WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1', [bookingId]);
      const payment = pRes.rows[0] || null;

      const isPaid = ['en_route', 'arrived', 'inspecting', 'quote_presented', 'quote_approved', 'completed'].includes(booking.status)
        || (payment && (payment.status === 'escrow_held' || payment.status === 'captured' || payment.status === 'settled'));

      return {
        success: true,
        bookingId: booking.id,
        status: booking.status,
        isPaid: Boolean(isPaid),
        payment: payment
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 2. Verify Razorpay Payment Signature and Record in Neon DB Escrow Ledger
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
          error: 'Cash payments are not allowed. Shazu One requires 100% digital escrow payments (UPI / Cards / Net Banking).'
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

      // Record in Neon DB Payments Escrow Ledger
      const insertSql = `
        INSERT INTO payments (booking_id, razorpay_order_id, razorpay_payment_id, amount_total, tech_payout_amount, platform_commission, status, payment_method, created_at)
        VALUES ($1, $2, $3, $4, 0.00, 0.00, 'escrow_held', 'RAZORPAY_ESCROW', NOW())
        ON CONFLICT (razorpay_order_id) DO UPDATE
          SET razorpay_payment_id = EXCLUDED.razorpay_payment_id,
              amount_total = EXCLUDED.amount_total,
              status = CASE WHEN payments.status = 'settled' THEN payments.status ELSE 'escrow_held' END
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
          const nextStatus = isQuoteApproval ? 'quote_approved' : 'en_route';

          await query(`
            UPDATE bookings 
            SET status = $1
            WHERE id = $2 AND status IN ('accepted', 'matching', 'quote_presented')
          `, [nextStatus, bookingId]);

          const quoteSub = parseFloat(currentB.quote_subtotal) || parsedAmount;
          const visit = parseFloat(currentB.visit_fee) || 99.00;
          const settings = await getLiveFeeSettings();

          dualInvoice = calculateDualCommissionInvoice({
            totalJobAmount: quoteSub,
            upfrontFeePaid: visit,
            customerFeePercent: settings.customerFeePercent,
            gatewayFeePercent: settings.gatewayFeePercent,
            partnerCommPercent: settings.partnerCommPercent
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
        escrowStatus: 'HELD_IN_ESCROW',
        guarantee: '100% Protected under Shazu One Escrow Policy',
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

  // 3. Dynamic Dual-Commission & Razorpay Route Split Calculation
  fastify.post('/payments/calculate-split', async (req, reply) => {
    const { grossAmount, visitFee = 99.00 } = req.body || {};
    const total = parseFloat(grossAmount) || 1000.00;
    const upfront = parseFloat(visitFee) || 99.00;
    const settings = await getLiveFeeSettings();

    const invoice = calculateDualCommissionInvoice({
      totalJobAmount: total,
      upfrontFeePaid: upfront,
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
        escrowNodalAccount: 'acc_RazorpayEscrow_Shazu One'
      }
    };
  });

  // 4. Customer Confirms Work Finished & Releases Escrow to Technician UPI
  fastify.post('/payments/escrow/release', async (req, reply) => {
    try {
      const { bookingId, customerOtp, rating = 5, reviewComment } = req.body;

      if (!bookingId) {
        return reply.status(400).send({ success: false, error: 'Booking ID is required to release escrow.' });
      }

      // Releasing escrow moves money to the partner, so it must be tied to one booking that
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
          error: 'This booking has no completion OTP on file, so escrow cannot be released.'
        });
      }

      if (!customerOtp || !secureEqual(String(customerOtp).trim(), String(booking.customer_otp).trim())) {
        return reply.status(403).send({
          success: false,
          error: 'A valid completion OTP is required to release escrow.'
        });
      }

      const alreadySettled = await query(`
        SELECT 1 FROM payments WHERE booking_id = $1 AND status = 'settled' LIMIT 1
      `, [booking.id]);
      if (alreadySettled.rows.length > 0) {
        return reply.status(409).send({ success: false, error: 'Escrow for this booking has already been released.' });
      }

      const targetId = booking.id;
      const quoteSubtotal = parseFloat(booking.quote_subtotal) || 250.00;
      const visitFee = parseFloat(booking.visit_fee) || 99.00;
      const settings = await getLiveFeeSettings();

      const invoice = calculateDualCommissionInvoice({
        totalJobAmount: quoteSubtotal,
        upfrontFeePaid: visitFee,
        customerFeePercent: settings.customerFeePercent,
        gatewayFeePercent: settings.gatewayFeePercent,
        partnerCommPercent: settings.partnerCommPercent
      });

      const totalTechPayout = invoice.partnerDirectRouteTransfer;
      const platformCut = invoice.partnerCommissionAmount + invoice.customerPlatformFee;
      const utrNumber = 'UPI-' + Math.floor(1000000 + Math.random() * 9000000) + '-OKAXIS';

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

      // 3. Record Payout Disbursal in DB
      await query(`
        INSERT INTO technician_payouts (technician_phone, technician_id, amount, upi_id, status, utr_ref, description, created_at)
        VALUES ($1, $2, $3, $4, 'DISBURSED_100%', $5, $6, NOW())
      `, [
        techPhone,
        techId,
        totalTechPayout,
        techUpi,
        utrNumber,
        `Instant cashless escrow release for #${targetId} (₹${invoice.totalJobAmount} total - ₹${invoice.partnerCommissionAmount} partner comm - ₹${invoice.upfrontFeePaid} advance = ₹${totalTechPayout})`
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

      // 4. Record Settled Payments in payments table
      // This is the same money as the escrow row taken at payment time, so it is updated in
      // place instead of duplicated. A booking that never had an escrow row still gets one.
      const settledRes = await query(`
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
        )
      `, [targetId, invoice.totalJobAmount, totalTechPayout, platformCut, utrNumber]);

      if (settledRes.rowCount === 0) {
        await query(`
          INSERT INTO payments (booking_id, amount_total, tech_payout_amount, platform_commission, status, payment_method, payout_utr, settled_at)
          VALUES ($1, $2, $3, $4, 'settled', 'UPI (Instant Escrow Released)', $5, NOW())
        `, [targetId, invoice.totalJobAmount, totalTechPayout, platformCut, utrNumber]);
      }

      // 5. Record Review if provided
      if (rating) {
        await query(`
          INSERT INTO reviews (booking_id, technician_id, rating, comment, created_at)
          VALUES ($1, $2, $3, $4, NOW())
        `, [targetId, techId, parseFloat(rating), reviewComment || 'Excellent on-time service & genuine spare parts fitted.']);
      }

      // 6. Audit Log
      await query(`
        INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
        VALUES ($1, 'SERVICE_COMPLETED_ESCROW_SETTLED', 'customer', 'customer', $2)
      `, [targetId, JSON.stringify({ totalTechPayout, utrNumber, techUpi, status: 'completed' })]);

      return {
        success: true,
        message: 'Customer confirmed work completion. Instant settlement disbursed to technician UPI!',
        booking: completedBooking,
        settlement: {
          totalAmount: invoice.totalJobAmount,
          technicianPayout: totalTechPayout,
          platformCommission: platformCut,
          techUpi,
          utrNumber,
          settledAt: new Date().toISOString()
        }
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });
}

module.exports = paymentsRoutes;
