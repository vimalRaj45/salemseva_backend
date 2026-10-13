const { query } = require('../db/db');

async function adminRoutes(fastify, options) {
  // 1. Central Ops Dashboard Overview
  fastify.get('/admin/overview', async (req, reply) => {
    try {
      const [bookingsCount, onlineTechs, paymentsSum, reviewsCount, recentBookings, techsList] = await Promise.all([
        query(`SELECT status, count(*) as count FROM bookings GROUP BY status`),
        query(`SELECT count(*) as count FROM technicians WHERE is_online = TRUE`),
        query(`SELECT COALESCE(SUM(amount_total), 0) as total_revenue, COALESCE(SUM(tech_payout_amount), 0) as total_payouts, COALESCE(SUM(platform_commission), 0) as total_commission FROM payments`),
        query(`SELECT count(*) as count FROM reviews WHERE is_below_3_star = TRUE`),
        query(`SELECT * FROM bookings ORDER BY created_at DESC LIMIT 30`),
        query(`
          SELECT 
            t.id, t.full_name, t.phone, t.primary_trade, t.years_experience,
            t.rating_avg, t.rating_count, t.jobs_completed_count, t.is_online, 
            t.is_kyc_verified, t.current_lat, t.current_lng, t.star_points,
            t.aadhaar_card_url, t.aadhaar_uploaded_at, t.aadhaar_number, t.upi_vpa,
            (
              SELECT count(*) 
              FROM bookings b 
              WHERE b.technician_id = t.id 
                AND b.status IN ('accepted', 'en_route', 'arrived', 'in_progress', 'quote_presented')
            ) as active_job_count
          FROM technicians t 
          ORDER BY t.is_online DESC, t.rating_avg DESC
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
          (
            SELECT count(*) 
            FROM bookings b 
            WHERE b.technician_id = t.id 
              AND b.status IN ('accepted', 'en_route', 'arrived', 'in_progress', 'quote_presented')
          ) as active_job_count
        FROM technicians t
        WHERE 1=1
      `;
      const params = [];

      if (trade && trade !== 'all') {
        params.push(trade);
        sql += ` AND t.primary_trade = $${params.length}`;
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

      sql += ` ORDER BY t.is_online DESC, t.rating_avg DESC`;

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
            reason: reason || (isApproved ? 'Aadhaar document verified by Salem Central Ops' : 'Aadhaar document rejected / resubmission requested'),
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

  // 5. Customer 360 Analytics & Directory
  fastify.get('/admin/customers', async (req, reply) => {
    try {
      const result = await query(`
        SELECT 
          COALESCE(b.customer_phone, u.phone) as customer_phone,
          COALESCE(MAX(b.customer_name), MAX(u.full_name), 'Salem Customer') as customer_name,
          COALESCE(MAX(b.locality), MAX(u.locality), 'Fairlands') as locality,
          MAX(b.service_address) as latest_address,
          COUNT(b.id) as total_orders,
          COALESCE(SUM(b.final_amount), 0) as total_spent,
          MAX(b.created_at) as last_order_date,
          COUNT(CASE WHEN b.status = 'completed' THEN 1 END) as completed_orders,
          COUNT(CASE WHEN b.status IN ('matching', 'accepted', 'en_route', 'arrived', 'in_progress', 'quote_presented') THEN 1 END) as active_orders
        FROM bookings b
        FULL OUTER JOIN users u ON b.customer_phone = u.phone
        WHERE b.customer_phone IS NOT NULL OR u.phone IS NOT NULL
        GROUP BY COALESCE(b.customer_phone, u.phone)
        ORDER BY total_orders DESC, last_order_date DESC
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
        WHERE b.customer_phone = $1
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
        query(`SELECT * FROM technicians WHERE id = $1`, [id]),
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
            COALESCE(SUM(tech_payout_amount), 0) as lifetime_earnings,
            COALESCE(SUM(amount_total), 0) as gross_job_volume
          FROM payments p
          JOIN bookings b ON p.booking_id = b.id
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

  // 10. Dispatch Technician to Booking
  fastify.post('/admin/bookings/dispatch', async (req, reply) => {
    try {
      const { bookingId, technicianId } = req.body;

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
            ('staff_01', 'Vimal Raj', 'vimal@salemseva.in', '+91 94432 10001', 'super_admin', 'Salem Central HQ', 'active', '["all"]'::jsonb),
            ('staff_02', 'Anand M.', 'anand.dispatch@salemseva.in', '+91 98421 22340', 'ops_dispatcher', 'Suramangalam Control Hub', 'active', '["dispatch", "tracking", "technicians"]'::jsonb),
            ('staff_03', 'Priya S.', 'priya.support@salemseva.in', '+91 97890 33411', 'support_quality', 'Customer Grievance Cell', 'active', '["reviews", "feedback", "customers"]'::jsonb),
            ('staff_04', 'Karthik K.', 'karthik.fin@salemseva.in', '+91 96555 44122', 'finance_officer', 'Accounts & Escrow Desk', 'active', '["settlements", "pricing", "rewards"]'::jsonb)
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
