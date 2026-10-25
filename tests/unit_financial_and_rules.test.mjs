/**
 * ============================================================================
 * SHAZU ONE / SALEMSEVA: UNIT TEST SUITE
 * Financial Escrow Splits, Coupon Rules, Cancellation Policies & State Machine
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
  getPartnerCommissionPercent
} = require('../src/services/commission.service.js');

// --- Pure Business Logic Implementations Under Test ---

/**
 * Dynamic Escrow Payout Split
 * Platform fee = commissionPercent % (default 2%), Technician = (100 - commissionPercent)%
 */
export function calculateEscrowSplit(totalAmount, commissionPercent = 2) {
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

describe('Unit Test: Dynamic Platform Commission & Escrow Payout Split', () => {
  it('should accurately split ₹1000 at default 2% commission into ₹20 platform fee and ₹980 technician payout', () => {
    const split = calculateEscrowSplit(1000, 2);
    assert.equal(split.platformFee, 20);
    assert.equal(split.technicianPayout, 980);
    assert.equal(split.platformFee + split.technicianPayout, 1000);
  });

  it('should dynamically adapt when commission is increased in .env (e.g. 5% or 10%) as business grows', () => {
    // At 5% platform commission
    const split5 = calculateEscrowSplit(1000, 5);
    assert.equal(split5.platformFee, 50);
    assert.equal(split5.technicianPayout, 950);
    assert.equal(split5.platformFee + split5.technicianPayout, 1000);

    // At 8.5% platform commission on ₹1250 job
    const split8_5 = calculateEscrowSplit(1250, 8.5);
    assert.equal(split8_5.platformFee, 106.25);
    assert.equal(split8_5.technicianPayout, 1143.75);
    assert.equal(split8_5.platformFee + split8_5.technicianPayout, 1250);

    // At 10% platform commission on ₹2500 job
    const split10 = calculateEscrowSplit(2500, 10);
    assert.equal(split10.platformFee, 250);
    assert.equal(split10.technicianPayout, 2250);
    assert.equal(split10.platformFee + split10.technicianPayout, 2500);
  });

  it('should accurately calculate split for standard visitation fee ₹149', () => {
    const split = calculateEscrowSplit(149, 2);
    assert.equal(split.platformFee, 2.98);
    assert.equal(split.technicianPayout, 146.02);
    assert.equal(Math.round((split.platformFee + split.technicianPayout) * 100) / 100, 149);
  });

  it('should reject invalid or negative numbers', () => {
    assert.throws(() => calculateEscrowSplit(-500), /positive number/);
    assert.throws(() => calculateEscrowSplit(0), /positive number/);
    assert.throws(() => calculateEscrowSplit('invalid'), /positive number/);
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
    assert.equal(inv.partnerDirectRouteTransfer, 851.00); // 950 - 99
    assert.equal(inv.platformTotalRetained, 167.02); // 99 + 18.02 + 50
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
    assert.equal(inv.partnerDirectRouteTransfer, 1741.00); // 1840 - 99
    assert.equal(inv.platformTotalRetained, 316.03); // 99 + 57.03 + 160
  });

  it('should handle small job where total amount equals upfront fee without negative partner transfer', () => {
    const inv = calculateDualCommissionInvoice({
      totalJobAmount: 99,
      upfrontFeePaid: 99,
      customerFeePercent: 2.0,
      gatewayFeePercent: 2.0,
      partnerCommPercent: 5.0
    });

    assert.equal(inv.remainingWorkAmount, 0);
    assert.equal(inv.customerPlatformFee, 0);
    assert.equal(inv.paymentGatewayFee, 0);
    assert.equal(inv.customerFinalPayable, 0);
    assert.equal(inv.partnerDirectRouteTransfer, 0); // No negative payout
  });
});
