// One password implementation for the whole backend.
//
// There were two: auth.routes.js hashed correctly with scrypt, and partner.routes.js still
// used unsalted SHA-256 with a hardcoded default of 'salem123'. Two implementations of the
// same security primitive always drift, so there is now one.
//
// Format: scrypt$<salt>$<key>. A bare hex string is a legacy unsalted SHA-256 hash; those
// still verify and are upgraded on the next successful sign-in.

const crypto = require('crypto');

const KEY_LENGTH = 64;
const SALT_BYTES = 16;

function hashPassword(pwd) {
  if (!pwd) return '';
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  const key = crypto.scryptSync(String(pwd).trim(), salt, KEY_LENGTH).toString('hex');
  return `scrypt$${salt}$${key}`;
}

function legacySha256(pwd) {
  return crypto.createHash('sha256').update(String(pwd).trim()).digest('hex');
}

// Length-safe constant time comparison, so a wrong password cannot be found by timing.
function constantTimeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a == null ? '' : a)).digest();
  const right = crypto.createHash('sha256').update(String(b == null ? '' : b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function verifyPassword(pwd, stored) {
  if (!pwd || !stored) return false;
  const value = String(stored);
  if (value.startsWith('scrypt$')) {
    const [, salt, key] = value.split('$');
    if (!salt || !key) return false;
    const derived = crypto.scryptSync(String(pwd).trim(), salt, KEY_LENGTH).toString('hex');
    return constantTimeEqual(derived, key);
  }
  return constantTimeEqual(legacySha256(pwd), stored);
}

// A verified legacy hash is upgraded at sign-in instead of being left weak forever.
function needsRehash(stored) {
  return !String(stored || '').startsWith('scrypt$');
}

module.exports = { hashPassword, verifyPassword, needsRehash, constantTimeEqual, legacySha256 };
