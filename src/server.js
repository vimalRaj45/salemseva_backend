const fastify = require('fastify')({ logger: true });
const cors = require('@fastify/cors');
require('dotenv').config();
const { query } = require('./db/db');
const sessionStore = require('./services/session.service');


// Register CORS
// When CORS_ORIGINS is set, browsers are restricted to that list. Native builds send no
// Origin header, so those requests stay allowed. Without the variable the previous
// reflect-everything behaviour is kept, which is acceptable only until auth is in place.
const corsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

fastify.register(cors, {
  origin: corsOrigins.length
    ? (origin, cb) => cb(null, !origin || corsOrigins.includes(origin))
    : true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
});

// Fastify 5 rejects an empty body that arrives with Content-Type: application/json. Most
// HTTP helpers, including this project's own test client, set that header unconditionally on
// DELETE requests, so the framework default turned three working delete endpoints into 400s.
// An empty body is treated as {}, which is what the handlers already assume.
fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  if (body === undefined || body === null || String(body).trim() === '') {
    return done(null, {});
  }
  // Razorpay signs the exact bytes it sent, so the webhook has to verify against those and
  // not against a re-serialised object. Storing the string is a reference, not a copy.
  req.rawBody = body;
  try {
    done(null, JSON.parse(body));
  } catch (err) {
    err.statusCode = 400;
    err.message = 'Request body is not valid JSON.';
    done(err, undefined);
  }
});

// Register All Production Routes
fastify.register(require('./routes/services.routes'), { prefix: '/api/v1' });
fastify.register(require('./routes/bookings.routes'), { prefix: '/api/v1' });
fastify.register(require('./routes/payments.routes'), { prefix: '/api/v1' });
fastify.register(require('./routes/reviews.routes'), { prefix: '/api/v1' });
fastify.register(require('./routes/translate.routes'), { prefix: '/api/v1' });
fastify.register(require('./routes/webrtc.routes'), { prefix: '/api/v1' });
fastify.register(require('./routes/partner.routes'), { prefix: '/api/v1' });
fastify.register(require('./routes/wallet.routes'), { prefix: '/api/v1' });
fastify.register(require('./routes/admin.routes'), { prefix: '/api/v1' });
fastify.register(require('./routes/auth.routes'), { prefix: '/api/v1' });
fastify.register(require('./routes/feedback.routes'), { prefix: '/api/v1' });
fastify.register(require('./routes/storage.routes'), { prefix: '/api/v1' });
fastify.register(require('./routes/settings.routes'), { prefix: '/api/v1' });
fastify.register(require('./routes/coupons.routes'), { prefix: '/api/v1' });
fastify.register(require('./routes/tickets.routes'), { prefix: '/api/v1' });
fastify.register(require('./routes/notifications.routes'), { prefix: '/api/v1' });

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------
// Every request except a short, explicit list needs a live session token. Before this
// existed the API had no authorization at all: any caller could cancel bookings, release
// escrow, verify partner KYC or read the customer list with a bare curl.
//
// The public list is deliberately literal. Adding an endpoint here is a security decision,
// so it should be a visible edit in review rather than something an implicit default allows.
const PUBLIC_ROUTES = new Set([
  // Sign-in, sign-up, recovery. These are the only ways to obtain a token.
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/register',
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/otp/request',
  'POST /api/v1/auth/otp/verify',
  'POST /api/v1/auth/session/verify',
  'POST /api/v1/auth/password/set',
  'POST /api/v1/auth/passkey/login-options',
  'POST /api/v1/auth/passkey/login-verify',
  'POST /api/v1/auth/passkey/register-options',
  'POST /api/v1/auth/passkey/register-verify',
  'GET /api/v1/auth/passkey/status/:phone',

  // Razorpay calls this. It carries its own HMAC signature, and the handler refuses
  // anything unsigned, so a session cannot be required here.
  'POST /api/v1/payments/webhook',

  // Catalogue and other read-only content needed before an account exists.
  'GET /api/v1/services',
  'GET /api/v1/services/:id',
  'GET /api/v1/services/:id/availability',
  'GET /api/v1/services/:id/issues',
  'GET /api/v1/services/:id/spares',
  'GET /api/v1/services-availability',
  'GET /api/v1/coupons/active',
  'GET /api/v1/reviews',
  'GET /api/v1/reviews/stats',
  'GET /api/v1/feedback',
  'GET /api/v1/feedback/list',
  'GET /api/v1/settings/rewards',
  'GET /api/v1/notifications/vapid-public-key',
  'GET /api/v1/storage/file/*',
  'GET /api/v1/storage/view',
  'POST /api/v1/translate',
  'GET /health'
]);

// Endpoints that read or write one person's own records. A customer session may only touch
// its own rows: without this, any logged-in customer could pass another phone number and
// read that person's wallet balance or empty their wallet.
const SELF_SCOPED_ROUTES = new Set([
  'GET /api/v1/wallet/customer',
  'GET /api/v1/bookings/history',
  'GET /api/v1/tickets/user/:phone',
  'GET /api/v1/partner/earnings',
  'GET /api/v1/partner/jobs/history',
  // The payout UPI on a partner profile decides where money lands, so a session may only
  // update the profile of the phone number it signed in with.
  'POST /api/v1/partner/profile/update',
  'POST /api/v1/wallet/customer/debit',
  'POST /api/v1/wallet/customer/credit'
]);

