const { query } = require('../db/db');

/**
 * Shazu One Dual-Commission & Razorpay Route Engine
 * Configurable via .env:
 * - CUSTOMER_PLATFORM_FEE_PERCENT (Default: 2.0%)
 * - PAYMENT_GATEWAY_FEE_PERCENT (Default: 2.0%)
 * - PARTNER_COMMISSION_PERCENT (Default: 5.0%)
 */

function getEnvUpiId() {
  return (process.env.BUSINESS_UPI_ID || process.env.UPI_ID || '').trim();
}

function getEnvMerchantName() {
  return (process.env.BUSINESS_MERCHANT_NAME || process.env.MERCHANT_NAME || '').trim();
}

// Real-time synchronization cache: mirrors the active platform_settings table row in PostgreSQL
let latestSettings = {
  customerFeePercent: 2.0,
  gatewayFeePercent: 0.0,
  partnerCommPercent: 2.0,
  inspectionVisitFee: 99.0,
  partnerReferralIncentive: 100.0,
  refereeDiscountAmount: 50.0,
  businessUpiId: getEnvUpiId(),
  businessMerchantName: getEnvMerchantName(),
  paymentGatewayMode: process.env.PAYMENT_GATEWAY_MODE || 'DYNAMIC_QR'
};

function getBusinessUpiId() {
  return getEnvUpiId() || latestSettings.businessUpiId || '';
}

function getBusinessMerchantName() {
  return getEnvMerchantName() || latestSettings.businessMerchantName || '';
}

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

let cachedFeeSettings = null;
let feeSettingsExpiry = 0;
let cachedQualitySettings = null;
let qualitySettingsExpiry = 0;
const SETTINGS_CACHE_TTL_MS = 30000;

/**
 * Real-time query to PostgreSQL platform_settings table with 30s in-memory TTL caching.
 * Fetches the live configuration and automatically invalidates whenever admin modifies settings.
 */
async function getLiveFeeSettings() {
  const now = Date.now();
  if (cachedFeeSettings && now < feeSettingsExpiry) {
    return cachedFeeSettings;
  }
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
        businessUpiId: getEnvUpiId() || row.business_upi_id || '',
        businessMerchantName: getEnvMerchantName() || row.business_merchant_name || '',
        paymentGatewayMode: row.payment_gateway_mode || process.env.PAYMENT_GATEWAY_MODE || 'DYNAMIC_QR'
      };
      cachedFeeSettings = latestSettings;
      feeSettingsExpiry = now + SETTINGS_CACHE_TTL_MS;
      return latestSettings;
    }
  } catch (err) {
    // If DB is temporarily recovering, serve latest in-memory row
  }

  return latestSettings;
}

function invalidateCommissionCache() {
  cachedFeeSettings = null;
  feeSettingsExpiry = 0;
  cachedQualitySettings = null;
  qualitySettingsExpiry = 0;
}

/**
 * Core Dual-Commission Invoice Calculation (Option A: Advance Adjustment Model)
 *
 * In this model:
 * 1. Customer pays an upfront advance (e.g., visit fee ₹99 - coupon ₹50 = ₹49 paid).
 * 2. Technician performs work and quotes total job/labour (e.g., ₹500).
 * 3. Customer's final bill:
 *    - Quoted Labour: ₹500
 *    - Less Advance Paid at Booking: -₹49 (The ACTUAL cash collected from customer)
 *    - Remaining Balance Work: ₹500 - ₹49 = ₹451
 *    - Customer Platform Fee: % of Remaining Balance Work (from platform_settings)
 *    - Payment Gateway Fee: 0% (Direct Business UPI QR)
 *    - Total Remaining Due: Remaining Balance Work + Customer Platform Fee
 * 4. Partner (Technician) Payout:
 *    - Quoted Labour: ₹500
 *    - Partner Platform Commission: % of Total Job Amount (e.g., 5% = ₹25)
 *    - Partner Guaranteed Earnings: Total Job Amount - Partner Commission = ₹475
 *    - Net Direct Transfer:
 *      - Online / UPI QR: Full ₹475 transferred to technician (since platform collected all funds).
 *      - Cash on Delivery: ₹475 - cash collected at doorstep.
 *
 * Result: Zero financial deficit, zero mismatch, full fair pay for technician and platform.
 */
