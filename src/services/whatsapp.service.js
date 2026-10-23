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
    this.connectedPhone = null;
    this.connectedName = null;
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
        browser: ['Shazu One Admin Hub', 'Chrome', '1.0.0'],
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
            this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 7 });
            console.log('[WhatsApp Gateway] New pairing QR generated for admin.');
          } catch (qrErr) {
            console.warn('[WhatsApp Gateway] Failed to generate QR data URL:', qrErr.message);
          }
        }

        if (connection === 'open') {
          this.connectionStatus = 'connected';
          this.qrRaw = null;
          this.qrDataUrl = null;
          this.connectedPhone = sock.user?.id ? sock.user.id.split(':')[0] : 'Linked Number';
          this.connectedName = sock.user?.name || 'Shazu One Business';
          console.log(`[WhatsApp Gateway] Connected to WhatsApp Business account: ${this.connectedPhone}`);
        } else if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          this.connectionStatus = 'disconnected';
          this.connectedPhone = null;
          this.connectedName = null;
          console.log(`[WhatsApp Gateway] Connection closed (code: ${statusCode}). Reconnect: ${shouldReconnect}`);

          if (shouldReconnect) {
            if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => {
              this.isInitializing = false;
              this.initialize();
            }, 6000);
          } else {
            console.log('[WhatsApp Gateway] Device logged out. Admin scan or pairing code needed.');
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
        // Intentionally ignore incoming messages
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
      connectedPhone: this.connectedPhone,
      connectedName: this.connectedName,
      qrCodeDataUrl: this.qrDataUrl,
      qrRaw: this.qrRaw
    };
  }

  async requestPairingCode(rawPhone) {
    if (!this.sock) {
      await this.initialize();
    }
    const cleanDigits = (rawPhone || '').replace(/\D/g, '');
    const cleanPhone = cleanDigits.length === 10 ? `91${cleanDigits}` : cleanDigits;

    if (!cleanPhone || cleanPhone.length < 10) {
      throw new Error('Valid phone number with country code is required (e.g. 919842099999)');
    }

    if (this.sock?.authState?.creds?.registered) {
      throw new Error('A WhatsApp number is already paired. Please disconnect first before linking a new number.');
    }

    const code = await this.sock.requestPairingCode(cleanPhone);
    return {
      success: true,
      phone: cleanPhone,
      pairingCode: code
    };
  }

  async logoutAndReset() {
    try {
      if (this.sock) {
        await this.sock.logout().catch(() => {});
        this.sock.end(undefined);
      }
    } catch (e) {}

    try {
      if (fs.existsSync(this.authFolder)) {
        fs.rmSync(this.authFolder, { recursive: true, force: true });
      }
    } catch (err) {
      console.warn('[WhatsApp Gateway] Auth folder cleanup note:', err.message);
    }

    this.connectionStatus = 'disconnected';
    this.sock = null;
    this.qrRaw = null;
    this.qrDataUrl = null;
    this.connectedPhone = null;
    this.connectedName = null;

    setTimeout(() => {
      this.isInitializing = false;
      this.initialize();
    }, 1500);

    return { success: true, message: 'WhatsApp session reset. Generating fresh QR code...' };
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

    // Fallback / Pending QR scan notification
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
