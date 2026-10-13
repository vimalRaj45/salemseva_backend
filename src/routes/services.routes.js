const { query } = require('../db/db');
const { translateText } = require('../services/translate.service');

async function servicesRoutes(fastify, options) {
  // 1. Get all core services from DB
  fastify.get('/services', async (req, reply) => {
    try {
      const lang = req.query.lang || 'en';
      const result = await query('SELECT * FROM services WHERE is_active = TRUE ORDER BY visit_fee ASC');
      
      const services = result.rows.map(s => ({
        id: s.id,
        name: lang === 'ta' ? s.name_ta : s.name_en,
        category: s.category,
        visitFee: parseFloat(s.visit_fee),
        priceRange: lang === 'ta' ? s.est_price_range_ta : s.est_price_range_en,
        icon: s.icon,
        colorHex: s.color_hex
      }));

      return { success: true, count: services.length, services };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 2. Get single service details from DB
  fastify.get('/services/:id', async (req, reply) => {
    try {
      const { id } = req.params;
      const lang = req.query.lang || 'en';
      const result = await query('SELECT * FROM services WHERE id = $1', [id]);
      
      if (result.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Service not found' });
      }

      const s = result.rows[0];
      return {
        success: true,
        service: {
          id: s.id,
          name: lang === 'ta' ? s.name_ta : s.name_en,
          category: s.category,
          visitFee: parseFloat(s.visit_fee),
          priceRange: lang === 'ta' ? s.est_price_range_ta : s.est_price_range_en,
          icon: s.icon,
          colorHex: s.color_hex
        }
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 3. Get common issues for a specific service from DB
  fastify.get('/services/:id/issues', async (req, reply) => {
    try {
      const { id } = req.params;
      const lang = req.query.lang || 'en';

      const result = await query(
        'SELECT * FROM service_issues WHERE service_id = $1 ORDER BY is_custom ASC',
        [id]
      );

      const issues = result.rows.map(issue => ({
        id: issue.id,
        name: lang === 'ta' ? issue.name_ta : issue.name_en,
        icon: issue.icon,
        estRange: issue.est_range,
        isCustom: issue.is_custom
      }));

      return { success: true, serviceId: id, count: issues.length, issues };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });


  // 5. Get Real Spares & Labor Catalog for a Service from DB
  fastify.get('/services/:id/spares', async (req, reply) => {
    try {
      const { id } = req.params;
      const res = await query(
        'SELECT * FROM service_spares_catalog WHERE service_id = $1 ORDER BY is_oem_part DESC, unit_price DESC',
        [id]
      );
      return {
        success: true,
        serviceId: id,
        count: res.rows.length,
        items: res.rows.map(item => ({
          id: item.id,
          name: item.item_name,
          type: item.item_type,
          price: parseFloat(item.unit_price),
          qty: 1,
          isOem: Boolean(item.is_oem_part),
          partNumber: item.part_number,
          dealerName: item.dealer_name
        }))
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // ==========================================
  // 6. ADMIN FULL CRUD FOR SERVICES & INSPECTION FEES
  // ==========================================

  // GET /admin/services - List all services with inspection fees & status
  fastify.get('/admin/services', async (req, reply) => {
    try {
      const res = await query('SELECT * FROM services ORDER BY created_at ASC, id ASC');
      return {
        success: true,
        count: res.rows.length,
        services: res.rows.map(s => ({
          id: s.id,
          name: s.name_en,
          name_en: s.name_en,
          name_ta: s.name_ta,
          category: s.category,
          visit_fee: s.visit_fee,
          visitFee: parseFloat(s.visit_fee),
          inspectionFee: parseFloat(s.visit_fee),
          base_price: s.est_price_range_en,
          estPriceRangeEn: s.est_price_range_en,
          estPriceRangeTa: s.est_price_range_ta,
          icon: s.icon,
          colorHex: s.color_hex,
          isActive: Boolean(s.is_active),
          createdAt: s.created_at
        }))
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // POST /admin/services - Create new service category
  fastify.post('/admin/services', async (req, reply) => {
    try {
      const {
        id,
        name_en,
        name_ta,
        category = 'Home Maintenance',
        visitFee = 99.00,
        estPriceRangeEn = 'INR 299 - INR 1,499',
        estPriceRangeTa = 'ரூ.299 - ரூ.1,499',
        icon = 'home_repair_service',
        colorHex = '#0284c7',
        isActive = true
      } = req.body || {};

      if (!id || !name_en) {
        return reply.status(400).send({ success: false, error: 'Service ID and English Name are required' });
      }

      const cleanId = id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');

      // Check duplicate
      const dup = await query('SELECT id FROM services WHERE id = $1', [cleanId]);
      if (dup.rows.length > 0) {
        return reply.status(400).send({ success: false, error: `Service with ID "${cleanId}" already exists` });
      }

      const insertRes = await query(`
        INSERT INTO services (
          id, name_en, name_ta, category, visit_fee,
          est_price_range_en, est_price_range_ta, icon, color_hex, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *;
      `, [
        cleanId,
        name_en.trim(),
        (name_ta || name_en).trim(),
        category.trim(),
        parseFloat(visitFee) || 99.00,
        estPriceRangeEn,
        estPriceRangeTa,
        icon,
        colorHex,
        Boolean(isActive)
      ]);

      // Audit log
      try {
        await query(`
          INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
          VALUES ('SERVICE-NEW', 'SERVICE_CREATED', 'admin_salem_central', 'admin', $1)
        `, [JSON.stringify({ serviceId: cleanId, visitFee, name_en, timestamp: new Date().toISOString() })]);
      } catch (auditErr) {}

      return {
        success: true,
        message: `Service "${name_en}" created successfully with Inspection Fee INR ${parseFloat(visitFee)}`,
        service: insertRes.rows[0]
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // PUT /admin/services/:id - Update full service parameters
  fastify.put('/admin/services/:id', async (req, reply) => {
    try {
      const { id } = req.params;
      const {
        name_en,
        name_ta,
        category,
        visitFee,
        estPriceRangeEn,
        estPriceRangeTa,
        icon,
        colorHex,
        isActive
      } = req.body || {};

      const curRes = await query('SELECT * FROM services WHERE id = $1', [id]);
      if (curRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Service not found' });
      }

      const cur = curRes.rows[0];
      const newNameEn = name_en !== undefined ? name_en.trim() : cur.name_en;
      const newNameTa = name_ta !== undefined ? name_ta.trim() : cur.name_ta;
      const newCat = category !== undefined ? category.trim() : cur.category;
      const newFee = visitFee !== undefined ? parseFloat(visitFee) : parseFloat(cur.visit_fee);
      const newRangeEn = estPriceRangeEn !== undefined ? estPriceRangeEn : cur.est_price_range_en;
      const newRangeTa = estPriceRangeTa !== undefined ? estPriceRangeTa : cur.est_price_range_ta;
      const newIcon = icon !== undefined ? icon : cur.icon;
      const newColor = colorHex !== undefined ? colorHex : cur.color_hex;
      const newActive = isActive !== undefined ? Boolean(isActive) : cur.is_active;

      const updateRes = await query(`
        UPDATE services 
        SET name_en = $1, name_ta = $2, category = $3, visit_fee = $4,
            est_price_range_en = $5, est_price_range_ta = $6, icon = $7,
            color_hex = $8, is_active = $9
        WHERE id = $10
        RETURNING *;
      `, [newNameEn, newNameTa, newCat, newFee, newRangeEn, newRangeTa, newIcon, newColor, newActive, id]);

      // Audit log
      try {
        await query(`
          INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
          VALUES ('SERVICE-UPDATE', 'SERVICE_UPDATED', 'admin_salem_central', 'admin', $1)
        `, [JSON.stringify({ serviceId: id, oldFee: cur.visit_fee, newFee, timestamp: new Date().toISOString() })]);
      } catch (auditErr) {}

      return {
        success: true,
        message: `Service "${newNameEn}" updated successfully. Inspection fee: INR ${newFee}`,
        service: updateRes.rows[0]
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // PATCH /admin/services/:id/fee - Fast Inspection Fee update
  fastify.patch('/admin/services/:id/fee', async (req, reply) => {
    try {
      const { id } = req.params;
      const { visitFee } = req.body || {};

      if (visitFee === undefined || isNaN(parseFloat(visitFee))) {
        return reply.status(400).send({ success: false, error: 'Valid visitFee is required' });
      }

      const numericFee = Math.max(0, parseFloat(visitFee));

      const updateRes = await query(`
        UPDATE services 
        SET visit_fee = $1 
        WHERE id = $2 
        RETURNING *;
      `, [numericFee, id]);

      if (updateRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Service not found' });
      }

      return {
        success: true,
        message: `Inspection fee for ${updateRes.rows[0].name_en} updated to INR ${numericFee}`,
        service: updateRes.rows[0]
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // DELETE /admin/services/:id - Delete or de-activate service
  fastify.delete('/admin/services/:id', async (req, reply) => {
    try {
      const { id } = req.params;
      const res = await query('DELETE FROM services WHERE id = $1 RETURNING name_en;', [id]);
      if (res.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Service not found' });
      }
      return {
        success: true,
        message: `Service "${res.rows[0].name_en}" deleted successfully`
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });
}

module.exports = servicesRoutes;
