const { query } = require('../db/db');
const { webpush, vapidPublicKey } = require('../config/vapid');

function cleanPhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/[^\d]/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

class PushNotificationService {
  constructor() {
    this.publicKey = vapidPublicKey;
    this.sseClients = new Set();
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

    this.emitRealtime({ phone: normalizedPhone, role, bookingId: payload?.bookingId, payload });

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
      return [];
    }

    const promises = res.rows.map(sub => this.sendToSubscription(sub, payload, options));
    return Promise.all(promises);
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
        const fallbackRes = await query(
          'SELECT * FROM push_subscriptions WHERE booking_id = $1 AND (user_role = $2 OR user_role IS NULL)',
          [bookingId, targetRole]
        );
        if (fallbackRes.rows && fallbackRes.rows.length > 0) {
          const promises = fallbackRes.rows.map(sub => this.sendToSubscription(sub, { bookingId, ...payload }, options));
          results = await Promise.all(promises);
        }
      }

      return results;
    } catch (e) {
      console.warn('Error sending push to booking party:', e.message);
    }
    return [];
  }

  // 6. Broadcast push to all active technicians
  async sendPushToRole({ role, payload, options = {} }) {
    try {
      this.emitRealtime({ role, payload });
      const res = await query('SELECT * FROM push_subscriptions WHERE user_role = $1', [role]);
      if (!res.rows || res.rows.length === 0) return [];
      const promises = res.rows.map(sub => this.sendToSubscription(sub, payload, options));
      return Promise.all(promises);
    } catch (e) {
      console.warn('Error broadcasting push to role:', e.message);
      return [];
    }
  }
}

module.exports = new PushNotificationService();
