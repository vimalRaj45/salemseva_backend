/**
 * Domain:           Security / Anti-Bot & Automated Form Submission Guard
 * Purpose:          Cryptographic Math Challenge (e.g. 4 + 4 = 8) & Honeypot Protection
 * Design Doctrine:  Zero user frustration. Triggers only when suspicious activity is detected.
 * Zero emoji rule strictly observed.
 */

const crypto = require('crypto');

const HMAC_SECRET = process.env.SECURITY_HMAC_SECRET || process.env.JWT_SECRET || 'salem_shazu_anti_bot_guard_2026_secret';
const CHALLENGE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// In-memory replay prevention (consumed challenge IDs) with auto-pruning
const consumedChallenges = new Map();
const cleanupTimer1 = setInterval(() => {
  const now = Date.now();
  for (const [id, expiry] of consumedChallenges.entries()) {
    if (now > expiry) consumedChallenges.delete(id);
  }
}, 60 * 1000);
if (cleanupTimer1.unref) cleanupTimer1.unref();

// In-memory rolling burst tracker for risk-based step-up evaluation
const ipAttemptTracker = new Map();
const phoneAttemptTracker = new Map();

const cleanupTimer2 = setInterval(() => {
  const now = Date.now();
  for (const [key, record] of ipAttemptTracker.entries()) {
    if (now - record.firstSeen > 10 * 60 * 1000) ipAttemptTracker.delete(key);
  }
  for (const [key, record] of phoneAttemptTracker.entries()) {
    if (now - record.firstSeen > 10 * 60 * 1000) phoneAttemptTracker.delete(key);
  }
}, 60 * 1000);
if (cleanupTimer2.unref) cleanupTimer2.unref();

/**
 * Generate a tamper-proof arithmetic challenge.
 * Answer is never exposed to the client in plaintext or cookies.
 */
function generateMathChallenge() {
  const challengeId = 'ch_' + crypto.randomBytes(8).toString('hex');
  const isAddition = Math.random() > 0.35; // 65% addition, 35% subtraction
  let a, b, answer, question;

  if (isAddition) {
    a = Math.floor(Math.random() * 8) + 2; // 2 to 9
    b = Math.floor(Math.random() * 8) + 1; // 1 to 8
    answer = a + b;
    question = `What is ${a} + ${b}?`;
  } else {
    a = Math.floor(Math.random() * 8) + 3; // 3 to 10
    b = Math.floor(Math.random() * (a - 1)) + 1; // 1 to (a-1)
    answer = a - b;
    question = `What is ${a} - ${b}?`;
  }

  const expiresAt = Date.now() + CHALLENGE_EXPIRY_MS;
  const signature = crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(`${challengeId}:${answer}:${expiresAt}`)
    .digest('hex');

  const tokenPayload = {
    cId: challengeId,
    exp: expiresAt,
    sig: signature
  };

  const challengeToken = Buffer.from(JSON.stringify(tokenPayload)).toString('base64');

  return {
    challengeId,
    question,
    questionTa: `பாதுகாப்பு சரிபார்ப்பு: ${a} ${isAddition ? '+' : '-'} ${b} = எவ்வளவு?`,
    challengeToken
  };
}

/**
 * Verify a submitted math challenge answer against the cryptographic token.
 */
function verifyMathChallenge(challengeToken, submittedAnswer) {
  if (!challengeToken || submittedAnswer === undefined || submittedAnswer === null || String(submittedAnswer).trim() === '') {
    return { valid: false, error: 'Security math verification answer is required.' };
  }

  try {
    const rawPayload = Buffer.from(challengeToken, 'base64').toString('utf8');
    const { cId, exp, sig } = JSON.parse(rawPayload);

    if (!cId || !exp || !sig) {
      return { valid: false, error: 'Malformed security challenge token.' };
    }

    if (Date.now() > Number(exp)) {
      return { valid: false, error: 'Security challenge has expired. Please refresh and try again.' };
    }

    if (consumedChallenges.has(cId)) {
      return { valid: false, error: 'Security challenge token was already used. Please request a new one.' };
    }

    const cleanAnswer = String(submittedAnswer).trim().replace(/[^0-9\-]/g, '');
    const expectedSig = crypto
      .createHmac('sha256', HMAC_SECRET)
      .update(`${cId}:${cleanAnswer}:${exp}`)
      .digest('hex');

    const expectedBuf = Buffer.from(expectedSig, 'hex');
    const actualBuf = Buffer.from(sig, 'hex');

    if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
      return { valid: false, error: 'Incorrect answer to security verification. Please check the math and try again.' };
    }

    // Mark as consumed to prevent replay attacks
    consumedChallenges.set(cId, exp);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: 'Invalid security challenge format.' };
  }
}

