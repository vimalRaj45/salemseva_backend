import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

describe('Unit Test: Admin Email OTP Authentication & Session Security', () => {
  const allowedEmailsConfig = 'malikasaravanan774@gmail.com, operations.lead@shazuone.in';
  
  function getAllowedAdminEmails(rawConfig = allowedEmailsConfig) {
    return rawConfig
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);
  }

  function validateAdminAccess(email, rawConfig) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      return { authorized: false, error: 'Please enter a valid administrator email address.' };
    }
    const allowed = getAllowedAdminEmails(rawConfig);
    if (!allowed.includes(cleanEmail)) {
      return { authorized: false, error: `Access Denied: The email "${cleanEmail}" is not authorized for administrator access.` };
    }
    return { authorized: true, email: cleanEmail };
  }

  function generateAdminOtp() {
    const otpCode = crypto.randomInt(100000, 999999).toString();
    const otpHash = crypto.createHash('sha256').update(otpCode).digest('hex');
    return { otpCode, otpHash };
  }

  function verifyOtp(submittedOtp, storedHash, attempts, expiresAt) {
    if (Date.now() > expiresAt) {
      return { success: false, error: 'Verification code has expired. Please request a new code.' };
    }
    if (attempts >= 5) {
      return { success: false, error: 'Too many incorrect attempts. Please request a new verification code.' };
    }
    const submittedHash = crypto.createHash('sha256').update(String(submittedOtp).trim()).digest('hex');
    if (submittedHash !== storedHash) {
      return { success: false, attempts: attempts + 1, error: 'Incorrect verification code.' };
    }
    return { success: true };
  }

  it('should reject unauthorized or malformed email addresses', () => {
    assert.equal(validateAdminAccess('hacker@evil.com').authorized, false);
    assert.equal(validateAdminAccess('').authorized, false);
    assert.equal(validateAdminAccess('not-an-email').authorized, false);
    assert.equal(validateAdminAccess('guest@shazuone.in').authorized, false);
  });

  it('should allow authorized administrator email addresses regardless of casing or surrounding whitespace', () => {
    const result1 = validateAdminAccess('  malikasaravanan774@gmail.com  ');
    assert.equal(result1.authorized, true);
    assert.equal(result1.email, 'malikasaravanan774@gmail.com');

    const result2 = validateAdminAccess('OPERATIONS.LEAD@SHAZUONE.IN');
    assert.equal(result2.authorized, true);
    assert.equal(result2.email, 'operations.lead@shazuone.in');
  });

  it('should generate valid 6-digit cryptographic OTP', () => {
    for (let i = 0; i < 20; i++) {
      const { otpCode, otpHash } = generateAdminOtp();
      assert.equal(otpCode.length, 6);
      assert.match(otpCode, /^[0-9]{6}$/);
      assert.equal(typeof otpHash, 'string');
      assert.equal(otpHash.length, 64);
    }
  });

  it('should correctly verify valid OTP and reject invalid OTP with attempt counting', () => {
    const { otpCode, otpHash } = generateAdminOtp();
    const expiresAt = Date.now() + 10 * 60 * 1000;

    // Wrong OTP
    const failResult = verifyOtp('000000', otpHash, 0, expiresAt);
    assert.equal(failResult.success, false);
    assert.equal(failResult.attempts, 1);

    // Correct OTP
    const successResult = verifyOtp(otpCode, otpHash, 1, expiresAt);
    assert.equal(successResult.success, true);
  });

  it('should expire OTP after 10-minute window', () => {
    const { otpCode, otpHash } = generateAdminOtp();
    const expiredTimestamp = Date.now() - 1000; // 1 second in past

    const result = verifyOtp(otpCode, otpHash, 0, expiredTimestamp);
    assert.equal(result.success, false);
    assert.match(result.error, /expired/i);
  });

  it('should lockout verification after 5 failed attempts', () => {
    const { otpCode, otpHash } = generateAdminOtp();
    const expiresAt = Date.now() + 10 * 60 * 1000;

    const result = verifyOtp(otpCode, otpHash, 5, expiresAt);
    assert.equal(result.success, false);
    assert.match(result.error, /Too many incorrect attempts/i);
  });

  it('should enforce emergency password login policy and validation', () => {
    const adminPasswordEnv = 'EwsYhiVtQXdDLIjs';

    function verifyEmergencyPasswordLogin({ email, password, enabled, configuredPassword = adminPasswordEnv }) {
      if (!enabled) {
        return { success: false, status: 403, error: 'Emergency password login is disabled.' };
      }
      const access = validateAdminAccess(email);
      if (!access.authorized) {
        return { success: false, status: 403, error: access.error };
      }
      if (password !== configuredPassword) {
        return { success: false, status: 401, error: 'Incorrect administrator password.' };
      }
      return { success: true, user: { email: access.email, role: 'admin' } };
    }

    // 1. Rejected when disabled in env
    const disabledResult = verifyEmergencyPasswordLogin({
      email: 'malikasaravanan774@gmail.com',
      password: adminPasswordEnv,
      enabled: false
    });
    assert.equal(disabledResult.success, false);
    assert.equal(disabledResult.status, 403);

    // 2. Rejected when unauthorized email attempts password login
    const unauthorizedResult = verifyEmergencyPasswordLogin({
      email: 'intruder@example.com',
      password: adminPasswordEnv,
      enabled: true
    });
    assert.equal(unauthorizedResult.success, false);
    assert.equal(unauthorizedResult.status, 403);

    // 3. Rejected when wrong password
    const wrongPasswordResult = verifyEmergencyPasswordLogin({
      email: 'malikasaravanan774@gmail.com',
      password: 'wrong_password',
      enabled: true
    });
    assert.equal(wrongPasswordResult.success, false);
    assert.equal(wrongPasswordResult.status, 401);

    // 4. Accepted when enabled, authorized email, and correct password
    const validResult = verifyEmergencyPasswordLogin({
      email: 'malikasaravanan774@gmail.com',
      password: adminPasswordEnv,
      enabled: true
    });
    assert.equal(validResult.success, true);
    assert.equal(validResult.user.role, 'admin');
  });
});
