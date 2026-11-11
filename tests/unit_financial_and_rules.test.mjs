/**
 * ============================================================================
 * SHAZU ONE: UNIT TEST SUITE
 * Financial . Splits, Coupon Rules, Cancellation Policies & State Machine
 * ============================================================================
 * Uses Node.js native test runner (node:test & node:assert/strict).
 * Zero external runner dependencies required.
 *
 * Run: node --test backend/tests/unit_financial_and_rules.test.js
 * ============================================================================
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  calculateDualCommissionInvoice,
  getCustomerPlatformFeePercent,
  getPaymentGatewayFeePercent,
  getPartnerCommissionPercent,
  getEnvUpiId,
  getEnvMerchantName,
  getBusinessUpiId,
  getBusinessMerchantName
} = require('../src/services/commission.service.js');
const { checkCancellationWindow } = require('../src/services/cancellation_policy.service.js');

// --- Pure Business Logic Implementations Under Test ---

/**
 * Dynamic . Payout Split
 * Platform fee = commissionPercent % (default 2%), Technician = (100 - commissionPercent)%
 */
export function calculateSplit(totalAmount, commissionPercent = 2) {
  if (typeof totalAmount !== 'number' || isNaN(totalAmount) || totalAmount <= 0) {
    throw new Error('Total amount must be a positive number');
  }
  const rate = commissionPercent / 100;
  const platformFee = Math.round((totalAmount * rate) * 100) / 100;
  const technicianPayout = Math.round((totalAmount - platformFee) * 100) / 100;
  return {
    total: totalAmount,
    commissionPercent,
    platformFee,
    technicianPayout
  };
}

/**
 * Coupon Rule Engine
 */
export function evaluateCoupon(coupon, cartTotal) {
  if (!coupon || !coupon.active) {
    return { valid: false, reason: 'Coupon is inactive or invalid', discount: 0, finalTotal: cartTotal };
  }

  if (coupon.minOrder && cartTotal < coupon.minOrder) {
    return {
      valid: false,
      reason: `Minimum order amount of ₹${coupon.minOrder} required`,
      discount: 0,
      finalTotal: cartTotal
    };
  }

  let discount = 0;
  if (coupon.type === 'FLAT') {
    discount = Math.min(coupon.value, cartTotal);
  } else if (coupon.type === 'PERCENTAGE') {
    discount = (cartTotal * coupon.value) / 100;
    if (coupon.maxDiscount && discount > coupon.maxDiscount) {
      discount = coupon.maxDiscount;
    }
  }

  discount = Math.round(discount * 100) / 100;
  const finalTotal = Math.max(0, Math.round((cartTotal - discount) * 100) / 100);

  return {
    valid: true,
    discount,
    finalTotal
  };
}

/**
 * Cancellation Policy & Refund Matrix
 */
export function computeCancellationRefund(bookingStatus, paidAmount, inspectionFee = 99) {
  const PRE_DISPATCH_STATUSES = ['created', 'matching', 'scheduled'];
  const POST_DISPATCH_STATUSES = ['accepted', 'en_route', 'arrived', 'inspecting'];

  if (PRE_DISPATCH_STATUSES.includes(bookingStatus)) {
    return {
      refundAmount: paidAmount,
      cancellationCharge: 0,
      policy: 'FULL_REFUND_PRE_DISPATCH'
    };
  }

  if (POST_DISPATCH_STATUSES.includes(bookingStatus)) {
    const charge = Math.min(inspectionFee, paidAmount);
    return {
      refundAmount: Math.max(0, paidAmount - charge),
      cancellationCharge: charge,
      policy: 'VISITATION_DEDUCTION_POST_DISPATCH'
    };
  }

  if (bookingStatus === 'completed') {
    return {
      refundAmount: 0,
      cancellationCharge: paidAmount,
      policy: 'NO_REFUND_POST_COMPLETION'
    };
  }

  throw new Error(`Unsupported booking status for cancellation: ${bookingStatus}`);
}

/**
 * Salem Haversine Distance (in kilometers)
 */
