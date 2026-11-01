/**
 * Brevo Transactional Email Service
 * Handles administrative OTP dispatch and security notifications via Brevo API v3.
 * Zero emoji rule strictly enforced.
 */

const https = require('https');

class EmailService {
  constructor() {
    this.apiKey = process.env.BREVO_API_KEY || '';
    this.senderEmail = process.env.BREVO_SENDER || 'malikasaravanan774@gmail.com';
    this.senderName = 'Shazu One Admin Security';
  }

  /**
   * Send transactional email using Brevo REST API v3
   * @param {Object} options
   * @param {string} options.toEmail
   * @param {string} [options.toName]
   * @param {string} options.subject
   * @param {string} options.htmlContent
   * @returns {Promise<{ success: boolean, messageId?: string }>}
   */
  async sendEmail({ toEmail, toName = 'Administrator', subject, htmlContent }) {
    const apiKey = process.env.BREVO_API_KEY || this.apiKey;
    const senderEmail = process.env.BREVO_SENDER || this.senderEmail;

    if (!apiKey) {
      throw new Error('BREVO_API_KEY is not configured in backend environment');
    }

    const payload = JSON.stringify({
      sender: {
        name: this.senderName,
        email: senderEmail
      },
      to: [
        {
          email: toEmail.trim().toLowerCase(),
          name: toName
        }
      ],
      subject,
      htmlContent
    });

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.brevo.com',
        port: 443,
        path: '/v3/smtp/email',
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'api-key': apiKey,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch (e) {
            parsed = { raw: data };
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({
              success: true,
              messageId: parsed.messageId || 'SENT'
            });
          } else {
            const errorMsg = parsed.message || parsed.code || `Brevo API HTTP ${res.statusCode}`;
            reject(new Error(`Failed to send email via Brevo: ${errorMsg}`));
          }
        });
      });

      req.on('error', (err) => {
        reject(new Error(`Network error contacting Brevo API: ${err.message}`));
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * Dispatch 6-digit Admin Login OTP
   * @param {string} toEmail
   * @param {string} otp
   * @param {number} validityMinutes
   */
  async sendAdminLoginOtp(toEmail, otp, validityMinutes = 10) {
    const subject = `Shazu One Admin Security - Login Verification Code: ${otp}`;
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #0f172a; }
          .container { max-width: 520px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
          .header { background: #0f172a; padding: 24px; text-align: center; color: #ffffff; }
          .brand { font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }
          .badge { display: inline-block; font-size: 11px; font-weight: 600; text-transform: uppercase; background: #1e293b; color: #94a3b8; padding: 4px 8px; border-radius: 4px; margin-top: 6px; }
          .content { padding: 32px 24px; text-align: center; }
          .title { font-size: 18px; font-weight: 600; color: #0f172a; margin-bottom: 8px; }
          .subtitle { font-size: 14px; color: #64748b; line-height: 1.5; margin-bottom: 24px; }
          .otp-box { background: #f1f5f9; border: 1px dashed #cbd5e1; border-radius: 8px; padding: 18px 24px; display: inline-block; margin-bottom: 24px; }
          .otp-code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #0f172a; }
          .expiry { font-size: 13px; color: #ef4444; font-weight: 500; margin-bottom: 20px; }
          .security-note { font-size: 12px; color: #94a3b8; line-height: 1.5; text-align: left; background: #f8fafc; border-left: 3px solid #cbd5e1; padding: 12px 16px; border-radius: 0 4px 4px 0; }
          .footer { padding: 16px 24px; background: #f8fafc; border-top: 1px solid #e2e8f0; text-align: center; font-size: 12px; color: #94a3b8; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="brand">Shazu One Operations Console</div>
            <div class="badge">Administrative Authentication</div>
          </div>
          <div class="content">
            <div class="title">Admin Verification Code</div>
            <div class="subtitle">Use the one-time passcode below to authenticate your administrative session for Shazu One Central Operations.</div>
            <div class="otp-box">
              <div class="otp-code">${otp}</div>
            </div>
            <div class="expiry">This passcode expires in ${validityMinutes} minutes.</div>
            <div class="security-note">
              <strong>Security Notice:</strong> This code provides full administrative control over platform dispatch, customer records, and technician KYC. If you did not request this verification code, please review server security logs immediately.
            </div>
          </div>
          <div class="footer">
            Shazu One Central Operations &bull; Salem, Tamil Nadu, India
          </div>
        </div>
      </body>
      </html>
    `;

    return this.sendEmail({
      toEmail,
      toName: 'Shazu One Administrator',
      subject,
      htmlContent
    });
  }
}

module.exports = new EmailService();