/**
 * Check if common invisible honeypot trap fields were populated by a bot.
 */
function isHoneypotTriggered(body = {}) {
  if (!body || typeof body !== 'object') return false;
  const honeypotKeys = ['website_url', 'company_fax', '_hp_check', 'bot_trap', 'secondary_address'];
  for (const key of honeypotKeys) {
    if (body[key] && String(body[key]).trim().length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Adaptive evaluation: Detects whether a Math Challenge is required for this request.
 * Legitimate users with normal submission cadence are NEVER blocked or frustrated.
 */
function evaluateRiskAndCheckChallenge({ req, phone, formType, body = {} }) {
  const ip = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';
  const cleanPhone = phone ? String(phone).replace(/[^0-9]/g, '').slice(-10) : '';
  const now = Date.now();

  // 1. Honeypot check: If bot filled the hidden input, flag immediately
  if (isHoneypotTriggered(body)) {
    return {
      triggeredHoneypot: true,
      challengeRequired: true,
      reason: 'Honeypot trap triggered.'
    };
  }

  // 2. Timing check: If client sent submissionDurationMs and it's super-human (< 2200ms)
  const durationMs = Number(body.submissionDurationMs || body.formFillTimeMs || 0);
  if (durationMs > 0 && durationMs < 2200) {
    return {
      challengeRequired: true,
      reason: 'Automated submission speed detected.'
    };
  }

  // 3. Track burst attempts per IP
  const ipKey = `${formType}:${ip}`;
  const ipRec = ipAttemptTracker.get(ipKey) || { count: 0, firstSeen: now };
  if (now - ipRec.firstSeen > 5 * 60 * 1000) {
    ipRec.count = 1;
    ipRec.firstSeen = now;
  } else {
    ipRec.count += 1;
  }
  ipAttemptTracker.set(ipKey, ipRec);

  // 4. Track burst attempts per Phone (e.g. OTP pumping)
  let phoneCount = 0;
  if (cleanPhone) {
    const phoneKey = `${formType}:${cleanPhone}`;
    const phoneRec = phoneAttemptTracker.get(phoneKey) || { count: 0, firstSeen: now };
    if (now - phoneRec.firstSeen > 5 * 60 * 1000) {
      phoneRec.count = 1;
      phoneRec.firstSeen = now;
    } else {
      phoneRec.count += 1;
    }
    phoneAttemptTracker.set(phoneKey, phoneRec);
    phoneCount = phoneRec.count;
  }

  // Trigger thresholds:
  // For OTP: require challenge starting from 3rd request within 5 minutes
  if (formType === 'otp' && (phoneCount >= 3 || ipRec.count >= 5)) {
    return {
      challengeRequired: true,
      reason: 'Repeated OTP requests detected.'
    };
  }

  // For Bookings: require challenge starting from 3rd attempt within 5 minutes
  if (formType === 'booking' && ipRec.count >= 3) {
    return {
      challengeRequired: true,
      reason: 'Multiple rapid booking attempts detected.'
    };
  }

  // For Feedback & Tickets: require challenge starting from 3rd attempt within 5 minutes
  if ((formType === 'feedback' || formType === 'ticket') && ipRec.count >= 3) {
    return {
      challengeRequired: true,
      reason: 'Rapid form submissions detected.'
    };
  }

  // Normal human interaction: no challenge required
  return { challengeRequired: false };
}

module.exports = {
  generateMathChallenge,
  verifyMathChallenge,
  isHoneypotTriggered,
  evaluateRiskAndCheckChallenge
};
