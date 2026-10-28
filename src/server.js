const fastify = require('fastify')({ logger: true });
const cors = require('@fastify/cors');
require('dotenv').config();
const { query } = require('./db/db');


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
// Session tokens were removed at the owner's request. Sign-in returns the user object and
// no route asks for a credential: /api/v1/admin/*, the wallet, the partner payout routes and
// the WhatsApp gateway are all reachable by anyone who knows the URL. Every endpoint should
// be treated as public until an authentication layer is put back.

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
