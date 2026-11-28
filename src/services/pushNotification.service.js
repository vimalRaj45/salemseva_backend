const { query } = require('../db/db');
const { webpush, vapidPublicKey } = require('../config/vapid');
const firebaseAuthService = require('./firebase-auth.service');

function cleanPhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/[^\d]/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

class PushNotificationService {
  constructor() {
    this.publicKey = vapidPublicKey;
    this.sseClients = new Set();
    this.tableReady = false;
    this.fcmTableReady = false;
  }

  async ensureFcmTable() {
    if (this.fcmTableReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS fcm_tokens (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(30) DEFAULT '',
          user_role VARCHAR(20) DEFAULT 'customer',
          booking_id VARCHAR(50),
          token TEXT UNIQUE NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_fcm_tokens_phone ON fcm_tokens (user_phone);
      `);
      this.fcmTableReady = true;
    } catch (_) {}
  }

  async saveFcmToken({ phone = '', role = 'customer', bookingId = null, token }) {
    if (!token) return null;
    await this.ensureFcmTable();
    const normalizedPhone = cleanPhone(phone);
    const res = await query(
      `INSERT INTO fcm_tokens (user_phone, user_role, booking_id, token, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (token)
       DO UPDATE SET
         user_phone = CASE
           WHEN EXCLUDED.user_phone IS NOT NULL AND EXCLUDED.user_phone != '' THEN EXCLUDED.user_phone
           ELSE fcm_tokens.user_phone
         END,
         user_role = COALESCE(EXCLUDED.user_role, fcm_tokens.user_role),
         booking_id = COALESCE(EXCLUDED.booking_id, fcm_tokens.booking_id),
         updated_at = NOW()
       RETURNING id, user_phone, user_role, token`,
      [normalizedPhone, role, bookingId ? String(bookingId) : null, token]
    );
    return res.rows[0];
  }

  async removeFcmToken(token) {
    if (!token) return;
    await this.ensureFcmTable();
    await query('DELETE FROM fcm_tokens WHERE token = $1', [token]);
  }

  async _sendFcmToTokens(tokens, payload = {}) {
    const messaging = firebaseAuthService.getMessaging();
    const uniqueTokens = [...new Set((tokens || []).filter(Boolean))];
    if (!messaging || uniqueTokens.length === 0) return [];

    const dataPayload = {};
    if (payload.type) dataPayload.type = String(payload.type);
    if (payload.bookingId) dataPayload.bookingId = String(payload.bookingId);
    if (payload.ticketId) dataPayload.ticketId = String(payload.ticketId);
    if (payload.role) dataPayload.role = String(payload.role);

    const resolvedUrl = payload.url || (
      payload.type === 'ticket_update' || payload.ticketId
        ? '/support'
        : payload.type === 'chat' || payload.type === 'chat_message'
          ? (payload.bookingId ? `/chat/${payload.bookingId}` : '/notifications')
          : payload.type === 'new_job' || payload.type === 'payout_settled' || payload.role === 'technician'
            ? (payload.bookingId ? `/partner?bookingId=${payload.bookingId}` : '/partner')
            : payload.bookingId
              ? `/track?bookingId=${payload.bookingId}`
              : '/notifications'
    );
    dataPayload.url = String(resolvedUrl);

    const results = [];
    // FCM sendEachForMulticast accepts up to 500 tokens per batch
    for (let offset = 0; offset < uniqueTokens.length; offset += 500) {
      const batch = uniqueTokens.slice(offset, offset + 500);
      const response = await messaging.sendEachForMulticast({
        tokens: batch,
        notification: {
          title: payload.title || 'Shazu One Update',
          body: payload.body || ''
        },
        data: dataPayload,
        android: {
          priority: 'high',
          notification: {
            sound: 'default'
          }
        },
        webpush: {
          headers: {
            Urgency: 'high'
          },
          notification: {
            icon: '/icons/icon-192x192.png'
          },
          fcmOptions: {
            link: resolvedUrl
          }
        }
      });

      for (let i = 0; i < response.responses.length; i++) {
        const r = response.responses[i];
        if (r.success) {
          results.push({ success: true, channel: 'fcm', token: batch[i] });
        } else {
          const code = r.error?.code || '';
          if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
            await this.removeFcmToken(batch[i]).catch(() => {});
          }
          results.push({ success: false, channel: 'fcm', error: r.error?.message });
        }
      }
    }
    return results;
  }

  async sendFcmToPhone({ phone, role, payload = {} }) {
    const normalizedPhone = cleanPhone(phone);
    if (!normalizedPhone) return [];

    await this.ensureFcmTable();
    let sql = `SELECT token FROM fcm_tokens WHERE (user_phone = $1 OR user_phone LIKE '%' || $1)`;
    const params = [normalizedPhone];
    if (role) {
      sql += ' AND (user_role = $2 OR user_role IS NULL)';
      params.push(role);
    }

    const res = await query(sql, params);
    const tokens = (res.rows || []).map(r => r.token).filter(Boolean);
    return this._sendFcmToTokens(tokens, payload);
  }

  async ensureNotificationsTable() {
    if (this.tableReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS user_notifications (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(30) DEFAULT '',
          user_role VARCHAR(20) DEFAULT 'customer',
          booking_id VARCHAR(50),
          title TEXT NOT NULL,
          body TEXT DEFAULT '',
          notif_type VARCHAR(40) DEFAULT 'info',
          target_url TEXT DEFAULT '/',
          is_read BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_user_notifications_phone_created
          ON user_notifications (user_phone, created_at DESC);
      `);
      this.tableReady = true;
    } catch (_) {}
  }

  async saveNotificationRecord({ phone = '', role = 'customer', bookingId = null, payload = {} }) {
    try {
      await this.ensureNotificationsTable();
      const normalizedPhone = cleanPhone(phone);
      const title = payload.title || 'Shazu One Update';
      const body = payload.body || '';
      const notifType = payload.type || 'info';
      const targetUrl = payload.url || (bookingId ? `/track?bookingId=${bookingId}` : '/');

      await query(
        `INSERT INTO user_notifications (user_phone, user_role, booking_id, title, body, notif_type, target_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [normalizedPhone, role || 'customer', bookingId ? String(bookingId) : null, title, body, notifType, targetUrl]
      );
    } catch (_) {}
  }

  async getNotificationHistory({ phone = '', role = '', limit = 50 }) {
    await this.ensureNotificationsTable();
    const normalizedPhone = cleanPhone(phone);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);

    const conditions = [];
    const params = [];
    if (normalizedPhone) {
      params.push(normalizedPhone);
      conditions.push(`(user_phone = $${params.length} OR user_phone LIKE '%' || $${params.length})`);
    }
    if (role) {
      params.push(String(role).toLowerCase());
      conditions.push(`(user_role = $${params.length} OR user_role IS NULL)`);
    }

    if (conditions.length === 0) {
      return { notifications: [], unreadCount: 0 };
    }

    const whereClause = conditions.join(' AND ');
    const listRes = await query(
      `SELECT id, user_phone, user_role, booking_id, title, body, notif_type, target_url, is_read, created_at
       FROM user_notifications
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT ${safeLimit}`,
      params
    );

    const unreadRes = await query(
      `SELECT COUNT(*)::int AS cnt FROM user_notifications WHERE ${whereClause} AND is_read = FALSE`,
      params
    );

    return {
      notifications: listRes.rows || [],
      unreadCount: unreadRes.rows?.[0]?.cnt || 0
    };
  }

  async markNotificationsRead({ id = null, phone = '', role = '', markAll = false }) {
    await this.ensureNotificationsTable();
    if (id) {
      await query('UPDATE user_notifications SET is_read = TRUE WHERE id = $1', [id]);
      return;
    }
    const normalizedPhone = cleanPhone(phone);
    if (markAll && normalizedPhone) {
      const params = [normalizedPhone];
      let sql = `UPDATE user_notifications SET is_read = TRUE WHERE (user_phone = $1 OR user_phone LIKE '%' || $1)`;
      if (role) {
        params.push(String(role).toLowerCase());
        sql += ` AND user_role = $2`;
      }
      await query(sql, params);
    }
  }

  /**
   * Register an active SSE connection for real-time in-app notifications.
   * Returns a cleanup function to invoke when the connection closes.
   */
  registerSseClient({ res, phone = '', role = '', bookingId = null }) {
    const client = {
      res,
      phone: cleanPhone(phone),
      role: role ? String(role).toLowerCase() : '',
      bookingId: bookingId ? String(bookingId) : null
    };
    this.sseClients.add(client);
    return () => {
      this.sseClients.delete(client);
    };
  }

  /**
   * Deliver a notification payload immediately to matching connected SSE clients.
   */
  emitRealtime({ phone = '', role = '', bookingId = null, payload }) {
    if (!this.sseClients.size || !payload) return 0;

    const targetPhone = cleanPhone(phone);
    const targetRole = role ? String(role).toLowerCase() : '';
    const targetBookingId = bookingId ? String(bookingId) : null;
    const message = `event: notification\ndata: ${JSON.stringify({
      ...payload,
      bookingId: payload.bookingId || targetBookingId || undefined,
      timestamp: Date.now()
    })}\n\n`;

    let delivered = 0;
    for (const client of this.sseClients) {
      const phoneMatch = targetPhone && client.phone && client.phone === targetPhone;
      const bookingMatch = targetBookingId && client.bookingId && client.bookingId === targetBookingId;
      const roleMatch = !targetRole || !client.role || client.role === targetRole;

      const shouldDeliver = phoneMatch || (bookingMatch && roleMatch) || (!targetPhone && !targetBookingId && targetRole && client.role === targetRole);
      if (!shouldDeliver) continue;

      try {
        if (!client.res.writableEnded) {
          client.res.write(message);
          delivered += 1;
        } else {
          this.sseClients.delete(client);
        }
      } catch (_) {
        this.sseClients.delete(client);
      }
    }
    return delivered;
  }

  // 1. Save or update a client push subscription
  async saveSubscription({ phone, role = 'customer', bookingId = null, endpoint, p256dh, auth }) {
    if (!endpoint || !p256dh || !auth) {
      throw new Error('endpoint, p256dh, and auth keys are required');
    }

    const normalizedPhone = cleanPhone(phone);

    const sql = `
      INSERT INTO push_subscriptions (user_phone, user_role, booking_id, endpoint, p256dh, auth, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (endpoint) 
      DO UPDATE SET 
        user_phone = CASE 
          WHEN EXCLUDED.user_phone IS NOT NULL AND EXCLUDED.user_phone != '' THEN EXCLUDED.user_phone 
          ELSE push_subscriptions.user_phone 
        END,
        user_role = COALESCE(EXCLUDED.user_role, push_subscriptions.user_role),
        booking_id = COALESCE(EXCLUDED.booking_id, push_subscriptions.booking_id),
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        updated_at = NOW()
      RETURNING id, user_phone, user_role, endpoint;
    `;

    const res = await query(sql, [normalizedPhone, role, bookingId, endpoint, p256dh, auth]);
    return res.rows[0];
  }

  // 2. Remove subscription (e.g. on logout or user toggle off)
  async removeSubscription(endpoint) {
    if (!endpoint) return;
    await query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
  }

  // 3. Low-level send with automatic stale subscription cleanup (HTTP 410 / 404)
  async sendToSubscription(subRecord, payload, options = {}) {
    const pushSubscription = {
      endpoint: subRecord.endpoint,
      keys: {
        p256dh: subRecord.p256dh,
        auth: subRecord.auth
      }
    };

    const pushOptions = {
      TTL: options.TTL || (payload.type === 'call' ? 60 : 3600), // 60s for calls, 1hr for updates
      urgency: options.urgency || (payload.type === 'call' ? 'high' : 'normal'),
      ...options
    };

    try {
      await webpush.sendNotification(pushSubscription, JSON.stringify(payload), pushOptions);
      return { success: true, endpoint: subRecord.endpoint };
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        console.log(`Pruning expired push subscription [${err.statusCode}]: ${subRecord.endpoint.slice(0, 30)}...`);
        await this.removeSubscription(subRecord.endpoint);
      } else {
        console.warn('Web push delivery note:', err.statusCode || err.message);
      }
      return { success: false, error: err.message, statusCode: err.statusCode };
    }
  }

  // 4. Send push to a user by normalized phone number
  async sendPushToPhone({ phone, role, payload, options = {} }) {
    const normalizedPhone = cleanPhone(phone);
    if (!normalizedPhone) return [];

    this.saveNotificationRecord({ phone: normalizedPhone, role: role || 'customer', bookingId: payload?.bookingId, payload });
    this.emitRealtime({ phone: normalizedPhone, role, bookingId: payload?.bookingId, payload });

    const fcmResults = await this.sendFcmToPhone({ phone: normalizedPhone, role, payload }).catch(() => []);

    let sql = `
      SELECT * FROM push_subscriptions 
      WHERE (user_phone = $1 OR user_phone LIKE '%' || $1)
    `;
    const params = [normalizedPhone];

    if (role) {
      sql += ' AND (user_role = $2 OR user_role IS NULL)';
      params.push(role);
    }

    const res = await query(sql, params);
    if (!res.rows || res.rows.length === 0) {
      return fcmResults;
    }

    const promises = res.rows.map(sub => this.sendToSubscription(sub, payload, options));
    const webPushResults = await Promise.all(promises);
    return [...fcmResults, ...webPushResults];
  }

  // 5. Send push to booking parties (Customer or Technician) with automatic booking_id fallback
  async sendPushToBookingParty({ bookingId, targetRole, payload, options = {} }) {
    if (!bookingId || !targetRole) return [];

    try {
      const bRes = await query('SELECT customer_phone, technician_id FROM bookings WHERE id = $1', [bookingId]);
      if (!bRes.rows || bRes.rows.length === 0) return [];
      const booking = bRes.rows[0];

      let targetPhone = '';
      if (targetRole === 'customer') {
        targetPhone = booking.customer_phone;
      } else if (targetRole === 'technician' && booking.technician_id) {
        const tRes = await query('SELECT phone FROM technicians WHERE id = $1', [booking.technician_id]);
        if (tRes.rows.length > 0) {
          targetPhone = tRes.rows[0].phone;
        }
      }

      let results = [];
      if (targetPhone) {
        results = await this.sendPushToPhone({
          phone: targetPhone,
          role: targetRole,
          payload: {
            bookingId,
            ...payload
          },
          options
        });
      } else {
        this.emitRealtime({ role: targetRole, bookingId, payload: { bookingId, ...payload } });
      }

      // If no phone match was found, fallback to match by bookingId & targetRole
      if (!results || results.length === 0) {
        await this.ensureFcmTable();
        const fcmFallback = await query(
          'SELECT token FROM fcm_tokens WHERE booking_id = $1 AND (user_role = $2 OR user_role IS NULL)',
          [String(bookingId), targetRole]
        );
        const fcmRes = await this._sendFcmToTokens(
          (fcmFallback.rows || []).map(r => r.token),
          { bookingId, role: targetRole, ...payload }
        ).catch(() => []);

        const fallbackRes = await query(
          'SELECT * FROM push_subscriptions WHERE booking_id = $1 AND (user_role = $2 OR user_role IS NULL)',
          [bookingId, targetRole]
        );
        let webRes = [];
        if (fallbackRes.rows && fallbackRes.rows.length > 0) {
          const promises = fallbackRes.rows.map(sub => this.sendToSubscription(sub, { bookingId, ...payload }, options));
          webRes = await Promise.all(promises);
        }
        results = [...fcmRes, ...webRes];
      }

      return results;
    } catch (e) {
      console.warn('Error sending push to booking party:', e.message);
    }
    return [];
  }

  // 6. Broadcast push to all active users/technicians of a role
  async sendPushToRole({ role, payload, options = {} }) {
    try {
      this.emitRealtime({ role, payload });

      await this.ensureFcmTable();
      const fcmResRows = await query('SELECT token FROM fcm_tokens WHERE user_role = $1', [role]);
      const fcmResults = await this._sendFcmToTokens(
        (fcmResRows.rows || []).map(r => r.token),
        { role, ...payload }
      ).catch(() => []);

      const res = await query('SELECT * FROM push_subscriptions WHERE user_role = $1', [role]);
      if (!res.rows || res.rows.length === 0) return fcmResults;
      const promises = res.rows.map(sub => this.sendToSubscription(sub, payload, options));
      const webResults = await Promise.all(promises);
      return [...fcmResults, ...webResults];
    } catch (e) {
      console.warn('Error broadcasting push to role:', e.message);
      return [];
    }
  }
}

module.exports = new PushNotificationService();
