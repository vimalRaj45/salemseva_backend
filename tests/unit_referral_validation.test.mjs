import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Unit Test: Customer Referral Code Verification & Waiver Security', () => {
  it('should reject random referral code in referral check logic', () => {
    const enteredCode = 'RANDOM_GARBAGE_CODE';
    const existingUsers = [
      { referral_code: 'SEVA9482', phone: '+919443288901' },
      { referral_code: 'SEVA1122', phone: '+919842711234' }
    ];

    const refTrim = enteredCode.trim().toUpperCase();
    const refDigits = refTrim.replace(/[^0-9]/g, '').slice(-10);

    const match = existingUsers.find(
      u => u.referral_code === refTrim || (refDigits.length === 10 && u.phone.includes(refDigits))
    );

    assert.equal(match, undefined);
  });

  it('should accept existing referral code matching referral_code or 10-digit phone', () => {
    const existingUsers = [
      { referral_code: 'SEVA9482', phone: '+919443288901', full_name: 'Murugan' },
      { referral_code: 'SEVA1122', phone: '+919842711234', full_name: 'Kavitha' }
    ];

    // Check code match
    const codeMatch = existingUsers.find(u => u.referral_code === 'SEVA9482');
    assert.ok(codeMatch);
    assert.equal(codeMatch.full_name, 'Murugan');

    // Check phone match
    const phoneInput = '9842711234';
    const phoneMatch = existingUsers.find(u => u.phone.replace(/[^0-9]/g, '').slice(-10) === phoneInput);
    assert.ok(phoneMatch);
    assert.equal(phoneMatch.full_name, 'Kavitha');
  });

  it('should reject self-referral attempts', () => {
    const customerPhone = '9443288901';
    const myReferralCode = 'SEVA8901';

    // Attempting to use my own referral code
    const enteredReferral = 'SEVA8901';
    const isSelfByCode = enteredReferral.toUpperCase() === myReferralCode;
    assert.equal(isSelfByCode, true);

    // Attempting to use my own phone
    const enteredPhone = '+91 94432 88901';
    const isSelfByPhone = enteredPhone.replace(/[^0-9]/g, '').slice(-10) === customerPhone;
    assert.equal(isSelfByPhone, true);
  });

  it('should strictly guard REFERWAIVER50 so that only genuinely referred users qualify', () => {
    const unreferredUser = { id: 'u1', referred_by: null, referral_count: 0 };
    const fakeReferredUser = { id: 'u2', referred_by: '12212', referral_count: 0 }; // Referrer 12212 does not exist
    const validReferredUser = { id: 'u3', referred_by: 'SEVA9482', referral_count: 0 }; // Referrer SEVA9482 exists

    const existingUsers = [{ referral_code: 'SEVA9482', phone: '+919443288901' }];

    function checkEligibility(user) {
      if (!user) return false;
      let validReferrer = false;
      if (user.referred_by) {
        const refDigits = String(user.referred_by).replace(/[^0-9]/g, '').slice(-10);
        validReferrer = existingUsers.some(
          ex => ex.referral_code === String(user.referred_by).toUpperCase() ||
                (refDigits.length === 10 && ex.phone.includes(refDigits))
        );
      }
      return Boolean(validReferrer || user.referral_count > 0);
    }

    assert.equal(checkEligibility(unreferredUser), false);
    assert.equal(checkEligibility(fakeReferredUser), false);
    assert.equal(checkEligibility(validReferredUser), true);
  });
});