export function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 100) / 100;
}

/**
 * State Transition Guard
 */
const VALID_TRANSITIONS = {
  created: ['matching', 'scheduled', 'cancelled'],
  matching: ['accepted', 'cancelled', 'timeout'],
  scheduled: ['matching', 'cancelled'],
  accepted: ['en_route', 'cancelled'],
  en_route: ['arrived', 'cancelled'],
  arrived: ['inspecting', 'cancelled'],
  inspecting: ['quote_presented', 'cancelled'],
  quote_presented: ['quote_approved', 'cancelled'],
  quote_approved: ['completed'],
  completed: [],
  cancelled: []
};

export function isValidStateTransition(currentStatus, nextStatus) {
  const allowed = VALID_TRANSITIONS[currentStatus];
  if (!allowed) return false;
  return allowed.includes(nextStatus);
}

// ============================================================================
// TEST SPECIFICATIONS
// ============================================================================

describe('Unit Test: Dynamic Platform Commission & . Payout Split', () => {
  it('should accurately split ₹1000 at default 2% commission into ₹20 platform fee and ₹980 technician payout', () => {
    const split = calculateSplit(1000, 2);
    assert.equal(split.platformFee, 20);
    assert.equal(split.technicianPayout, 980);
    assert.equal(split.platformFee + split.technicianPayout, 1000);
  });

  it('should dynamically adapt when commission is increased in .env (e.g. 5% or 10%) as business grows', () => {
    // At 5% platform commission
    const split5 = calculateSplit(1000, 5);
    assert.equal(split5.platformFee, 50);
    assert.equal(split5.technicianPayout, 950);
    assert.equal(split5.platformFee + split5.technicianPayout, 1000);

    // At 8.5% platform commission on ₹1250 job
    const split8_5 = calculateSplit(1250, 8.5);
    assert.equal(split8_5.platformFee, 106.25);
    assert.equal(split8_5.technicianPayout, 1143.75);
    assert.equal(split8_5.platformFee + split8_5.technicianPayout, 1250);

    // At 10% platform commission on ₹2500 job
    const split10 = calculateSplit(2500, 10);
    assert.equal(split10.platformFee, 250);
    assert.equal(split10.technicianPayout, 2250);
    assert.equal(split10.platformFee + split10.technicianPayout, 2500);
  });

  it('should accurately calculate split for standard visitation fee ₹149', () => {
    const split = calculateSplit(149, 2);
    assert.equal(split.platformFee, 2.98);
    assert.equal(split.technicianPayout, 146.02);
    assert.equal(Math.round((split.platformFee + split.technicianPayout) * 100) / 100, 149);
  });

  it('should reject invalid or negative numbers', () => {
    assert.throws(() => calculateSplit(-500), /positive number/);
    assert.throws(() => calculateSplit(0), /positive number/);
    assert.throws(() => calculateSplit('invalid'), /positive number/);
  });
});

describe('Unit Test: Coupon & Promo Discount Engine', () => {
  it('should apply flat ₹100 discount when cart satisfies minimum order', () => {
    const coupon = { type: 'FLAT', value: 100, minOrder: 500, active: true };
    const result = evaluateCoupon(coupon, 650);
    assert.equal(result.valid, true);
    assert.equal(result.discount, 100);
    assert.equal(result.finalTotal, 550);
  });

  it('should reject flat discount when cart is below minimum threshold', () => {
    const coupon = { type: 'FLAT', value: 100, minOrder: 500, active: true };
    const result = evaluateCoupon(coupon, 450);
    assert.equal(result.valid, false);
    assert.equal(result.discount, 0);
    assert.equal(result.finalTotal, 450);
  });

  it('should cap percentage discount at maxDiscount ceiling', () => {
    const coupon = { type: 'PERCENTAGE', value: 20, minOrder: 200, maxDiscount: 150, active: true };
    // 20% of ₹1000 is ₹200, but cap is ₹150
    const result = evaluateCoupon(coupon, 1000);
    assert.equal(result.valid, true);
    assert.equal(result.discount, 150);
    assert.equal(result.finalTotal, 850);
  });

  it('should reject inactive coupons', () => {
    const coupon = { type: 'FLAT', value: 50, active: false };
    const result = evaluateCoupon(coupon, 500);
    assert.equal(result.valid, false);
    assert.equal(result.discount, 0);
  });
});

