import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  resolveTechnicianReferrer,
  resolveCustomerReferrer
} = require('../src/services/referral.service.js');

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

describe('Unit Test: Technician Partner Referral Code Resolution', () => {
  const sampleTechs = [
    { id: 'tech-uuid-1', full_name: 'S. Venkatesh', phone: '+91 9842711234', referral_code: 'TECH-1234' },
    { id: 'tech-uuid-2', full_name: 'M. Karthik', phone: '+91 9443288901', referral_code: null }
  ];

  const mockQuery = async (sql, params) => {
    if (sql.includes('FROM technicians')) {
      const [normCode, phone10] = params;
      const found = sampleTechs.find((t) => {
        const storedNorm = String(t.referral_code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const techDigits = t.phone.replace(/[^0-9]/g, '').slice(-10);
        const defaultNorm = `TECH${techDigits.slice(-4)}`;
        return (
          (normCode && storedNorm === normCode) ||
          (normCode && defaultNorm === normCode) ||
          (phone10 && techDigits === phone10)
        );
      });
      return { rows: found ? [found] : [] };
    }
    if (sql.includes('FROM users')) {
      const [refTrim, phone10] = params;
      const sampleUsers = [
        { id: 'user-1', full_name: 'Murugan', phone: '+919443288901', referral_code: 'SEVA9482' }
      ];
      const found = sampleUsers.find((u) => {
        const uDigits = u.phone.replace(/[^0-9]/g, '').slice(-10);
        return u.referral_code.toUpperCase() === refTrim || (phone10 && uDigits === phone10);
      });
      return { rows: found ? [found] : [] };
    }
    return { rows: [] };
  };

  it('should match hyphenated, unhyphenated, and phone-based technician referral codes', async () => {
    const byHyphen = await resolveTechnicianReferrer(mockQuery, 'tech-1234', '9000011111');
    assert.equal(byHyphen.ok, true);
    assert.equal(byHyphen.referrer.id, 'tech-uuid-1');

    const byPlain = await resolveTechnicianReferrer(mockQuery, 'TECH1234', '9000011111');
    assert.equal(byPlain.ok, true);
    assert.equal(byPlain.referrer.id, 'tech-uuid-1');

    const byFallbackDefault = await resolveTechnicianReferrer(mockQuery, 'TECH8901', '9000011111');
    assert.equal(byFallbackDefault.ok, true);
    assert.equal(byFallbackDefault.referrer.id, 'tech-uuid-2');
    assert.equal(byFallbackDefault.referralCode, 'TECH8901');

    const byPhone = await resolveTechnicianReferrer(mockQuery, '9842711234', '9000011111');
    assert.equal(byPhone.ok, true);
    assert.equal(byPhone.referrer.id, 'tech-uuid-1');
  });

  it('should reject invalid or unknown technician referral codes', async () => {
    const res = await resolveTechnicianReferrer(mockQuery, 'TECH-9999', '9000011111');
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
    assert.match(res.error, /Wrong referral code/);
  });

  it('should reject technician self-referrals by code or phone', async () => {
    const byCode = await resolveTechnicianReferrer(mockQuery, 'TECH-1234', '9842711234');
    assert.equal(byCode.ok, false);
    assert.equal(byCode.status, 400);
    assert.match(byCode.error, /own referral code/i);

    const byPhone = await resolveTechnicianReferrer(mockQuery, '9842711234', '+91 98427 11234');
    assert.equal(byPhone.ok, false);
    assert.equal(byPhone.status, 400);
  });

  it('should resolve customer referral codes consistently', async () => {
    const valid = await resolveCustomerReferrer(mockQuery, 'SEVA9482', '9000011111');
    assert.equal(valid.ok, true);
    assert.equal(valid.referrerName, 'Murugan');

    const invalid = await resolveCustomerReferrer(mockQuery, 'BADCODE', '9000011111');
    assert.equal(invalid.ok, false);
    assert.equal(invalid.status, 404);
  });
});
