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
        userId || (role === 'technician' ? 'tech-ramesh' : 'usr-cust-001'),
        userName || (role === 'technician' ? 'K. Ramesh (Partner)' : 'Vimal Raj'),
        userPhone || '+91 98427 11234',
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

      return {
        success: true,
        message: 'Feedback submitted successfully and sent to Salem Central Operations Desk',
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
