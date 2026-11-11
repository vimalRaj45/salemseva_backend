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

/**
 * Processes the referring technician's referral incentive strictly when the referred
 * technician completes their first service job (jobs_completed_count >= 1).
 * Idempotent across multiple completion endpoints via atomic referral_incentive_paid update.
 */
async function processTechnicianReferralOnCompletion(queryFn, techId, log = console) {
  if (!techId) {
    return { rewarded: false, reason: 'missing_tech_id' };
  }

  try {
    await queryFn(
      `
        UPDATE technicians
        SET jobs_completed_count = (
          SELECT count(*)::int FROM bookings WHERE technician_id = $1 AND status = 'completed'
        )
        WHERE id = $1
      `,
      [techId]
    );

    const techRes = await queryFn(
      `
        SELECT id, full_name, phone, jobs_completed_count, referred_by_tech_id, referral_incentive_paid
        FROM technicians
        WHERE id = $1
      `,
      [techId]
    );

    const currentTech = techRes.rows?.[0];
    if (!currentTech) {
      return { rewarded: false, reason: 'technician_not_found' };
    }
    if (!currentTech.referred_by_tech_id) {
      return { rewarded: false, reason: 'no_referrer' };
    }
    if (Number(currentTech.jobs_completed_count || 0) < 1) {
      return { rewarded: false, reason: 'first_job_not_completed' };
    }
    if (currentTech.referral_incentive_paid) {
      return { rewarded: false, reason: 'already_paid' };
    }

    const sRes = await queryFn(
      `SELECT partner_referral_incentive FROM platform_settings WHERE id = 'reward_settings' LIMIT 1`
    );
    const incentiveAmount = sRes.rows?.length > 0
      ? parseFloat(sRes.rows[0].partner_referral_incentive ?? 100)
      : 100.00;

    if (!Number.isFinite(incentiveAmount) || incentiveAmount <= 0) {
      return { rewarded: false, reason: 'zero_incentive' };
    }

    const referrerRes = await queryFn(
      `SELECT id, phone, upi_vpa, full_name FROM technicians WHERE id = $1`,
      [currentTech.referred_by_tech_id]
    );
    if (!referrerRes.rows || referrerRes.rows.length === 0) {
      return { rewarded: false, reason: 'referrer_not_found' };
    }
    const referrerTech = referrerRes.rows[0];

    const claimRes = await queryFn(
      `
        UPDATE technicians
        SET referral_incentive_paid = TRUE
        WHERE id = $1
          AND jobs_completed_count >= 1
          AND referred_by_tech_id IS NOT NULL
          AND COALESCE(referral_incentive_paid, FALSE) = FALSE
        RETURNING id
      `,
      [techId]
    );

    if (!claimRes.rows || claimRes.rows.length === 0) {
      return { rewarded: false, reason: 'already_claimed' };
    }

    const refUtr = 'REF-' + Math.floor(100000 + Math.random() * 900000);
    await queryFn(
      `
        INSERT INTO technician_payouts (technician_phone, technician_id, amount, upi_id, status, utr_ref, description, created_at)
        VALUES ($1, $2, $3, $4, 'DISBURSED_100%', $5, $6, NOW())
      `,
      [
        referrerTech.phone,
        referrerTech.id,
        incentiveAmount,
        referrerTech.upi_vpa || '',
        refUtr,
        `Partner Referral Incentive: ${currentTech.full_name} completed first service job!`
      ]
    );

    return {
      rewarded: true,
      incentiveAmount,
      referrerId: referrerTech.id,
      refereeId: currentTech.id,
      utr: refUtr
    };
  } catch (err) {
    if (log && typeof log.warn === 'function') {
      log.warn('Could not process technician referral incentive: ' + err.message);
    }
    return { rewarded: false, reason: 'error', error: err.message };
  }
}

module.exports = {
  sanitizePhone10,
  normalizeReferralInput,
  resolveTechnicianReferrer,
  resolveCustomerReferrer,
  processTechnicianReferralOnCompletion
};
