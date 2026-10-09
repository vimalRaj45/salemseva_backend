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
}

module.exports = servicesRoutes;
