const { query } = require('../db/db');

/**
 * Shazu One Dual-Commission & Razorpay Route Engine
 * Configurable via .env:
 * - CUSTOMER_PLATFORM_FEE_PERCENT (Default: 2.0%)
 * - PAYMENT_GATEWAY_FEE_PERCENT (Default: 2.0%)
 * - PARTNER_COMMISSION_PERCENT (Default: 5.0%)
 */

// Real-time synchronization cache: mirrors the active platform_settings table row in PostgreSQL
let latestSettings = {
  customerFeePercent: 2.0,
  gatewayFeePercent: 0.0,
  partnerCommPercent: 2.0,
  inspectionVisitFee: 99.0,
  partnerReferralIncentive: 100.0,
  refereeDiscountAmount: 50.0,
  businessUpiId: 'shazuone.pay@icici',
  businessMerchantName: 'Shazu One Home Services',
  paymentGatewayMode: 'DYNAMIC_QR'
};

function getCustomerPlatformFeePercent() {
  return latestSettings.customerFeePercent;
}

function getPaymentGatewayFeePercent() {
  return latestSettings.gatewayFeePercent;
}

function getPartnerCommissionPercent() {
  return latestSettings.partnerCommPercent;
}

// Backward-compatibility alias
function getEnvCommissionPercent() {
  return getPartnerCommissionPercent();
}

/**
 * Real-time query to PostgreSQL platform_settings table.
 * Fetches the live configuration on every call without stale caching.
 */
async function getLiveFeeSettings() {
  try {
    const res = await query(`
      SELECT 
        customer_platform_fee_percent, 
        payment_gateway_fee_percent, 
        gateway_fee_percent,
        partner_commission_percent, 
        platform_commission_percent, 
        inspection_visit_fee,
        partner_referral_incentive,
        referee_discount_amount,
        business_upi_id,
        business_merchant_name,
        payment_gateway_mode
      FROM platform_settings 
      WHERE id = 'reward_settings' 
      LIMIT 1
    `);
    if (res.rows.length > 0) {
      const row = res.rows[0];
      const custFee = row.customer_platform_fee_percent != null
        ? parseFloat(row.customer_platform_fee_percent)
        : (parseFloat(process.env.CUSTOMER_PLATFORM_FEE_PERCENT) || 2.0);
      const gwFee = row.payment_gateway_fee_percent != null
        ? parseFloat(row.payment_gateway_fee_percent)
        : (row.gateway_fee_percent != null ? parseFloat(row.gateway_fee_percent) : (parseFloat(process.env.PAYMENT_GATEWAY_FEE_PERCENT) || 0.0));
      const partComm = row.partner_commission_percent != null
        ? parseFloat(row.partner_commission_percent)
        : (row.platform_commission_percent != null ? parseFloat(row.platform_commission_percent) : (parseFloat(process.env.PARTNER_COMMISSION_PERCENT) || 2.0));
      const visitFee = row.inspection_visit_fee != null
        ? parseFloat(row.inspection_visit_fee)
        : 99.0;
      const refIncentive = row.partner_referral_incentive != null
        ? parseFloat(row.partner_referral_incentive)
        : 100.0;
      const refDiscount = row.referee_discount_amount != null
        ? parseFloat(row.referee_discount_amount)
        : 50.0;

      latestSettings = {
        customerFeePercent: custFee,
        gatewayFeePercent: gwFee,
        partnerCommPercent: partComm,
        inspectionVisitFee: visitFee,
        partnerReferralIncentive: refIncentive,
        refereeDiscountAmount: refDiscount,
        businessUpiId: row.business_upi_id || 'shazuone.pay@icici',
        businessMerchantName: row.business_merchant_name || 'Shazu One Home Services',
        paymentGatewayMode: row.payment_gateway_mode || 'DYNAMIC_QR'
      };
      return latestSettings;
    }
  } catch (err) {
    // If DB is temporarily recovering, serve latest in-memory row
  }

  return latestSettings;
}

function invalidateCommissionCache() {
  // Real-time queries bypass cache; kept for backward-compatibility call sites
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
