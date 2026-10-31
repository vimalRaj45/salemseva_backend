const { query } = require('../db/db');
const pushService = require('../services/pushNotification.service');
const { getPlatformCommissionPercent, calculateCommissionSplit } = require('../services/commission.service');

async function adminRoutes(fastify, options) {
  // 1. Central Ops Dashboard Overview
  fastify.get('/admin/overview', async (req, reply) => {
    try {
      const [bookingsCount, onlineTechs, paymentsSum, reviewsCount, recentBookings, techsList] = await Promise.all([
        query(`SELECT status, count(*) as count FROM bookings GROUP BY status`),
        query(`SELECT count(*) as count FROM technicians WHERE is_online = TRUE`),
        query(`SELECT COALESCE(SUM(amount_total), 0) as total_revenue, COALESCE(SUM(tech_payout_amount), 0) as total_payouts, COALESCE(SUM(platform_commission), 0) as total_commission FROM payments`),
        query(`SELECT count(*) as count FROM reviews WHERE is_below_3_star = TRUE`),
        query(`
          SELECT 
            b.*,
            t.full_name as technician_name,
            t.phone as technician_phone,
            COALESCE(
              NULLIF(ROUND((SELECT AVG(r.rating)::numeric FROM reviews r WHERE r.technician_id = t.id), 1), 0),
              NULLIF(t.rating_avg, 0),
              CASE WHEN (SELECT count(*)::int FROM bookings b2 WHERE b2.technician_id = t.id AND b2.status = 'completed') > 0 THEN 5.0 ELSE 0 END
            ) as technician_rating,
            t.primary_trade as technician_trade
          FROM bookings b
          LEFT JOIN technicians t ON b.technician_id = t.id
          ORDER BY b.created_at DESC
          LIMIT 250
        `),
        query(`
          SELECT 
            t.id, t.full_name, t.phone, t.primary_trade, t.secondary_trades, t.years_experience,
            COALESCE(
              NULLIF(ROUND((SELECT AVG(r.rating)::numeric FROM reviews r WHERE r.technician_id = t.id), 1), 0),
              NULLIF(t.rating_avg, 0),
              CASE WHEN (SELECT count(*)::int FROM bookings b WHERE b.technician_id = t.id AND b.status = 'completed') > 0 THEN 5.0 ELSE 0 END
            ) as rating_avg,
            GREATEST(
              COALESCE(t.rating_count, 0),
              (SELECT count(*)::int FROM reviews r WHERE r.technician_id = t.id)
            ) as rating_count,
            GREATEST(
              COALESCE(t.jobs_completed_count, 0),
              (SELECT count(*)::int FROM bookings b WHERE b.technician_id = t.id AND b.status = 'completed')
            ) as jobs_completed_count,
            t.is_online, 
            t.is_kyc_verified, t.current_lat, t.current_lng, t.star_points,
            t.aadhaar_card_url, t.aadhaar_uploaded_at, t.aadhaar_number, t.upi_vpa,
            t.assigned_localities, t.created_at,
            t.is_blocked, t.block_reason, t.blocked_at,
            (
              SELECT count(*) 
              FROM bookings b 
              WHERE b.technician_id = t.id 
                AND b.status IN ('accepted', 'en_route', 'arrived', 'in_progress', 'quote_presented')
            ) as active_job_count
          FROM technicians t 
          ORDER BY (CASE WHEN t.is_kyc_verified = FALSE THEN 0 ELSE 1 END), t.created_at DESC NULLS LAST, t.is_online DESC, t.rating_avg DESC
        `)
      ]);

      const statusMap = {};
      bookingsCount.rows.forEach(r => {
        statusMap[r.status] = parseInt(r.count, 10);
      });

      return {
        success: true,
        metrics: {
          activeBookings: (statusMap['matching'] || 0) + (statusMap['accepted'] || 0) + (statusMap['in_progress'] || 0) + (statusMap['arrived'] || 0) + (statusMap['en_route'] || 0) + (statusMap['quote_presented'] || 0),
          totalCompleted: statusMap['completed'] || 0,
          onlineTechnicians: parseInt(onlineTechs.rows[0]?.count || 0, 10),
          disputesPending: parseInt(reviewsCount.rows[0]?.count || 0, 10),
          financials: {
            totalRevenue: parseFloat(paymentsSum.rows[0]?.total_revenue || 0),
            techPayouts: parseFloat(paymentsSum.rows[0]?.total_payouts || 0),
            platformCommission: parseFloat(paymentsSum.rows[0]?.total_commission || 0)
          }
        },
        recentBookings: recentBookings.rows,
        technicians: techsList.rows
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 2. Technicians list with advanced filtering
  fastify.get('/admin/technicians', async (req, reply) => {
    try {
      const { trade, status, is_kyc } = req.query;
      let sql = `
        SELECT 
          t.*,
          COALESCE(
            NULLIF(ROUND((SELECT AVG(r.rating)::numeric FROM reviews r WHERE r.technician_id = t.id), 1), 0),
            NULLIF(t.rating_avg, 0),
            CASE WHEN (SELECT count(*)::int FROM bookings b WHERE b.technician_id = t.id AND b.status = 'completed') > 0 THEN 5.0 ELSE 0 END
          ) as rating_avg,
          GREATEST(
            COALESCE(t.rating_count, 0),
            (SELECT count(*)::int FROM reviews r WHERE r.technician_id = t.id)
          ) as rating_count,
          GREATEST(
            COALESCE(t.jobs_completed_count, 0),
            (SELECT count(*)::int FROM bookings b WHERE b.technician_id = t.id AND b.status = 'completed')
          ) as jobs_completed_count,
          (
            SELECT count(*) 
            FROM bookings b 
            WHERE b.technician_id = t.id 
              AND b.status IN ('accepted', 'en_route', 'arrived', 'in_progress', 'quote_presented')
          ) as active_job_count,
          COALESCE(t.daily_job_capacity, 4) as daily_job_capacity,
          (
            SELECT count(*)::int 
            FROM bookings b 
            WHERE b.technician_id = t.id 
              AND (b.created_at >= CURRENT_DATE OR b.scheduled_slot LIKE '%' || TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') || '%')
              AND b.status != 'cancelled'
          ) as today_jobs_count
        FROM technicians t
        WHERE 1=1
      `;
      const params = [];

      if (trade && trade !== 'all') {
        params.push(trade);
        sql += ` AND (t.primary_trade = $${params.length} OR (t.secondary_trades IS NOT NULL AND $${params.length} = ANY(t.secondary_trades)))`;
      }
      if (status === 'online') {
        sql += ` AND t.is_online = TRUE`;
      } else if (status === 'offline') {
        sql += ` AND t.is_online = FALSE`;
      }
      if (is_kyc === 'true') {
        sql += ` AND t.is_kyc_verified = TRUE`;
      } else if (is_kyc === 'false') {
        sql += ` AND t.is_kyc_verified = FALSE`;
      }

      sql += ` ORDER BY (CASE WHEN t.is_kyc_verified = FALSE THEN 0 ELSE 1 END), t.created_at DESC NULLS LAST, t.is_online DESC, t.rating_avg DESC`;

      const result = await query(sql, params);
      return { success: true, count: result.rows.length, technicians: result.rows };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 3. Toggle Technician Online/Offline Status (Admin override)
  fastify.post('/admin/technicians/:id/toggle-online', async (req, reply) => {
    try {
      const { id } = req.params;
      const res = await query(`
        UPDATE technicians 
        SET is_online = NOT is_online 
        WHERE id = $1 
        RETURNING *
      `, [id]);

      if (res.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Technician not found' });
      }

      return { success: true, technician: res.rows[0] };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 4. Verify / Approve or Reject Technician KYC
  fastify.post('/admin/technicians/:id/verify-kyc', async (req, reply) => {
    try {
      const { id } = req.params;
      const { action = 'approve', reason = '' } = req.body || {};
      const isApproved = action === 'approve';

      const res = await query(`
        UPDATE technicians 
        SET is_kyc_verified = $1,
            kyc_verified_at = CASE WHEN $1 = TRUE THEN NOW() ELSE NULL END
        WHERE id = $2 
        RETURNING *
      `, [isApproved, id]);

      if (res.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Technician not found' });
      }

      const tech = res.rows[0];

      // Audit Log
      try {
        await query(`
          INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
          VALUES ('TECH-KYC-' || $1, $2, 'admin_hq', 'admin', $3)
        `, [
          tech.phone || id,
          isApproved ? 'TECH_KYC_APPROVED' : 'TECH_KYC_REJECTED',
          JSON.stringify({
            technicianId: id,
            technicianName: tech.full_name,
            action,
            reason: reason || (isApproved ? 'Aadhaar document verified by Shazu One Central Ops' : 'Aadhaar document rejected / resubmission requested'),
            timestamp: new Date().toISOString()
          })
        ]);
      } catch (auditErr) {}

      return { 
        success: true, 
        message: isApproved 
          ? `KYC verified for ${tech.full_name}. Partner is now certified to accept doorstep jobs.`
          : `KYC rejected for ${tech.full_name}. Partner duty access remains locked until re-verification.`, 
        technician: tech 
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 4b. Toggle Block/Unblock for Technician
  fastify.post('/admin/technicians/:id/toggle-block', async (req, reply) => {
    try {
      const { id } = req.params;
      const { isBlocked = true, reason = '' } = req.body || {};

      const res = await query(`
        UPDATE technicians 
        SET is_blocked = $1,
            block_reason = CASE WHEN $1 = TRUE THEN $2 ELSE NULL END,
            blocked_at = CASE WHEN $1 = TRUE THEN NOW() ELSE NULL END,
            is_online = CASE WHEN $1 = TRUE THEN FALSE ELSE is_online END
        WHERE id = $3 
        RETURNING *
      `, [isBlocked, reason || 'Administrative block by Shazu One Central Operations', id]);

      if (res.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Technician not found' });
      }

      const tech = res.rows[0];

      // Audit Log
      try {
        await query(`
          INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
          VALUES ('TECH-BLOCK-' || $1, $2, 'admin_hq', 'admin', $3)
        `, [
          tech.phone || id,
          isBlocked ? 'TECHNICIAN_BLOCKED' : 'TECHNICIAN_UNBLOCKED',
          JSON.stringify({
            technicianId: id,
            technicianName: tech.full_name,
            reason: reason || (isBlocked ? 'Account blocked by admin' : 'Account restored by admin'),
            timestamp: new Date().toISOString()
          })
        ]);
      } catch (auditErr) {}

      return {
        success: true,
        message: isBlocked
          ? `Technician ${tech.full_name} has been suspended. They cannot go online or receive bookings.`
          : `Technician ${tech.full_name} has been unblocked.`,
        technician: tech
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 4c. Toggle Block/Unblock for Customer
  fastify.post('/admin/customers/:phone/toggle-block', async (req, reply) => {
    try {
      const { phone } = req.params;
      const { isBlocked = true, reason = '' } = req.body || {};
      const cleanPhone = (phone.startsWith('+91') ? phone : `+91${phone}`).replace(/[\s\-]/g, '');

      let res = await query(`
        UPDATE users 
        SET is_blocked = $1,
            block_reason = CASE WHEN $1 = TRUE THEN $2 ELSE NULL END,
            blocked_at = CASE WHEN $1 = TRUE THEN NOW() ELSE NULL END
        WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = RIGHT(REGEXP_REPLACE($3, '\\D', '', 'g'), 10)
        RETURNING *
      `, [isBlocked, reason || 'Administrative block by Shazu One Central Operations', cleanPhone]);

      if (res.rows.length === 0) {
        res = await query(`
          INSERT INTO users (phone, full_name, role, is_blocked, block_reason, blocked_at)
          VALUES ($1, 'Customer ' || RIGHT($1, 4), 'customer', $2, $3, NOW())
          ON CONFLICT (phone) DO UPDATE 
          SET is_blocked = EXCLUDED.is_blocked, block_reason = EXCLUDED.block_reason, blocked_at = EXCLUDED.blocked_at
          RETURNING *
        `, [cleanPhone, isBlocked, reason]);
      }

      const user = res.rows[0];

      // Audit Log
      try {
        await query(`
          INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
          VALUES ('USER-BLOCK-' || $1, $2, 'admin_hq', 'admin', $3)
        `, [
          cleanPhone,
          isBlocked ? 'CUSTOMER_BLOCKED' : 'CUSTOMER_UNBLOCKED',
          JSON.stringify({
            phone: cleanPhone,
            reason: reason || (isBlocked ? 'Account blocked by admin' : 'Account restored by admin'),
            timestamp: new Date().toISOString()
          })
        ]);
      } catch (auditErr) {}

      return {
        success: true,
        message: isBlocked
          ? `Customer (${cleanPhone}) has been blocked. They cannot place new bookings.`
          : `Customer (${cleanPhone}) has been unblocked.`,
        customer: user
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 5. Customer 360 Analytics & Directory
  fastify.get('/admin/customers', async (req, reply) => {
    try {
      const result = await query(`
        WITH people AS (
          SELECT
            RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) as phone_key,
            MAX(phone) as phone,
            MAX(full_name) as full_name,
            MAX(locality) as locality,
            BOOL_OR(COALESCE(is_blocked, FALSE)) as is_blocked,
            MAX(block_reason) as block_reason,
            MAX(blocked_at) as blocked_at
          FROM users
          WHERE role != 'admin'
          GROUP BY 1
        ),
        orders AS (
          SELECT
            RIGHT(REGEXP_REPLACE(customer_phone, '\\D', '', 'g'), 10) as phone_key,
            MAX(customer_name) as customer_name,
            MAX(locality) as locality,
            MAX(service_address) as latest_address,
            COUNT(*) as total_orders,
            COALESCE(SUM(final_amount), 0) as total_spent,
            MAX(created_at) as last_order_date,
            COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_orders,
            COUNT(CASE WHEN status IN ('matching', 'accepted', 'en_route', 'arrived', 'in_progress', 'quote_presented') THEN 1 END) as active_orders
          FROM bookings
          WHERE RIGHT(REGEXP_REPLACE(customer_phone, '\\D', '', 'g'), 10) <> ''
          GROUP BY 1
        )
        SELECT
          COALESCE(p.phone, o.phone_key) as customer_phone,
          COALESCE(o.customer_name, p.full_name, 'Salem Customer') as customer_name,
          COALESCE(o.locality, p.locality, 'Fairlands') as locality,
          o.latest_address,
          COALESCE(o.total_orders, 0) as total_orders,
          COALESCE(o.total_spent, 0) as total_spent,
          o.last_order_date,
          COALESCE(o.completed_orders, 0) as completed_orders,
          COALESCE(o.active_orders, 0) as active_orders,
          COALESCE(p.is_blocked, FALSE) as is_blocked,
          p.block_reason,
          p.blocked_at
        FROM people p
        FULL OUTER JOIN orders o ON p.phone_key = o.phone_key
        WHERE COALESCE(p.phone_key, o.phone_key) <> ''
        ORDER BY total_orders DESC, last_order_date DESC NULLS LAST
      `);

      return {
        success: true,
        count: result.rows.length,
        customers: result.rows
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 6. Specific Customer Order History & Service Timeline
  fastify.get('/admin/customers/:phone/history', async (req, reply) => {
    try {
      const { phone } = req.params;
      const result = await query(`
        SELECT 
          b.*,
          t.full_name as technician_name,
          t.phone as technician_phone,
          t.primary_trade,
          t.rating_avg as technician_rating
        FROM bookings b
        LEFT JOIN technicians t ON b.technician_id = t.id
        WHERE RIGHT(REGEXP_REPLACE(b.customer_phone, '\\D', '', 'g'), 10) = RIGHT(REGEXP_REPLACE($1, '\\D', '', 'g'), 10)
        ORDER BY b.created_at DESC
      `, [phone]);

      return {
        success: true,
        count: result.rows.length,
        history: result.rows
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 7. Specific Technician Service History & Performance Dossier
  fastify.get('/admin/technicians/:id/dossier', async (req, reply) => {
    try {
      const { id } = req.params;
      const [techRes, jobsRes, earningsRes] = await Promise.all([
        query(`
          SELECT 
            t.*,
            COALESCE(
              NULLIF(ROUND((SELECT AVG(r.rating)::numeric FROM reviews r WHERE r.technician_id = t.id), 1), 0),
              NULLIF(t.rating_avg, 0),
              CASE WHEN (SELECT count(*)::int FROM bookings b WHERE b.technician_id = t.id AND b.status = 'completed') > 0 THEN 5.0 ELSE 0 END
            ) as rating_avg,
            GREATEST(
              COALESCE(t.rating_count, 0),
              (SELECT count(*)::int FROM reviews r WHERE r.technician_id = t.id)
            ) as rating_count,
            GREATEST(
              COALESCE(t.jobs_completed_count, 0),
              (SELECT count(*)::int FROM bookings b WHERE b.technician_id = t.id AND b.status = 'completed')
            ) as jobs_completed_count
          FROM technicians t
          WHERE t.id = $1
        `, [id]),
        query(`
          SELECT 
            b.*,
            p.tech_payout_amount,
            p.status as payment_status
          FROM bookings b
          LEFT JOIN payments p ON b.id = p.booking_id
          WHERE b.technician_id = $1
          ORDER BY b.created_at DESC
        `, [id]),
        query(`
          SELECT 
            COALESCE(SUM(CASE WHEN b.status = 'completed' THEN COALESCE(NULLIF(p.tech_payout_amount, 0), b.final_amount * 0.95, 0) ELSE 0 END), 0) as lifetime_earnings,
            COALESCE(SUM(COALESCE(p.amount_total, b.final_amount, 0)), 0) as gross_job_volume
          FROM bookings b
          LEFT JOIN payments p ON p.booking_id = b.id
          WHERE b.technician_id = $1
        `, [id])
      ]);

      if (techRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Technician not found' });
      }

      return {
        success: true,
        technician: techRes.rows[0],
        jobs: jobsRes.rows,
        financials: {
          lifetimeEarnings: parseFloat(earningsRes.rows[0]?.lifetime_earnings || 0),
          grossJobVolume: parseFloat(earningsRes.rows[0]?.gross_job_volume || 0)
        }
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 8. Audit Logs & Traceability
  fastify.get('/admin/traceability', async (req, reply) => {
    try {
      const result = await query(`
        SELECT * FROM audit_logs 
        ORDER BY created_at DESC 
        LIMIT 50
      `);

      return {
        success: true,
        count: result.rows.length,
        logs: result.rows
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 9. Settlements Ledger & Razorpay Payouts
  fastify.get('/admin/settlements', async (req, reply) => {
    try {
      const result = await query(`
        SELECT p.*, b.customer_name, b.service_id, b.locality, t.full_name as technician_name, t.upi_vpa
        FROM payments p
        LEFT JOIN bookings b ON p.booking_id = b.id
        LEFT JOIN technicians t ON b.technician_id = t.id
        ORDER BY p.created_at DESC
        LIMIT 50
      `);

      return {
        success: true,
        count: result.rows.length,
        settlements: result.rows
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 9.1 End-to-End Financial Ledger & Revenue Tracking with Region & Date Filters
  fastify.get('/admin/financials/ledger', async (req, reply) => {
    try {
      const { locality, startDate, endDate, serviceId, status } = req.query || {};

      let whereConditions = [];
      let params = [];

      if (locality && locality !== 'all') {
        params.push(`%${locality}%`);
        whereConditions.push(`(b.locality ILIKE $${params.length} OR b.service_address ILIKE $${params.length})`);
      }

      if (serviceId && serviceId !== 'all') {
        params.push(serviceId);
        whereConditions.push(`b.service_id = $${params.length}`);
      }

      if (startDate) {
        params.push(startDate);
        whereConditions.push(`b.created_at >= $${params.length}::timestamp`);
      }

      if (endDate) {
        params.push(`${endDate} 23:59:59`);
        whereConditions.push(`b.created_at <= $${params.length}::timestamp`);
      }

      if (status && status !== 'all') {
        params.push(status);
        whereConditions.push(`b.status = $${params.length}`);
      }

      const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

      const sql = `
        SELECT 
          b.id as booking_id,
          b.created_at,
          b.status as booking_status,
          b.customer_name,
          b.customer_phone,
          b.locality,
          b.service_id,
          b.final_amount,
          b.visit_fee,
          b.quote_subtotal,
          b.booking_type,
          b.scheduled_slot,
          b.cancelled_at,
          b.cancellation_reason,
          t.full_name as technician_name,
          t.phone as technician_phone,
          t.primary_trade as technician_trade,
          t.upi_vpa as technician_upi,
          p.id as payment_id,
          p.razorpay_payment_id,
          p.payment_method,
          p.status as payment_status,
          p.amount_total as payment_amount,
          p.tech_payout_amount as payment_tech_payout,
          p.platform_commission as payment_platform_commission
        FROM bookings b
        LEFT JOIN technicians t ON b.technician_id = t.id
        LEFT JOIN LATERAL (
          SELECT * FROM payments WHERE booking_id = b.id ORDER BY created_at DESC LIMIT 1
        ) p ON true
        ${whereClause}
        ORDER BY b.created_at DESC
        LIMIT 200
      `;

      const result = await query(sql, params);
      const rows = result.rows || [];

      // Calculate end-to-end financial aggregations
      let totalGross = 0;
      let totalRazorpayFee = 0;
      let totalTechPayout = 0;
      let totalPlatformCut = 0;
      let totalCustomerRefunds = 0;
      let completedCount = 0;

      const regionMap = {};
      const dailyMap = {};

      const transactions = rows.map(r => {
        const visitFee = parseFloat(r.visit_fee) || 49.00;
        const quoteSubtotal = parseFloat(r.quote_subtotal) || 0.00;
        const isCancelled = r.booking_status === 'cancelled';
        const isCompleted = r.booking_status === 'completed';
        const isPaid = ['en_route', 'arrived', 'inspecting', 'quote_presented', 'quote_approved', 'completed'].includes(r.booking_status) || (isCancelled && r.final_amount > 0);

        // Gross inflow from customer
        let gross = parseFloat(r.payment_amount) || parseFloat(r.final_amount) || (isPaid ? (visitFee + quoteSubtotal) : visitFee);
        if (isCancelled && !r.payment_amount && !r.final_amount) {
          gross = 0;
        }

        // Razorpay Gateway Fee: 2% + 18% GST on the fee = 2.36% of gross transaction
        const razorpayFee = gross > 0 ? parseFloat((gross * 0.0236).toFixed(2)) : 0.00;

        // Technician Payout: 100% of visit travel fee + 95% of quote labor
        let techPayout = 0;
        if (isCompleted) {
          techPayout = parseFloat(r.payment_tech_payout) || parseFloat((visitFee + quoteSubtotal * 0.95).toFixed(2));
        } else if (isPaid && !isCancelled) {
          techPayout = visitFee; // Visit fee travel allocation
        } else if (isCancelled && r.technician_name) {
          techPayout = visitFee; // Travel disbursal if cancelled after technician dispatch
        }

        // Platform Commission: 5% of quote labor
        let platformCut = 0;
        if (isCompleted) {
          platformCut = parseFloat(r.payment_platform_commission) || parseFloat((quoteSubtotal * 0.05).toFixed(2));
        }

        // Customer Refund
        let refund = 0;
        if (isCancelled && (r.cancellation_reason?.includes('customer') || !r.technician_name)) {
          refund = gross; // 100% refunded if cancelled before technician dispatch
        }

        // Update overall summary
        totalGross += gross;
        totalRazorpayFee += razorpayFee;
        totalTechPayout += techPayout;
        totalPlatformCut += platformCut;
        totalCustomerRefunds += refund;
        if (isCompleted) completedCount++;

        // Region Breakdown
        const loc = r.locality || 'Fairlands';
        if (!regionMap[loc]) {
          regionMap[loc] = { locality: loc, gross: 0, orders: 0, techPayout: 0, platformCut: 0 };
        }
        regionMap[loc].gross += gross;
        regionMap[loc].orders += 1;
        regionMap[loc].techPayout += techPayout;
        regionMap[loc].platformCut += platformCut;

        // Daily Breakdown
        const dateKey = new Date(r.created_at).toISOString().split('T')[0];
        if (!dailyMap[dateKey]) {
          dailyMap[dateKey] = { date: dateKey, gross: 0, techPayout: 0, razorpayFee: 0, platformCut: 0, orders: 0 };
        }
        dailyMap[dateKey].gross += gross;
        dailyMap[dateKey].techPayout += techPayout;
        dailyMap[dateKey].razorpayFee += razorpayFee;
        dailyMap[dateKey].platformCut += platformCut;
        dailyMap[dateKey].orders += 1;

        return {
          id: r.payment_id || `txn_${r.booking_id}`,
          bookingId: r.booking_id,
          createdAt: r.created_at,
          bookingStatus: r.booking_status,
          customerName: r.customer_name || 'Customer',
          customerPhone: r.customer_phone || '',
          locality: r.locality || 'Fairlands',
          serviceId: r.service_id || 'ac',
          technicianName: r.technician_name || (isCancelled ? 'None (Pre-Dispatch)' : 'Pending Allocation'),
          technicianTrade: r.technician_trade || '',
          technicianUpi: r.technician_upi || '',
          grossAmount: parseFloat(gross.toFixed(2)),
          razorpayFee: parseFloat(razorpayFee.toFixed(2)),
          techPayout: parseFloat(techPayout.toFixed(2)),
          platformCut: parseFloat(platformCut.toFixed(2)),
          customerRefund: parseFloat(refund.toFixed(2)),
          paymentMethod: r.payment_method || 'UPI (Razorpay Escrow)',
          razorpayPaymentId: r.razorpay_payment_id || `pay_${r.booking_id.substring(0, 8)}`,
          status: isCancelled ? 'REFUNDED' : (isCompleted ? 'SETTLED' : 'ESCROW_HELD')
        };
      });

      const regionBreakdown = Object.values(regionMap).map(rm => ({
        ...rm,
        gross: parseFloat(rm.gross.toFixed(2)),
        techPayout: parseFloat(rm.techPayout.toFixed(2)),
        platformCut: parseFloat(rm.platformCut.toFixed(2)),
        pctShare: totalGross > 0 ? parseFloat(((rm.gross / totalGross) * 100).toFixed(1)) : 0
      })).sort((a, b) => b.gross - a.gross);

      const dailyBreakdown = Object.values(dailyMap).map(dm => ({
        ...dm,
        gross: parseFloat(dm.gross.toFixed(2)),
        techPayout: parseFloat(dm.techPayout.toFixed(2)),
        razorpayFee: parseFloat(dm.razorpayFee.toFixed(2)),
        platformCut: parseFloat(dm.platformCut.toFixed(2))
      })).sort((a, b) => a.date.localeCompare(b.date));

      const responsePayload = {
        summary: {
          totalGross: parseFloat(totalGross.toFixed(2)),
          totalRazorpayFee: parseFloat(totalRazorpayFee.toFixed(2)),
          totalTechPayout: parseFloat(totalTechPayout.toFixed(2)),
          totalPlatformCut: parseFloat(totalPlatformCut.toFixed(2)),
          totalCustomerRefunds: parseFloat(totalCustomerRefunds.toFixed(2)),
          netPlatformEarnings: parseFloat((totalPlatformCut - totalRazorpayFee).toFixed(2)),
          totalTransactions: transactions.length,
          completedOrders: completedCount
        },
        regionBreakdown,
        dailyBreakdown,
        transactions
      };

      return {
        success: true,
        data: responsePayload,
        ...responsePayload
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 10. Dispatch Technician to Booking
  fastify.post('/admin/bookings/dispatch', async (req, reply) => {
    try {
      const { bookingId, technicianId, force = false } = req.body;

      if (!force) {
        const tCheck = await query(`
          SELECT t.id, t.full_name, COALESCE(t.daily_job_capacity, 4) as capacity,
            (SELECT COUNT(*)::int FROM bookings b WHERE b.technician_id = t.id AND (b.created_at >= CURRENT_DATE OR b.scheduled_slot LIKE '%' || TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') || '%') AND b.status != 'cancelled') as today_count
          FROM technicians t WHERE t.id = $1
        `, [technicianId]);
        if (tCheck.rows.length > 0) {
          const { full_name, capacity, today_count } = tCheck.rows[0];
          if (today_count >= capacity) {
            return reply.status(409).send({
              success: false,
              code: 'DAILY_CAPACITY_REACHED',
              error: `${full_name} has reached their daily job limit (${today_count}/${capacity} jobs today).`
            });
          }
        }
      }

      const updateRes = await query(`
        UPDATE bookings 
        SET technician_id = $1, status = 'accepted', matched_at = NOW() 
        WHERE id = $2 
        RETURNING *
      `, [technicianId, bookingId]);

      // Record Audit Log
      await query(`
        INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
        VALUES ($1, 'MANUAL_DISPATCH', 'admin_salem_central', 'admin', $2)
      `, [bookingId, JSON.stringify({ technicianId, timestamp: new Date().toISOString() })]);

      // Dispatch real-time background push notifications to both parties
      try {
        const tRes = await query('SELECT phone, full_name FROM technicians WHERE id = $1', [technicianId]);
        if (tRes.rows.length > 0) {
          pushService.sendPushToPhone({
            phone: tRes.rows[0].phone,
            role: 'technician',
            payload: {
              title: 'New Service Dispatch Assigned',
              body: `Booking #${bookingId} has been assigned to you by Central Dispatch. Tap to view details.`,
              tag: `job-${bookingId}`,
              type: 'new_job',
              bookingId,
              role: 'technician',
              url: '/partner'
            },
            options: { urgency: 'high', TTL: 1800 }
          }).catch(e => console.warn('Dispatch tech push note:', e.message));
        }

        pushService.sendPushToBookingParty({
          bookingId,
          targetRole: 'customer',
          payload: {
            title: 'Specialist Dispatched!',
            body: `A verified technician has been allocated to Booking #${bookingId}. Tap to track live status.`,
            tag: `order-${bookingId}-matched`,
            type: 'order_status',
            bookingId,
            role: 'customer',
            url: `/track?bookingId=${bookingId}`
          },
          options: { urgency: 'high', TTL: 1800 }
        }).catch(e => console.warn('Dispatch cust push note:', e.message));
      } catch (pushErr) {
        console.warn('Admin dispatch push error:', pushErr.message);
      }

      return {
        success: true,
        message: 'Technician dispatched successfully',
        booking: updateRes.rows[0]
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 10B. Admin Emergency Release: Release Technician & Cancel Unresponsive Booking
  fastify.post('/admin/bookings/release-technician', async (req, reply) => {
    try {
      const {
        bookingId,
        reason = 'Customer not answering phone calls / Doorbell no response at doorstep',
        reasonDetails = '',
        compensateTech = true,
        adminNotes = ''
      } = req.body || {};

      if (!bookingId) {
        return reply.status(400).send({ success: false, error: 'bookingId is required' });
      }

      const bookingRes = await query(`SELECT * FROM bookings WHERE id = $1`, [bookingId]);
      if (bookingRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Booking not found' });
      }

      const booking = bookingRes.rows[0];
      const technicianId = booking.technician_id;
      let techName = 'Assigned Partner';

      if (technicianId) {
        const techRes = await query(`SELECT full_name FROM technicians WHERE id = $1`, [technicianId]);
        if (techRes.rows.length > 0) {
          techName = techRes.rows[0].full_name;
        }

        // Release technician: mark online & ready for dispatches
        await query(`
          UPDATE technicians 
          SET is_online = TRUE,
              jobs_completed_count = COALESCE(jobs_completed_count, 0) + ${compensateTech ? 1 : 0}
          WHERE id = $1
        `, [technicianId]);

        // If compensateTech is true, record compensation in payments
        if (compensateTech) {
          // Payments has no `amount` column and `tech_compensated` is not a payment_status
          // label, so this insert never landed. Travel allowance is a settled payout.
          await query(`
            INSERT INTO payments (booking_id, amount_total, tech_payout_amount, platform_commission, status, payment_method, settled_at)
            VALUES ($1, 99.00, 99.00, 0.00, 'settled', 'admin_travel_allowance', NOW())
          `, [bookingId]);
        }
      }

      const fullReason = `Customer Unresponsive: ${reason}`;
      const fullDetails = adminNotes 
        ? `${reasonDetails} [Admin Note: ${adminNotes}]` 
        : (reasonDetails || 'Customer did not respond to technician/ops attempts. Technician released by central dispatch.');

      // Update booking to cancelled
      const updateRes = await query(`
        UPDATE bookings 
        SET status = 'cancelled',
            cancellation_reason = $1,
            cancellation_details = $2,
            cancelled_by = 'admin_ops',
            cancelled_at = NOW(),
            technician_id = NULL
        WHERE id = $3
        RETURNING *
      `, [fullReason, fullDetails, bookingId]);

      // Release advance payment and mark refunded to customer wallet
      try {
        // payments has no refund_amount column. The refunded figure is amount_total, which
        // stays on the row, so marking the status is the whole ledger write.
        await query(`
          UPDATE payments
          SET status = 'refunded',
              settled_at = NOW()
          WHERE booking_id = $1 AND status <> 'refunded'
        `, [bookingId]);
      } catch (refundErr) {
        fastify.log.warn('Release technician customer refund note: ' + refundErr.message);
      }

      // Record immutable audit log
      await query(`
        INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
        VALUES ($1, 'ADMIN_RELEASE_TECH_CUSTOMER_UNRESPONSIVE', 'admin_salem_central', 'admin', $2)
      `, [bookingId, JSON.stringify({
        technicianId,
        techName,
        reason: fullReason,
        compensateTech,
        adminNotes,
        timestamp: new Date().toISOString()
      })]);

      return {
        success: true,
        message: `Technician ${techName} has been released. Booking #${bookingId} marked as cancelled due to customer unresponsiveness.${compensateTech ? ' Technician compensated ₹99 travel fee.' : ''}`,
        booking: updateRes.rows[0]
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 10C. Admin General-Purpose Cancel Order & Release Technician
  fastify.post('/admin/bookings/cancel-order', async (req, reply) => {
    try {
      const {
        bookingId,
        reason,
        reasonDetails = '',
        compensateTech = false,
        adminNotes = '',
        adminId = 'admin_ops'
      } = req.body || {};

      if (!bookingId) {
        return reply.status(400).send({ success: false, error: 'bookingId is required' });
      }
      if (!reason) {
        return reply.status(400).send({ success: false, error: 'reason is required' });
      }

      // Fetch booking
      const bookingRes = await query(`
        SELECT b.*, 
               t.full_name as tech_name, t.phone as tech_phone
        FROM bookings b
        LEFT JOIN technicians t ON b.technician_id = t.id
        WHERE b.id = $1
      `, [bookingId]);

      if (bookingRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Booking not found' });
      }

      const booking = bookingRes.rows[0];

      // Guard: already cancelled/completed
      if (['cancelled', 'completed'].includes(booking.status)) {
        return reply.status(400).send({
          success: false,
          error: `Booking is already ${booking.status} and cannot be cancelled again.`
        });
      }

      const technicianId = booking.technician_id;
      const techName = booking.tech_name || 'Unassigned';
      const hasTech = Boolean(technicianId);

      // 1. Release the technician — set back online & available
      if (hasTech) {
        await query(`
          UPDATE technicians
          SET is_online = TRUE
          WHERE id = $1
        `, [technicianId]);

        // Optional travel compensation
        if (compensateTech) {
          // Same two defects as the release-technician path: no `amount` column and a status
          // label outside the payment_status enum. Both are corrected here.
          await query(`
            INSERT INTO payments (booking_id, amount_total, tech_payout_amount, platform_commission, status, payment_method, settled_at)
            VALUES ($1, 99.00, 99.00, 0.00, 'settled', 'admin_travel_allowance', NOW())
          `, [bookingId]);
        }
      }

      // 2. Cancel the booking
      const fullDetails = [
        reasonDetails,
        adminNotes ? `[Admin Note: ${adminNotes}]` : ''
      ].filter(Boolean).join(' ').trim() || 'Cancelled by Shazu One Central Operations admin.';

      const updateRes = await query(`
        UPDATE bookings
        SET status            = 'cancelled',
            cancellation_reason  = $1,
            cancellation_details = $2,
            cancelled_by      = $3,
            cancelled_at      = NOW(),
            technician_id     = NULL
        WHERE id = $4
        RETURNING *
      `, [reason, fullDetails, adminId, bookingId]);

      // Release advance payment and mark refunded to customer wallet
      try {
        // payments has no refund_amount column; amount_total already holds the refunded sum.
        await query(`
          UPDATE payments
          SET status = 'refunded',
              settled_at = NOW()
          WHERE booking_id = $1 AND status <> 'refunded'
        `, [bookingId]);
      } catch (refundErr) {
        fastify.log.warn('Admin cancel customer refund note: ' + refundErr.message);
      }

      // 3. Audit log
      await query(`
        INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
        VALUES ($1, 'ADMIN_CANCEL_ORDER', $2, 'admin', $3)
      `, [
        bookingId,
        adminId,
        JSON.stringify({
          reason,
          reasonDetails: fullDetails,
          previousStatus: booking.status,
          technicianId: technicianId || null,
          techName,
          compensateTech,
          timestamp: new Date().toISOString()
        })
      ]);

      return {
        success: true,
        message: `Order #${bookingId} cancelled by admin.${hasTech ? ` Technician ${techName} released and set online.` : ''}${compensateTech ? ' Travel allowance (₹99) credited to technician.' : ''}`,
        booking: updateRes.rows[0],
        techReleased: hasTech,
        compensated: compensateTech && hasTech
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 10b. Emergency Admin Payment Override ("Mark as Paid")
  fastify.post('/admin/bookings/:id/payment-override', async (req, reply) => {
    try {
      const { id } = req.params;
      const {
        paymentStage = 'advance', // 'advance', 'final_settlement', 'full'
        amountPaid,
        paymentMethod = 'direct_upi', // 'direct_upi', 'cash_technician', 'cash_central_desk', 'bank_neft_imps'
        transactionRef,
        reason = 'razorpay_gateway_down',
        notes = '',
        adminId = 'admin_central_ops'
      } = req.body || {};

      // 1. Fetch booking
      const bRes = await query('SELECT * FROM bookings WHERE id = $1', [id]);
      if (bRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: `Booking #${id} not found` });
      }

      const booking = bRes.rows[0];
      const visitFee = parseFloat(booking.visit_fee) || 99.00;
      const quoteSubtotal = parseFloat(booking.quote_subtotal) || 0.00;
      const parsedAmount = amountPaid !== undefined && amountPaid !== null && !isNaN(parseFloat(amountPaid))
        ? parseFloat(amountPaid)
        : (paymentStage === 'advance' ? visitFee : (paymentStage === 'final_settlement' ? quoteSubtotal : visitFee + quoteSubtotal));

      if (parsedAmount <= 0) {
        return reply.status(400).send({ success: false, error: 'Valid payment amount is required' });
      }

      // 2. Financial calculation
      let techPayoutAmount = 0.00;
      let platformCommission = 0.00;
      let targetStatus = booking.status;
      let targetPaymentStatus = 'settled';

      const methodNames = {
        direct_upi: 'Direct UPI (Company QR)',
        cash_technician: 'Cash Collected by Partner',
        cash_central_desk: 'Cash Received at Central Desk',
        bank_neft_imps: 'Bank Transfer (NEFT/IMPS)'
      };
      const resolvedMethodName = methodNames[paymentMethod] || paymentMethod || 'MANUAL_ADMIN_OVERRIDE';

      const utrRef = transactionRef?.trim() || `MANUAL-${id.substring(0, 8)}-${Date.now()}`;
      const fakeOrderId = `manual_ord_${id}_${Date.now()}`;
      const fakePaymentId = `manual_pay_${id}_${Date.now()}`;

      if (paymentStage === 'advance') {
        // 100% of Advance / Travel fee goes to technician
        techPayoutAmount = parsedAmount;
        platformCommission = 0.00;
        targetPaymentStatus = 'escrow_held';
        
        // If booking is waiting for payment in created or matching, advance to en_route (if tech assigned) or matching/accepted
        if (booking.status === 'created' || booking.status === 'matching') {
          targetStatus = booking.technician_id ? 'en_route' : 'matching';
        } else if (booking.status === 'accepted') {
          targetStatus = 'en_route';
        }
      } else {
        // Final quote settlement or full payment
        // Dynamic Shazu One platform commission and technician payout
        const commissionPercent = await getPlatformCommissionPercent();
        const split = calculateCommissionSplit(parsedAmount, commissionPercent);
        platformCommission = split.platformCommission;
        techPayoutAmount = split.techPayout;
        targetPaymentStatus = 'settled';
        targetStatus = 'completed';
      }

      // 3. Upsert into payments ledger
      const paymentRes = await query(`
        INSERT INTO payments (
          booking_id, razorpay_order_id, razorpay_payment_id, amount_total,
          tech_payout_amount, platform_commission, status, payment_method, payout_utr,
          settled_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::payment_status, $8, $9, CASE WHEN $7 = 'settled' THEN NOW() ELSE NULL END, NOW())
        RETURNING *;
      `, [
        id,
        fakeOrderId,
        fakePaymentId,
        parsedAmount,
        techPayoutAmount,
        platformCommission,
        targetPaymentStatus,
        resolvedMethodName,
        utrRef
      ]);

      // 4. Update bookings table
      const updatedBookingRes = await query(`
        UPDATE bookings
        SET
          status = $1,
          final_amount = CASE WHEN $2::numeric > 0 THEN $2::numeric ELSE final_amount END,
          completed_at = CASE WHEN $1 = 'completed' THEN NOW() ELSE completed_at END
        WHERE id = $3
        RETURNING *;
      `, [targetStatus, parsedAmount, id]);

      // 5. If completed or settlement, record technician payout disbursal
      if (targetStatus === 'completed' && booking.technician_id) {
        try {
          const tRes = await query('SELECT phone, upi_vpa, full_name FROM technicians WHERE id = $1', [booking.technician_id]);
          const tech = tRes.rows[0];
          await query(`
            INSERT INTO technician_payouts (
              technician_phone, technician_id, amount, upi_id, status, utr_ref, description, created_at
            ) VALUES ($1, $2, $3, $4, 'DISBURSED_100%', $5, $6, NOW())
          `, [
            tech?.phone || 'PARTNER',
            booking.technician_id,
            techPayoutAmount,
            tech?.upi_vpa || null,
            utrRef,
            `Admin manual payment override settlement for Booking #${id} (${resolvedMethodName})`
          ]);
          // Sync technician completed jobs count
          await query(`
            UPDATE technicians 
            SET jobs_completed_count = (
              SELECT count(*)::int FROM bookings WHERE technician_id = $1 AND status = 'completed'
            )
            WHERE id = $1
          `, [booking.technician_id]);
        } catch (pErr) {
          fastify.log.warn('Could not record tech payout on override:', pErr.message);
        }
      }

      // 6. Write to audit_logs
      await query(`
        INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
        VALUES ($1, 'ADMIN_MANUAL_PAYMENT_OVERRIDE', $2, 'admin', $3)
      `, [
        id,
        adminId,
        JSON.stringify({
          amountPaid: parsedAmount,
          paymentStage,
          paymentMethod: resolvedMethodName,
          transactionRef: utrRef,
          reason,
          notes,
          previousStatus: booking.status,
          newStatus: targetStatus,
          techPayoutAmount,
          platformCommission,
          timestamp: new Date().toISOString()
        })
      ]);

      // 7. Push notification to Technician (if assigned)
      if (booking.technician_id) {
        try {
          const pushService = require('../services/pushNotification.service');
          await pushService.sendPushNotification({
            userId: booking.technician_id,
            role: 'technician',
            payload: {
              title: 'Payment Confirmed by Central Ops',
              body: `Payment of INR ${parsedAmount} for Booking #${id} has been verified (${resolvedMethodName}). Continue service.`,
              tag: `pay-override-${id}`,
              type: 'payment_verified',
              bookingId: id
            }
          });
        } catch (pushErr) {}
      }

      return {
        success: true,
        message: `Booking #${id} successfully marked as PAID (INR ${parsedAmount.toFixed(2)} via ${resolvedMethodName}). Status advanced to '${targetStatus}'.`,
        payment: paymentRes.rows[0],
        booking: updatedBookingRes.rows[0],
        stage: paymentStage,
        amount: parsedAmount,
        status: targetStatus
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 11. Deep Booking Traceability
  fastify.get('/admin/bookings/:id/trace', async (req, reply) => {
    try {
      const { id } = req.params;
      const [bookingRes, auditsRes, paymentRes] = await Promise.all([
        query(`
          SELECT b.*, 
                 t.full_name as technician_name, t.phone as technician_phone, t.primary_trade, 
                 t.rating_avg as technician_rating, t.aadhaar_card_url as tech_aadhaar_url, 
                 t.is_kyc_verified as tech_kyc_verified, t.upi_vpa as tech_upi
          FROM bookings b
          LEFT JOIN technicians t ON b.technician_id = t.id
          WHERE b.id = $1
        `, [id]),
        query(`SELECT * FROM audit_logs WHERE booking_id = $1 ORDER BY created_at ASC`, [id]),
        query(`SELECT * FROM payments WHERE booking_id = $1`, [id])
      ]);

      if (bookingRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Booking not found' });
      }

      return {
        success: true,
        booking: bookingRes.rows[0],
        auditLogs: auditsRes.rows,
        payment: paymentRes.rows[0] || null
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 12. Internal Team RBAC Management
  async function initTeamTable() {
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS admin_team (
          id VARCHAR(64) PRIMARY KEY,
          name VARCHAR(128) NOT NULL,
          email VARCHAR(128) NOT NULL UNIQUE,
          phone VARCHAR(32),
          role VARCHAR(64) NOT NULL DEFAULT 'ops_dispatcher',
          hub_locality VARCHAR(128) DEFAULT 'Salem Central HQ',
          status VARCHAR(32) DEFAULT 'active',
          permissions JSONB DEFAULT '[]'::jsonb,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);

      const countRes = await query(`SELECT count(*) as count FROM admin_team`);
      if (parseInt(countRes.rows[0]?.count || 0, 10) === 0) {
        await query(`
          INSERT INTO admin_team (id, name, email, phone, role, hub_locality, status, permissions)
          VALUES 
            ('staff_01', 'Operations Lead', 'admin@shazuone.in', '+91 94432 10001', 'super_admin', 'Salem Central HQ', 'active', '["all"]'::jsonb),
            ('staff_02', 'Dispatch Controller', 'dispatch@shazuone.in', '+91 98421 22340', 'ops_dispatcher', 'Suramangalam Control Hub', 'active', '["dispatch", "tracking", "technicians"]'::jsonb),
            ('staff_03', 'Quality & Support', 'support@shazuone.in', '+91 97890 33411', 'support_quality', 'Customer Grievance Cell', 'active', '["reviews", "feedback", "customers"]'::jsonb),
            ('staff_04', 'Finance & Escrow', 'finance@shazuone.in', '+91 96555 44122', 'finance_officer', 'Accounts & Escrow Desk', 'active', '["settlements", "pricing", "rewards"]'::jsonb)
        `);
      }
    } catch (err) {
      console.warn('admin_team init warning:', err.message);
    }
  }
  await initTeamTable();

  fastify.get('/admin/team', async (req, reply) => {
    try {
      const res = await query(`SELECT * FROM admin_team ORDER BY created_at ASC`);
      return { success: true, count: res.rows.length, team: res.rows };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  fastify.post('/admin/team', async (req, reply) => {
    try {
      const { name, email, phone, role, hub_locality, status, permissions } = req.body;
      if (!name || !email || !role) {
        return reply.status(400).send({ success: false, error: 'Name, email and role are required' });
      }
      const id = 'staff_' + Date.now();
      const res = await query(`
        INSERT INTO admin_team (id, name, email, phone, role, hub_locality, status, permissions)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [
        id,
        name,
        email,
        phone || '',
        role,
        hub_locality || 'Salem Central HQ',
        status || 'active',
        JSON.stringify(permissions || [])
      ]);
      return { success: true, member: res.rows[0] };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  fastify.put('/admin/team/:id', async (req, reply) => {
    try {
      const { id } = req.params;
      const { name, email, phone, role, hub_locality, status, permissions } = req.body;
      const res = await query(`
        UPDATE admin_team
        SET 
          name = COALESCE($1, name),
          email = COALESCE($2, email),
          phone = COALESCE($3, phone),
          role = COALESCE($4, role),
          hub_locality = COALESCE($5, hub_locality),
          status = COALESCE($6, status),
          permissions = COALESCE($7, permissions)
        WHERE id = $8
        RETURNING *
      `, [
        name, email, phone, role, hub_locality, status,
        permissions ? JSON.stringify(permissions) : null,
        id
      ]);

      if (res.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Member not found' });
      }
      return { success: true, member: res.rows[0] };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  fastify.delete('/admin/team/:id', async (req, reply) => {
    try {
      const { id } = req.params;
      await query(`DELETE FROM admin_team WHERE id = $1`, [id]);
      return { success: true, message: 'Member deleted successfully' };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });
}

module.exports = adminRoutes;