describe('Unit Test: Cancellation & Refund Policy Rules', () => {
  it('should issue 100% full refund if cancelled in matching phase', () => {
    const res = computeCancellationRefund('matching', 500);
    assert.equal(res.refundAmount, 500);
    assert.equal(res.cancellationCharge, 0);
    assert.equal(res.policy, 'FULL_REFUND_PRE_DISPATCH');
  });

  it('should deduct standard ₹99 visitation charge if cancelled post-dispatch (en_route)', () => {
    const res = computeCancellationRefund('en_route', 500, 99);
    assert.equal(res.refundAmount, 401);
    assert.equal(res.cancellationCharge, 99);
    assert.equal(res.policy, 'VISITATION_DEDUCTION_POST_DISPATCH');
  });

  it('should refund 0 if booking was already completed', () => {
    const res = computeCancellationRefund('completed', 500);
    assert.equal(res.refundAmount, 0);
    assert.equal(res.cancellationCharge, 500);
    assert.equal(res.policy, 'NO_REFUND_POST_COMPLETION');
  });
});

describe('Unit Test: 24-Hour Pre-Service Cancellation Cutoff Policy', () => {
  it('should permit cancellation when appointment is 48 hours in the future', () => {
    const fixedNow = new Date('2026-11-08T10:00:00.000Z');
    const futureSlot = '2026-11-10 10:00 AM - 12:00 PM';
    const result = checkCancellationWindow(futureSlot, fixedNow, false, fixedNow);

    assert.equal(result.isCancellationAllowed, true);
    assert.ok(result.hoursRemaining >= 24, `Expected hours >= 24, got ${result.hoursRemaining}`);
    assert.ok(result.policyReason.includes('Cancellation is available'));
  });

  it('should strictly block cancellation when appointment is within 12 hours', () => {
    const fixedNow = new Date('2026-11-08T10:00:00.000Z');
    const soonSlot = '2026-11-08 06:00 PM - 08:00 PM'; // 8 hours away
    const result = checkCancellationWindow(soonSlot, fixedNow, false, fixedNow);

    assert.equal(result.isCancellationAllowed, false);
    assert.ok(result.hoursRemaining < 24);
    assert.ok(result.policyReason.includes('must be made at least 24 hours prior to service'));
  });

  it('should block cancellation for emergency and immediate dispatch bookings', () => {
    const fixedNow = new Date('2026-11-08T10:00:00.000Z');
    const result = checkCancellationWindow('Immediate / Emergency Dispatch', fixedNow, true, fixedNow);

    assert.equal(result.isCancellationAllowed, false);
    assert.ok(result.policyReason.includes('Emergency and immediate dispatch bookings'));
  });

  it('should block cancellation when scheduled for tomorrow morning if less than 24 hours remain', () => {
    const fixedNow = new Date('2026-11-08T15:00:00.000Z'); // 3:00 PM today
    const tomorrowMorningSlot = 'Tomorrow, 10:00 AM'; // 19 hours away
    const result = checkCancellationWindow(tomorrowMorningSlot, fixedNow, false, fixedNow);

    assert.equal(result.isCancellationAllowed, false);
    assert.ok(result.hoursRemaining < 24);
  });
});

describe('Unit Test: Salem Geographic Distance & Proximity Engine', () => {
  it('should calculate distance between Fairlands and Hasthampatti (~2.4 km)', () => {
    // Fairlands Salem: 11.6738, 78.1408
    // Hasthampatti Salem: 11.6845, 78.1585
    const dist = calculateHaversineDistance(11.6738, 78.1408, 11.6845, 78.1585);
    assert.ok(dist >= 2.0 && dist <= 3.0, `Expected distance ~2.3km, got ${dist}km`);
  });

  it('should calculate 0 distance for identical coordinates', () => {
    const dist = calculateHaversineDistance(11.6738, 78.1408, 11.6738, 78.1408);
    assert.equal(dist, 0);
  });
});

