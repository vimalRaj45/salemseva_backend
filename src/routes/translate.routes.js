const { translateText } = require('../services/translate.service');

async function translateRoutes(fastify, options) {
  // Simple on-the-fly translation endpoint for mobile UI
  fastify.post('/translate', async (req, reply) => {
    const { text, targetLang = 'ta' } = req.body;
    
    if (!text) {
      return reply.code(400).send({ success: false, message: 'Text is required' });
    }

    const translated = await translateText(text, targetLang);
    return {
      success: true,
      original: text,
      targetLang,
      translated
    };
  });
}

module.exports = translateRoutes;
