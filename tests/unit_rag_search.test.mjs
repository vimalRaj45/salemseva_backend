import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Unit Test: Admin RAG Query Engine Intent Extraction', () => {
  const SALEM_LOCALITIES = [
    'Fairlands', 'Hasthampatti', 'Suramangalam', 'Ammapet',
    'Shevapet', 'Gugai', 'Alagapuram', 'Meyyanur',
    'Kondalampatti', 'Kannankurichi', 'Gorimedu', 'Steel Plant Area'
  ];
  const TRADES = ['ac', 'electrician', 'plumber', 'cleaning'];

  function extractIntent(queryText) {
    const phoneMatch = queryText.match(/(?:\+91[\-\s]?)?[6-9]\d{9}\b/);
    const extractedPhone = phoneMatch ? phoneMatch[0].replace(/[^0-9]/g, '').slice(-10) : null;
    const detectedLocality = SALEM_LOCALITIES.find(loc => new RegExp(`\\b${loc}\\b`, 'i').test(queryText)) || null;
    const detectedTrade = TRADES.find(tr => new RegExp(`\\b${tr}\\b`, 'i').test(queryText)) || null;
    
    const lower = queryText.toLowerCase();
    const isBookingIntent = lower.includes('booking') || lower.includes('job') || lower.includes('order');
    const isTechIntent = lower.includes('tech') || lower.includes('partner') || lower.includes('kyc');
    const isPaymentIntent = lower.includes('pay') || lower.includes('qr') || lower.includes('settle');

    return {
      phone: extractedPhone,
      locality: detectedLocality,
      trade: detectedTrade,
      isBookingIntent,
      isTechIntent,
      isPaymentIntent
    };
  }

  it('should accurately extract customer phone and booking intent', () => {
    const q = 'I need all bookings of customer 9842711234';
    const res = extractIntent(q);
    assert.equal(res.phone, '9842711234');
    assert.equal(res.isBookingIntent, true);
    assert.equal(res.isTechIntent, false);
  });

  it('should detect locality and trade in operational inquiries', () => {
    const q = 'Show unassigned AC technician jobs in Fairlands';
    const res = extractIntent(q);
    assert.equal(res.locality, 'Fairlands');
    assert.equal(res.trade, 'ac');
    assert.equal(res.isBookingIntent, true);
    assert.equal(res.isTechIntent, true);
  });

  it('should detect QR payment review intent', () => {
    const q = 'Show pending QR payments waiting for verification';
    const res = extractIntent(q);
    assert.equal(res.isPaymentIntent, true);
  });
});
