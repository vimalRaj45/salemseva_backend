const { query } = require('../db/db');

// In-memory real-time WebRTC Signaling Store for Active Calls
const callSignals = {};

function getOrCreateCall(bookingId) {
  if (!callSignals[bookingId]) {
    callSignals[bookingId] = {
      active: false,
      status: 'IDLE', // IDLE | RINGING | CONNECTED | ENDED
      bookingId,
      caller: null,
      callerName: 'Customer',
      calleeName: 'Technician',
      offer: null,
      answer: null,
      candidates: [],
      startedAt: 0,
      connectedAt: 0
    };
  }
  return callSignals[bookingId];
}

async function webrtcRoutes(fastify, options) {
  const TURN_KEY_ID = process.env.CLOUDFLARE_TURN_KEY_ID || '21b1f9a2fb7df552879fd42bf659d3c8';
  const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '2fd6d247ddbbfcc4527005f3d94650e9574249fbd9a067a545188d722bad98f2';

  // 1. Generate Cloudflare + Google STUN / TURN ICE Servers
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
          body: JSON.stringify({ ttl: 86400 })
        }
      );

      if (response.ok) {
        const data = await response.json();
        const cfServers = Array.isArray(data.iceServers)
          ? data.iceServers
          : (data.iceServers ? [data.iceServers] : []);
        return {
          success: true,
          iceServers: [
            ...cfServers,
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ]
        };
      }
    } catch (err) {
      fastify.log.warn('Cloudflare TURN fetch note:', err.message);
    }

    return {
      success: true,
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ]
    };
  });

  // 2. Real-time Masked Chat: Get Messages
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

  // 3. Real-time Masked Chat: Send Message
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
    const { bookingId = 'SLM-84920', caller = 'customer', callerName = 'Customer', calleeName = 'Technician' } = req.body || {};
    const call = getOrCreateCall(bookingId);
    
    call.active = true;
    call.status = 'RINGING';
    call.caller = caller;
    call.callerName = callerName;
    call.calleeName = calleeName;
    call.startedAt = Date.now();
    call.offer = null;
    call.answer = null;
    call.candidates = [];

    return {
      success: true,
      call
    };
  });

  // 5. VoIP Signaling: Check Status (Polling)
  fastify.get('/webrtc/call/status', async (req, reply) => {
    const { bookingId = 'SLM-84920' } = req.query || {};
    const call = getOrCreateCall(bookingId);
    return {
      success: true,
      call
    };
  });

  // 6. VoIP Signaling: Accept Call
  fastify.post('/webrtc/call/accept', async (req, reply) => {
    const { bookingId = 'SLM-84920' } = req.body || {};
    const call = getOrCreateCall(bookingId);
    call.status = 'CONNECTED';
    call.connectedAt = Date.now();
    return {
      success: true,
      call
    };
  });

  // 7. VoIP Signaling: End / Reject Call
  fastify.post('/webrtc/call/end', async (req, reply) => {
    const { bookingId = 'SLM-84920' } = req.body || {};
    const call = getOrCreateCall(bookingId);
    call.status = 'ENDED';
    call.active = false;
    call.offer = null;
    call.answer = null;
    call.candidates = [];
    return {
      success: true,
      message: 'Call terminated'
    };
  });

  // 8. SDP Offer: Caller sends SDP Offer
  fastify.post('/webrtc/call/offer', async (req, reply) => {
    const { bookingId = 'SLM-84920', sdp } = req.body || {};
    const call = getOrCreateCall(bookingId);
    call.offer = sdp;
    return { success: true };
  });

  // 9. SDP Offer: Callee retrieves SDP Offer
  fastify.get('/webrtc/call/offer', async (req, reply) => {
    const { bookingId = 'SLM-84920' } = req.query || {};
    const call = getOrCreateCall(bookingId);
    return { success: true, offer: call.offer };
  });

  // 10. SDP Answer: Callee sends SDP Answer
  fastify.post('/webrtc/call/answer', async (req, reply) => {
    const { bookingId = 'SLM-84920', sdp } = req.body || {};
    const call = getOrCreateCall(bookingId);
    call.answer = sdp;
    call.status = 'CONNECTED';
    return { success: true };
  });

  // 11. SDP Answer: Caller retrieves SDP Answer
  fastify.get('/webrtc/call/answer', async (req, reply) => {
    const { bookingId = 'SLM-84920' } = req.query || {};
    const call = getOrCreateCall(bookingId);
    return { success: true, answer: call.answer };
  });

  // 12. ICE Candidate: Send ICE Candidate
  fastify.post('/webrtc/call/candidate', async (req, reply) => {
    const { bookingId = 'SLM-84920', candidate, senderRole = 'caller' } = req.body || {};
    const call = getOrCreateCall(bookingId);
    if (candidate) {
      call.candidates.push({ candidate, senderRole, timestamp: Date.now() });
    }
    return { success: true };
  });

  // 13. ICE Candidates: Retrieve pending ICE Candidates
  fastify.get('/webrtc/call/candidates', async (req, reply) => {
    const { bookingId = 'SLM-84920', targetRole = 'callee' } = req.query || {};
    const call = getOrCreateCall(bookingId);
    // targetRole 'callee' gets candidates sent by 'caller'; targetRole 'caller' gets candidates sent by 'callee'
    const matching = (call.candidates || []).filter(c => c.senderRole !== targetRole);
    return {
      success: true,
      candidates: matching.map(m => m.candidate)
    };
  });
}

module.exports = webrtcRoutes;
