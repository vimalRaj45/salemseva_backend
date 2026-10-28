const { query } = require('../db/db');

async function ticketsRoutes(fastify, options) {
  // 1. Create a support ticket (authenticated or auth help guest)
  fastify.post('/tickets/create', async (req, reply) => {
    try {
      const body = req.body || {};
      const creatorId = body.creatorId || body.creator_id || null;
      const creatorRole = body.creatorRole || body.creator_role || 'customer';
      const creatorName = body.creatorName || body.creator_name || 'Citizen User';
      const rawPhone = body.creatorPhone || body.creator_phone || body.phone || '';
      const creatorPhone = String(rawPhone).trim();
      const bookingId = body.bookingId || body.booking_id || null;
      const category = body.category || 'general';
      const priority = body.priority || 'normal';
      const subject = body.subject;
      const description = body.description;
      const voiceNoteUrl = body.voiceNoteUrl || body.voice_note_url || null;
      const attachmentUrl = body.attachmentUrl || body.attachment_url || null;
      const locality = body.locality || 'Salem';

      if (!creatorPhone) {
        return reply.status(400).send({ success: false, error: 'Mobile phone number is required to file a support ticket' });
      }

      if (!subject || !String(subject).trim()) {
        return reply.status(400).send({ success: false, error: 'Ticket subject is required' });
      }

      if (!description || !String(description).trim()) {
        return reply.status(400).send({ success: false, error: 'Ticket description details are required' });
      }

      const ticketId = `TICK-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const randomDigits = Math.floor(1000 + Math.random() * 9000);
      const ticketNumber = `#SO-${randomDigits}`;

      const insertSql = `
        INSERT INTO support_tickets (
          id, ticket_number, creator_id, creator_role, creator_name, creator_phone,
          booking_id, category, priority, subject, description,
          voice_note_url, attachment_url, locality, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'open')
        RETURNING *;
      `;

      const result = await query(insertSql, [
        ticketId,
        ticketNumber,
        creatorId,
        creatorRole,
        String(creatorName).trim(),
        String(creatorPhone).trim(),
        bookingId,
        category,
        priority,
        String(subject).trim(),
        String(description).trim(),
        voiceNoteUrl,
        attachmentUrl,
        locality
      ]);

      const createdTicket = result.rows[0];

      // Audit log entry
      try {
        await query(`
          INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
          VALUES ($1, 'TICKET_CREATED', $2, $3, $4)
        `, [
          bookingId || 'SUPPORT',
          creatorPhone,
          creatorRole,
          JSON.stringify({ ticketId, ticketNumber, category, priority, subject })
        ]);
      } catch (auditErr) {}

      return {
        success: true,
        message: `Support ticket ${ticketNumber} registered successfully with Shazu One Central Desk`,
        ticketNumber,
        ticket: createdTicket
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 2. Get tickets by user phone number
  fastify.get('/tickets/user/:phone', async (req, reply) => {
    try {
      const { phone } = req.params;
      const cleanPhone = String(phone).trim();

      const res = await query(`
        SELECT * FROM support_tickets 
        WHERE creator_phone = $1 OR creator_phone LIKE $2
        ORDER BY created_at DESC;
      `, [cleanPhone, `%${cleanPhone.replace(/[^0-9]/g, '').slice(-10)}%`]);

      return {
        success: true,
        count: res.rows.length,
        tickets: res.rows
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 3. Get single ticket by ticket ID or ticket number
  fastify.get('/tickets/:id', async (req, reply) => {
    try {
      const { id } = req.params;
      const res = await query(`
        SELECT * FROM support_tickets 
        WHERE id = $1 OR UPPER(ticket_number) = UPPER($1)
        LIMIT 1;
      `, [id]);

      if (res.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Ticket not found' });
      }

      return {
        success: true,
        ticket: res.rows[0]
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 4. Admin queue: list all support tickets
  fastify.get('/admin/tickets', async (req, reply) => {
    try {
      const { status, category, priority, limit = 50 } = req.query || {};

      let sql = 'SELECT * FROM support_tickets WHERE 1=1';
      const params = [];

      if (status && status !== 'all') {
        params.push(status);
        sql += ` AND status = $${params.length}`;
      }

      if (category && category !== 'all') {
        params.push(category);
        sql += ` AND category = $${params.length}`;
      }

      if (priority && priority !== 'all') {
        params.push(priority);
        sql += ` AND priority = $${params.length}`;
      }

      sql += ` ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END ASC, created_at DESC LIMIT $${params.length + 1}`;
      params.push(parseInt(limit, 10) || 50);

      const res = await query(sql, params);

      return {
        success: true,
        count: res.rows.length,
        tickets: res.rows
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 5. Admin resolution: resolve, update status, add resolution notes
  fastify.patch('/admin/tickets/:id/resolve', async (req, reply) => {
    try {
      const { id } = req.params;
      const {
        status = 'resolved',
        adminNotes = '',
        resolutionSummary = '',
        resolvedBy = 'Shazu One Central Operations Desk'
      } = req.body || {};

      const check = await query('SELECT * FROM support_tickets WHERE id = $1 OR UPPER(ticket_number) = UPPER($1)', [id]);
      if (check.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Ticket not found' });
      }

      const existing = check.rows[0];

      const updateRes = await query(`
        UPDATE support_tickets 
        SET status = $1,
            admin_notes = COALESCE(NULLIF($2, ''), admin_notes),
            resolution_summary = $3,
            resolved_by = $4,
            resolved_at = CASE WHEN $1::varchar IN ('resolved', 'closed') THEN NOW() ELSE resolved_at END,
            updated_at = NOW()
        WHERE id = $5
        RETURNING *;
      `, [status, adminNotes, resolutionSummary || 'Resolved by Salem Central Desk', resolvedBy, existing.id]);

      // Audit log entry
      try {
        await query(`
          INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
          VALUES ($1, 'TICKET_RESOLVED', $2, 'admin', $3)
        `, [
          existing.booking_id || 'SUPPORT',
          resolvedBy,
          JSON.stringify({ ticketId: existing.id, status, resolutionSummary })
        ]);
      } catch (auditErr) {}

      return {
        success: true,
        message: `Ticket ${existing.ticket_number} updated to status "${status}"`,
        ticket: updateRes.rows[0]
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });
}

module.exports = ticketsRoutes;
