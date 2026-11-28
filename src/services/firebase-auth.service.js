const { initializeApp, cert, applicationDefault, getApps, getApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getMessaging: getFirebaseMessaging } = require('firebase-admin/messaging');

class FirebaseAuthService {
  constructor() {
    this.app = null;
    this.initialized = false;
    this.initError = null;
    this.projectId = process.env.FIREBASE_PROJECT_ID || null;
  }

  _loadCredential() {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON.trim();
      const jsonStr = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
      const parsed = JSON.parse(jsonStr);
      this.projectId = this.projectId || parsed.project_id || null;
      return cert(parsed);
    }

    if (
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY
    ) {
      return cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      });
    }

    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      return applicationDefault();
    }

    return null;
  }

  initialize() {
    if (this.initialized && this.app) return this.app;

    try {
      const existingApps = getApps();
      if (existingApps.length > 0) {
        this.app = getApp();
        this.initialized = true;
        return this.app;
      }

      const credential = this._loadCredential();
      if (!credential) {
        this.initialized = false;
        this.app = null;
        return null;
      }

      const opts = { credential };
      if (this.projectId) {
        opts.projectId = this.projectId;
      }

      this.app = initializeApp(opts);
      this.initialized = true;
      this.initError = null;
      return this.app;
    } catch (err) {
      this.initialized = false;
      this.app = null;
      this.initError = err.message;
      console.warn('[Firebase Auth] Initialization skipped/failed:', err.message);
      return null;
    }
  }

  isConfigured() {
    return Boolean(this.initialize());
  }

  getMessaging() {
    const app = this.initialize();
    return app ? getFirebaseMessaging(app) : null;
  }

  getStatus() {
    const configured = this.isConfigured();
    return {
      status: configured ? 'connected' : 'not_configured',
      isConnected: configured,
      provider: 'firebase_phone_auth',
      projectId: this.projectId,
      connectedPhone: null,
      connectedName: configured ? 'Firebase Phone Auth' : null,
      qrCodeDataUrl: null,
      qrRaw: null,
      initError: this.initError
    };
  }

  /**
   * Verifies a Firebase ID token obtained from Firebase Phone Auth on the client
   * and returns the normalized 10-digit Indian phone number (or full E.164 digits).
   */
  async verifyPhoneIdToken(idToken) {
    const app = this.initialize();
    if (!app) {
      throw new Error('Firebase Admin is not configured on the server.');
    }
    if (!idToken || typeof idToken !== 'string') {
      throw new Error('Firebase ID token is required.');
    }

    const decoded = await getAuth(app).verifyIdToken(idToken);
    if (!decoded.phone_number) {
      throw new Error('Firebase token does not contain a verified phone number.');
    }

    const digits = String(decoded.phone_number).replace(/\D/g, '');
    const clean10 = digits.slice(-10);
    if (clean10.length !== 10) {
      throw new Error('Verified Firebase phone number is invalid.');
    }

    return {
      uid: decoded.uid,
      phoneNumber: decoded.phone_number,
      cleanPhone: clean10
    };
  }
}

module.exports = new FirebaseAuthService();