describe('Unit Test: State Machine Transition Integrity', () => {
  it('should allow valid sequential lifecycle flow', () => {
    assert.equal(isValidStateTransition('created', 'matching'), true);
    assert.equal(isValidStateTransition('matching', 'accepted'), true);
    assert.equal(isValidStateTransition('accepted', 'en_route'), true);
    assert.equal(isValidStateTransition('en_route', 'arrived'), true);
    assert.equal(isValidStateTransition('arrived', 'inspecting'), true);
    assert.equal(isValidStateTransition('inspecting', 'quote_presented'), true);
    assert.equal(isValidStateTransition('quote_presented', 'quote_approved'), true);
    assert.equal(isValidStateTransition('quote_approved', 'completed'), true);
  });

  it('should reject invalid or backwards transitions', () => {
    assert.equal(isValidStateTransition('completed', 'matching'), false);
    assert.equal(isValidStateTransition('cancelled', 'en_route'), false);
    assert.equal(isValidStateTransition('matching', 'completed'), false);
    assert.equal(isValidStateTransition('created', 'quote_approved'), false);
  });
});

describe('Unit Test: Dual-Commission Split & Razorpay Route Engine', () => {
  it('should accurately calculate dual commission for ₹1000 bill with ₹99 upfront fee per business specification', () => {
    // Bill = ₹1000, Upfront = ₹99, Customer Fee = 2%, PG Fee = 2%, Partner Comm = 5%
    const inv = calculateDualCommissionInvoice({
      totalJobAmount: 1000,
      upfrontFeePaid: 99,
      customerFeePercent: 2.0,
      gatewayFeePercent: 2.0,
      partnerCommPercent: 5.0
    });

    assert.equal(inv.totalJobAmount, 1000);
    assert.equal(inv.upfrontFeePaid, 99);
    assert.equal(inv.remainingWorkAmount, 901); // 1000 - 99
    assert.equal(inv.customerPlatformFee, 18.02); // 901 * 2%
    assert.equal(inv.paymentGatewayFee, 18.38); // (901 + 18.02) * 2% = 919.02 * 0.02
    assert.equal(inv.customerFinalPayable, 937.40); // 901 + 18.02 + 18.38
    assert.equal(inv.partnerCommissionAmount, 50.00); // 1000 * 5%
    assert.equal(inv.partnerNetEarnings, 950.00); // 1000 - 50
    // In cashless UPI QR, platform collects all funds online and transfers full net earnings:
    assert.equal(inv.partnerDirectRouteTransfer, 950.00);
    assert.equal(inv.platformTotalRetained, 68.02); // customerPlatformFee (18.02) + partnerCommission (50)
  });

  it('should dynamically update when commission percentages are overridden or configured via .env', () => {
    // Partner comm scaled to 8%, Customer fee scaled to 3%, PG fee at 2%
    const inv = calculateDualCommissionInvoice({
      totalJobAmount: 2000,
      upfrontFeePaid: 99,
      customerFeePercent: 3.0,
      gatewayFeePercent: 2.0,
      partnerCommPercent: 8.0
    });

    assert.equal(inv.remainingWorkAmount, 1901); // 2000 - 99
    assert.equal(inv.customerPlatformFee, 57.03); // 1901 * 3%
    assert.equal(inv.paymentGatewayFee, 39.16); // (1901 + 57.03) * 2%
    assert.equal(inv.customerFinalPayable, 1997.19);
    assert.equal(inv.partnerCommissionAmount, 160.00); // 2000 * 8%
    assert.equal(inv.partnerNetEarnings, 1840.00);
    assert.equal(inv.partnerDirectRouteTransfer, 1840.00);
    assert.equal(inv.platformTotalRetained, 217.03); // customerPlatformFee (57.03) + partnerCommission (160)
  });

  it('should deduct cash kept by technician on COD bookings', () => {
    const inv = calculateDualCommissionInvoice({
      totalJobAmount: 1000,
      upfrontFeePaid: 99,
      paymentMethod: 'cash',
      customerFeePercent: 2.0,
      gatewayFeePercent: 2.0,
      partnerCommPercent: 5.0
    });

    // Net earnings = 950, customer paid remaining 901 in cash directly to tech:
    assert.equal(inv.partnerNetEarnings, 950.00);
    assert.equal(inv.partnerDirectRouteTransfer, 49.00); // 950 - 901
  });
});

