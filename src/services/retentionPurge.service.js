const { query } = require('../db/db');
const { deleteFromS3 } = require('./storage.service');

const CLOSED_BOOKING_STATUSES = ['completed', 'cancelled', 'refunded', 'rejected', 'inspection_only'];

function parsePositiveInt(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Purges ephemeral operational data (old closed-booking chats & S3 voice notes,
 * expired OTPs, old read/stale notifications, stale push/FCM tokens, and old
 * rejected lead logs) while preserving financial, booking, payout, review, and legal records.
 */
async function runPurgeCycle(options = {}) {
  const chatDays = parsePositiveInt(options.chatDays ?? process.env.PURGE_CHAT_DAYS, 7);
  const notifReadDays = parsePositiveInt(options.notifReadDays ?? process.env.PURGE_NOTIF_READ_DAYS, 14);
  const notifDays = parsePositiveInt(options.notifDays ?? process.env.PURGE_NOTIF_DAYS, 30);
  const tokenDays = parsePositiveInt(options.tokenDays ?? process.env.PURGE_TOKEN_DAYS, 90);
  const rejectedLeadDays = parsePositiveInt(options.rejectedLeadDays ?? process.env.PURGE_REJECTED_LEAD_DAYS, 30);
  const dryRun = Boolean(options.dryRun);

  const summary = {
    dryRun,
    retentionDays: { chatDays, notifReadDays, notifDays, tokenDays, rejectedLeadDays },
    deleted: {
      chatMessages: 0,
      chatAudioObjects: 0,
      otps: 0,
      notifications: 0,
      fcmTokens: 0,
      pushSubscriptions: 0,
      rejectedLeads: 0
    },
    ranAt: new Date().toISOString()
  };

  // 1. Purge chat_messages (+ S3 voice notes) for bookings closed longer than chatDays
  try {
    const oldChatsRes = await query(
      `
        SELECT cm.id, cm.attachment_url
        FROM chat_messages cm
        INNER JOIN bookings b ON b.id = cm.booking_id
        WHERE b.status::text = ANY($1::text[])
          AND COALESCE(b.completed_at, b.created_at) < NOW() - ($2::text || ' days')::interval
          AND cm.created_at < NOW() - ($2::text || ' days')::interval
      `,
      [CLOSED_BOOKING_STATUSES, String(chatDays)]
    );

    const rows = oldChatsRes.rows || [];
    summary.deleted.chatMessages = rows.length;

    if (!dryRun && rows.length > 0) {
      for (const row of rows) {
        if (row.attachment_url) {
          const delRes = await deleteFromS3(row.attachment_url);
          if (delRes.deleted) summary.deleted.chatAudioObjects += 1;
        }
      }
      const ids = rows.map(r => r.id);
      await query('DELETE FROM chat_messages WHERE id = ANY($1::int[])', [ids]);
    }
  } catch (err) {
    console.warn('[AutoPurge] chat_messages purge skipped:', err.message);
  }

  // 2. Purge expired or already-used OTPs
  try {
    if (dryRun) {
      const r = await query(`
        SELECT COUNT(*)::int AS cnt FROM otp_verifications
        WHERE expires_at < NOW() - INTERVAL '1 hour'
           OR (verified = TRUE AND created_at < NOW() - INTERVAL '24 hours')
      `);
      summary.deleted.otps = r.rows[0]?.cnt || 0;
    } else {
      const r = await query(`
        DELETE FROM otp_verifications
        WHERE expires_at < NOW() - INTERVAL '1 hour'
           OR (verified = TRUE AND created_at < NOW() - INTERVAL '24 hours')
      `);
      summary.deleted.otps = r.rowCount || 0;
    }
  } catch (err) {
    console.warn('[AutoPurge] otp_verifications purge skipped:', err.message);
  }

  // 3. Purge old user_notifications (read > 14d, any > 30d)
  try {
    if (dryRun) {
      const r = await query(
        `
          SELECT COUNT(*)::int AS cnt FROM user_notifications
          WHERE (is_read = TRUE AND created_at < NOW() - ($1::text || ' days')::interval)
             OR created_at < NOW() - ($2::text || ' days')::interval
        `,
        [String(notifReadDays), String(notifDays)]
      );
      summary.deleted.notifications = r.rows[0]?.cnt || 0;
    } else {
      const r = await query(
        `
          DELETE FROM user_notifications
          WHERE (is_read = TRUE AND created_at < NOW() - ($1::text || ' days')::interval)
             OR created_at < NOW() - ($2::text || ' days')::interval
        `,
        [String(notifReadDays), String(notifDays)]
      );
      summary.deleted.notifications = r.rowCount || 0;
    }
  } catch (err) {
    console.warn('[AutoPurge] user_notifications purge skipped:', err.message);
  }

  // 4. Purge stale FCM & Web Push tokens not refreshed in tokenDays
  try {
    if (dryRun) {
      const r = await query(
        `SELECT COUNT(*)::int AS cnt FROM fcm_tokens WHERE updated_at < NOW() - ($1::text || ' days')::interval`,
        [String(tokenDays)]
      );
      summary.deleted.fcmTokens = r.rows[0]?.cnt || 0;
    } else {
      const r = await query(
        `DELETE FROM fcm_tokens WHERE updated_at < NOW() - ($1::text || ' days')::interval`,
        [String(tokenDays)]
      );
      summary.deleted.fcmTokens = r.rowCount || 0;
    }
  } catch (err) {
    console.warn('[AutoPurge] fcm_tokens purge skipped:', err.message);
  }

  try {
    if (dryRun) {
      const r = await query(
        `SELECT COUNT(*)::int AS cnt FROM push_subscriptions WHERE updated_at < NOW() - ($1::text || ' days')::interval`,
        [String(tokenDays)]
      );
      summary.deleted.pushSubscriptions = r.rows[0]?.cnt || 0;
    } else {
      const r = await query(
        `DELETE FROM push_subscriptions WHERE updated_at < NOW() - ($1::text || ' days')::interval`,
        [String(tokenDays)]
      );
      summary.deleted.pushSubscriptions = r.rowCount || 0;
    }
  } catch (err) {
    console.warn('[AutoPurge] push_subscriptions purge skipped:', err.message);
  }

  // 5. Purge old technician_rejected_leads entries
  try {
    if (dryRun) {
      const r = await query(
        `SELECT COUNT(*)::int AS cnt FROM technician_rejected_leads WHERE rejected_at < NOW() - ($1::text || ' days')::interval`,
        [String(rejectedLeadDays)]
      );
      summary.deleted.rejectedLeads = r.rows[0]?.cnt || 0;
    } else {
      const r = await query(
        `DELETE FROM technician_rejected_leads WHERE rejected_at < NOW() - ($1::text || ' days')::interval`,
        [String(rejectedLeadDays)]
      );
      summary.deleted.rejectedLeads = r.rowCount || 0;
    }
  } catch (err) {
    console.warn('[AutoPurge] technician_rejected_leads purge skipped:', err.message);
  }

  return summary;
}

let schedulerStarted = false;

function startAutoPurgeScheduler() {
  if (schedulerStarted) return;
  if (process.env.AUTO_PURGE_ENABLED === 'false') {
    console.log('[AutoPurge] Disabled via AUTO_PURGE_ENABLED=false');
    return;
  }
  schedulerStarted = true;

  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  const runSafely = async () => {
    try {
      const res = await runPurgeCycle();
      const total = Object.values(res.deleted).reduce((acc, n) => acc + (n || 0), 0);
      if (total > 0) {
        console.log('[AutoPurge] Cycle completed:', JSON.stringify(res.deleted));
      }
    } catch (err) {
      console.warn('[AutoPurge] Cycle warning:', err.message);
    }
  };

  setTimeout(runSafely, 30 * 1000).unref();
  setInterval(runSafely, SIX_HOURS_MS).unref();
}

module.exports = {
  runPurgeCycle,
  startAutoPurgeScheduler,
  CLOSED_BOOKING_STATUSES
};
