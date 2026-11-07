const {
  getSalemOpsContact,
  handleSupportQuery
} = require('../services/support_agent.service');
const { transcribeAudioWithWhisper } = require('../services/cloudflare_ai.service');

async function supportAgentRoutes(fastify, options) {
  // GET /api/v1/support/ops-contact
  fastify.get('/support/ops-contact', async (req, reply) => {
    return {
      success: true,
      opsContact: getSalemOpsContact()
    };
  });

  // POST /api/v1/support/ai-chat
  fastify.post('/support/ai-chat', async (req, reply) => {
    try {
      const {
        query: textQuery = '',
        audioBase64 = null,
        role = 'customer',
        userId = 'guest',
        userPhone = '',
        userName = 'Customer'
      } = req.body || {};

      // Friendly User Identification (logged in or guest inquiry)
      const isGuest = !userId || userId === 'guest' || userId === 'null' || userId === 'undefined';
      const effectiveUserName = (userName && userName.toLowerCase() !== 'customer')
        ? userName
        : (isGuest ? 'there' : 'Customer');

      let effectiveQuery = String(textQuery || '').trim();

      // 1. Process Voice Input if audioBase64 is provided
      if (audioBase64 && !effectiveQuery) {
        try {
          const rawBase64 = audioBase64.replace(/^data:audio\/[a-z0-9]+;base64,/, '');
          const audioBuffer = Buffer.from(rawBase64, 'base64');

          const sttResult = await transcribeAudioWithWhisper(audioBuffer);

          if (!sttResult.success) {
            const ops = getSalemOpsContact();
            return {
              success: true,
              transcribedText: '',
              reply: 'Our voice assistant service is currently at maximum demand. Please type your query or connect directly with our Salem Operations desk.',
              escalateToOps: true,
              creditExhausted: Boolean(sttResult.creditExhausted),
              opsContact: ops
            };
          }

          effectiveQuery = (sttResult.text || '').trim();
          console.log(`[Support Agent STT] Voice transcribed: "${effectiveQuery}"`);
        } catch (sttErr) {
          console.warn('[Support Agent STT] Buffer parse or STT error:', sttErr.message);
        }
      }

      if (!effectiveQuery) {
        const ops = getSalemOpsContact();
        return {
          success: true,
          reply: 'Please speak or type your question so I can assist you with your booking or service request.',
          escalateToOps: false,
          opsContact: ops
        };
      }

      // 2. Delegate to Support Agent Orchestrator
      const result = await handleSupportQuery({
        queryText: effectiveQuery,
        role: role === 'technician' ? 'technician' : 'customer',
        userId: String(userId || 'guest'),
        userPhone: String(userPhone || ''),
        userName: String(effectiveUserName || 'there')
      });

      return {
        success: true,
        transcribedText: audioBase64 ? effectiveQuery : undefined,
        ...result
      };
    } catch (err) {
      fastify.log.error('Support AI Chat error:', err);
      const ops = getSalemOpsContact();
      return {
        success: true,
        reply: 'An unexpected error occurred while processing your request. Our Salem Operations team is standing by to help you immediately.',
        escalateToOps: true,
        opsContact: ops
      };
    }
  });
}

module.exports = supportAgentRoutes;
