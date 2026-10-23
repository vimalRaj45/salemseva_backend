const fastify = require('../src/server');

async function runTests() {
  await fastify.ready();
  console.log('--- Testing WhatsApp OTP & Passkey Endpoints ---');

  const testPhone = '9842799111';

  // 1. Test WhatsApp Status
  const statusRes = await fastify.inject({
    method: 'GET',
    url: '/api/v1/auth/whatsapp/status'
  });
  console.log('1. WhatsApp Status Response:', statusRes.statusCode, JSON.parse(statusRes.payload).status);

  // 2. Test OTP Request
  const otpReqRes = await fastify.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/request',
    payload: { phone: testPhone, purpose: 'register' }
  });
  const otpData = JSON.parse(otpReqRes.payload);
  console.log('2. OTP Request Response:', otpReqRes.statusCode, otpData.message, 'Cooldown:', otpData.cooldownSeconds);

  // 2b. Test Cooldown
  const cooldownRes = await fastify.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/request',
    payload: { phone: testPhone, purpose: 'register' }
  });
  console.log('2b. Cooldown Check (expected 429):', cooldownRes.statusCode, JSON.parse(cooldownRes.payload).error);

  // 3. Test OTP Verify (using simulated OTP if returned)
  if (otpData.simulatedOtp) {
    const verifyRes = await fastify.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      payload: { phone: testPhone, otp: otpData.simulatedOtp, purpose: 'register' }
    });
    const verifyData = JSON.parse(verifyRes.payload);
    console.log('3. OTP Verify Response:', verifyRes.statusCode, 'Verified:', verifyData.verified, 'HasToken:', Boolean(verifyData.verificationToken));

    // 4. Test Set Password with verification token
    if (verifyData.verificationToken) {
      const setPwdRes = await fastify.inject({
        method: 'POST',
        url: '/api/v1/auth/password/set',
        payload: {
          phone: testPhone,
          verificationToken: verifyData.verificationToken,
          newPassword: 'testpassword123',
          role: 'customer'
        }
      });
      console.log('4. Set Password Response:', setPwdRes.statusCode, JSON.parse(setPwdRes.payload).message);
    }
  }

  // 5. Test Passkey Register Options
  const passkeyRegOptRes = await fastify.inject({
    method: 'POST',
    url: '/api/v1/auth/passkey/register-options',
    payload: { phone: testPhone }
  });
  const passkeyRegData = JSON.parse(passkeyRegOptRes.payload);
  console.log('5. Passkey Register Options Response:', passkeyRegOptRes.statusCode, 'ChallengeExists:', Boolean(passkeyRegData?.options?.challenge));

  // 6. Test Passkey Login Options
  const passkeyLoginOptRes = await fastify.inject({
    method: 'POST',
    url: '/api/v1/auth/passkey/login-options',
    payload: { phone: testPhone }
  });
  const passkeyLoginData = JSON.parse(passkeyLoginOptRes.payload);
  console.log('6. Passkey Login Options Response:', passkeyLoginOptRes.statusCode, 'ChallengeExists:', Boolean(passkeyLoginData?.options?.challenge));

  console.log('--- All Backend Tests Executed Successfully ---');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
