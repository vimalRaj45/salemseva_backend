const legalService = require('../services/legalAgreement.service');
const { query } = require('../db/db');

async function legalRoutes(fastify, options) {
  // 1. Fetch Active Legal Document Content, Version & Hash
  fastify.get('/legal/active/:documentType', async (req, reply) => {
    try {
      const { documentType } = req.params;
      const doc = legalService.getActiveDocument(documentType);
      return {
        success: true,
        document: {
          type: doc.type,
          version: doc.version,
          title: doc.title,
          summary: doc.summary,
          content: doc.content,
          contentHash: doc.contentHash,
          effectiveDate: doc.effectiveDate,
          requiredCheckboxes: doc.requiredCheckboxes
        }
      };
    } catch (err) {
      return reply.status(404).send({ success: false, error: err.message });
    }
  });

  // 2. Check User Legal Acceptance Status (Fail-closed verification directly from Neon DB)
  fastify.get('/legal/status', async (req, reply) => {
    try {
      const { phone, role = 'customer', documentType } = req.query || {};
      if (!phone) {
        return reply.status(400).send({ success: false, error: 'Phone number is required to verify legal status' });
      }

      const status = await legalService.hasAcceptedActiveDocument({
        phone,
        role,
        documentType
      });

      return {
        success: true,
        status
      };
    } catch (err) {
      req.log.error('Legal status query error:', err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 3. Explicit Acceptance Submission (Stores in Neon DB with Section 65B Audit Evidence)
  fastify.post('/legal/accept', async (req, reply) => {
    try {
      const {
        phone,
        role = 'customer',
        documentType,
        version,
        documentHash
      } = req.body || {};

      if (!phone) {
        return reply.status(400).send({ success: false, error: 'Phone number is required' });
      }

      const clientIp = req.headers['x-forwarded-for']
        ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
        : req.ip || req.socket?.remoteAddress;
      const userAgent = req.headers['user-agent'] || 'Unknown Client';

      const result = await legalService.recordAcceptance({
        phone,
        role,
        documentType,
        version,
        documentHash,
        ip: clientIp,
        userAgent
      });

      if (!result.success) {
        return reply.status(400).send(result);
      }

      return {
        success: true,
        message: 'Legal agreement acceptance successfully registered.',
        record: result.record,
        documentType: result.documentType,
        version: result.version
      };
    } catch (err) {
      req.log.error('Legal acceptance submission error:', err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 4. Admin Audit List of Legal Acceptances
  fastify.get('/admin/legal/acceptances', async (req, reply) => {
    try {
      const { limit = 50, offset = 0, role } = req.query || {};
      let sql = `
        SELECT id, user_phone, user_role, document_type, document_version, document_hash, ip_address, accepted_at
        FROM legal_acceptances
      `;
      const params = [];

      if (role) {
        sql += ` WHERE user_role = $1`;
        params.push(role);
      }

      sql += ` ORDER BY accepted_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(parseInt(limit, 10), parseInt(offset, 10));

      const res = await query(sql, params);
      return {
        success: true,
        acceptances: res.rows
      };
    } catch (err) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });
}

module.exports = legalRoutes;
