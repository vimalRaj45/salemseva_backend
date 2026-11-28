const firebaseAuthService = require('./firebase-auth.service');

/**
 * Legacy WhatsAppGatewayService shim retained for route/test compatibility
 * after migrating from @whiskeysockets/baileys to Firebase Phone Auth.
 */
class WhatsAppGatewayService {
  isRemoteMode() {
    return false;
  }

  async initialize() {
    return firebaseAuthService.initialize();
  }

  getStatus() {
    return firebaseAuthService.getStatus();
  }

  async requestPairingCode() {
    return {
      success: false,
      provider: 'firebase_phone_auth',
      error: 'QR/pairing codes are no longer required. Mobile OTP is handled by Firebase Phone Auth.'
    };
  }

  async logoutAndReset() {
    return {
      success: true,
      provider: 'firebase_phone_auth',
      message: 'Baileys session removed. Mobile OTP is handled by Firebase Phone Auth.'
    };
  }

  async sendOtpMessage(rawPhone, otpCode) {
    const cleanDigits = (rawPhone || '').replace(/\D/g, '');
    const clean10 = cleanDigits.slice(-10);

    if (clean10.length !== 10) {
      throw new Error('Valid 10-digit mobile number required');
    }

    const intlPhone = `91${clean10}`;
    console.log(`[OTP Service Notice] Firebase Phone Auth handles client SMS delivery. Simulated fallback OTP for ${intlPhone}: ${otpCode}`);

    return {
      success: true,
      delivered: false,
      simulated: true,
      channel: 'firebase_simulated_fallback',
      phone: intlPhone,
      otp: process.env.NODE_ENV !== 'production' ? otpCode : undefined
    };
  }
}

module.exports = new WhatsAppGatewayService();