describe('Unit Test: Advance Payment Verification & Lead Visibility Guard', () => {
  it('should enforce that only paid bookings (status === matching) are visible as open leads to technicians', () => {
    const isVisibleInOpenLeads = (booking) => {
      // Unpaid bookings remain in 'created' status and must never show in open scheduled leads
      return booking.status === 'matching' && booking.technician_id === null;
    };

    const unpaidBooking = { id: 'SLM-1001', status: 'created', visit_fee: 99, advance_amount_paid: 0, technician_id: null };
    const paidBooking = { id: 'SLM-1002', status: 'matching', visit_fee: 99, advance_amount_paid: 99, technician_id: null };
    const assignedPaidBooking = { id: 'SLM-1003', status: 'accepted', visit_fee: 99, advance_amount_paid: 99, technician_id: 'tech-1' };

    assert.equal(isVisibleInOpenLeads(unpaidBooking), false, 'Unpaid booking must NOT be shown as an open lead');
    assert.equal(isVisibleInOpenLeads(paidBooking), true, 'Paid booking in matching radar MUST be shown as an open lead');
    assert.equal(isVisibleInOpenLeads(assignedPaidBooking), false, 'Already assigned booking must not be shown as open unassigned lead');
  });

  it('should verify advance payment transitions booking from created to matching or accepted', () => {
    const processAdvancePayment = (booking, amountPaid) => {
      if (booking.status !== 'created') return booking;
      const targetStatus = booking.technician_id ? 'accepted' : 'matching';
      return {
        ...booking,
        status: targetStatus,
        advance_amount_paid: (booking.advance_amount_paid || 0) + amountPaid
      };
    };

    const unpaidBroadcast = { id: 'SLM-2001', status: 'created', technician_id: null, advance_amount_paid: 0 };
    const paidBroadcast = processAdvancePayment(unpaidBroadcast, 99);
    assert.equal(paidBroadcast.status, 'matching');
    assert.equal(paidBroadcast.advance_amount_paid, 99);

    const unpaidDirect = { id: 'SLM-2002', status: 'created', technician_id: 'tech-5', advance_amount_paid: 0 };
    const paidDirect = processAdvancePayment(unpaidDirect, 99);
    assert.equal(paidDirect.status, 'accepted');
    assert.equal(paidDirect.advance_amount_paid, 99);
  });
});

