/**
 * Comprehensive Unit Test Suite for Math Guard & Adaptive Bot Protection
 * Run: node --test backend/tests/unit_math_guard.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateMathChallenge,
  verifyMathChallenge,
  isHoneypotTriggered,
  evaluateRiskAndCheckChallenge
} from '../src/utils/mathGuard.js';

test('generateMathChallenge creates valid arithmetic questions and signed tokens', () => {
  for (let i = 0; i < 15; i++) {
    const challenge = generateMathChallenge();
    assert.ok(challenge.challengeId.startsWith('ch_'), 'Has challenge ID prefix');
    assert.ok(typeof challenge.question === 'string' && challenge.question.length > 5, 'Has question');
    assert.ok(typeof challenge.questionTa === 'string' && challenge.questionTa.length > 5, 'Has Tamil translation');
    assert.ok(typeof challenge.challengeToken === 'string' && challenge.challengeToken.length > 20, 'Has challenge token');

    const match = challenge.question.match(/What is (\d+) ([\+\-]) (\d+)\?/);
    assert.ok(match, 'Question matches arithmetic regex');
    const a = parseInt(match[1], 10);
    const op = match[2];
    const b = parseInt(match[3], 10);
    assert.ok(a > 0 && b > 0, 'Numbers are positive');
    if (op === '-') {
      assert.ok(a >= b, 'Subtraction always results in non-negative answer');
    }
  }
});

test('verifyMathChallenge validates correct answer and rejects wrong answer', () => {
  const challenge = generateMathChallenge();
  const match = challenge.question.match(/What is (\d+) ([\+\-]) (\d+)\?/);
  assert.ok(match);

  const a = parseInt(match[1], 10);
  const op = match[2];
  const b = parseInt(match[3], 10);
  const correctAnswer = op === '+' ? a + b : a - b;
  const wrongAnswer = correctAnswer + 7;

  // 1. Wrong answer must fail
  const wrongResult = verifyMathChallenge(challenge.challengeToken, wrongAnswer);
  assert.equal(wrongResult.valid, false);
  assert.ok(wrongResult.error.includes('Incorrect answer'));

  // 2. Correct answer must pass
  const correctResult = verifyMathChallenge(challenge.challengeToken, correctAnswer);
  assert.equal(correctResult.valid, true);

  // 3. Replay attack: using the exact same token a second time must fail
  const replayResult = verifyMathChallenge(challenge.challengeToken, correctAnswer);
  assert.equal(replayResult.valid, false);
  assert.ok(replayResult.error.includes('already used'));
});

test('verifyMathChallenge rejects tampered and malformed tokens', () => {
  // Empty or invalid input
  assert.equal(verifyMathChallenge('', 8).valid, false);
  assert.equal(verifyMathChallenge('not_a_base64_json', 8).valid, false);

  // Forged signature
  const fakeToken = Buffer.from(JSON.stringify({
    cId: 'ch_fake123',
    exp: Date.now() + 100000,
    sig: '00112233445566778899aabbccddeeff'
  })).toString('base64');
  const forgedResult = verifyMathChallenge(fakeToken, 8);
  assert.equal(forgedResult.valid, false);
});

test('isHoneypotTriggered detects bot traps across multiple trap keys', () => {
  // Clean human payload
  assert.equal(isHoneypotTriggered({ customerName: 'Ravi', phone: '9842100000', address: 'Fairlands' }), false);

  // Bot populated website_url
  assert.equal(isHoneypotTriggered({ customerName: 'Bot', website_url: 'http://spam.ru' }), true);

  // Bot populated company_fax
  assert.equal(isHoneypotTriggered({ customerName: 'Bot', company_fax: '123456' }), true);

  // Bot populated bot_trap
  assert.equal(isHoneypotTriggered({ customerName: 'Bot', bot_trap: 'hidden_val' }), true);
});

test('evaluateRiskAndCheckChallenge: zero frustration for normal human flow', () => {
  const mockReq = { ip: '103.25.10.5', headers: {} };

  // Normal human with normal fill time (> 3000ms)
  const res = evaluateRiskAndCheckChallenge({
    req: mockReq,
    phone: '9842111222',
    formType: 'booking',
    body: { submissionDurationMs: 4500 }
  });

  assert.equal(res.challengeRequired, false, 'Human submission has zero friction');
});

test('evaluateRiskAndCheckChallenge: triggers on super-fast automated scripts (< 2200ms)', () => {
  const mockReq = { ip: '103.25.10.6', headers: {} };

  const res = evaluateRiskAndCheckChallenge({
    req: mockReq,
    phone: '9842111333',
    formType: 'booking',
    body: { submissionDurationMs: 600 } // Automated headless post
  });

  assert.equal(res.challengeRequired, true, 'Sub-human submission speed triggers challenge');
  assert.ok(res.reason.includes('Automated submission speed'));
});

test('evaluateRiskAndCheckChallenge: triggers on OTP pumping burst attacks', () => {
  const mockReq = { ip: '103.25.10.7', headers: {} };
  const targetPhone = '9842111999';

  // First OTP request: passes smoothly
  const r1 = evaluateRiskAndCheckChallenge({ req: mockReq, phone: targetPhone, formType: 'otp' });
  assert.equal(r1.challengeRequired, false);

  // Second OTP request: passes
  const r2 = evaluateRiskAndCheckChallenge({ req: mockReq, phone: targetPhone, formType: 'otp' });
  assert.equal(r2.challengeRequired, false);

  // Third rapid OTP request for same phone: triggers Step-Up Math Challenge to protect SMS quota
  const r3 = evaluateRiskAndCheckChallenge({ req: mockReq, phone: targetPhone, formType: 'otp' });
  assert.equal(r3.challengeRequired, true);
  assert.ok(r3.reason.includes('Repeated OTP'));
});
