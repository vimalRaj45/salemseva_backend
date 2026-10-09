// Simple, lightweight Google Translate Service for English <-> Tamil
// No complex SDKs needed.

const DICTIONARY_FALLBACK = {
  // English to Tamil instant map for instant zero-latency UI responses
  'AC Repair & Service': 'ஏசி பழுதுபார்ப்பு & சர்வீஸ்',
  'Electrician & Wiring': 'எலக்ட்ரீசியன் & வயரிங்',
  'Plumber & Sanitary': 'பிளம்பர் & குழாய் வேலை',
  'Home & Bath Cleaning': 'வீடு & குளியலறை சுத்தம்',
  'Full Diagnostic & Inspection': 'முழு பரிசோதனை & ஆய்வு',
  'Doorstep Visit Fee': 'வீட்டு பார்வை கட்டணம்',
  'Technician Arrived': 'டெக்னீசியன் வந்துவிட்டார்',
  'Job Completed': 'வேலை முடிந்தது',
  'Paid via Razorpay': 'ரேசர்பே மூலம் செலுத்தப்பட்டது',
  'Zero Commission Weekend': '0% கமிஷன் வார இறுதி'
};

async function translateText(text, targetLang = 'ta') {
  if (!text) return '';
  if (targetLang === 'en') return text;
  
  // 1. Fast Dictionary Cache
  if (DICTIONARY_FALLBACK[text]) {
    return DICTIONARY_FALLBACK[text];
  }

  // 2. Direct Lightweight Google Translate HTTP Query
  try {
    const encoded = encodeURIComponent(text);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encoded}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data && data[0] && data[0][0] && data[0][0][0]) {
        return data[0][0][0];
      }
    }
  } catch (err) {
    console.warn('Google Translate API fallback used:', err.message);
  }

  return text;
}

module.exports = {
  translateText,
  DICTIONARY_FALLBACK
};
