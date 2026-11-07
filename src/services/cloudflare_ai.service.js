/**
 * Cloudflare Workers AI Integration Service
 * Provides Speech-to-Text (Whisper) and Mistral 7B LLM inferences
 * with graceful credit-exhaustion and outage fallback.
 */

function getCloudflareConfig() {
  return {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
    apiToken: process.env.CLOUDFLARE_API_TOKEN || '',
    llmModel: process.env.CLOUDFLARE_LLM_MODEL || '@cf/mistral/mistral-7b-instruct-v0.1',
    sttModel: process.env.CLOUDFLARE_STT_MODEL || '@cf/openai/whisper'
  };
}

/**
 * Transcribes audio buffer via Cloudflare Whisper STT
 * @param {Buffer|Uint8Array} audioBuffer
 * @returns {Promise<{success: boolean, text?: string, error?: string, creditExhausted?: boolean}>}
 */
async function transcribeAudioWithWhisper(audioBuffer) {
  const { accountId, apiToken, sttModel } = getCloudflareConfig();

  if (!accountId || !apiToken) {
    return {
      success: false,
      creditExhausted: false,
      error: 'Cloudflare credentials not configured'
    };
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    return {
      success: false,
      error: 'Empty audio buffer provided'
    };
  }

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${sttModel}`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/octet-stream'
      },
      body: audioBuffer
    });

    if (response.status === 429 || response.status === 402 || response.status === 403) {
      console.warn(`[Cloudflare STT] Credit or rate quota error: HTTP ${response.status}`);
      return {
        success: false,
        creditExhausted: true,
        error: `Cloudflare AI service quota reached (HTTP ${response.status})`
      };
    }

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[Cloudflare STT] Request failed: ${response.status} - ${errText}`);
      return {
        success: false,
        creditExhausted: response.status === 400 && errText.includes('quota'),
        error: `Cloudflare STT error: HTTP ${response.status}`
      };
    }

    const data = await response.json();
    const transcribedText = data?.result?.text || '';
    return {
      success: true,
      text: transcribedText.trim()
    };
  } catch (err) {
    console.error('[Cloudflare STT] Network or dispatch error:', err);
    return {
      success: false,
      creditExhausted: false,
      error: err.message
    };
  }
}

/**
 * Runs Mistral 7B LLM inference on Cloudflare Workers AI
 * @param {Array<{role: string, content: string}>} messages
 * @param {Object} [options]
 * @param {number} [options.maxTokens=512]
 * @param {number} [options.temperature=0.2]
 * @returns {Promise<{success: boolean, response?: string, error?: string, creditExhausted?: boolean}>}
 */
async function runMistralChat(messages, options = {}) {
  const { accountId, apiToken, llmModel } = getCloudflareConfig();
  const maxTokens = options.maxTokens || 512;
  const temperature = options.temperature !== undefined ? options.temperature : 0.2;

  if (!accountId || !apiToken) {
    return {
      success: false,
      creditExhausted: false,
      error: 'Cloudflare credentials not configured'
    };
  }

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${llmModel}`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages,
        max_tokens: maxTokens,
        temperature
      })
    });

    if (response.status === 429 || response.status === 402 || response.status === 403) {
      console.warn(`[Cloudflare LLM] Credit or quota error: HTTP ${response.status}`);
      return {
        success: false,
        creditExhausted: true,
        error: `Cloudflare AI quota reached (HTTP ${response.status})`
      };
    }

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[Cloudflare LLM] Request failed: ${response.status} - ${errText}`);
      return {
        success: false,
        creditExhausted: response.status === 400 && errText.includes('quota'),
        error: `Cloudflare LLM error: HTTP ${response.status}`
      };
    }

    const data = await response.json();
    const replyText = data?.result?.response || '';
    return {
      success: true,
      response: replyText.trim()
    };
  } catch (err) {
    console.error('[Cloudflare LLM] Network or dispatch error:', err);
    return {
      success: false,
      creditExhausted: false,
      error: err.message
    };
  }
}

module.exports = {
  getCloudflareConfig,
  transcribeAudioWithWhisper,
  runMistralChat
};
