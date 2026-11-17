/**
 * Comprehensive Integration Test: Anti-Bot & Adaptive Math Guard
 * Run: node --test backend/tests/unit_bot_protection.test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fastify from 'fastify';

// Setup isolated fastify app instance with routes
let app;

before(async () => {
  app = fastify({ logger: false });
  await app.register(import('@fastify/cors'));
  await app.register(import('../src/routes/auth.routes.js'), { prefix: '/api/v1' });
  await app.register(import('../src/routes/bookings.routes.js'), { prefix: '/api/v1' });
  await app.register(import('../src/routes/feedback.routes.js'), { prefix: '/api/v1' });
  await app.register(import('../src/routes/tickets.routes.js'), { prefix: '/api/v1' });
  await app.ready();
});

after(async () => {
  if (app) await app.close();
});

test('GET /api/v1/auth/math-challenge returns valid question and token', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/math-challenge'
  });

  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.payload);
  assert.equal(data.success, true);
  assert.ok(data.challenge);
  assert.ok(data.challenge.question);
  assert.ok(data.challenge.challengeToken);
});

test('Honeypot trap triggers silent drop on booking endpoint', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/bookings/create',
    payload: {
      serviceId: 'ac_service',
      address: '12 Fairlands, Salem',
      customerPhone: '9842100001',
      website_url: 'http://bot-spammer.org' // Honeypot field
    }
  });

  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.payload);
  assert.equal(data.success, true);
  // Fake simulated response returned to fool the scraper
  assert.ok(data.booking.id.startsWith('SLM-'));
});

test('Super-fast automated submission triggers Adaptive Math Challenge', async () => {
  // 1. Send request with sub-human duration (e.g. 500ms from automated script)
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/bookings/create',
    payload: {
      serviceId: 'ac_service',
      address: '12 Fairlands, Salem',
      customerPhone: '9842100002',
      submissionDurationMs: 400
    }
  });

  assert.equal(res.statusCode, 403);
  const data = JSON.parse(res.payload);
  assert.equal(data.mathChallengeRequired, true);
  assert.ok(data.challenge.question);
  assert.ok(data.challenge.challengeToken);

  // 2. Solve the challenge dynamically
  const qMatch = data.challenge.question.match(/What is (\d+) ([\+\-]) (\d+)\?/);
  assert.ok(qMatch);
  const a = parseInt(qMatch[1], 10);
  const op = qMatch[2];
  const b = parseInt(qMatch[3], 10);
  const answer = op === '+' ? a + b : a - b;

  // 3. Submit wrong answer
  const wrongRes = await app.inject({
    method: 'POST',
    url: '/api/v1/bookings/create',
    payload: {
      serviceId: 'ac_service',
      address: '12 Fairlands, Salem',
      customerPhone: '9842100002',
      submissionDurationMs: 400,
      mathChallengeToken: data.challenge.challengeToken,
      mathAnswer: answer + 10
    }
  });

  assert.equal(wrongRes.statusCode, 403);
  const wrongData = JSON.parse(wrongRes.payload);
  assert.equal(wrongData.mathChallengeRequired, true);
  assert.ok(wrongData.error.includes('Incorrect answer'));

  // 4. Submit with correct answer (token is fresh from wrongData)
  const qMatch2 = wrongData.challenge.question.match(/What is (\d+) ([\+\-]) (\d+)\?/);
  const a2 = parseInt(qMatch2[1], 10);
  const op2 = qMatch2[2];
  const b2 = parseInt(qMatch2[3], 10);
  const answer2 = op2 === '+' ? a2 + b2 : a2 - b2;

  const correctRes = await app.inject({
    method: 'POST',
    url: '/api/v1/bookings/create',
    payload: {
      serviceId: 'ac_service',
      address: '12 Fairlands, Salem',
      customerPhone: '9842100002',
      locality: 'Fairlands, Salem',
      pincode: '636016',
      scheduledSlot: 'instant_now',
      submissionDurationMs: 400,
      mathChallengeToken: wrongData.challenge.challengeToken,
      mathAnswer: answer2
    }
  });

  // Since math check passed, request proceeded into booking handler
  assert.ok(correctRes.statusCode === 200 || correctRes.statusCode === 201, `Status was ${correctRes.statusCode}`);
});

test('Feedback endpoint traps honeypot submissions', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/feedback/submit',
    payload: {
      message: 'Great app',
      company_fax: '987654321' // Honeypot field
    }
  });

  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.payload);
  assert.equal(data.success, true);
});
