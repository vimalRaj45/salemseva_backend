import { describe, it } from 'node:test';
import assert from 'node:assert';
import telegramAlert from '../src/services/telegramAlert.service.js';

describe('Unit Test: Telegram Admin Alert Notification Service', () => {
  it('should gracefully skip notifications when credentials are not configured without throwing', async () => {
    const originalGetConfig = telegramAlert.getConfig.bind(telegramAlert);
    telegramAlert.getConfig = async () => ({
      botToken: '',
      chatId: '',
      enabled: false
    });

    try {
      const res = await telegramAlert.notifyNewBooking({
        id: 'SLM-TEST-001',
        service_id: 'ac',
        customer_name: 'Test Customer',
        customer_phone: '9842012345',
        locality: 'Fairlands, Salem',
        final_amount: 199.00
      });

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.skipped, true);
    } finally {
      telegramAlert.getConfig = originalGetConfig;
    }
  });

  it('should format booking alert with valid HTML structure and no emoji characters', async () => {
    let capturedPayload = null;
    const originalSend = telegramAlert.sendTelegramMessage.bind(telegramAlert);

    telegramAlert.sendTelegramMessage = async (args) => {
      capturedPayload = args;
      return { success: true, messageId: 999 };
    };

    try {
      // Mock getConfig
      const originalGetConfig = telegramAlert.getConfig.bind(telegramAlert);
      telegramAlert.getConfig = async () => ({
        botToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
        chatId: '987654321',
        enabled: true
      });

      const bookingSample = {
        id: 'SLM-882194',
        service_id: 'washing_machine',
        selected_issue_id: 'water_leakage',
        customer_name: 'Saravanan',
        customer_phone: '9842099999',
        locality: 'Hasthampatti',
        service_address: '12/4 Cross Road, Hasthampatti, Salem',
        scheduled_slot: '02:00 PM - 04:00 PM',
        visit_fee: 149.00,
        final_amount: 149.00,
        is_urgent_dispatch: true,
        status: 'scheduled'
      };

      const result = await telegramAlert.notifyNewBooking(bookingSample);

      assert.strictEqual(result.success, true);
      assert.ok(capturedPayload, 'Payload must be passed to sender');
      assert.strictEqual(capturedPayload.chatId, '987654321');
      assert.ok(capturedPayload.text.includes('<b>[NEW BOOKING ALERT]</b>'));
      assert.ok(capturedPayload.text.includes('#SLM-882194'));
      assert.ok(capturedPayload.text.includes('WASHING_MACHINE'));
      assert.ok(capturedPayload.text.includes('Saravanan'));
      assert.ok(capturedPayload.text.includes('9842099999'));
      assert.ok(capturedPayload.text.includes('Hasthampatti'));
      assert.ok(capturedPayload.text.includes('URGENT DISPATCH'));

      // Strict adherence to AGENTS.md rule: Zero emoji anywhere
      const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
      assert.strictEqual(emojiRegex.test(capturedPayload.text), false, 'Message text must contain zero emojis');

      // Check inline buttons
      assert.ok(Array.isArray(capturedPayload.inlineKeyboard));
      const firstRow = capturedPayload.inlineKeyboard[0];
      const callButton = firstRow.find(b => b.text === 'Call Customer');
      assert.ok(callButton, 'Call customer button should be present');
      assert.strictEqual(callButton.url, 'tel:9842099999');

      telegramAlert.getConfig = originalGetConfig;
    } finally {
      telegramAlert.sendTelegramMessage = originalSend;
    }
  });

  it('should format payment confirmation alert correctly', async () => {
    let capturedPayload = null;
    const originalSend = telegramAlert.sendTelegramMessage.bind(telegramAlert);

    telegramAlert.sendTelegramMessage = async (args) => {
      capturedPayload = args;
      return { success: true, messageId: 1001 };
    };

    try {
      const originalGetConfig = telegramAlert.getConfig.bind(telegramAlert);
      telegramAlert.getConfig = async () => ({
        botToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
        chatId: '987654321',
        enabled: true
      });

      const result = await telegramAlert.notifyBookingPayment({
        bookingId: 'SLM-771122',
        amount: 499.00,
        paymentMethod: 'UPI_QR',
        utr: '432109876543',
        customerName: 'Anitha'
      });

      assert.strictEqual(result.success, true);
      assert.ok(capturedPayload.text.includes('<b>[BOOKING PAYMENT CONFIRMED]</b>'));
      assert.ok(capturedPayload.text.includes('#SLM-771122'));
      assert.ok(capturedPayload.text.includes('Rs. 499.00'));
      assert.ok(capturedPayload.text.includes('432109876543'));

      telegramAlert.getConfig = originalGetConfig;
    } finally {
      telegramAlert.sendTelegramMessage = originalSend;
    }
  });

  it('should reject test notification when token or chat id is missing', async () => {
    const originalGetConfig = telegramAlert.getConfig.bind(telegramAlert);
    telegramAlert.getConfig = async () => ({
      botToken: '',
      chatId: '',
      enabled: false
    });

    try {
      const res = await telegramAlert.testNotification('', '');
      assert.strictEqual(res.success, false);
      assert.ok(res.error.includes('required'));
    } finally {
      telegramAlert.getConfig = originalGetConfig;
    }
  });
});
