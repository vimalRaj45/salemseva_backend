const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'salem_shazu_jwt_secret_key_2026';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

/**
 * Sign a payload into a JWT
 * @param {Object} payload User identity claims: { id, role, phone, name, email, locality }
 * @param {string} [expiresIn] Expiration duration, defaults to 7d
 * @returns {string} Signed JWT
 */
function signToken(payload, expiresIn = JWT_EXPIRES_IN) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Payload must be a valid object');
  }
  const claims = {
    id: payload.id || payload._id || payload.userId || null,
    role: payload.role || 'customer',
    phone: payload.phone || null,
    name: payload.name || payload.full_name || null,
    email: payload.email || null,
    locality: payload.locality || null
  };
  return jwt.sign(claims, JWT_SECRET, { expiresIn });
}

/**
 * Verify a JWT and decode its payload
 * @param {string} token
 * @returns {Object|null} Decoded payload or null if invalid/expired
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

/**
 * Extract token from Fastify request headers
 * Supports Authorization: Bearer <token>, x-auth-token, x-token, x-admin-token
 * @param {Object} req
 * @returns {string|null}
 */
function extractToken(req) {
  if (!req || !req.headers) return null;
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  const altToken = req.headers['x-auth-token'] || req.headers['x-token'] || req.headers['x-admin-token'];
  if (typeof altToken === 'string' && altToken.trim()) {
    return altToken.trim();
  }
  return null;
}

/**
 * Fastify preHandler hook: Strict authentication required.
 * Returns 401 if missing or invalid token.
 */
async function authenticateUser(req, reply) {
  const token = extractToken(req);
  if (!token) {
    return reply.status(401).send({
      success: false,
      error: 'Authentication token required.',
      code: 'AUTH_TOKEN_MISSING'
    });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return reply.status(401).send({
      success: false,
      error: 'Invalid or expired authentication session.',
      code: 'AUTH_TOKEN_INVALID'
    });
  }

  req.user = decoded;
}

/**
 * Fastify preHandler hook: Optional authentication.
 * Attaches req.user if valid token present, otherwise req.user = null.
 * Never fails or rejects the request, preserving existing public flows.
 */
async function optionalAuthenticate(req, reply) {
  const token = extractToken(req);
  if (!token) {
    req.user = null;
    return;
  }

  const decoded = verifyToken(token);
  req.user = decoded || null;
}

/**
 * Fastify preHandler hook: Role guard.
 * Must be preceded by authenticateUser.
 */
function requireRole(...allowedRoles) {
  return async function roleGuard(req, reply) {
    if (!req.user) {
      return reply.status(401).send({
        success: false,
        error: 'Unauthorized access.',
        code: 'UNAUTHORIZED'
      });
    }

    const userRole = (req.user.role || '').toLowerCase();
    const hasRole = allowedRoles.some((r) => r.toLowerCase() === userRole);
    if (!hasRole) {
      return reply.status(403).send({
        success: false,
        error: 'Forbidden: Insufficient privileges for this operation.',
        code: 'FORBIDDEN_ROLE'
      });
    }
  };
}

module.exports = {
  signToken,
  verifyToken,
  extractToken,
  authenticateUser,
  optionalAuthenticate,
  requireRole
};
