const pushService = require('../services/pushNotification.service');

async function notificationsRoutes(fastify, options) {
  // 0. Real-Time Server-Sent Events (SSE) stream for instant in-app push notifications
  fastify.get('/notifications/stream', async (req, reply) => {
    const { phone = '', role = '', bookingId = '' } = req.query || {};

    reply.hijack();
    const res = reply.raw;
    const origin = req.headers.origin;
    const headers = {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    };
    if (origin) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Vary'] = 'Origin';
    } else {
      headers['Access-Control-Allow-Origin'] = '*';
    }

    res.writeHead(200, headers);
    res.write(': connected\n\n');

    const unregister = pushService.registerSseClient({
      res,
      phone,
      role,
      bookingId: bookingId || null
    });

    const heartbeat = setInterval(() => {
      try {
        if (!res.writableEnded) {
          res.write(': ping\n\n');
        }
      } catch (_) {}
    }, 25000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unregister();
    });
  });

  // 0b. Get Notification History & Unread Count for Customer or Technician
  fastify.get('/notifications/history', async (req, reply) => {
    try {
      const { phone = '', role = '', limit = 50 } = req.query || {};
      const data = await pushService.getNotificationHistory({ phone, role, limit });
      return { success: true, ...data };
    } catch (err) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 0c. Mark Notification(s) as Read
  fastify.post('/notifications/mark-read', async (req, reply) => {
    try {
      const { id = null, phone = '', role = '', markAll = false } = req.body || {};
      await pushService.markNotificationsRead({ id, phone, role, markAll });
      return { success: true };
    } catch (err) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 1. Get VAPID Public Key for Web Push Manager subscription
  fastify.get('/notifications/vapid-public-key', async (req, reply) => {
    return {
      success: true,
      publicKey: pushService.publicKey
    };
  });

  // 2. Save Client Push Subscription
  fastify.post('/notifications/subscribe', async (req, reply) => {
    try {
      const { subscription, phone, role = 'customer', bookingId = null } = req.body || {};

      if (!subscription || !subscription.endpoint || !subscription.keys) {
        return reply.status(400).send({
          success: false,
          error: 'Valid push subscription object with endpoint and keys is required'
        });
      }

      const record = await pushService.saveSubscription({
        phone,
        role,
        bookingId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth
      });

      return {
        success: true,
        message: 'Push subscription registered successfully',
        subscriptionId: record.id
      };
    } catch (err) {
      req.log.error('Subscription error:', err);
      return reply.status(500).send({
        success: false,
        error: err.message || 'Failed to save push subscription'
      });
    }
  });

  // 3. Unsubscribe / Remove Push Subscription
  fastify.post('/notifications/unsubscribe', async (req, reply) => {
    try {
      const { endpoint } = req.body || {};
      if (endpoint) {
        await pushService.removeSubscription(endpoint);
      }
      return { success: true, message: 'Unsubscribed successfully' };
    } catch (err) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 4. Test Push Notification
  fastify.post('/notifications/test-push', async (req, reply) => {
    try {
      const { phone, role = 'customer', title, body } = req.body || {};
      if (!phone) {
        return reply.status(400).send({ success: false, error: 'Phone number is required' });
      }

      const results = await pushService.sendPushToPhone({
        phone,
        role,
        payload: {
          title: title || 'Test Notification',
          body: body || 'Background push notifications are working properly.',
          tag: `test-${Date.now()}`,
          type: 'info'
        }
      });

      return {
        success: true,
        sentCount: results.length,
        results
      };
    } catch (err) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });
}

module.exports = notificationsRoutes;
