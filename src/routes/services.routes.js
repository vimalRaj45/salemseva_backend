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


  // 4. Get Technician Domain Availability and Slot Capacity for a Service
  fastify.get('/services/:id/availability', async (req, reply) => {
    try {
      const { id } = req.params;
      const lang = req.query.lang || 'en';

      const svcRes = await query('SELECT * FROM services WHERE id = $1', [id]);
      if (svcRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Service not found' });
      }
      const s = svcRes.rows[0];
      const serviceName = lang === 'ta' ? s.name_ta : s.name_en;

      // Check verified, unblocked technicians for this trade in Salem
      const techsRes = await query(`
        SELECT id, full_name, phone, is_online, rating_avg, primary_trade, secondary_trades
        FROM technicians 
        WHERE (primary_trade = $1 OR (secondary_trades IS NOT NULL AND $1 = ANY(secondary_trades)))
          AND is_blocked = FALSE 
          AND is_kyc_verified = TRUE;
      `, [id]);

      const totalTechnicians = techsRes.rows.length;
      const onlineTechnicians = techsRes.rows.filter(t => Boolean(t.is_online)).length;

      // Case 1: No technician in system for this domain
      if (totalTechnicians === 0) {
        return {
          success: true,
          serviceId: id,
          serviceName,
          hasTechniciansInDomain: false,
          totalTechnicians: 0,
          onlineTechnicians: 0,
          isTemporarilyClosed: true,
          notice: {
            title: lang === 'ta' 
              ? `${serviceName} சேவை தற்காலிகமாக மூடப்பட்டுள்ளது`
              : `${serviceName} Temporarily Closed in Salem`,
            description: lang === 'ta'
              ? `சேலம் மற்றும் சுற்றுவட்டார பகுதிகளில் தற்போது ${serviceName} தொழில்நுட்ப வல்லுநர்கள் பதிவு செய்யப்படவில்லை. சான்றளிக்கப்பட்ட உள்ளூர் நிபுணர்களை சேர்க்க தீவிரமாக தேடி வருகிறோம்.`
              : `No certified ${serviceName} technicians are currently available in Salem & surroundings. We are actively looking for certified technicians for this domain. Service is temporarily closed.`,
            badge: lang === 'ta' ? 'தற்காலிகமாக மூடப்பட்டுள்ளது' : 'Temporarily Closed',
            status: 'temporarily_closed'
          },
          dates: {}
        };
      }

      // Case 2: Technicians exist -> Calculate 14-day capacity and slot availability
      const dailyCapacityPerTech = 4;
      const totalDailyCapacity = Math.max(1, totalTechnicians * dailyCapacityPerTech);

      // Fetch existing active bookings for this service
      const bookingsRes = await query(`
        SELECT id, scheduled_slot, status, created_at
        FROM bookings
        WHERE service_id = $1
          AND status != 'cancelled';
      `, [id]);

      const activeBookings = bookingsRes.rows;

      // Generate 14-day slot map starting today
      const datesAvailability = {};
      const standardSlots = [
        '08:00 AM - 10:00 AM',
        '10:00 AM - 12:00 PM',
        '12:00 PM - 02:00 PM',
        '02:00 PM - 04:00 PM',
        '04:00 PM - 06:00 PM',
        '06:00 PM - 08:00 PM'
      ];

      for (let i = 0; i < 14; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i);
        const iso = d.toISOString().split('T')[0];

        // Filter bookings matching this date
        const dateBookings = activeBookings.filter(b => {
          const slot = b.scheduled_slot || '';
          if (slot.includes(iso)) return true;
          const createdIso = new Date(b.created_at).toISOString().split('T')[0];
          return slot.includes(iso) || (!slot.match(/202\d-\d{2}-\d{2}/) && createdIso === iso);
        });

        const bookedCount = dateBookings.length;
        const isFullyBooked = bookedCount >= totalDailyCapacity;

        // Slot level counts
        const slotsStatus = {};
        for (const slotName of standardSlots) {
          const countInSlot = dateBookings.filter(b => (b.scheduled_slot || '').includes(slotName)).length;
          slotsStatus[slotName] = {
            booked: countInSlot,
            capacity: totalTechnicians,
            isFull: countInSlot >= totalTechnicians
          };
        }

        datesAvailability[iso] = {
          iso,
          bookedCount,
          totalCapacity: totalDailyCapacity,
          isFullyBooked,
          slots: slotsStatus,
          message: isFullyBooked 
            ? (lang === 'ta' ? 'இந்த தேதியில் அனைத்து தொழில்நுட்ப வல்லுநர்களும் முன்பதிவு செய்யப்பட்டுள்ளனர். மற்றொரு தேதியைத் தேர்ந்தெடுக்கவும்.' : 'All technicians are booked on this date. Please choose another date.')
            : null
        };
      }

      return {
        success: true,
        serviceId: id,
        serviceName,
        hasTechniciansInDomain: true,
        totalTechnicians,
        onlineTechnicians,
        isTemporarilyClosed: false,
        totalDailyCapacity,
        dailyCapacityPerTech,
        dates: datesAvailability
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 4b. Summary of all services technician availability
  fastify.get('/services-availability', async (req, reply) => {
    try {
      const servicesRes = await query('SELECT id, name_en, name_ta FROM services WHERE is_active = TRUE');
      const techsRes = await query(`
        SELECT id, primary_trade, secondary_trades, is_online 
        FROM technicians 
        WHERE is_blocked = FALSE AND is_kyc_verified = TRUE;
      `);

      const allTechs = techsRes.rows;
      const availabilitySummary = {};

      for (const s of servicesRes.rows) {
        const matchingTechs = allTechs.filter(t => 
          t.primary_trade === s.id || 
          (Array.isArray(t.secondary_trades) && t.secondary_trades.includes(s.id))
        );
        availabilitySummary[s.id] = {
          hasTechnicians: matchingTechs.length > 0,
          totalTechnicians: matchingTechs.length,
          onlineTechnicians: matchingTechs.filter(t => Boolean(t.is_online)).length,
          isTemporarilyClosed: matchingTechs.length === 0
        };
      }

      return { success: true, services: availabilitySummary };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });
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
      const body = req.body || {};
      const id = body.id;
      const name_en = body.name_en ?? body.name;
      const name_ta = body.name_ta;
      const category = body.category || 'Home Maintenance';
      const rawFee = body.visitFee ?? body.visit_fee ?? body.fee;
      const visitFee = rawFee !== undefined && !isNaN(parseFloat(rawFee)) ? parseFloat(rawFee) : 99.00;
      const estPriceRangeEn = body.estPriceRangeEn ?? body.est_price_range_en ?? (body.base_price ? `INR ${body.base_price}` : 'INR 299 - INR 1,499');
      const estPriceRangeTa = body.estPriceRangeTa ?? body.est_price_range_ta ?? (body.base_price ? `ரூ.${body.base_price}` : 'ரூ.299 - ரூ.1,499');
      const icon = body.icon || 'home_repair_service';
      const colorHex = body.colorHex ?? body.color_hex ?? '#0284c7';
      const isActive = body.isActive !== undefined ? Boolean(body.isActive) : (body.is_active !== undefined ? Boolean(body.is_active) : true);

      if (!id || !name_en) {
        return reply.status(400).send({ success: false, error: 'Service ID and English Name are required' });
      }

      const cleanId = String(id).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');

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
        String(name_en).trim(),
        (name_ta || name_en).trim(),
        category.trim(),
        parseFloat(visitFee),
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
      const body = req.body || {};

      const curRes = await query('SELECT * FROM services WHERE id = $1', [id]);
      if (curRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Service not found' });
      }

      const cur = curRes.rows[0];
      const rawNameEn = body.name_en ?? body.name;
      const rawNameTa = body.name_ta;
      const rawCat = body.category;
      const rawFee = body.visitFee ?? body.visit_fee ?? body.fee;
      const rawRangeEn = body.estPriceRangeEn ?? body.est_price_range_en ?? body.base_price;
      const rawRangeTa = body.estPriceRangeTa ?? body.est_price_range_ta;
      const rawIcon = body.icon;
      const rawColor = body.colorHex ?? body.color_hex;
      const rawActive = body.isActive !== undefined ? body.isActive : body.is_active;

      const newNameEn = rawNameEn !== undefined && String(rawNameEn).trim() ? String(rawNameEn).trim() : cur.name_en;
      const newNameTa = rawNameTa !== undefined && String(rawNameTa).trim() ? String(rawNameTa).trim() : cur.name_ta;
      const newCat = rawCat !== undefined && String(rawCat).trim() ? String(rawCat).trim() : cur.category;
      const newFee = rawFee !== undefined && !isNaN(parseFloat(rawFee)) ? Math.max(0, parseFloat(rawFee)) : parseFloat(cur.visit_fee);
      const newRangeEn = rawRangeEn !== undefined ? String(rawRangeEn) : cur.est_price_range_en;
      const newRangeTa = rawRangeTa !== undefined ? String(rawRangeTa) : cur.est_price_range_ta;
      const newIcon = rawIcon !== undefined ? rawIcon : cur.icon;
      const newColor = rawColor !== undefined ? rawColor : cur.color_hex;
      const newActive = rawActive !== undefined ? Boolean(rawActive) : cur.is_active;

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

  // PATCH / PUT /admin/services/:id/fee - Fast Inspection Fee update
  const handleFeeUpdate = async (req, reply) => {
    try {
      const { id } = req.params;
      const rawFee = req.body?.visitFee ?? req.body?.visit_fee ?? req.body?.fee;

      if (rawFee === undefined || isNaN(parseFloat(rawFee))) {
        return reply.status(400).send({ success: false, error: 'Valid visitFee is required' });
      }

      const numericFee = Math.max(0, parseFloat(rawFee));

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
  };

  fastify.patch('/admin/services/:id/fee', handleFeeUpdate);
  fastify.put('/admin/services/:id/fee', handleFeeUpdate);

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