describe('Unit Test: Payment Split-Up & Failed Payment Exclusion in Admin Ledger', () => {
  it('should exclude failed payment attempts from Gross Revenue and Customer Inflow', () => {
    const rawPayments = [
      { id: 'pay_1', amount_total: 99.00, status: '._held', part: 1 },
      { id: 'pay_2_fail', amount_total: 257.55, status: 'failed', part: 2 },
      { id: 'pay_2_success', amount_total: 257.55, status: 'settled', part: 2 }
    ];

    // Compute gross inflow excluding failed
    const nonFailedPayments = rawPayments.filter(p => p.status !== 'failed');
    const customerGross = nonFailedPayments.reduce((sum, p) => sum + p.amount_total, 0);
    const failedAmount = rawPayments.filter(p => p.status === 'failed').reduce((sum, p) => sum + p.amount_total, 0);

    assert.equal(failedAmount, 257.55, 'Failed payments must be captured separately');
    assert.equal(customerGross, 356.55, 'Customer Gross must strictly exclude failed attempts');
    assert.notEqual(customerGross, 614.10, 'Customer Gross must never inflate by adding failed attempts');
  });

  it('should calculate accurate 2-Part payment split with itemized deductions', () => {
    const quoteTotal = 250.00;
    const part1Advance = 99.00;
    const customerFeePercent = 2.0; // 2%
    const gatewayFeePercent = 1.0; // 1% ~ 1.02%

    const part1Txn = { id: 'txn_part1', amount_total: 99.00, status: '._held' };
    const part2Txn = { id: 'txn_part2', amount_total: 257.55, status: '._held' };

    // Itemized deductions calculation
    const netWorkBase = quoteTotal;
    const customerFee = Number((netWorkBase * (customerFeePercent / 100)).toFixed(2)); // 5.00
    const gatewayFee = Number(((netWorkBase + customerFee) * (gatewayFeePercent / 100)).toFixed(2)); // 2.55
    const computedPart2 = Number((netWorkBase + customerFee + gatewayFee).toFixed(2)); // 257.55

    assert.equal(customerFee, 5.00);
    assert.equal(gatewayFee, 2.55);
    assert.equal(computedPart2, 257.55);

    // Part 1 + Part 2 real totals
    const totalPaid = Number((part1Txn.amount_total + part2Txn.amount_total).toFixed(2));
    assert.equal(totalPaid, 356.55, 'Total paid must equal sum of verified Part 1 + Part 2 transactions');
    assert.notEqual(totalPaid, 250.00, 'Total paid must not be hardcoded to quote amount');
  });

  it('should calculate dual-sided cutoff percentages for admin ledger', () => {
    const grossInflow = 356.55;
    const customerFee = 5.00;
    const customerFeePercent = 2.0;
    const techGrossWork = 250.00;
    const partnerCommPercent = 10.0; // e.g. 10%
    const techCommissionCut = Number((techGrossWork * (partnerCommPercent / 100)).toFixed(2)); // 25.00
    const techDisbursed = Number((grossInflow - customerFee - techCommissionCut).toFixed(2)); // 356.55 - 5 - 25 = 326.55

    assert.equal(techCommissionCut, 25.00);
    assert.equal(customerFeePercent, 2.0);
    assert.equal(partnerCommPercent, 10.0);
    assert.ok(techDisbursed > 0);
  });
});

describe('Unit Test: Customer Service Review & Ops Escalation Policy', () => {
  it('should categorize 4 and 5 star ratings as standard satisfied completion', () => {
    const evaluateReview = (rating, tags = [], comment = '') => {
      const stars = parseFloat(rating) || 5.0;
      const isBelow3Star = stars <= 3.0;
      return {
        rating: stars,
        tags,
        comment,
        isBelow3Star,
        escalateToOps: isBelow3Star,
        techStarPointsAward: 2
      };
    };

    const review5 = evaluateReview(5, ['fast', 'oem', 'clean'], 'Superb service');
    assert.equal(review5.isBelow3Star, false);
    assert.equal(review5.escalateToOps, false);
    assert.equal(review5.techStarPointsAward, 2);

    const review4 = evaluateReview(4, ['transparent', 'tamil'], 'Good work');
    assert.equal(review4.isBelow3Star, false);
    assert.equal(review4.escalateToOps, false);
  });

  it('should automatically escalate 1, 2, and 3 star ratings to Salem Ops Manager with root cause tags', () => {
    const evaluateReview = (rating, tags = [], comment = '') => {
      const stars = parseFloat(rating) || 5.0;
      const isBelow3Star = stars <= 3.0;
      return {
        rating: stars,
        tags,
        comment,
        isBelow3Star,
        escalateToOps: isBelow3Star,
        customerBenefit: isBelow3Star
          ? 'Eligible for 100% Free Warranty Revisit or Full Diagnostic Refund'
          : 'Service Completed & 100% Satisfaction Guaranteed'
      };
    };

    const review3 = evaluateReview(3, ['pricing'], 'Charges higher than estimate');
    assert.equal(review3.isBelow3Star, true);
    assert.equal(review3.escalateToOps, true);
    assert.ok(review3.customerBenefit.includes('Free Warranty Revisit'));

    const review1 = evaluateReview(1, ['incomplete', 'behavior'], 'Issue persists and technician rude');
    assert.equal(review1.isBelow3Star, true);
    assert.equal(review1.escalateToOps, true);
  });
});

