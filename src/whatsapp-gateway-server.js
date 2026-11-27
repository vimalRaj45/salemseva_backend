require('dotenv').config();
const fastify = require('fastify')({ logger: true });

// Ensure this standalone EC2 gateway always runs Baileys locally (never proxies to itself)
delete process.env.WHATSAPP_GATEWAY_URL;
const whatsAppGateway = require('./services/whatsapp.service');

const GATEWAY_KEY = process.env.WHATSAPP_GATEWAY_KEY || process.env.INTERNAL_API_KEY || '';
const PORT = parseInt(process.env.WHATSAPP_GATEWAY_PORT || process.env.PORT || '3100', 10);

fastify.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return;
  if (!GATEWAY_KEY) {
    if (process.env.NODE_ENV === 'production') {
      return reply.status(503).send({ success: false, error: 'WHATSAPP_GATEWAY_KEY is not configured.' });
    }
    return;
  }
  const provided = req.headers['x-gateway-key'] || '';
  if (provided !== GATEWAY_KEY) {
    return reply.status(401).send({ success: false, error: 'Unauthorized gateway key.' });
  }
});

fastify.get('/health', async () => {
  const status = await whatsAppGateway.getStatus();
  return { success: true, service: 'Shazu One WhatsApp Gateway', ...status };
});

fastify.get('/status', async () => {
  return whatsAppGateway.getStatus();
});

fastify.post('/pairing-code', async (req, reply) => {
  try {
    const { phone } = req.body || {};
    return await whatsAppGateway.requestPairingCode(phone);
  } catch (err) {
    return reply.status(400).send({ success: false, error: err.message });
  }
});

fastify.post('/disconnect', async () => {
  return whatsAppGateway.logoutAndReset();
});

fastify.post('/send-otp', async (req, reply) => {
  try {
    const { phone, otpCode, purpose = 'verification' } = req.body || {};
    if (!phone || !otpCode) {
      return reply.status(400).send({ success: false, error: 'phone and otpCode are required.' });
    }
    return await whatsAppGateway.sendOtpMessage(phone, otpCode, purpose);
  } catch (err) {
    return reply.status(400).send({ success: false, error: err.message });
  }
});

fastify.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  console.log(`[WhatsApp Gateway Server] Listening on 0.0.0.0:${PORT}`);
}).catch((err) => {
  fastify.log.error(err);
  process.exit(1);
});
