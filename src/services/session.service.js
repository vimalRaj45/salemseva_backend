// Session registry shared by the sign-in routes and the request authentication hook.
//
// Sessions live in process memory. That is honest about what this deployment is: one
// Fastify instance, no shared store. Restarting the server signs everybody out, and a
// second instance would not see the first one's sessions. Both are acceptable now and
// both have to change before this runs behind a load balancer.
//
// The previous registry was keyed only by phone number, so nothing could be looked up by
// the token a client presents. It is still keyed by phone (signing in twice replaces the
// older session), but an index from token to session is maintained alongside it.

const crypto = require('crypto');

const TTL_MS = Math.max(1, Number(process.env.SESSION_TTL_HOURS || 168)) * 60 * 60 * 1000;
const MAX_SESSIONS = Math.max(100, Number(process.env.SESSION_MAX || 50000));

const byPhone = Object.create(null);
const byToken = new Map();

function newToken() {
  // crypto.randomBytes, not Math.random: a predictable session token is a session that
  // can be guessed from a timestamp.
  return 'sess_' + Date.now() + '_' + crypto.randomBytes(24).toString('hex');
}

function isExpired(session) {
  const last = Number(session && (session.lastActive || session.loggedInAt)) || 0;
  return !last || Date.now() - last > TTL_MS;
}

function prune() {
  for (const [token, session] of byToken) {
    if (isExpired(session)) {
      byToken.delete(token);
      if (byPhone[session.phone] && byPhone[session.phone].sessionToken === token) {
        delete byPhone[session.phone];
      }
    }
  }
}

function index(phone, session) {
  if (!session || !session.sessionToken) return session;

  const previous = byPhone[phone];
  if (previous && previous.sessionToken && previous.sessionToken !== session.sessionToken) {
    byToken.delete(previous.sessionToken);
  }

  session.phone = String(phone);
  byToken.set(session.sessionToken, session);

  if (byToken.size > MAX_SESSIONS) prune();
  return session;
}

// A Proxy keeps every existing `activeUserSessions[phone] = {...}` assignment working
// while making sure the token index can never drift out of step with the phone map.
const sessionStore = new Proxy(byPhone, {
  set(target, phone, session) {
    if (typeof phone !== 'string') {
      target[phone] = session;
      return true;
    }
    target[phone] = index(phone, session);
    return true;
  },
  deleteProperty(target, phone) {
    const existing = target[phone];
    if (existing && existing.sessionToken) byToken.delete(existing.sessionToken);
    delete target[phone];
    return true;
  }
});

// Resolve a bearer token to a live session, sliding its expiry on each use.
function resolveSession(token) {
  if (!token) return null;
  const session = byToken.get(String(token));
  if (!session) return null;
  if (isExpired(session)) {
    byToken.delete(String(token));
    if (byPhone[session.phone] && byPhone[session.phone].sessionToken === token) {
      delete byPhone[session.phone];
    }
    return null;
  }
  session.lastActive = Date.now();
  return session;
}

function revokeSession(token) {
  const session = token ? byToken.get(String(token)) : null;
  if (!session) return false;
  byToken.delete(String(token));
  if (byPhone[session.phone] && byPhone[session.phone].sessionToken === session.sessionToken) {
    delete byPhone[session.phone];
  }
  return true;
}

function revokePhone(phone) {
  const session = byPhone[phone];
  if (session && session.sessionToken) byToken.delete(session.sessionToken);
  delete byPhone[phone];
  return Boolean(session);
}

function stats() {
  return { sessions: byToken.size, ttlHours: Math.round(TTL_MS / 3600000) };
}

// Periodic prune so an idle server does not accumulate dead sessions forever.
const sweeper = setInterval(prune, 10 * 60 * 1000);
if (typeof sweeper.unref === 'function') sweeper.unref();

module.exports = {
  store: sessionStore,
  byPhone,
  newToken,
  resolveSession,
  revokeSession,
  revokePhone,
  stats
};
