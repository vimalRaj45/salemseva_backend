/**
 * Shared referral code normalization, self-referral detection, and DB lookup
 * helpers for both customer and technician partner onboarding/verification.
 */

function sanitizePhone10(phone) {
  const digits = String(phone || '').replace(/[^0-9]/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function normalizeReferralInput(rawCode) {
  const refTrim = String(rawCode || '').trim().toUpperCase();
  const refNormalized = refTrim.replace(/[^A-Z0-9]/g, '');
  const digitsOnly = refTrim.replace(/[^0-9]/g, '');
  const refPhone10 = digitsOnly.length >= 10 ? digitsOnly.slice(-10) : '';
  return { refTrim, refNormalized, refPhone10 };
}

/**
 * Resolves a technician referral code (e.g. TECH-1234, TECH1234, or 10-digit phone)
 * against the technicians table while blocking self-referrals.
 */
async function resolveTechnicianReferrer(queryFn, rawCode, applicantPhone = '') {
  const { refTrim, refNormalized, refPhone10 } = normalizeReferralInput(rawCode);
  const cleanPhone = sanitizePhone10(applicantPhone);

  if (!refTrim) {
    return { ok: false, status: 400, error: 'Please enter a partner referral code or phone number' };
  }

  if (
    cleanPhone &&
    ((refPhone10 && refPhone10 === cleanPhone) || refNormalized === `TECH${cleanPhone.slice(-4)}`)
  ) {
    return { ok: false, status: 400, error: 'You cannot use your own referral code.' };
  }

  const res = await queryFn(
    `
      SELECT id, full_name, phone, referral_code
      FROM technicians
      WHERE ($1::text <> '' AND UPPER(REGEXP_REPLACE(COALESCE(referral_code, ''), '[^A-Z0-9]', '', 'g')) = $1)
         OR ($1::text <> '' AND ('TECH' || RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 4)) = $1)
         OR ($2::text <> '' AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $2)
      LIMIT 1
    `,
    [refNormalized, refPhone10]
  );

  if (!res.rows || res.rows.length === 0) {
    return {
      ok: false,
      status: 404,
      error: `Wrong referral code "${refTrim}". No partner found with this referral code.`
    };
  }

  const tech = res.rows[0];
  const matchedPhone10 = sanitizePhone10(tech.phone);
  if (cleanPhone && matchedPhone10 && matchedPhone10 === cleanPhone) {
    return { ok: false, status: 400, error: 'You cannot use your own referral code.' };
  }

  const effectiveCode =
    tech.referral_code || (matchedPhone10 ? `TECH${matchedPhone10.slice(-4)}` : refTrim);

  return {
    ok: true,
    referrer: tech,
    referrerName: tech.full_name || 'Salem Partner',
    referralCode: effectiveCode
  };
}

/**
 * Resolves a customer referral code (e.g. SEVA9482 or 10-digit phone)
 * against the users table while blocking self-referrals.
 */
async function resolveCustomerReferrer(queryFn, rawCode, applicantPhone = '') {
  const { refTrim, refPhone10 } = normalizeReferralInput(rawCode);
  const cleanPhone = sanitizePhone10(applicantPhone);

  if (!refTrim) {
    return { ok: false, status: 400, error: 'Please enter a referral code or friend phone' };
  }

  if (
    cleanPhone &&
    ((refPhone10 && refPhone10 === cleanPhone) || refTrim === `SEVA${cleanPhone.slice(-4)}`)
  ) {
    return { ok: false, status: 400, error: 'You cannot use your own referral code.' };
  }

  const res = await queryFn(
    `
      SELECT id, full_name, referral_code, phone
      FROM users
      WHERE UPPER(referral_code) = $1
         OR ($2::text <> '' AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $2)
      LIMIT 1
    `,
    [refTrim, refPhone10]
  );

  if (!res.rows || res.rows.length === 0) {
    return {
      ok: false,
      status: 404,
      error: `Wrong referral code "${refTrim}". No member found with this referral code.`
    };
  }

  const user = res.rows[0];
  const matchedPhone10 = sanitizePhone10(user.phone);
  if (cleanPhone && matchedPhone10 && matchedPhone10 === cleanPhone) {
    return { ok: false, status: 400, error: 'You cannot use your own referral code.' };
  }

  return {
    ok: true,
    referrer: user,
    referrerName: user.full_name || 'Salem Member',
    referralCode: user.referral_code || user.phone
  };
}

module.exports = {
  sanitizePhone10,
  normalizeReferralInput,
  resolveTechnicianReferrer,
  resolveCustomerReferrer
};
