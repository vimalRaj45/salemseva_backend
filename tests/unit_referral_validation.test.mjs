import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  resolveTechnicianReferrer,
  resolveCustomerReferrer,
  processTechnicianReferralOnCompletion
} = require('../src/services/referral.service.js');
const { resolveLocalityCoords, SALEM_CENTER } = require('../src/utils/salemLocalities.js');

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

describe('Unit Test: First-Job Referral Incentive Payout & Idempotency', () => {
  it('pays referrer strictly after referred tech completes 1st job and never double-pays', async () => {
    const state = {
      completedBookings: 0,
      techs: {
        'tech-referrer': { id: 'tech-referrer', full_name: 'Referrer Tech', phone: '+919842711234', upi_vpa: '9842711234@ybl' },
        'tech-referee': {
          id: 'tech-referee',
          full_name: 'Referee Tech',
          phone: '+919000011111',
          jobs_completed_count: 0,
          referred_by_tech_id: 'tech-referrer',
          referral_incentive_paid: false
        }
      },
      payouts: []
    };

    const queryFn = async (sql, params = []) => {
      if (sql.includes('UPDATE technicians') && sql.includes('SET jobs_completed_count')) {
        const t = state.techs[params[0]];
        if (t) t.jobs_completed_count = state.completedBookings;
        return { rows: [] };
      }
      if (sql.includes('SELECT id, full_name, phone, jobs_completed_count, referred_by_tech_id, referral_incentive_paid')) {
        const t = state.techs[params[0]];
        return { rows: t ? [t] : [] };
      }
      if (sql.includes('SELECT partner_referral_incentive FROM platform_settings')) {
        return { rows: [{ partner_referral_incentive: '100.00' }] };
      }
      if (sql.includes('SELECT id, phone, upi_vpa, full_name FROM technicians')) {
        const t = state.techs[params[0]];
        return { rows: t ? [t] : [] };
      }
      if (sql.includes('UPDATE technicians') && sql.includes('SET referral_incentive_paid = TRUE')) {
        const t = state.techs[params[0]];
        if (t && t.jobs_completed_count >= 1 && t.referred_by_tech_id && !t.referral_incentive_paid) {
          t.referral_incentive_paid = true;
          return { rows: [{ id: t.id }] };
        }
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO technician_payouts')) {
        state.payouts.push({
          phone: params[0],
          technicianId: params[1],
          amount: params[2],
          upi: params[3],
          utr: params[4],
          description: params[5]
        });
        return { rows: [] };
      }
      return { rows: [] };
    };

    // 1. Before any completed job -> NO incentive awarded
    const beforeJob = await processTechnicianReferralOnCompletion(queryFn, 'tech-referee');
    assert.equal(beforeJob.rewarded, false);
    assert.equal(beforeJob.reason, 'first_job_not_completed');
    assert.equal(state.payouts.length, 0);

    // 2. First job completed -> Referrer receives 100 incentive payout
    state.completedBookings = 1;
    const onFirstJob = await processTechnicianReferralOnCompletion(queryFn, 'tech-referee');
    assert.equal(onFirstJob.rewarded, true);
    assert.equal(onFirstJob.incentiveAmount, 100);
    assert.equal(onFirstJob.referrerId, 'tech-referrer');
    assert.equal(state.payouts.length, 1);
    assert.equal(state.techs['tech-referee'].referral_incentive_paid, true);

    // 3. Second job completed / duplicate callback -> Idempotent (no duplicate payout)
    state.completedBookings = 2;
    const onSecondJob = await processTechnicianReferralOnCompletion(queryFn, 'tech-referee');
    assert.equal(onSecondJob.rewarded, false);
    assert.equal(onSecondJob.reason, 'already_paid');
    assert.equal(state.payouts.length, 1);
  });
});

describe('Unit Test: Salem Locality Coordinate Resolution', () => {
  it('resolves assigned technician localities and falls back to Salem center', () => {
    const ammapet = resolveLocalityCoords(['Ammapet', 'Hasthampatti']);
    assert.equal(ammapet.localityName, 'Ammapet');
    assert.equal(ammapet.lat, 11.654);

    const byPin = resolveLocalityCoords('636007 Salem');
    assert.equal(byPin.localityName, 'Hasthampatti');

    const unknown = resolveLocalityCoords('');
    assert.equal(unknown.lat, SALEM_CENTER.lat);
    assert.equal(unknown.lng, SALEM_CENTER.lng);
  });
});
