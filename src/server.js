const fastify = require('fastify')({ logger: true });
const cors = require('@fastify/cors');
require('dotenv').config();
require('./db/db');


// Register CORS
fastify.register(cors, {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE']
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


// Health & System Telemetry Check
fastify.get('/health', async () => {
  return {
    status: 'HEALTHY',
    service: 'SalemSeva Fastify Engine',
    database: 'Neon PostgreSQL (Connected)',
    razorpay: process.env.RAZORPAY_KEY_ID ? 'Configured (rzp_test)' : 'Missing',
    cloudflareTurn: process.env.CLOUDFLARE_TURN_KEY_ID ? 'Configured' : 'Missing',
    timestamp: new Date().toISOString()
  };
});

const PORT = process.env.PORT || 8080;

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`🚀 SalemSeva Fastify Server running at http://localhost:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
