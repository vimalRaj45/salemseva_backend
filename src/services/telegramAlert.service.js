const { query } = require('../db/db');

class TelegramAlertService {
  constructor() {
    this.defaultBaseUrl = 'https://api.telegram.org';
  }

  // Retrieve Telegram configuration from DB platform_settings with fallback to process.env
  async getConfig() {
    let botToken = process.env.TELEGRAM_BOT_TOKEN || '';
    let chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || '';
    let enabled = process.env.TELEGRAM_ALERTS_ENABLED !== 'false';

    try {
      const res = await query(
        `SELECT telegram_bot_token, telegram_admin_chat_id, telegram_alerts_enabled 
         FROM platform_settings 
         WHERE id = 'reward_settings' 
         LIMIT 1`
      );
      if (res.rows && res.rows.length > 0) {
        const row = res.rows[0];
        if (row.telegram_bot_token) {
          botToken = String(row.telegram_bot_token).trim();
        }
        if (row.telegram_admin_chat_id) {
          chatId = String(row.telegram_admin_chat_id).trim();
        }
        if (row.telegram_alerts_enabled !== null && row.telegram_alerts_enabled !== undefined) {
          enabled = Boolean(row.telegram_alerts_enabled);
        }
      }
    } catch (err) {
      // Non-fatal, use environment variables
    }

    return {
      botToken: botToken.trim(),
      chatId: chatId.trim(),
      enabled: Boolean(enabled && botToken && chatId)
    };
  }

  // Low-level HTTP call to Telegram Bot API
  async sendTelegramMessage({ botToken, chatId, text, inlineKeyboard = null }) {
    if (!botToken || !chatId) {
      return {
        success: false,
        skipped: true,
        reason: 'Telegram botToken or chatId is not configured'
      };
    }

    const payload = {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    };

    if (Array.isArray(inlineKeyboard) && inlineKeyboard.length > 0) {
      payload.reply_markup = {
        inline_keyboard: inlineKeyboard
      };
    }

    const url = `${this.defaultBaseUrl}/bot${botToken}/sendMessage`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      const json = await res.json();
      if (!res.ok || !json.ok) {
        const errorDesc = json?.description || `HTTP ${res.status}`;
        console.warn('[Telegram Alert Warning] API response error:', errorDesc);
        return { success: false, error: errorDesc };
      }

      return {
        success: true,
        messageId: json.result?.message_id
      };
    } catch (err) {
      console.warn('[Telegram Alert Network Error]:', err.message);
      return { success: false, error: err.message };
    }
  }

  // Notify Admin when a new booking is created
  async notifyNewBooking(booking) {
    if (!booking || !booking.id) return { success: false, reason: 'invalid_booking' };

    try {
      const config = await this.getConfig();
      if (!config.enabled) {
        return { success: false, skipped: true, reason: 'telegram_alerts_not_enabled' };
      }

      const bookingId = booking.id;
      const serviceName = (booking.service_id || 'home_service').toUpperCase();
      const customerName = booking.customer_name || 'Customer';
      const customerPhone = booking.customer_phone || '';
      const locality = booking.locality || 'Salem';
      const address = booking.service_address || booking.address || 'Address not specified';
      const slot = booking.scheduled_slot || 'ASAP';
      const visitFee = parseFloat(booking.visit_fee || 99).toFixed(2);
      const finalAmount = parseFloat(booking.final_amount || visitFee).toFixed(2);
      const isUrgent = Boolean(booking.is_urgent_dispatch);
      const issue = booking.custom_issue_description || booking.selected_issue_id || 'Doorstep Diagnostic & Inspection';
      const adminUrl = process.env.ADMIN_PORTAL_URL || 'https://shazuone.in/admin';

      const lines = [
        '<b>[NEW BOOKING ALERT]</b>',
        '',
        `<b>Booking ID:</b> #${bookingId}`,
        `<b>Service:</b> ${serviceName}`,
        `<b>Issue:</b> ${issue}`,
        `<b>Priority:</b> ${isUrgent ? 'URGENT DISPATCH' : 'Standard Scheduled'}`,
        `<b>Customer:</b> ${customerName}`,
        `<b>Mobile:</b> ${customerPhone || 'Not provided'}`,
        `<b>Locality:</b> ${locality}`,
        `<b>Address:</b> ${address}`,
        `<b>Slot:</b> ${slot}`,
        `<b>Total Amount:</b> Rs. ${finalAmount}`,
        `<b>Status:</b> ${booking.status || 'created'}`
      ];

      const inlineKeyboard = [];
      const row = [];

      if (adminUrl) {
        row.push({ text: 'Open Admin Dashboard', url: adminUrl });
      }

      if (customerPhone && customerPhone.length >= 10) {
        const cleanPhone = customerPhone.replace(/\D/g, '');
        row.push({ text: 'Call Customer', url: `tel:${cleanPhone}` });
      }

      if (row.length > 0) {
        inlineKeyboard.push(row);
      }

      return await this.sendTelegramMessage({
        botToken: config.botToken,
        chatId: config.chatId,
        text: lines.join('\n'),
        inlineKeyboard: inlineKeyboard.length > 0 ? inlineKeyboard : null
      });
    } catch (err) {
      console.warn('[Telegram Alert notifyNewBooking Exception]:', err.message);
      return { success: false, error: err.message };
    }
  }

  // Notify Admin when advance payment or booking payment is completed
  async notifyBookingPayment({ bookingId, amount, paymentMethod = 'UPI', utr = null, customerName = null }) {
    if (!bookingId) return { success: false, reason: 'missing_booking_id' };

    try {
      const config = await this.getConfig();
      if (!config.enabled) {
        return { success: false, skipped: true, reason: 'telegram_alerts_not_enabled' };
      }

      const adminUrl = process.env.ADMIN_PORTAL_URL || 'https://shazuone.in/admin';
      const lines = [
        '<b>[BOOKING PAYMENT CONFIRMED]</b>',
        '',
        `<b>Booking ID:</b> #${bookingId}`,
        `<b>Amount Received:</b> Rs. ${parseFloat(amount || 0).toFixed(2)}`,
        `<b>Payment Method:</b> ${paymentMethod}`,
        `<b>UTR / Ref:</b> ${utr || 'Auto-verified'}`,
        customerName ? `<b>Customer:</b> ${customerName}` : null,
        `<b>Timestamp:</b> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
      ].filter(Boolean);

      const inlineKeyboard = adminUrl
        ? [[{ text: 'View Settlement in Admin', url: adminUrl }]]
        : null;

      return await this.sendTelegramMessage({
        botToken: config.botToken,
        chatId: config.chatId,
        text: lines.join('\n'),
        inlineKeyboard
      });
    } catch (err) {
      console.warn('[Telegram Alert notifyBookingPayment Exception]:', err.message);
      return { success: false, error: err.message };
    }
  }

  // Test notification helper to verify setup immediately
  async testNotification(customToken = null, customChatId = null) {
    const config = await this.getConfig();
    const token = customToken || config.botToken;
    const chat = customChatId || config.chatId;

    if (!token || !chat) {
      return {
        success: false,
        error: 'Telegram Bot Token and Chat ID are required to run test.'
      };
    }

    const testMessage = [
      '<b>[SALEMSEVA ADMIN ALERT TEST]</b>',
      '',
      'Your Telegram alert trigger is configured and active.',
      'You will receive real-time notifications here on your phone whenever a new booking is created or paid.',
      `<b>Server Time:</b> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
    ].join('\n');

    return await this.sendTelegramMessage({
      botToken: token,
      chatId: chat,
      text: testMessage
    });
  }
}

module.exports = new TelegramAlertService();
