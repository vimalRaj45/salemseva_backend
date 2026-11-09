import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkCancellationWindow } = require('../src/services/cancellation_policy.service.js');

describe('Pre-Assignment Cancellation Window Policy Unit Tests', () => {
  const now = new Date('2026-11-10T08:00:00Z');

  it('allows free cancellation when technician is NOT assigned, even if slot is within 24 hours', () => {
    // Scheduled today at 10:00 AM (only 2 hours away)
    const slotStr = '2026-11-10 10:00 AM';
    const result = checkCancellationWindow(slotStr, '2026-11-10T07:30:00Z', false, now, false);

    assert.strictEqual(result.isCancellationAllowed, true, 'Cancellation should be allowed before tech assignment');
    assert.match(result.policyReason, /Technician has not yet been assigned/i);
  });

  it('allows free cancellation on urgent/emergency requests if technician is NOT yet assigned', () => {
    const slotStr = 'Emergency Immediate Dispatch';
    const result = checkCancellationWindow(slotStr, '2026-11-10T07:50:00Z', true, now, false);

    assert.strictEqual(result.isCancellationAllowed, true, 'Urgent request should allow cancel before tech assignment');
    assert.match(result.policyReason, /Technician has not yet been assigned/i);
  });

  it('enforces 24-hour lockout when technician IS assigned and slot is within 24 hours', () => {
    // Scheduled today at 10:00 AM (only 2 hours away)
    const slotStr = '2026-11-10 10:00 AM';
    const result = checkCancellationWindow(slotStr, '2026-11-10T07:30:00Z', false, now, true);

    assert.strictEqual(result.isCancellationAllowed, false, 'Cancellation should be blocked once tech is assigned within 24h');
    assert.match(result.policyReason, /cancellations must be made at least 24 hours prior/i);
  });

  it('permits cancellation when technician IS assigned but appointment is more than 24 hours away', () => {
    // Scheduled 3 days away
    const slotStr = '2026-11-13 10:00 AM';
    const result = checkCancellationWindow(slotStr, '2026-11-10T07:00:00Z', false, now, true);

    assert.strictEqual(result.isCancellationAllowed, true, 'Cancellation should be allowed when >24 hours away');
    assert.match(result.policyReason, /exceeds the 24-hour cutoff/i);
  });
});
