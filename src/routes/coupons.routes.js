const { query } = require('../db/db');

async function couponsRoutes(fastify, options) {
  // Ensure coupons table exists and seed default promotional codes if empty
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS coupons (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        discount_type VARCHAR(20) DEFAULT 'flat', -- 'flat' (INR) or 'percent' (%)
        discount_value NUMERIC(10,2) NOT NULL,
        min_order_amount NUMERIC(10,2) DEFAULT 0.00,
        max_discount_cap NUMERIC(10,2) DEFAULT NULL,
        description VARCHAR(255),
        is_active BOOLEAN DEFAULT TRUE,
        valid_from TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        valid_until TIMESTAMP WITH TIME ZONE DEFAULT NULL,
        usage_limit INT DEFAULT NULL,
        times_used INT DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Seed default coupons if none exist
    const countRes = await query(`SELECT COUNT(*) as count FROM coupons`);
    if (parseInt(countRes.rows[0]?.count || 0, 10) === 0) {
      await query(`
        INSERT INTO coupons (code, discount_type, discount_value, min_order_amount, description, is_active)
        VALUES 
          ('SALEM50', 'flat', 50.00, 99.00, 'Flat INR 50 discount on doorstep inspection', TRUE),
          ('WELCOME20', 'percent', 20.00, 99.00, '20% off for new Salem customers (up to INR 60)', TRUE),
          ('FESTIVE30', 'flat', 30.00, 99.00, 'Salem Festive Special flat INR 30 off', TRUE)
      `);
    }
  } catch (err) {
    fastify.log.warn('Coupons table initialization warning: ' + err.message);
  }

  // Helper to calculate discount given coupon and order amount
  const computeDiscount = (coupon, bookingAmount) => {
    const amt = parseFloat(bookingAmount || 0);
    const minAmt = parseFloat(coupon.min_order_amount || 0);

    if (amt < minAmt) {
      return {
        valid: false,
        discount: 0,
        message: `Minimum order amount of INR ${minAmt.toFixed(0)} required for coupon ${coupon.code}`
      };
    }

    let discount = 0;
    if (coupon.discount_type === 'percent') {
      discount = (amt * parseFloat(coupon.discount_value)) / 100;
      if (coupon.max_discount_cap !== null && coupon.max_discount_cap !== undefined) {
        discount = Math.min(discount, parseFloat(coupon.max_discount_cap));
      }
    } else {
      discount = parseFloat(coupon.discount_value);
    }

    // Never exceed booking amount
    discount = Math.min(discount, amt);
    discount = Math.round(discount * 100) / 100;

    return {
      valid: true,
      discount,
      message: `Coupon ${coupon.code} applied: INR ${discount.toFixed(0)} off`
    };
  };

  // 1. GET /coupons/active - Public Available Coupons
  fastify.get('/coupons/active', async (req, reply) => {
    try {
      const res = await query(`
        SELECT id, code, discount_type, discount_value, min_order_amount, max_discount_cap, description, valid_until
        FROM coupons
        WHERE is_active = TRUE
          AND (valid_until IS NULL OR valid_until >= NOW())
          AND (usage_limit IS NULL OR times_used < usage_limit)
        ORDER BY created_at DESC
        LIMIT 20
      `);

      return {
        success: true,
        coupons: res.rows.map(r => ({
          id: r.id,
          code: r.code,
          discountType: r.discount_type,
          discountValue: parseFloat(r.discount_value),
          minOrderAmount: parseFloat(r.min_order_amount),
          maxDiscountCap: r.max_discount_cap ? parseFloat(r.max_discount_cap) : null,
          description: r.description,
          validUntil: r.valid_until
        }))
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 2. POST /coupons/validate & /coupons/apply - Validate a coupon code and return discount
  const handleValidateCoupon = async (req, reply) => {
    try {
      const { code, bookingAmount, orderAmount } = req.body || {};
      const evalAmount = parseFloat(orderAmount !== undefined ? orderAmount : (bookingAmount !== undefined ? bookingAmount : 99));

      if (!code || !code.trim()) {
        return reply.status(400).send({
          success: false,
          valid: false,
          discountAmount: 0,
          error: 'Please enter a coupon code'
        });
      }

      const cleanCode = code.trim().toUpperCase();
      const res = await query(`
        SELECT * FROM coupons
        WHERE UPPER(code) = $1
        LIMIT 1
      `, [cleanCode]);

      if (res.rows.length === 0) {
        return {
          success: false,
          valid: false,
          discountAmount: 0,
          error: `Invalid coupon code "${cleanCode}". Please verify and re-enter.`
        };
      }

      const coupon = res.rows[0];

      if (!coupon.is_active) {
        return {
          success: false,
          valid: false,
          discountAmount: 0,
          error: `Coupon "${cleanCode}" is no longer active.`
        };
      }

      if (coupon.valid_until && new Date(coupon.valid_until) < new Date()) {
        return {
          success: false,
          valid: false,
          discountAmount: 0,
          error: `Coupon "${cleanCode}" has expired.`
        };
      }

      if (coupon.usage_limit && coupon.times_used >= coupon.usage_limit) {
        return {
          success: false,
          valid: false,
          discountAmount: 0,
          error: `Coupon "${cleanCode}" usage limit has been reached.`
        };
      }

      const calc = computeDiscount(coupon, evalAmount);
      if (!calc.valid) {
        return {
          success: false,
          valid: false,
          discountAmount: 0,
          error: calc.message
        };
      }

      return {
        success: true,
        valid: true,
        code: coupon.code,
        discountType: coupon.discount_type,
        discountValue: parseFloat(coupon.discount_value),
        discountAmount: calc.discount,
        description: coupon.description,
        message: calc.message
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, valid: false, discountAmount: 0, error: err.message });
    }
  };

  fastify.post('/coupons/validate', handleValidateCoupon);
  fastify.post('/coupons/apply', handleValidateCoupon);

  // 3. GET /admin/coupons - Admin List All Coupons
  fastify.get('/admin/coupons', async (req, reply) => {
    try {
      const res = await query(`
        SELECT * FROM coupons
        ORDER BY created_at DESC
      `);

      return {
        success: true,
        count: res.rows.length,
        coupons: res.rows.map(r => ({
          id: r.id,
          code: r.code,
          discountType: r.discount_type,
          discountValue: parseFloat(r.discount_value),
          minOrderAmount: parseFloat(r.min_order_amount),
          maxDiscountCap: r.max_discount_cap ? parseFloat(r.max_discount_cap) : null,
          description: r.description,
          isActive: Boolean(r.is_active),
          usageLimit: r.usage_limit,
          timesUsed: parseInt(r.times_used || 0, 10),
          validFrom: r.valid_from,
          validUntil: r.valid_until,
          createdAt: r.created_at,
          updatedAt: r.updated_at
        }))
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 4. POST /admin/coupons - Admin Create Coupon
  fastify.post('/admin/coupons', async (req, reply) => {
    try {
      const {
        code,
        discountType = 'flat',
        discountValue,
        minOrderAmount = 0,
        maxDiscountCap = null,
        description = '',
        isActive = true,
        validUntil = null,
        usageLimit = null
      } = req.body || {};

      if (!code || !code.trim()) {
        return reply.status(400).send({ success: false, error: 'Coupon code is required' });
      }

      const val = parseFloat(discountValue);
      if (isNaN(val) || val <= 0) {
        return reply.status(400).send({ success: false, error: 'Valid discount value is required' });
      }

      const cleanCode = code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');

      // Check if duplicate code
      const dupCheck = await query(`SELECT id FROM coupons WHERE UPPER(code) = $1`, [cleanCode]);
      if (dupCheck.rows.length > 0) {
        return reply.status(400).send({ success: false, error: `Coupon code "${cleanCode}" already exists` });
      }

      const insertRes = await query(`
        INSERT INTO coupons (
          code, discount_type, discount_value, min_order_amount,
          max_discount_cap, description, is_active, valid_until, usage_limit
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *;
      `, [
        cleanCode,
        discountType === 'percent' ? 'percent' : 'flat',
        val,
        parseFloat(minOrderAmount) || 0,
        maxDiscountCap ? parseFloat(maxDiscountCap) : null,
        description.trim(),
        Boolean(isActive),
        validUntil ? new Date(validUntil) : null,
        usageLimit ? parseInt(usageLimit, 10) : null
      ]);

      // Audit log
      try {
        await query(`
          INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
          VALUES ('COUPON-NEW', 'COUPON_CREATED', 'admin_salem_central', 'admin', $1)
        `, [JSON.stringify({ code: cleanCode, discountType, discountValue: val, timestamp: new Date().toISOString() })]);
      } catch (auditErr) {}

      return {
        success: true,
        message: `Coupon "${cleanCode}" created successfully`,
        coupon: insertRes.rows[0]
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 5. PUT /admin/coupons/:id - Admin Edit / Toggle Coupon
  fastify.put('/admin/coupons/:id', async (req, reply) => {
    try {
      const { id } = req.params;
      const {
        code,
        discountType,
        discountValue,
        minOrderAmount,
        maxDiscountCap,
        description,
        isActive,
        validUntil,
        usageLimit
      } = req.body || {};

      const existingRes = await query(`SELECT * FROM coupons WHERE id = $1`, [id]);
      if (existingRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Coupon not found' });
      }

      const cur = existingRes.rows[0];
      const newCode = code ? code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '') : cur.code;
      const newType = discountType !== undefined ? discountType : cur.discount_type;
      const newVal = discountValue !== undefined ? parseFloat(discountValue) : parseFloat(cur.discount_value);
      const newMin = minOrderAmount !== undefined ? parseFloat(minOrderAmount) : parseFloat(cur.min_order_amount);
      const newCap = maxDiscountCap !== undefined ? (maxDiscountCap ? parseFloat(maxDiscountCap) : null) : cur.max_discount_cap;
      const newDesc = description !== undefined ? description : cur.description;
      const newActive = isActive !== undefined ? Boolean(isActive) : cur.is_active;
      const newExpiry = validUntil !== undefined ? (validUntil ? new Date(validUntil) : null) : cur.valid_until;
      const newLimit = usageLimit !== undefined ? (usageLimit ? parseInt(usageLimit, 10) : null) : cur.usage_limit;

      const updateRes = await query(`
        UPDATE coupons
        SET code = $1, discount_type = $2, discount_value = $3, min_order_amount = $4,
            max_discount_cap = $5, description = $6, is_active = $7, valid_until = $8,
            usage_limit = $9, updated_at = CURRENT_TIMESTAMP
        WHERE id = $10
        RETURNING *;
      `, [newCode, newType, newVal, newMin, newCap, newDesc, newActive, newExpiry, newLimit, id]);

      return {
        success: true,
        message: `Coupon "${newCode}" updated successfully`,
        coupon: updateRes.rows[0]
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 6. DELETE /admin/coupons/:id - Admin Delete Coupon
  fastify.delete('/admin/coupons/:id', async (req, reply) => {
    try {
      const { id } = req.params;
      const res = await query(`DELETE FROM coupons WHERE id = $1 RETURNING code;`, [id]);
      if (res.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Coupon not found' });
      }

      return {
        success: true,
        message: `Coupon "${res.rows[0].code}" deleted successfully`
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });
}

module.exports = couponsRoutes;
