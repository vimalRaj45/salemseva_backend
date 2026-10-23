const path = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

class WhatsAppGatewayService {
  constructor() {
    this.sock = null;
    this.connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'qr_ready' | 'connected'
    this.qrRaw = null;
    this.qrDataUrl = null;
    this.authFolder = path.join(__dirname, '..', '..', 'baileys_auth_info');
    this.isInitializing = false;
    this.reconnectTimer = null;
  }

  async initialize() {
    if (this.isInitializing || this.connectionStatus === 'connected') {
      return;
    }
    this.isInitializing = true;

    try {
      if (!fs.existsSync(this.authFolder)) {
        fs.mkdirSync(this.authFolder, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);
      const { version } = await fetchLatestBaileysVersion();

      this.connectionStatus = 'connecting';
      console.log(`[WhatsApp Gateway] Initializing Baileys client v${version.join('.')}...`);

      const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Shazu One Gateway', 'Chrome', '1.0.0'],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        syncFullHistory: false
      });

      this.sock = sock;

      // Handle credentials update
      sock.ev.on('creds.update', saveCreds);

      // Handle connection updates
      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.qrRaw = qr;
          this.connectionStatus = 'qr_ready';
          try {
            this.qrDataUrl = await QRCode.toDataURL(qr);
            console.log('[WhatsApp Gateway] New QR code generated for pairing.');
          } catch (qrErr) {
            console.warn('[WhatsApp Gateway] Failed to generate QR data URL:', qrErr.message);
          }
        }

        if (connection === 'open') {
          this.connectionStatus = 'connected';
          this.qrRaw = null;
          this.qrDataUrl = null;
          console.log('[WhatsApp Gateway] Connection established successfully.');
        } else if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          this.connectionStatus = 'disconnected';
          console.log(`[WhatsApp Gateway] Connection closed. Reason code: ${statusCode}. Reconnecting: ${shouldReconnect}`);

          if (shouldReconnect) {
            if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => {
              this.isInitializing = false;
              this.initialize();
            }, 6000);
          } else {
            console.log('[WhatsApp Gateway] Session logged out. Manual re-pairing needed.');
          }
        }
      });

      // 1. Auto-reject voice and video calls to prevent spam
      sock.ev.on('call', async (calls) => {
        for (const call of calls) {
          if (call.status === 'offer') {
            try {
              await sock.rejectCall(call.id, call.from);
              console.log(`[WhatsApp Gateway] Auto-rejected call id ${call.id} from ${call.from}`);
            } catch (callErr) {
              console.warn('[WhatsApp Gateway] Could not reject call:', callErr.message);
            }
          }
        }
      });

      // 2. Ignore all incoming messages to prevent spam loops
      sock.ev.on('messages.upsert', async () => {
        // Explicitly ignore incoming messages
        return;
      });

    } catch (err) {
      this.connectionStatus = 'disconnected';
      console.error('[WhatsApp Gateway] Initialization error:', err.message);
    } finally {
      this.isInitializing = false;
    }
  }

  getStatus() {
    return {
      status: this.connectionStatus,
      isConnected: this.connectionStatus === 'connected',
      qrCodeDataUrl: this.qrDataUrl,
      qrRaw: this.qrRaw
    };
  }

  async sendOtpMessage(rawPhone, otpCode, purpose = 'verification') {
    const cleanDigits = (rawPhone || '').replace(/\D/g, '');
    const clean10 = cleanDigits.slice(-10);

    if (clean10.length !== 10) {
      throw new Error('Valid 10-digit mobile number required');
    }

    const intlPhone = `91${clean10}`;
    const jid = `${intlPhone}@s.whatsapp.net`;

    const purposeLabels = {
      register: 'Account Registration',
      login: 'Account Sign-In',
      forgot_password: 'Password Reset',
      verification: 'Security Verification'
    };
    const title = purposeLabels[purpose] || 'Security Verification';

    const messageText = `Shazu One ${title}\nYour 6-digit OTP code is: *${otpCode}*\n\nThis code is valid for 5 minutes. For security, never share this code with anyone.`;

    if (this.sock && this.connectionStatus === 'connected') {
      try {
        await this.sock.sendMessage(jid, { text: messageText });
        console.log(`[WhatsApp Gateway] OTP sent successfully to WhatsApp ${intlPhone}`);
        return {
          success: true,
          delivered: true,
          channel: 'whatsapp',
          phone: intlPhone
        };
      } catch (sendErr) {
        console.warn(`[WhatsApp Gateway] Failed to send to ${intlPhone}:`, sendErr.message);
      }
    }

    // Fallback/Simulated mode when WhatsApp client is waiting for pairing
    console.log(`[WhatsApp Gateway Notice] WhatsApp not connected (${this.connectionStatus}). Simulated OTP for ${intlPhone}: ${otpCode}`);
    return {
      success: true,
      delivered: false,
      simulated: true,
      channel: 'whatsapp_simulated',
      phone: intlPhone,
      otp: process.env.NODE_ENV !== 'production' ? otpCode : undefined
    };
  }
}

const whatsAppGateway = new WhatsAppGatewayService();

// Auto-initialize WhatsApp gateway on service load
whatsAppGateway.initialize().catch((err) => {
  console.warn('[WhatsApp Gateway] Auto-init deferred:', err.message);
});

module.exports = whatsAppGateway;
