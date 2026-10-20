const { query } = require('../db/db');

async function feedbackRoutes(fastify, options) {
  // Ensure platform_feedback table exists
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS platform_feedback (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(100),
        user_name VARCHAR(150),
        user_phone VARCHAR(50),
        role VARCHAR(50) DEFAULT 'customer',
        feedback_type VARCHAR(100) DEFAULT 'general',
        rating INT DEFAULT 5,
        subject VARCHAR(200),
        message TEXT NOT NULL,
        locality VARCHAR(100) DEFAULT 'Fairlands, Salem',
        status VARCHAR(50) DEFAULT 'new',
        admin_notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
  } catch (e) {
    fastify.log.warn('Platform feedback table initialization warning:', e.message);
  }

  // 1. Submit Platform Feedback (Customer or Technician)
  fastify.post('/feedback/submit', async (req, reply) => {
    try {
      const {
        userId,
        userName,
        userPhone,
        role = 'customer',
        feedbackType = 'general',
        rating = 5,
        subject = '',
        message,
        locality = 'Fairlands, Salem'
      } = req.body;

      if (!message || !message.trim()) {
        return reply.status(400).send({ success: false, error: 'Feedback message is required' });
      }

      const insertSql = `
        INSERT INTO platform_feedback (
          user_id, user_name, user_phone, role, feedback_type,
          rating, subject, message, locality, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'new')
        RETURNING *;
      `;

      const result = await query(insertSql, [
        userId || null,
        userName || (role === 'technician' ? 'Verified Partner' : 'Customer'),
        userPhone || null,
        role,
        feedbackType,
        parseInt(rating, 10) || 5,
        subject || `${role === 'technician' ? 'Partner' : 'Customer'} Platform Experience`,
        message.trim(),
        locality
      ]);

      // Record Audit Log
      try {
        await query(`
          INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
          VALUES ($1, 'PLATFORM_FEEDBACK_SUBMITTED', $2, $3, $4)
        `, [
          'SYSTEM-FEEDBACK-' + result.rows[0].id,
          userPhone || 'unknown',
          role,
          JSON.stringify({ feedbackId: result.rows[0].id, rating, feedbackType })
        ]);
      } catch (auditErr) {}

      // Award feedback credits if enabled by admin
      let creditsAwarded = 0;
      let newBalance = null;
      try {
        const sRes = await query(`
          SELECT feedback_reward_credits, feedback_rewards_enabled 
          FROM platform_settings 
          WHERE id = 'reward_settings' 
          LIMIT 1
        `);
        const isEnabled = sRes.rows.length > 0 ? Boolean(sRes.rows[0].feedback_rewards_enabled) : true;
        const rewardAmount = sRes.rows.length > 0 ? parseFloat(sRes.rows[0].feedback_reward_credits) : 15.00;

        if (isEnabled && rewardAmount > 0 && userPhone) {
          const cleanPhone = (userPhone || '').replace(/[\s\-\(\)]/g, '');
          const updateRes = await query(`
            UPDATE users 
            SET wallet_balance = COALESCE(wallet_balance, 0) + $1,
                updated_at = CURRENT_TIMESTAMP
            WHERE REPLACE(REPLACE(phone, ' ', ''), '-', '') = $2
            RETURNING id, phone, wallet_balance
          `, [rewardAmount, cleanPhone]);

          if (updateRes.rows.length > 0) {
            creditsAwarded = rewardAmount;
            newBalance = parseFloat(updateRes.rows[0].wallet_balance);
            await query(`
              INSERT INTO wallet_transactions (user_id, user_phone, title, amount, type, category, description)
              VALUES ($1, $2, 'Platform Feedback Reward', $3, 'CREDIT', 'FEEDBACK_REWARD', 'Credits rewarded for helpful platform feedback')
            `, [updateRes.rows[0].id, cleanPhone, rewardAmount]);
          }
        }
      } catch (fbCreditErr) {
        fastify.log.warn('Could not award feedback credits: ' + fbCreditErr.message);
      }

      return {
        success: true,
        message: creditsAwarded > 0
          ? `Feedback submitted successfully! +${creditsAwarded} Credits added to your wallet.`
          : 'Feedback submitted successfully and sent to Shazu One Central Operations Desk',
        creditsAwarded,
        newBalance,
        feedback: result.rows[0]
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 2. Get All Platform Feedbacks (For Admin Dashboard & Audit)
  const getFeedbackHandler = async (req, reply) => {
    try {
      const { role, status } = req.query;
      let sql = `SELECT * FROM platform_feedback WHERE 1=1`;
      const params = [];

      if (role && role !== 'all') {
        params.push(role);
        sql += ` AND role = $${params.length}`;
      }
      if (status && status !== 'all') {
        params.push(status);
        sql += ` AND status = $${params.length}`;
      }

      sql += ` ORDER BY created_at DESC LIMIT 100;`;

      const result = await query(sql, params);
      return {
        success: true,
        count: result.rows.length,
        feedbacks: result.rows,
        feedback: result.rows
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  };

  fastify.get('/feedback/list', getFeedbackHandler);
  fastify.get('/feedback', getFeedbackHandler);

  // 3. Update Feedback Status (Resolve / Acknowledge by Admin)
  fastify.post('/feedback/:id/status', async (req, reply) => {
    try {
      const { id } = req.params;
      const { status = 'resolved', adminNotes = '' } = req.body;

      const updateRes = await query(`
        UPDATE platform_feedback
        SET status = $1, admin_notes = $2
        WHERE id = $3
        RETURNING *;
      `, [status, adminNotes, id]);

      if (updateRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Feedback record not found' });
      }

      return {
        success: true,
        message: `Feedback status updated to ${status}`,
        feedback: updateRes.rows[0]
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });
}

module.exports = feedbackRoutes;
