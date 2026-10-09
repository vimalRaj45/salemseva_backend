const { query } = require('../db/db');

// Ephemeral signaling state for active WebRTC peer connection
let sharedActiveCall = {
  active: false,
  status: 'IDLE',
  caller: 'customer',
  callerName: 'Customer',
  calleeName: 'Technician',
  startedAt: 0
};
const callStore = {};

async function webrtcRoutes(fastify, options) {
  const TURN_KEY_ID = process.env.CLOUDFLARE_TURN_KEY_ID || '21b1f9a2fb7df552879fd42bf659d3c8';
  const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '2fd6d247ddbbfcc4527005f3d94650e9574249fbd9a067a545188d722bad98f2';

  // 1. Generate Ephemeral Cloudflare TURN / STUN ICE Servers for WebRTC Voice & Video Calls
  fastify.get('/webrtc/ice-servers', async (req, reply) => {
    try {
      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ ttl: 86400 }) // 24 hours TTL
        }
      );

      if (response.ok) {
        const data = await response.json();
        return {
          success: true,
          iceServers: data.iceServers || [
            { urls: 'stun:stun.cloudflare.com:3478' }
          ]
        };
      } else {
        return {
          success: true,
          iceServers: [
            { urls: 'stun:stun.cloudflare.com:3478' },
            { urls: 'stun:stun.l.google.com:19302' }
          ]
        };
      }
    } catch (err) {
      fastify.log.warn('Cloudflare TURN fetch note:', err.message);
      return {
        success: true,
        iceServers: [
          { urls: 'stun:stun.cloudflare.com:3478' },
          { urls: 'stun:stun.l.google.com:19302' }
        ]
      };
    }
  });

  // 2. Real-time Masked Chat: Get Messages from PostgreSQL
  fastify.get('/bookings/:id/messages', async (req, reply) => {
    const { id } = req.params;
    try {
      const res = await query(`
        SELECT 
          id, 
          sender_role as sender, 
          CASE WHEN sender_role = 'technician' THEN 'K. Ramesh (Technician)' ELSE 'Customer' END as "senderName",
          message_text as text, 
          TO_CHAR(created_at, 'HH12:MI AM') as time,
          EXTRACT(EPOCH FROM created_at) * 1000 as timestamp
        FROM chat_messages
        WHERE booking_id = $1
        ORDER BY created_at ASC
      `, [id]);

      return {
        success: true,
        bookingId: id,
        messages: res.rows
      };
    } catch (e) {
      fastify.log.error(e);
      return reply.status(500).send({ success: false, error: e.message });
    }
  });

  // 3. Real-time Masked Chat: Send Message to PostgreSQL
  fastify.post('/bookings/:id/messages', async (req, reply) => {
    const { id } = req.params;
    const { sender = 'customer', text = '' } = req.body || {};

    try {
      const res = await query(`
        INSERT INTO chat_messages (booking_id, sender_role, message_text)
        VALUES ($1, $2, $3)
        RETURNING 
          id, 
          sender_role as sender, 
          CASE WHEN sender_role = 'technician' THEN 'K. Ramesh (Technician)' ELSE 'Customer' END as "senderName",
          message_text as text, 
          TO_CHAR(created_at, 'HH12:MI AM') as time,
          EXTRACT(EPOCH FROM created_at) * 1000 as timestamp
      `, [id, sender, text]);

      return {
        success: true,
        message: res.rows[0]
      };
    } catch (e) {
      fastify.log.error(e);
      return reply.status(500).send({ success: false, error: e.message });
    }
  });

  // 4. VoIP Signaling: Initiate Call
  fastify.post('/webrtc/call/initiate', async (req, reply) => {
    const { bookingId = 'SLM-84920', caller = 'customer', callerName = 'Customer', calleeName = 'Technician' } = req.body;
    
    sharedActiveCall = {
      active: true,
      bookingId,
      caller,
      callerName,
      calleeName,
      status: 'RINGING',
      startedAt: Date.now()
    };
    callStore[bookingId] = sharedActiveCall;

    return {
      success: true,
      call: sharedActiveCall
    };
  });

  // 5. VoIP Signaling: Check Status (Polling)
  fastify.get('/webrtc/call/status', async (req, reply) => {
    const { bookingId = 'SLM-84920' } = req.query;
    const call = callStore[bookingId] || sharedActiveCall;
    return {
      success: true,
      call
    };
  });

  // 6. VoIP Signaling: Accept Call
  fastify.post('/webrtc/call/accept', async (req, reply) => {
    const { bookingId = 'SLM-84920' } = req.body;
    sharedActiveCall.status = 'CONNECTED';
    sharedActiveCall.connectedAt = Date.now();
    if (callStore[bookingId]) {
      callStore[bookingId].status = 'CONNECTED';
      callStore[bookingId].connectedAt = Date.now();
    }
    return {
      success: true,
      call: sharedActiveCall
    };
  });

  // 7. VoIP Signaling: End / Reject Call
  fastify.post('/webrtc/call/end', async (req, reply) => {
    const { bookingId = 'SLM-84920' } = req.body;
    sharedActiveCall.status = 'ENDED';
    sharedActiveCall.active = false;
    if (callStore[bookingId]) {
      callStore[bookingId].status = 'ENDED';
      callStore[bookingId].active = false;
    }
    return {
      success: true,
      message: 'Call terminated'
    };
  });
}

module.exports = webrtcRoutes;
