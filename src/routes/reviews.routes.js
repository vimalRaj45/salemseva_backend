const { query } = require('../db/db');

async function reviewsRoutes(fastify, options) {
  // 1. Submit Customer Review with Dynamic Below 3-Star Escalation
  fastify.post('/reviews/submit', async (req, reply) => {
    const {
      bookingId,
      rating,
      comment,
      feedback,
      tags = [],
      rootCauseTags = []
    } = req.body || {};

    const userComment = comment || feedback || '';
    const stars = parseFloat(rating) || 5.0;
    const isBelow3Star = stars <= 3.0;

    if (!bookingId) {
      return reply.status(400).send({ success: false, error: 'Booking ID is required to submit a review' });
    }

    const bCheck = await query('SELECT id FROM bookings WHERE id = $1', [bookingId]);
    if (bCheck.rows.length === 0) {
      return reply.status(404).send({ success: false, error: 'Booking not found' });
    }

    const insertSql = `
      INSERT INTO reviews (
        booking_id, rating, comment, tags, is_below_3_star, 
        root_cause_tags, ops_manager_escalated
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
    `;

    const result = await query(insertSql, [
      bookingId,
      stars,
      userComment,
      tags,
      isBelow3Star,
      rootCauseTags,
      isBelow3Star // Automatically escalates to Salem Ops Manager Anand if <= 3 stars
    ]);

    // Mark the booking as completed in database
    if (bookingId) {
      await query(`
        UPDATE bookings 
        SET status = 'completed' 
        WHERE id = $1
      `, [bookingId]);

        // Award technician +2 Star Points towards zero commission on completed job
        await query(`
          UPDATE technicians 
          SET star_points = star_points + 2 
          WHERE id = (SELECT technician_id FROM bookings WHERE id = $1)
        `, [bookingId]);

        // Real Automated Referral Fulfillment: If this customer was referred by someone, reward the referrer directly
        try {
          const custRes = await query(`
            SELECT u.id, u.full_name, u.locality, u.referred_by
            FROM users u
            WHERE u.id = (SELECT customer_id FROM bookings WHERE id = $1)
               OR RIGHT(REGEXP_REPLACE(u.phone, '\\D', '', 'g'), 10) = (
                    SELECT RIGHT(REGEXP_REPLACE(customer_phone, '\\D', '', 'g'), 10)
                    FROM bookings WHERE id = $1
                  )
            LIMIT 1
          `, [bookingId]);
          if (custRes.rows.length > 0 && custRes.rows[0].referred_by) {
            const refCode = custRes.rows[0].referred_by;
            const referrerRes = await query(`SELECT id, phone, full_name FROM users WHERE referral_code = $1 LIMIT 1`, [refCode]);
            if (referrerRes.rows.length > 0) {
              const existingRef = await query(`
                SELECT id FROM wallet_transactions 
                WHERE user_id = $1 AND category = 'REFERRAL_REWARD' AND description LIKE '%' || $2 || '%'
              `, [referrerRes.rows[0].id, custRes.rows[0].full_name]);
              if (existingRef.rows.length === 0) {
                const sRes = await query(`SELECT customer_referral_credits FROM platform_settings WHERE id = 'reward_settings' LIMIT 1`);
                const refCredits = sRes.rows.length > 0 ? parseFloat(sRes.rows[0].customer_referral_credits) : 50.00;
                await query(`UPDATE users SET wallet_balance = COALESCE(wallet_balance, 0) + $1 WHERE id = $2`, [refCredits, referrerRes.rows[0].id]);
                await query(`
                  INSERT INTO wallet_transactions (user_id, user_phone, title, amount, type, category, description)
                  VALUES ($1, $2, 'Friend Referral Cash Reward', $3, 'CREDIT', 'REFERRAL_REWARD', 'Friend ' || $4 || ' completed first service! Direct ₹' || $3 || ' discount added for your next booking.')
                `, [referrerRes.rows[0].id, referrerRes.rows[0].phone, refCredits, custRes.rows[0].full_name]);
              }
            }
          }
        } catch (refErr) {}
    }

    return {
      success: true,
      review: {
        ...result.rows[0],
        is_escalated: isBelow3Star
      },
      escalationStatus: isBelow3Star ? 'ESCALATED_TO_SALEM_OPS' : 'NORMAL_COMPLETED',
      creditsAwarded: 0,
      techStarPointsAwarded: 2,
      customerBenefit: isBelow3Star 
        ? 'Eligible for 100% Free Warranty Revisit or Full Diagnostic Refund'
        : 'Service Completed & 100% Satisfaction Guaranteed'
    };
  });

  // 2. Fetch Real Reviews with Filters
  fastify.get('/reviews', async (req, reply) => {
    try {
      const { serviceId, techId, limit = 50 } = req.query || {};
      let sql = `
        SELECT 
          r.id, r.booking_id, r.rating, r.comment, r.tags, 
          r.is_below_3_star, r.root_cause_tags, r.ops_manager_escalated, r.ops_manager_notes, r.created_at,
          b.service_id, b.locality, b.customer_name,
          t.full_name as technician_name, t.primary_trade,
          CASE 
            WHEN b.service_id = 'ac' THEN 'AC Repair & Service'
            WHEN b.service_id = 'electrician' THEN 'Electrician & Wiring'
            WHEN b.service_id = 'plumber' THEN 'Plumber & Sanitary'
            WHEN b.service_id = 'cleaning' THEN 'Home & Bath Cleaning'
            ELSE 'Home Service'
          END as service_name
        FROM reviews r
        LEFT JOIN bookings b ON r.booking_id = b.id
        LEFT JOIN technicians t ON r.technician_id = t.id OR b.technician_id = t.id
        WHERE r.comment IS NOT NULL AND TRIM(r.comment) != ''
      `;
      const params = [];
      if (serviceId) {
        params.push(serviceId);
        sql += ` AND b.service_id = $${params.length}`;
      }
      if (techId) {
        params.push(techId);
        sql += ` AND (r.technician_id = $${params.length} OR b.technician_id = $${params.length})`;
      }
      sql += ` ORDER BY r.rating DESC, r.created_at DESC LIMIT $${params.length + 1}`;
      params.push(parseInt(limit) || 50);

      const res = await query(sql, params);
      return { success: true, count: res.rows.length, reviews: res.rows };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 3. Aggregate Real Reviews & Ratings Statistics
  fastify.get('/reviews/stats', async (req, reply) => {
    try {
      const statsRes = await query(`
        SELECT 
          COUNT(*) as total_reviews,
          ROUND(AVG(rating)::numeric, 2) as average_rating,
          COUNT(*) FILTER (WHERE rating >= 4.5) as stars_5,
          COUNT(*) FILTER (WHERE rating >= 3.5 AND rating < 4.5) as stars_4,
          COUNT(*) FILTER (WHERE rating >= 2.5 AND rating < 3.5) as stars_3,
          COUNT(*) FILTER (WHERE rating >= 1.5 AND rating < 2.5) as stars_2,
          COUNT(*) FILTER (WHERE rating < 1.5) as stars_1,
          COUNT(*) FILTER (WHERE is_below_3_star = TRUE) as escalated_count
        FROM reviews
      `);
      return { success: true, stats: statsRes.rows[0] };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });
}

module.exports = reviewsRoutes;
