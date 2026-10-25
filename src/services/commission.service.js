const { query } = require('../db/db');

/**
 * Shazu One Dual-Commission & Razorpay Route Engine
 * Configurable via .env:
 * - CUSTOMER_PLATFORM_FEE_PERCENT (Default: 2.0%)
 * - PAYMENT_GATEWAY_FEE_PERCENT (Default: 2.0%)
 * - PARTNER_COMMISSION_PERCENT (Default: 5.0%)
 */

let cachedSettings = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 30000;

function getCustomerPlatformFeePercent() {
  const envVal = parseFloat(process.env.CUSTOMER_PLATFORM_FEE_PERCENT);
  return !isNaN(envVal) && envVal >= 0 && envVal <= 100 ? envVal : 2.0;
}

function getPaymentGatewayFeePercent() {
  const envVal = parseFloat(process.env.PAYMENT_GATEWAY_FEE_PERCENT);
  return !isNaN(envVal) && envVal >= 0 && envVal <= 100 ? envVal : 2.0;
}

function getPartnerCommissionPercent() {
  const envVal = parseFloat(process.env.PARTNER_COMMISSION_PERCENT);
  return !isNaN(envVal) && envVal >= 0 && envVal <= 100 ? envVal : 5.0;
}

// Backward-compatibility alias
function getEnvCommissionPercent() {
  return getPartnerCommissionPercent();
}

async function getLiveFeeSettings() {
  const now = Date.now();
  if (cachedSettings !== null && (now - lastCacheTime) < CACHE_TTL_MS) {
    return cachedSettings;
  }

  try {
    const res = await query(`
      SELECT customer_platform_fee_percent, payment_gateway_fee_percent, partner_commission_percent, platform_commission_percent 
      FROM platform_settings 
      WHERE id = 'reward_settings' 
      LIMIT 1
    `);
    if (res.rows.length > 0) {
      const row = res.rows[0];
      cachedSettings = {
        customerFeePercent: row.customer_platform_fee_percent !== null && row.customer_platform_fee_percent !== undefined
          ? parseFloat(row.customer_platform_fee_percent)
          : getCustomerPlatformFeePercent(),
        gatewayFeePercent: row.payment_gateway_fee_percent !== null && row.payment_gateway_fee_percent !== undefined
          ? parseFloat(row.payment_gateway_fee_percent)
          : getPaymentGatewayFeePercent(),
        partnerCommPercent: row.partner_commission_percent !== null && row.partner_commission_percent !== undefined
          ? parseFloat(row.partner_commission_percent)
          : (row.platform_commission_percent !== null && row.platform_commission_percent !== undefined ? parseFloat(row.platform_commission_percent) : getPartnerCommissionPercent())
      };
      lastCacheTime = now;
      return cachedSettings;
    }
  } catch (err) {
    // If database table is not yet migrated, fall back gracefully to environment variables
  }

  cachedSettings = {
    customerFeePercent: getCustomerPlatformFeePercent(),
    gatewayFeePercent: getPaymentGatewayFeePercent(),
    partnerCommPercent: getPartnerCommissionPercent()
  };
  lastCacheTime = now;
  return cachedSettings;
}

function invalidateCommissionCache() {
  cachedSettings = null;
  lastCacheTime = 0;
}

/**
 * Core Dual-Commission Invoice Calculation:
 * Example:
 * Total Bill = ₹1,000, Upfront Fee Paid = ₹99
 * Remaining Work = ₹901
 * Customer Platform Fee (2%) = ₹18.02
 * Payment Gateway Surcharge (2%) = ₹18.38
 * Customer Net Checkout = ₹937.40
 *
 * Partner Gross = ₹1,000
 * Partner Commission (5%) = ₹50.00
 * Partner Net Total = ₹950.00
 * Direct Route Transfer to Partner Bank = ₹950 - ₹99 = ₹851.00
 */
function calculateDualCommissionInvoice({
  totalJobAmount,
  upfrontFeePaid = 99,
  customerFeePercent = getCustomerPlatformFeePercent(),
  gatewayFeePercent = getPaymentGatewayFeePercent(),
  partnerCommPercent = getPartnerCommissionPercent()
}) {
  const total = Math.max(0, parseFloat(totalJobAmount) || 0);
  const upfront = Math.min(total, Math.max(0, parseFloat(upfrontFeePaid) || 0));
  const remainingWork = Math.max(0, total - upfront);

  // 1. Customer-side surcharges
  const customerPlatformFee = Math.round(((remainingWork * customerFeePercent) / 100) * 100) / 100;
  const taxableBase = remainingWork + customerPlatformFee;
  const paymentGatewayFee = Math.round(((taxableBase * gatewayFeePercent) / 100) * 100) / 100;
  const customerFinalPayable = Math.round((remainingWork + customerPlatformFee + paymentGatewayFee) * 100) / 100;

  // 2. Partner-side commission & payout
  const partnerCommissionAmount = Math.round(((total * partnerCommPercent) / 100) * 100) / 100;
  const partnerNetEarnings = Math.round((total - partnerCommissionAmount) * 100) / 100;
  // Since platform collected upfront fee, partner direct transfer from checkout is:
  const partnerDirectRouteTransfer = Math.max(0, Math.round((partnerNetEarnings - upfront) * 100) / 100);

  // 3. Platform total earnings retained
  const platformTotalRetained = Math.round((upfront + customerPlatformFee + partnerCommissionAmount) * 100) / 100;

  return {
    totalJobAmount: total,
    upfrontFeePaid: upfront,
    remainingWorkAmount: remainingWork,
    customerFeePercent,
    customerPlatformFee,
    gatewayFeePercent,
    paymentGatewayFee,
    customerFinalPayable,
    partnerCommPercent,
    partnerCommissionAmount,
    partnerNetEarnings,
    partnerDirectRouteTransfer,
    platformTotalRetained
  };
}

// Backward-compatibility split calculation
function calculateCommissionSplit(totalAmount, percent = getPartnerCommissionPercent()) {
  const safeTotal = Math.max(0, parseFloat(totalAmount) || 0);
  const safePercent = Math.max(0, Math.min(100, parseFloat(percent) || 0));
  const platformCut = parseFloat(((safeTotal * safePercent) / 100).toFixed(2));
  const techPayout = parseFloat((safeTotal - platformCut).toFixed(2));
  return {
    total: safeTotal,
    commissionPercent: safePercent,
    platformCommission: platformCut,
    techPayout
  };
}

module.exports = {
  getCustomerPlatformFeePercent,
  getPaymentGatewayFeePercent,
  getPartnerCommissionPercent,
  getEnvCommissionPercent,
  getLiveFeeSettings,
  calculateDualCommissionInvoice,
  calculateCommissionSplit,
  invalidateCommissionCache
};
