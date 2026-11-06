/**
 * ============================================================================
 * SHAZU ONE: DIRECT CALLING PRIVACY GUARD (OPTION 1) TEST SUITE
 * Validates stage-gated phone number visibility, masking, and E.164 dialer formatting
 * ============================================================================
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  HELPDESK_PHONE,
  ACTIVE_DIRECT_CALL_STATUSES,
  canDirectCall,
  sanitizePhoneForDialer,
  maskPhoneNumber,
  redactBookingParties
} = require('../src/utils/privacy.js');

describe('Unit Test: Smart Privacy Guard Direct Phone Calling (Option 1)', () => {

  it('1. should allow direct phone calls only during active service stages', () => {
    const activeStages = [
      'matching',
      'accepted',
      'en_route',
      'arrived',
      'inspecting',
      'quote_presented',
      'quote_approved',
      'in_progress'
    ];

    for (const stage of activeStages) {
      assert.equal(canDirectCall(stage), true, `Direct call must be enabled in stage: ${stage}`);
    }

    const closedStages = ['completed', 'cancelled', 'created', 'rejected', null, undefined];
    for (const stage of closedStages) {
      assert.equal(canDirectCall(stage), false, `Direct call must be blocked in stage: ${stage}`);
    }
  });

  it('2. should format and mask phone numbers accurately for completed orders', () => {
    assert.equal(maskPhoneNumber('+91 8807099277'), '+91 88*** ***77');
    assert.equal(maskPhoneNumber('8807099288'), '+91 88*** ***88');
    assert.equal(maskPhoneNumber('+91-98421-00012'), '+91 98*** ***12');
    assert.equal(maskPhoneNumber('123'), '******');
    assert.equal(maskPhoneNumber(null), null);
  });

  it('3. should sanitize phone numbers to E.164 dialer format', () => {
    assert.equal(sanitizePhoneForDialer('8807099277'), '+918807099277');
    assert.equal(sanitizePhoneForDialer('+91 88070 99277'), '+918807099277');
    assert.equal(sanitizePhoneForDialer('+91-8807099277'), '+918807099277');
    assert.equal(sanitizePhoneForDialer(null), HELPDESK_PHONE);
    assert.equal(sanitizePhoneForDialer(''), HELPDESK_PHONE);
  });

  it('4. should keep real phone numbers on active bookings and redact on completed bookings', () => {
    const activeBooking = {
      id: 'SLM-ACTIVE',
      status: 'en_route',
      customer_phone: '+91 8807099288',
      technician_phone: '+91 8807099277'
    };

    const activeResult = redactBookingParties(activeBooking);
    assert.equal(activeResult.canDirectCall, true);
    assert.equal(activeResult.customer_phone, '+91 8807099288');
    assert.equal(activeResult.technician_phone, '+91 8807099277');
    assert.equal(activeResult.helpdeskPhone, HELPDESK_PHONE);

    const completedBooking = {
      id: 'SLM-COMPLETED',
      status: 'completed',
      customer_phone: '+91 8807099288',
      technician_phone: '+91 8807099277'
    };

    const completedResult = redactBookingParties(completedBooking);
    assert.equal(completedResult.canDirectCall, false);
    assert.equal(completedResult.customer_phone, '+91 88*** ***88');
    assert.equal(completedResult.technician_phone, '+91 88*** ***77');
    assert.equal(completedResult.helpdeskPhone, HELPDESK_PHONE);
  });

  it('5. should allow admin to bypass redaction on completed bookings', () => {
    const completedBooking = {
      id: 'SLM-COMPLETED',
      status: 'completed',
      customer_phone: '+91 8807099288',
      technician_phone: '+91 8807099277'
    };

    const adminResult = redactBookingParties(completedBooking, { isAdmin: true });
    assert.equal(adminResult.canDirectCall, true);
    assert.equal(adminResult.customer_phone, '+91 8807099288');
    assert.equal(adminResult.technician_phone, '+91 8807099277');
  });

});