// The WhatsApp gateway is infrastructure: pairing the device, disconnecting it or sending a
// test message is an operations action, not something a customer session should reach.
const ADMIN_ONLY_PREFIXES = ['/api/v1/admin/', '/api/v1/auth/whatsapp/'];

function bearerToken(req) {
  const header = req.headers['authorization'] || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  if (match) return match[1].trim();
  const alt = req.headers['x-session-token'];
  return alt ? String(alt).trim() : '';
}

function digits(value) {
  return String(value == null ? '' : value).replace(/\D/g, '').slice(-10);
}

fastify.addHook('onRequest', async (req, reply) => {
  if (req.method === 'OPTIONS') return;

  // The resolved route pattern, e.g. /api/v1/bookings/:id/status. Falls back to the raw
  // path for requests that never matched a route, which the 404 handler owns.
  const pattern = req.routeOptions && req.routeOptions.url ? req.routeOptions.url : req.url.split('?')[0];
  const key = `${req.method} ${pattern}`;

  if (PUBLIC_ROUTES.has(key) || pattern === '/health') return;

  const session = sessionStore.resolveSession(bearerToken(req));
  if (!session) {
    return reply.status(401).send({
      success: false,
      error: 'Authentication required. Present a valid session token in the Authorization header.'
    });
  }
  req.session = session;

  if (ADMIN_ONLY_PREFIXES.some(prefix => pattern.startsWith(prefix)) && session.role !== 'admin') {
    return reply.status(403).send({
      success: false,
      error: 'This action requires an administrator session.'
    });
  }
});

// Runs after the body is parsed, so a wallet debit is checked against the phone in its own
// payload rather than only the query string.
fastify.addHook('preHandler', async (req, reply) => {
  if (!req.session || req.session.role === 'admin') return;

  const pattern = req.routeOptions && req.routeOptions.url ? req.routeOptions.url : req.url.split('?')[0];
  if (!SELF_SCOPED_ROUTES.has(`${req.method} ${pattern}`)) return;

  const q = req.query || {};
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const claimed = digits(
    q.phone || q.customerPhone || q.technicianPhone ||
    b.phone || b.customerPhone || b.technicianPhone
  );
  const own = digits(req.session.phone);

  if (claimed && own && claimed !== own) {
    return reply.status(403).send({
      success: false,
      error: 'You may only access your own records.'
    });
  }
});

// ---------------------------------------------------------------------------
// Error hygiene
// ---------------------------------------------------------------------------
// 116 handlers answered with err.message. A driver error string names the table, the column
// and often the statement, which is a free map of the schema for anyone probing. The detail
// is logged with the request id; the caller gets the id and nothing else.
const GENERIC_500 = 'Something went wrong on our side. Quote the requestId when reporting it.';

fastify.addHook('onSend', async (req, reply, payload) => {
  if (reply.statusCode < 500) return payload;

  const pattern = req.routeOptions && req.routeOptions.url ? req.routeOptions.url : '';
  // /health reports its own degradation on purpose; /payments/webhook is machine to machine.
  if (pattern === '/health') return payload;
  if (typeof payload !== 'string' || payload.length === 0) return payload;

  try {
    const body = JSON.parse(payload);
    if (!body || typeof body !== 'object') return payload;
    if ('error' in body) body.error = GENERIC_500;
    if ('message' in body && typeof body.message === 'string') body.message = GENERIC_500;
    body.requestId = String(req.id);
    req.log.error(`[${req.id}] 5xx detail withheld from the client`);
    return JSON.stringify(body);
  } catch (_) {
    return payload;
  }
});

fastify.setErrorHandler((err, req, reply) => {
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  if (status >= 500) {
    req.log.error(err);
    return reply.status(status).send({ success: false, error: GENERIC_500, requestId: String(req.id) });
  }
  return reply.status(status).send({ success: false, error: err.message });
});


// Health & System Telemetry Check
// The database is probed instead of being reported as connected unconditionally: a monitor
// that trusts a literal string stays green while the database is unreachable.
fastify.get('/health', async (request, reply) => {
  let database = 'unreachable';
  try {
    await query('SELECT 1');
    database = 'connected';
  } catch (err) {
    fastify.log.error('Health check database probe failed: ' + err.message);
  }

  const healthy = database === 'connected';
  const body = {
    status: healthy ? 'HEALTHY' : 'DEGRADED',
    service: 'Shazu One Fastify Engine',
    database,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  };

  if (!healthy) return reply.status(503).send(body);
  return body;
});

// Boot-time configuration check. Missing production secrets should surface at deploy time,
// not on the first customer request.
const REQUIRED_IN_PRODUCTION = ['DATABASE_URL', 'ADMIN_PASSWORD', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'];
const missingConfig = REQUIRED_IN_PRODUCTION.filter(key => !process.env[key]);
if (process.env.NODE_ENV === 'production' && missingConfig.length) {
  console.error('[startup] Missing required configuration: ' + missingConfig.join(', '));
}
if (!process.env.INTERNAL_API_KEY) {
  console.warn('[startup] INTERNAL_API_KEY is not set. Wallet credit stays open in non-production and is refused in production.');
}

const PORT = process.env.PORT || 8080;

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(` Shazu One Fastify Server running at http://localhost:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

if (require.main === module) {
  start();
}

module.exports = fastify;