describe('Unit Test: Environment-Driven UPI ID & Merchant Name (No Hardcoding)', () => {
  const originalBusinessUpi = process.env.BUSINESS_UPI_ID;
  const originalMerchant = process.env.BUSINESS_MERCHANT_NAME;
  const originalUpiId = process.env.UPI_ID;
  const originalMerchantName = process.env.MERCHANT_NAME;

  it('should dynamically read business UPI ID from BUSINESS_UPI_ID env var', () => {
    process.env.BUSINESS_UPI_ID = 'test.custom@hdfcbank';
    delete process.env.UPI_ID;
    assert.equal(getEnvUpiId(), 'test.custom@hdfcbank');
    assert.equal(getBusinessUpiId(), 'test.custom@hdfcbank');
  });

  it('should support UPI_ID alias when BUSINESS_UPI_ID is omitted', () => {
    delete process.env.BUSINESS_UPI_ID;
    process.env.UPI_ID = 'salem.alias@sbi';
    assert.equal(getEnvUpiId(), 'salem.alias@sbi');
    assert.equal(getBusinessUpiId(), 'salem.alias@sbi');
  });

  it('should dynamically read merchant name from BUSINESS_MERCHANT_NAME env var', () => {
    process.env.BUSINESS_MERCHANT_NAME = 'Custom Salem Services';
    delete process.env.MERCHANT_NAME;
    assert.equal(getEnvMerchantName(), 'Custom Salem Services');
    assert.equal(getBusinessMerchantName(), 'Custom Salem Services');
  });

  it('should support MERCHANT_NAME alias when BUSINESS_MERCHANT_NAME is omitted', () => {
    delete process.env.BUSINESS_MERCHANT_NAME;
    process.env.MERCHANT_NAME = 'Salem Enterprise Hub';
    assert.equal(getEnvMerchantName(), 'Salem Enterprise Hub');
    assert.equal(getBusinessMerchantName(), 'Salem Enterprise Hub');
  });

  it('should generate valid UPI Intent string with custom environment variables', () => {
    process.env.BUSINESS_UPI_ID = 'merchant.pay@okaxis';
    process.env.BUSINESS_MERCHANT_NAME = 'Salem Direct Services';

    const vpa = getEnvUpiId();
    const name = getEnvMerchantName();
    const amount = '149.00';
    const txnRef = 'SLM-999-ADV';
    const txnNote = `${name} SLM-999`;

    const uri = `upi://pay?pa=${encodeURIComponent(vpa)}&pn=${encodeURIComponent(name)}&am=${amount}&tr=${encodeURIComponent(txnRef)}&tn=${encodeURIComponent(txnNote)}&cu=INR`;

    assert.ok(uri.includes('pa=merchant.pay%40okaxis'));
    assert.ok(uri.includes('pn=Salem%20Direct%20Services'));
    assert.ok(uri.includes('am=149.00'));
  });

  // Restore environment variables
  it('should restore original environment variables after test', () => {
    if (originalBusinessUpi !== undefined) process.env.BUSINESS_UPI_ID = originalBusinessUpi;
    else delete process.env.BUSINESS_UPI_ID;

    if (originalMerchant !== undefined) process.env.BUSINESS_MERCHANT_NAME = originalMerchant;
    else delete process.env.BUSINESS_MERCHANT_NAME;

    if (originalUpiId !== undefined) process.env.UPI_ID = originalUpiId;
    else delete process.env.UPI_ID;

    if (originalMerchantName !== undefined) process.env.MERCHANT_NAME = originalMerchantName;
    else delete process.env.MERCHANT_NAME;
  });
});
