const { query } = require('../db/db');

async function reviewsRoutes(fastify, options) {
  // 1. Submit Customer Review with Dynamic Below 3-Star Escalation
  fastify.post('/reviews/submit', async (req, reply) => {
    const {
      bookingId,
      rating,
      comment,
      tags = [],
      rootCauseTags = []
    } = req.body;

    const stars = parseFloat(rating) || 5.0;
    const isBelow3Star = stars <= 3.0;

    const insertSql = `
      INSERT INTO reviews (
        booking_id, rating, comment, tags, is_below_3_star, 
        root_cause_tags, ops_manager_escalated
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
    `;

    const result = await query(insertSql, [
      bookingId || 'SLM-84920',
      stars,
      comment || '',
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

      // If rating >= 4, award 50 wallet credits and 2 star points
      if (!isBelow3Star) {
        try {
          // Credit customer wallet in database
          await query(`
            UPDATE users 
            SET wallet_balance = wallet_balance + 50 
            WHERE id = (SELECT customer_id FROM bookings WHERE id = $1)
          `, [bookingId]);

          // Award technician +2 Star Points towards zero commission
          await query(`
            UPDATE technicians 
            SET star_points = star_points + 2 
            WHERE id = (SELECT technician_id FROM bookings WHERE id = $1)
          `, [bookingId]);
        } catch (e) {}
      }
    }

    return {
      success: true,
      review: result.rows[0],
      escalationStatus: isBelow3Star ? 'ESCALATED_TO_SALEM_OPS' : 'NORMAL_COMPLETED',
      creditsAwarded: !isBelow3Star ? 50 : 0,
      techStarPointsAwarded: !isBelow3Star ? 2 : 0,
      customerBenefit: isBelow3Star 
        ? 'Eligible for 100% Free Warranty Revisit or Full Diagnostic Refund'
        : '+50 Seva Credits Added to Wallet'
    };
  });
}


module.exports = reviewsRoutes;
