const { query } = require('../db/db');
const { 
  getEnvCommissionPercent, 
  getLiveFeeSettings, 
  invalidateCommissionCache,
  getEnvUpiId,
  getEnvMerchantName
} = require('../services/commission.service');

async function settingsRoutes(fastify, options) {
  // Ensure platform_settings table exists and seed default configuration if empty
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        id VARCHAR(50) PRIMARY KEY DEFAULT 'reward_settings',
        referee_discount_amount NUMERIC(10,2) DEFAULT 50.00,
        partner_referral_incentive NUMERIC(10,2) DEFAULT 100.00,
        partner_welcome_bonus NUMERIC(10,2) DEFAULT 0.00,
        platform_commission_percent NUMERIC(5,2) DEFAULT 2.00,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_by VARCHAR(100) DEFAULT 'admin'
      );
      ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS platform_commission_percent NUMERIC(5,2) DEFAULT 2.00;
      ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS customer_platform_fee_percent NUMERIC(5,2) DEFAULT 2.00;
      ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS payment_gateway_fee_percent NUMERIC(5,2) DEFAULT 2.00;
      ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS gateway_fee_percent NUMERIC(5,2) DEFAULT 2.00;
      ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS partner_commission_percent NUMERIC(5,2) DEFAULT 2.00;
      ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS inspection_visit_fee NUMERIC(10,2) DEFAULT 99.00;
      ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS business_upi_id VARCHAR(150);
      ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS business_merchant_name VARCHAR(150);
      ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS payment_gateway_mode VARCHAR(50) DEFAULT 'DYNAMIC_QR';
    `);

    // Seed initial row if table is empty
    const checkRes = await query(`SELECT id FROM platform_settings WHERE id = 'reward_settings'`);
    if (checkRes.rows.length === 0) {
      await query(`
        INSERT INTO platform_settings (
          id, referee_discount_amount,
          partner_referral_incentive, partner_welcome_bonus, platform_commission_percent, updated_by
        ) VALUES (
          'reward_settings', 50.00, 100.00, 0.00, 2.00, 'system_init'
        )
      `);
    }
  } catch (err) {
    fastify.log.warn('Platform settings table initialization warning: ' + err.message);
  }

  // 1. GET /settings/rewards - Public Endpoint for Customer and Partner UI
  fastify.get('/settings/rewards', async (req, reply) => {
    try {
      const feeSettings = await getLiveFeeSettings();
      const partnerComm = feeSettings.partnerCommPercent;
      const partnerPayout = Math.max(0, 100 - partnerComm);

      const res = await query(`SELECT * FROM platform_settings WHERE id = 'reward_settings' LIMIT 1`);
      if (res.rows.length === 0) {
        return {
          success: true,
          settings: {
            customer_referral_credits: 50.00,
            referee_discount_amount: 50.00,
            review_reward_credits: 25.00,
            feedback_reward_credits: 0.00,
            feedback_rewards_enabled: false,
            partner_referral_incentive: 100.00,
            partner_welcome_bonus: 0.00,
            platform_commission_percent: partnerComm,
            partner_commission_percent: partnerComm,
            partner_payout_percent: partnerPayout,
            customer_platform_fee_percent: feeSettings.customerFeePercent,
            payment_gateway_fee_percent: feeSettings.gatewayFeePercent,
            inspection_visit_fee: feeSettings.inspectionVisitFee || 99.00
          }
        };
      }

      const row = res.rows[0] || {};
      return {
        success: true,
        settings: {
          referee_discount_amount: parseFloat(row.referee_discount_amount || 50),
          partner_referral_incentive: parseFloat(row.partner_referral_incentive || 100),
          partner_welcome_bonus: parseFloat(row.partner_welcome_bonus || 0),
          platform_commission_percent: partnerComm,
          partner_commission_percent: partnerComm,
          partner_payout_percent: partnerPayout,
          customer_platform_fee_percent: feeSettings.customerFeePercent,
          payment_gateway_fee_percent: feeSettings.gatewayFeePercent,
          inspection_visit_fee: parseFloat(row.inspection_visit_fee ?? feeSettings.inspectionVisitFee ?? 99.00),
          updated_at: row.updated_at
        }
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 1b. GET /settings/fees - Public Real-Time Fee Matrix
  fastify.get('/settings/fees', async (req, reply) => {
    try {
      const feeSettings = await getLiveFeeSettings();
      const partnerComm = feeSettings.partnerCommPercent;
      const partnerPayout = Math.max(0, 100 - partnerComm);
      return {
        success: true,
        fees: {
          customerPlatformFeePercent: feeSettings.customerFeePercent,
          paymentGatewayFeePercent: feeSettings.gatewayFeePercent,
          partnerCommissionPercent: partnerComm,
          partnerPayoutPercent: partnerPayout
        }
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 2. GET /admin/settings/rewards & /admin/reward-config - Admin View
  const handleGetRewards = async (req, reply) => {
    try {
      const res = await query(`SELECT * FROM platform_settings WHERE id = 'reward_settings' LIMIT 1`);
      const row = res.rows[0] || {
        referee_discount_amount: 50.00,
        partner_referral_incentive: 100.00,
        partner_welcome_bonus: 0.00,
        inspection_visit_fee: 99.00,
        updated_by: 'system',
        updated_at: new Date()
      };

      const settingsObj = {
        referee_discount_amount: parseFloat(row.referee_discount_amount || 50),
        partner_referral_incentive: parseFloat(row.partner_referral_incentive || 100),
        partner_welcome_bonus: parseFloat(row.partner_welcome_bonus || 0),
        partner_commission_percent: parseFloat(row.partner_commission_percent !== null && row.partner_commission_percent !== undefined ? row.partner_commission_percent : (row.platform_commission_percent || 2.0)),
        platform_commission_percent: parseFloat(row.platform_commission_percent !== null && row.platform_commission_percent !== undefined ? row.platform_commission_percent : (row.partner_commission_percent || 2.0)),
        customer_platform_fee_percent: parseFloat(row.customer_platform_fee_percent !== null && row.customer_platform_fee_percent !== undefined ? row.customer_platform_fee_percent : 2.0),
        payment_gateway_fee_percent: parseFloat(row.payment_gateway_fee_percent !== null && row.payment_gateway_fee_percent !== undefined ? row.payment_gateway_fee_percent : (row.gateway_fee_percent || 2.0)),
        inspection_visit_fee: parseFloat(row.inspection_visit_fee || 99),
        business_upi_id: getEnvUpiId() || row.business_upi_id || '',
        business_merchant_name: getEnvMerchantName() || row.business_merchant_name || '',
        payment_gateway_mode: row.payment_gateway_mode || 'DYNAMIC_QR',
        updated_by: row.updated_by,
        updated_at: row.updated_at
      };

      return {
        success: true,
        settings: settingsObj,
        config: settingsObj
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  };

  fastify.get('/admin/settings/rewards', handleGetRewards);
  fastify.get('/admin/reward-config', handleGetRewards);

  // 3. POST & PUT /admin/settings/rewards & /admin/reward-config - Update Reward & Credit Rates
  const handleUpdateRewards = async (req, reply) => {
    try {
      const {
        referee_discount_amount,
        partner_referral_incentive,
        partner_welcome_bonus,
        partner_commission_percent,
        platform_commission_percent,
        customer_platform_fee_percent,
        payment_gateway_fee_percent,
        inspection_visit_fee,
        business_upi_id,
        business_merchant_name,
        payment_gateway_mode,
        updated_by = 'admin_salem_central'
      } = req.body || {};

      const currentRes = await query(`SELECT * FROM platform_settings WHERE id = 'reward_settings' LIMIT 1`);
      const current = currentRes.rows[0] || {};

      const newRefDisc = referee_discount_amount !== undefined ? Math.max(0, parseFloat(referee_discount_amount)) : parseFloat(current.referee_discount_amount || 50);
      const newPartnerIncentive = partner_referral_incentive !== undefined ? Math.max(0, parseFloat(partner_referral_incentive)) : parseFloat(current.partner_referral_incentive || 100);
      const newPartnerBonus = partner_welcome_bonus !== undefined ? Math.max(0, parseFloat(partner_welcome_bonus)) : parseFloat(current.partner_welcome_bonus || 0);
      const rawComm = partner_commission_percent !== undefined ? partner_commission_percent : platform_commission_percent;
      const newCommission = rawComm !== undefined
        ? Math.max(0, Math.min(100, parseFloat(rawComm)))
        : parseFloat(current.partner_commission_percent || current.platform_commission_percent || 2.0);
      const newCustFee = customer_platform_fee_percent !== undefined
        ? Math.max(0, Math.min(100, parseFloat(customer_platform_fee_percent)))
        : parseFloat(current.customer_platform_fee_percent || 2.0);
      const newGatewayFee = payment_gateway_fee_percent !== undefined
        ? Math.max(0, Math.min(100, parseFloat(payment_gateway_fee_percent)))
        : parseFloat(current.payment_gateway_fee_percent || current.gateway_fee_percent || 2.0);
      const newVisitFee = inspection_visit_fee !== undefined
        ? Math.max(0, parseFloat(inspection_visit_fee))
        : parseFloat(current.inspection_visit_fee || 99);
      const defaultUpi = getEnvUpiId() || current.business_upi_id || '';
      const defaultMerchant = getEnvMerchantName() || current.business_merchant_name || '';
      const newBusinessUpi = business_upi_id !== undefined ? String(business_upi_id).trim() : defaultUpi;
      const newBusinessMerchant = business_merchant_name !== undefined ? String(business_merchant_name).trim() : defaultMerchant;
      const newPaymentMode = payment_gateway_mode !== undefined ? String(payment_gateway_mode).trim() : (current.payment_gateway_mode || 'DYNAMIC_QR');

      const updateSql = `
        INSERT INTO platform_settings (
          id, referee_discount_amount,
          partner_referral_incentive, partner_welcome_bonus, 
          partner_commission_percent, platform_commission_percent,
          customer_platform_fee_percent, payment_gateway_fee_percent, gateway_fee_percent,
          inspection_visit_fee, business_upi_id, business_merchant_name, payment_gateway_mode,
          updated_at, updated_by
        ) VALUES (
          'reward_settings', $1, $2, $3, $4, $4, $5, $6, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP, $11
        )
        ON CONFLICT (id) DO UPDATE SET
          referee_discount_amount = EXCLUDED.referee_discount_amount,
          partner_referral_incentive = EXCLUDED.partner_referral_incentive,
          partner_welcome_bonus = EXCLUDED.partner_welcome_bonus,
          partner_commission_percent = EXCLUDED.partner_commission_percent,
          platform_commission_percent = EXCLUDED.platform_commission_percent,
          customer_platform_fee_percent = EXCLUDED.customer_platform_fee_percent,
          payment_gateway_fee_percent = EXCLUDED.payment_gateway_fee_percent,
          gateway_fee_percent = EXCLUDED.gateway_fee_percent,
          inspection_visit_fee = EXCLUDED.inspection_visit_fee,
          business_upi_id = EXCLUDED.business_upi_id,
          business_merchant_name = EXCLUDED.business_merchant_name,
          payment_gateway_mode = EXCLUDED.payment_gateway_mode,
          updated_at = CURRENT_TIMESTAMP,
          updated_by = EXCLUDED.updated_by
        RETURNING *;
      `;

      const result = await query(updateSql, [
        newRefDisc,
        newPartnerIncentive,
        newPartnerBonus,
        newCommission,
        newCustFee,
        newGatewayFee,
        newVisitFee,
        newBusinessUpi,
        newBusinessMerchant,
        newPaymentMode,
        updated_by
      ]);

      invalidateCommissionCache();

      // Record in audit log
      try {
        await query(`
          INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
          VALUES ('SETTINGS-REWARDS', 'REWARD_SETTINGS_UPDATED', $1, 'admin', $2)
        `, [
          updated_by,
          JSON.stringify({
            referee_discount_amount: newRefDisc,
            partner_referral_incentive: newPartnerIncentive,
            partner_welcome_bonus: newPartnerBonus,
            timestamp: new Date().toISOString()
          })
        ]);
      } catch (auditErr) {}

      return {
        success: true,
        message: 'Reward and referral settings updated successfully in database',
        settings: {
          referee_discount_amount: parseFloat(result.rows[0].referee_discount_amount),
          partner_referral_incentive: parseFloat(result.rows[0].partner_referral_incentive),
          partner_welcome_bonus: parseFloat(result.rows[0].partner_welcome_bonus),
          partner_commission_percent: parseFloat(result.rows[0].partner_commission_percent ?? result.rows[0].platform_commission_percent ?? 2.0),
          platform_commission_percent: parseFloat(result.rows[0].platform_commission_percent ?? result.rows[0].partner_commission_percent ?? 2.0),
          customer_platform_fee_percent: parseFloat(result.rows[0].customer_platform_fee_percent ?? 2.0),
          payment_gateway_fee_percent: parseFloat(result.rows[0].payment_gateway_fee_percent ?? result.rows[0].gateway_fee_percent ?? 2.0),
          inspection_visit_fee: parseFloat(result.rows[0].inspection_visit_fee ?? 99.0),
          updated_at: result.rows[0].updated_at
        }
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  };

  fastify.post('/admin/settings/rewards', handleUpdateRewards);
  fastify.post('/admin/reward-config', handleUpdateRewards);
  fastify.put('/admin/reward-config', handleUpdateRewards);
}

module.exports = settingsRoutes;
