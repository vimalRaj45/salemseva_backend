const { query } = require('../db/db');

// In-memory Concurrent Session Registry
// Format: { [cleanPhone]: { sessionToken: string, loggedInAt: number, lastActive: number, role: string } }
const activeUserSessions = {};

async function authRoutes(fastify, options) {
  // 1. Unified Single-Device Login Endpoint
  fastify.post('/auth/login', async (req, reply) => {
    try {
      const { phone = '', role = 'customer', name = '', trade = 'ac' } = req.body || {};
      const cleanPhone = (phone || '').replace(/[\s\-\(\)]/g, '');

      if (!cleanPhone) {
        return reply.status(400).send({ success: false, error: 'Phone number is required' });
      }

      // Generate a new unique session token
      const sessionToken = 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2, 12);

      // Invalidate any previous device session for this phone number
      activeUserSessions[cleanPhone] = {
        sessionToken,
        role,
        loggedInAt: Date.now(),
        lastActive: Date.now()
      };

      // Query or fetch user record from DB
      let userRecord = null;
      if (role === 'technician' || role === 'partner') {
        const techRes = await query(`
          SELECT * FROM technicians 
          WHERE REPLACE(REPLACE(phone, ' ', ''), '-', '') = $1 
          LIMIT 1
        `, [cleanPhone]);
        userRecord = techRes.rows[0] || {
          id: 'tech-' + cleanPhone.slice(-4),
          role: 'technician',
          name: name || 'Certified Technician',
          phone: cleanPhone,
          trade
        };
      } else {
        const custRes = await query(`
          SELECT * FROM users 
          WHERE REPLACE(REPLACE(phone, ' ', ''), '-', '') = $1 
          LIMIT 1
        `, [cleanPhone]);
        userRecord = custRes.rows[0] || {
          id: 'cust-' + cleanPhone.slice(-4),
          role: 'customer',
          name: name || 'Salem Customer',
          phone: cleanPhone
        };
      }

      return {
        success: true,
        sessionToken,
        user: {
          ...userRecord,
          role,
          phone: cleanPhone
        },
        message: 'Login successful. Active on this device.'
      };
    } catch (e) {
      fastify.log.error(e);
      return reply.status(500).send({ success: false, error: e.message });
    }
  });

  // 2. Active Session Heartbeat & Concurrent Session Verification
  fastify.post('/auth/session/verify', async (req, reply) => {
    try {
      const { phone = '', sessionToken = '', role = 'customer' } = req.body || {};
      const cleanPhone = (phone || '').replace(/[\s\-\(\)]/g, '');

      if (!cleanPhone) {
        return { success: true, active: true };
      }

      const activeSession = activeUserSessions[cleanPhone];

      // If a session exists for this phone and the sessionToken differs -> Logged in on another device!
      if (activeSession && sessionToken && activeSession.sessionToken !== sessionToken) {
        return {
          success: false,
          code: 'SESSION_TERMINATED',
          error: 'Your account was logged in on another device. You have been logged out for security.',
          activeOnOtherDevice: true
        };
      }

      // If no session registered yet, register this token as active
      if (!activeSession && sessionToken) {
        activeUserSessions[cleanPhone] = {
          sessionToken,
          role,
          loggedInAt: Date.now(),
          lastActive: Date.now()
        };
      } else if (activeSession) {
        activeSession.lastActive = Date.now();
      }

      return {
        success: true,
        active: true
      };
    } catch (e) {
      fastify.log.error(e);
      return { success: true, active: true };
    }
  });

  // 3. User Explicit Logout
  fastify.post('/auth/logout', async (req, reply) => {
    const { phone = '' } = req.body || {};
    const cleanPhone = (phone || '').replace(/[\s\-\(\)]/g, '');
    if (cleanPhone && activeUserSessions[cleanPhone]) {
      delete activeUserSessions[cleanPhone];
    }
    return { success: true, message: 'Logged out successfully' };
  });
}

module.exports = authRoutes;
