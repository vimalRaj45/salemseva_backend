/**
 * ============================================================================
 * SHAZU ONE: THREE-SIDED MONEY FLOW & ESCROW INTEGRITY TEST SUITE
 * Validates perfect mathematical alignment across Customer, Technician, and Admin
 * ============================================================================
 * Scenario Tested:
 * - AC Service Booking Visit Fee: 99.00
 * - Coupon SALEM50: -50.00
 * - Part 1 Advance Paid: 49.00
 * - Quoted Labor Tasks: 150.00 + 250.00 = 400.00
 * - Customer Platform Fee: 5.0%
 * - Technician Commission: 7.0%
 * - Gateway Surcharge: 0.0%
 *
 * Equilibrium Requirement:
 * Customer Total Inflow (417.55) === Tech Payout (372.00) + Net Platform Cut (45.55)
 * ============================================================================
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { calculateDualCommissionInvoice } = require('../src/services/commission.service.js');

describe('Three-Sided Money Flow Integrity: Dual-Commission Advance Adjustment Model', () => {

  const bookingConfig = {
    totalJobAmount: 400.00,
    actualAdvancePaid: 49.00,
    couponDiscount: 50.00,
    customerFeePercent: 5.0,
    partnerCommPercent: 7.0,
    gatewayFeePercent: 0.0,
    paymentMethod: 'online'
  };

  it('1. Core Engine: accurately calculates Part 2 payable and platform/tech splits', () => {
    const inv = calculateDualCommissionInvoice(bookingConfig);

    // Customer Part 2 bill breakdown
    assert.equal(inv.totalJobAmount, 400.00, 'Total job quote must be 400.00');
    assert.equal(inv.upfrontFeePaid, 49.00, 'Advance credited must be exactly 49.00');
    assert.equal(inv.remainingWorkAmount, 351.00, 'Net work base must be 400 - 49 = 351.00');
    assert.equal(inv.customerPlatformFee, 17.55, 'Customer platform fee (5% of 351) must be 17.55');
    assert.equal(inv.paymentGatewayFee, 0.00, 'Direct UPI gateway surcharge must be 0.00');
    assert.equal(inv.customerFinalPayable, 368.55, 'Customer Part 2 payable must be 351 + 17.55 = 368.55');

    // Partner (Technician) guaranteed earnings
    assert.equal(inv.partnerCommissionAmount, 28.00, '7% technician commission on 400 must be 28.00');
    assert.equal(inv.partnerNetEarnings, 372.00, 'Technician net earnings must be 400 - 28 = 372.00');
    assert.equal(inv.partnerDirectRouteTransfer, 372.00, 'Direct route transfer must be 372.00');

    // Platform Net Margin
    assert.equal(inv.platformTotalRetained, 45.55, 'Platform retained margin (17.55 + 28.00) must be 45.55');

    // Zero-Deficit Financial Equilibrium Check
    const totalCustomerPaid = bookingConfig.actualAdvancePaid + inv.customerFinalPayable;
    assert.equal(totalCustomerPaid, 417.55, 'Customer total payment across Part 1 and Part 2 must be 417.55');
    const totalDisbursedAndRetained = inv.partnerDirectRouteTransfer + inv.platformTotalRetained;
    assert.equal(totalCustomerPaid, totalDisbursedAndRetained, 'Total customer inflow must exactly equal Tech payout + Platform margin');
  });

  it('2. Multi-Payment Incremental Split: prevents double-counting advance payment', () => {
    const inv = calculateDualCommissionInvoice(bookingConfig);

    // Transaction 1: Upfront advance booking fee
    const payment1 = {
      amount_total: 49.00,
      tech_payout_amount: 45.57,
      platform_commission: 3.43
    };

    // Transaction 2: Final settlement payment
    const part2TxnAmount = inv.customerFinalPayable; // 368.55
    const priorTechPayout = payment1.tech_payout_amount; // 45.57
    const priorPlatformComm = payment1.platform_commission; // 3.43

    const payment2 = {
      amount_total: part2TxnAmount,
      tech_payout_amount: Math.max(0, parseFloat((inv.partnerDirectRouteTransfer - priorTechPayout).toFixed(2))),
      platform_commission: Math.max(0, parseFloat((inv.platformTotalRetained - priorPlatformComm).toFixed(2)))
    };

    assert.equal(payment2.amount_total, 368.55, 'Payment 2 must record only its own transaction amount (368.55)');
    assert.equal(payment2.tech_payout_amount, 326.43, 'Payment 2 incremental tech payout must be 326.43');
    assert.equal(payment2.platform_commission, 42.12, 'Payment 2 incremental platform cut must be 42.12');

    // Aggregated database sums across both payments
    const totalGross = parseFloat((payment1.amount_total + payment2.amount_total).toFixed(2));
    const totalTechDisbursed = parseFloat((payment1.tech_payout_amount + payment2.tech_payout_amount).toFixed(2));
    const totalPlatformRetained = parseFloat((payment1.platform_commission + payment2.platform_commission).toFixed(2));

    assert.equal(totalGross, 417.55, 'Aggregated Gross Inflow must be 417.55 (not 466.55)');
    assert.equal(totalTechDisbursed, 372.00, 'Aggregated Tech Payout must be exactly 372.00');
    assert.equal(totalPlatformRetained, 45.55, 'Aggregated Platform Commission must be exactly 45.55');
    assert.equal(totalGross, parseFloat((totalTechDisbursed + totalPlatformRetained).toFixed(2)), 'Total gross must equal total tech + platform');
  });

  it('3. Customer Screen Data Integrity: verifies receipt view matches quote approval', () => {
    const inv = calculateDualCommissionInvoice(bookingConfig);

    const customerReceipt = {
      approvedQuoteTotal: inv.totalJobAmount,
      advanceCredited: inv.upfrontFeePaid,
      netWorkBase: inv.remainingWorkAmount,
      customerPlatformFee: inv.customerPlatformFee,
      customerPlatformFeePercent: inv.customerFeePercent,
      part1Paid: bookingConfig.actualAdvancePaid,
      part2Paid: inv.customerFinalPayable,
      totalPaid: bookingConfig.actualAdvancePaid + inv.customerFinalPayable
    };

    assert.equal(customerReceipt.approvedQuoteTotal, 400.00);
    assert.equal(customerReceipt.advanceCredited, 49.00);
    assert.equal(customerReceipt.netWorkBase, 351.00);
    assert.equal(customerReceipt.customerPlatformFee, 17.55);
    assert.equal(customerReceipt.part1Paid, 49.00);
    assert.equal(customerReceipt.part2Paid, 368.55);
    assert.equal(customerReceipt.totalPaid, 417.55);
  });

  it('4. Technician Screen Data Integrity: verifies partner job card earnings', () => {
    const inv = calculateDualCommissionInvoice(bookingConfig);

    const partnerView = {
      grossAmount: inv.totalJobAmount,
      techPayout: inv.partnerDirectRouteTransfer,
      platformCommission: inv.partnerCommissionAmount,
      techSharePercent: 100 - inv.partnerCommPercent,
      platformCommPercent: inv.partnerCommPercent
    };

    assert.equal(partnerView.grossAmount, 400.00);
    assert.equal(partnerView.techPayout, 372.00);
    assert.equal(partnerView.platformCommission, 28.00);
    assert.equal(partnerView.techSharePercent, 93);
    assert.equal(partnerView.platformCommPercent, 7);
    assert.equal(partnerView.techPayout + partnerView.platformCommission, partnerView.grossAmount);
  });

  it('5. Admin Financial Ledger Data Integrity: verifies master settlement ledger', () => {
    const inv = calculateDualCommissionInvoice(bookingConfig);
    const totalGrossInflow = bookingConfig.actualAdvancePaid + inv.customerFinalPayable;

    const adminLedgerRow = {
      grossInflow: totalGrossInflow,
      customerCutoff: inv.customerPlatformFee,
      customerFeePercent: inv.customerFeePercent,
      techCutoff: inv.partnerCommissionAmount,
      partnerCommPercent: inv.partnerCommPercent,
      techPayout: inv.partnerDirectRouteTransfer,
      netPlatformCut: inv.platformTotalRetained,
      gatewayFee: inv.paymentGatewayFee
    };

    assert.equal(adminLedgerRow.grossInflow, 417.55);
    assert.equal(adminLedgerRow.customerCutoff, 17.55);
    assert.equal(adminLedgerRow.techCutoff, 28.00);
    assert.equal(adminLedgerRow.techPayout, 372.00);
    assert.equal(adminLedgerRow.netPlatformCut, 45.55);

    // Admin Dual-Sided Cutoff Matrix consistency checks
    assert.equal(
      parseFloat((adminLedgerRow.customerCutoff + adminLedgerRow.techCutoff).toFixed(2)),
      adminLedgerRow.netPlatformCut,
      'Customer cut + Tech cut must equal Net Platform Cut'
    );
    assert.equal(
      parseFloat((adminLedgerRow.techPayout + adminLedgerRow.netPlatformCut).toFixed(2)),
      adminLedgerRow.grossInflow,
      'Tech Payout + Net Platform Cut must equal Gross Inflow'
    );
  });

});