function calculateDualCommissionInvoice({
  totalJobAmount,
  upfrontFeePaid,
  actualAdvancePaid,
  couponDiscount = 0,
  customerFeePercent = getCustomerPlatformFeePercent(),
  gatewayFeePercent = getPaymentGatewayFeePercent(),
  partnerCommPercent = getPartnerCommissionPercent(),
  paymentMethod = 'online'
}) {
  const total = Math.max(0, parseFloat(totalJobAmount) || 0);

  // Option A: Advance Credit is the ACTUAL cash amount paid by customer upfront
  const advancePaid = actualAdvancePaid !== undefined
    ? Math.max(0, parseFloat(actualAdvancePaid) || 0)
    : Math.max(0, parseFloat(upfrontFeePaid !== undefined ? upfrontFeePaid : 99) || 0);

  // Advance credit applied to the final bill, capped at total job amount
  const upfrontCredit = Math.min(total, advancePaid);
  const remainingWork = Math.max(0, Math.round((total - upfrontCredit) * 100) / 100);

  // 1. Customer-side surcharges on remaining work
  const customerPlatformFee = Math.round(((remainingWork * customerFeePercent) / 100) * 100) / 100;
  const taxableBase = remainingWork + customerPlatformFee;
  const paymentGatewayFee = Math.round(((taxableBase * gatewayFeePercent) / 100) * 100) / 100;
  const customerFinalPayable = Math.round((remainingWork + customerPlatformFee + paymentGatewayFee) * 100) / 100;

  // 2. Partner-side commission & guaranteed earnings
  const partnerCommissionAmount = Math.round(((total * partnerCommPercent) / 100) * 100) / 100;
  const partnerNetEarnings = Math.max(0, Math.round((total - partnerCommissionAmount) * 100) / 100);

  // In cashless direct Business UPI QR payments, Shazu One collects all customer funds online.
  // Therefore the platform disburses the technician's full partnerNetEarnings (e.g. ₹475).
  // If paymentMethod is cash/COD, the customer handed the remaining work balance in cash to the technician.
  const cashCollectedByTech = (paymentMethod === 'cash' || paymentMethod === 'cod') ? remainingWork : 0;
  const partnerDirectRouteTransfer = Math.max(0, Math.round((partnerNetEarnings - cashCollectedByTech) * 100) / 100);

  // 3. Platform total earnings retained
  // Platform net profit = customerPlatformFee + partnerCommissionAmount
  const platformTotalRetained = Math.round((customerPlatformFee + partnerCommissionAmount) * 100) / 100;

  return {
    totalJobAmount: total,
    upfrontFeePaid: upfrontCredit,
    actualAdvancePaid: advancePaid,
    advanceCouponDiscount: parseFloat(couponDiscount) || 0,
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

async function getLiveQualitySettings() {
  const now = Date.now();
  if (cachedQualitySettings && now < qualitySettingsExpiry) {
    return cachedQualitySettings;
  }
  try {
    const res = await query(`
      SELECT 
        quality_governance_enabled,
        quality_throttle_rating,
        quality_throttle_daily_cap,
        quality_throttle_min_reviews,
        quality_priority_window_seconds,
        quality_priority_min_rating,
        quality_suspension_rating,
        quality_suspension_min_reviews
      FROM platform_settings 
      WHERE id = 'reward_settings' 
      LIMIT 1
    `);
    if (res.rows.length > 0) {
      const row = res.rows[0];
      cachedQualitySettings = {
        enabled: row.quality_governance_enabled != null ? Boolean(row.quality_governance_enabled) : true,
        throttleRating: row.quality_throttle_rating != null ? parseFloat(row.quality_throttle_rating) : 4.0,
        throttleDailyCap: row.quality_throttle_daily_cap != null ? parseInt(row.quality_throttle_daily_cap, 10) : 1,
        throttleMinReviews: row.quality_throttle_min_reviews != null ? parseInt(row.quality_throttle_min_reviews, 10) : 3,
        priorityWindowSeconds: row.quality_priority_window_seconds != null ? parseInt(row.quality_priority_window_seconds, 10) : 90,
        priorityMinRating: row.quality_priority_min_rating != null ? parseFloat(row.quality_priority_min_rating) : 4.5,
        suspensionRating: row.quality_suspension_rating != null ? parseFloat(row.quality_suspension_rating) : 3.5,
        suspensionMinReviews: row.quality_suspension_min_reviews != null ? parseInt(row.quality_suspension_min_reviews, 10) : 5
      };
      qualitySettingsExpiry = now + SETTINGS_CACHE_TTL_MS;
      return cachedQualitySettings;
    }
  } catch (err) {
    // Return sensible defaults if columns are not yet initialized
  }
  return {
    enabled: true,
    throttleRating: 4.0,
    throttleDailyCap: 1,
    throttleMinReviews: 3,
    priorityWindowSeconds: 90,
    priorityMinRating: 4.5,
    suspensionRating: 3.5,
    suspensionMinReviews: 5
  };
}

module.exports = {
  getEnvUpiId,
  getEnvMerchantName,
  getBusinessUpiId,
  getBusinessMerchantName,
  getCustomerPlatformFeePercent,
  getPaymentGatewayFeePercent,
  getPartnerCommissionPercent,
  getEnvCommissionPercent,
  getLiveFeeSettings,
  getLiveQualitySettings,
  calculateDualCommissionInvoice,
  calculateCommissionSplit,
  invalidateCommissionCache
};
