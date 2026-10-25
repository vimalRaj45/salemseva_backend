const { query } = require('../db/db');
const { getEnvCommissionPercent, invalidateCommissionCache } = require('../services/commission.service');

async function settingsRoutes(fastify, options) {
  // Ensure platform_settings table exists and seed default configuration if empty
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        id VARCHAR(50) PRIMARY KEY DEFAULT 'reward_settings',
        customer_referral_credits NUMERIC(10,2) DEFAULT 50.00,
        referee_discount_amount NUMERIC(10,2) DEFAULT 50.00,
        review_reward_credits NUMERIC(10,2) DEFAULT 25.00,
        feedback_reward_credits NUMERIC(10,2) DEFAULT 15.00,
        feedback_rewards_enabled BOOLEAN DEFAULT TRUE,
        partner_referral_incentive NUMERIC(10,2) DEFAULT 100.00,
        partner_welcome_bonus NUMERIC(10,2) DEFAULT 50.00,
        platform_commission_percent NUMERIC(5,2) DEFAULT 2.00,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_by VARCHAR(100) DEFAULT 'admin'
      );
      ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS platform_commission_percent NUMERIC(5,2) DEFAULT 2.00;
    `);

    // Seed initial row if table is empty
    const checkRes = await query(`SELECT id FROM platform_settings WHERE id = 'reward_settings'`);
    if (checkRes.rows.length === 0) {
      await query(`
        INSERT INTO platform_settings (
          id, customer_referral_credits, referee_discount_amount,
          review_reward_credits, feedback_reward_credits, feedback_rewards_enabled,
          partner_referral_incentive, partner_welcome_bonus, platform_commission_percent, updated_by
        ) VALUES (
          'reward_settings', 50.00, 50.00, 25.00, 15.00, TRUE, 100.00, 50.00, 2.00, 'system_init'
        )
      `);
    }
  } catch (err) {
    fastify.log.warn('Platform settings table initialization warning: ' + err.message);
  }

  // 1. GET /settings/rewards - Public Endpoint for Customer and Partner UI
  fastify.get('/settings/rewards', async (req, reply) => {
    try {
      const res = await query(`SELECT * FROM platform_settings WHERE id = 'reward_settings' LIMIT 1`);
      if (res.rows.length === 0) {
        return {
          success: true,
          settings: {
            customer_referral_credits: 50.00,
            referee_discount_amount: 50.00,
            review_reward_credits: 25.00,
            feedback_reward_credits: 15.00,
            feedback_rewards_enabled: true,
            partner_referral_incentive: 100.00,
            partner_welcome_bonus: 50.00
          }
        };
      }

      const row = res.rows[0];
      return {
        success: true,
        settings: {
          customer_referral_credits: parseFloat(row.customer_referral_credits),
          referee_discount_amount: parseFloat(row.referee_discount_amount),
          review_reward_credits: parseFloat(row.review_reward_credits),
          feedback_reward_credits: parseFloat(row.feedback_reward_credits),
          feedback_rewards_enabled: Boolean(row.feedback_rewards_enabled),
          partner_referral_incentive: parseFloat(row.partner_referral_incentive),
          partner_welcome_bonus: parseFloat(row.partner_welcome_bonus),
          updated_at: row.updated_at
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
        customer_referral_credits: 50.00,
        referee_discount_amount: 50.00,
        review_reward_credits: 25.00,
        feedback_reward_credits: 15.00,
        feedback_rewards_enabled: true,
        partner_referral_incentive: 100.00,
        partner_welcome_bonus: 50.00,
        inspection_visit_fee: 99.00,
        updated_by: 'system',
        updated_at: new Date()
      };

      const settingsObj = {
        customer_referral_credits: parseFloat(row.customer_referral_credits || 50),
        referee_discount_amount: parseFloat(row.referee_discount_amount || 50),
        review_reward_credits: parseFloat(row.review_reward_credits || 25),
        feedback_reward_credits: parseFloat(row.feedback_reward_credits || 15),
        feedback_rewards_enabled: Boolean(row.feedback_rewards_enabled),
        partner_referral_incentive: parseFloat(row.partner_referral_incentive || 100),
        partner_welcome_bonus: parseFloat(row.partner_welcome_bonus || 50),
        platform_commission_percent: parseFloat(row.platform_commission_percent !== null && row.platform_commission_percent !== undefined ? row.platform_commission_percent : getEnvCommissionPercent()),
        inspection_visit_fee: parseFloat(row.inspection_visit_fee || 99),
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
        customer_referral_credits,
        referee_discount_amount,
        review_reward_credits,
        feedback_reward_credits,
        feedback_rewards_enabled,
        partner_referral_incentive,
        partner_welcome_bonus,
        platform_commission_percent,
        updated_by = 'admin_salem_central'
      } = req.body || {};

      const currentRes = await query(`SELECT * FROM platform_settings WHERE id = 'reward_settings' LIMIT 1`);
      const current = currentRes.rows[0] || {};

      const newCustRef = customer_referral_credits !== undefined ? Math.max(0, parseFloat(customer_referral_credits)) : parseFloat(current.customer_referral_credits || 50);
      const newRefDisc = referee_discount_amount !== undefined ? Math.max(0, parseFloat(referee_discount_amount)) : parseFloat(current.referee_discount_amount || 50);
      const newRevCredits = review_reward_credits !== undefined ? Math.max(0, parseFloat(review_reward_credits)) : parseFloat(current.review_reward_credits || 25);
      const newFbCredits = feedback_reward_credits !== undefined ? Math.max(0, parseFloat(feedback_reward_credits)) : parseFloat(current.feedback_reward_credits || 15);
      const newFbEnabled = feedback_rewards_enabled !== undefined ? Boolean(feedback_rewards_enabled) : Boolean(current.feedback_rewards_enabled ?? true);
      const newPartnerIncentive = partner_referral_incentive !== undefined ? Math.max(0, parseFloat(partner_referral_incentive)) : parseFloat(current.partner_referral_incentive || 100);
      const newPartnerBonus = partner_welcome_bonus !== undefined ? Math.max(0, parseFloat(partner_welcome_bonus)) : parseFloat(current.partner_welcome_bonus || 50);
      const newCommission = platform_commission_percent !== undefined
        ? Math.max(0, Math.min(100, parseFloat(platform_commission_percent)))
        : parseFloat(current.platform_commission_percent !== null && current.platform_commission_percent !== undefined ? current.platform_commission_percent : getEnvCommissionPercent());

      const updateSql = `
        INSERT INTO platform_settings (
          id, customer_referral_credits, referee_discount_amount,
          review_reward_credits, feedback_reward_credits, feedback_rewards_enabled,
          partner_referral_incentive, partner_welcome_bonus, platform_commission_percent, updated_at, updated_by
        ) VALUES (
          'reward_settings', $1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, $9
        )
        ON CONFLICT (id) DO UPDATE SET
          customer_referral_credits = EXCLUDED.customer_referral_credits,
          referee_discount_amount = EXCLUDED.referee_discount_amount,
          review_reward_credits = EXCLUDED.review_reward_credits,
          feedback_reward_credits = EXCLUDED.feedback_reward_credits,
          feedback_rewards_enabled = EXCLUDED.feedback_rewards_enabled,
          partner_referral_incentive = EXCLUDED.partner_referral_incentive,
          partner_welcome_bonus = EXCLUDED.partner_welcome_bonus,
          platform_commission_percent = EXCLUDED.platform_commission_percent,
          updated_at = CURRENT_TIMESTAMP,
          updated_by = EXCLUDED.updated_by
        RETURNING *;
      `;

      const result = await query(updateSql, [
        newCustRef,
        newRefDisc,
        newRevCredits,
        newFbCredits,
        newFbEnabled,
        newPartnerIncentive,
        newPartnerBonus,
        newCommission,
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
            customer_referral_credits: newCustRef,
            referee_discount_amount: newRefDisc,
            review_reward_credits: newRevCredits,
            feedback_reward_credits: newFbCredits,
            feedback_rewards_enabled: newFbEnabled,
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
          customer_referral_credits: parseFloat(result.rows[0].customer_referral_credits),
          referee_discount_amount: parseFloat(result.rows[0].referee_discount_amount),
          review_reward_credits: parseFloat(result.rows[0].review_reward_credits),
          feedback_reward_credits: parseFloat(result.rows[0].feedback_reward_credits),
          feedback_rewards_enabled: Boolean(result.rows[0].feedback_rewards_enabled),
          partner_referral_incentive: parseFloat(result.rows[0].partner_referral_incentive),
          partner_welcome_bonus: parseFloat(result.rows[0].partner_welcome_bonus),
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
