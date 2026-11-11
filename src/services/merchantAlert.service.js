const crypto = require('crypto');

function normalizeBookingRef(rawRef) {
  if (!rawRef) return null;
  return String(rawRef).trim().replace(/-(?:ADV|FIN)$/i, '').toUpperCase();
}

/**
 * Parses a Bank Credit Email Alert (subject/body or title/text) into structured credit data.
 */
function parseMerchantNotification({ title = '', text = '', subject = '', body = '', from = '', appName = '' } = {}) {
  const headline = String(subject || title || '').trim();
  const details = String(body || text || '').trim();
  const combined = `${headline} ${details}`.trim();
  const sourceApp = appName === 'bank_csv' ? 'bank_csv' : 'bank_email';

  if (!combined) {
    return { isCredit: false, reason: 'empty_notification', sourceApp };
  }

  const looksDebit = /\b(debited|sent\s+to|paid\s+to|transferred\s+to|withdrawn)\b/i.test(combined);
  const looksCredit = /\b(received|credited|credit\s+alert|deposited|payment\s+of|received\s+rs|received\s+₹|cr\b)\b/i.test(combined);

  if (looksDebit && !looksCredit) {
    return { isCredit: false, reason: 'debit_notification_ignored', sourceApp };
  }

  const amountPatterns = [
    /(?:₹|Rs\.?|INR)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i,
    /\b(?:credited|received|amount)\s*(?:with|of|by|:)?\s*(?:₹|Rs\.?|INR)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\b/i
  ];
  let amount = null;
  for (const pat of amountPatterns) {
    const m = combined.match(pat);
    if (m && m[1]) {
      const parsed = parseFloat(m[1].replace(/,/g, ''));
      if (Number.isFinite(parsed) && parsed > 0) {
        amount = parsed;
        break;
      }
    }
  }

  if (amount === null) {
    return { isCredit: false, reason: 'amount_not_detected', sourceApp };
  }

  const utrPatterns = [
    /(?:UPI\s*Ref(?:\s*No)?|UTR(?:\s*No)?|Ref(?:\s*No)?|Txn\s*ID|Transaction\s*ID|RRN|UPI\/)[\s.:=#\/\-]*([0-9]{12})/i,
    /\b([0-9]{12})\b/
  ];
  let utr = null;
  for (const pat of utrPatterns) {
    const m = combined.match(pat);
    if (m && m[1] && /^\d{12}$/.test(m[1])) {
      utr = m[1];
      break;
    }
  }

  const refMatch = combined.match(/\b((?:SLM|SCHED|BK|ORD|TEMP)[-_A-Z0-9]{4,36})\b/i);
  const bookingRef = refMatch ? normalizeBookingRef(refMatch[1]) : null;

  const hashBasis = utr
    ? `${amount.toFixed(2)}|utr|${utr}`
    : `${sourceApp}|${amount.toFixed(2)}|${bookingRef || combined.toLowerCase().slice(0, 120)}`;
  const alertHash = crypto.createHash('sha256').update(hashBasis).digest('hex');

  return {
    isCredit: true,
    sourceApp,
    amount,
    utr,
    bookingRef,
    senderLabel: String(from || headline || '').trim().slice(0, 180) || null,
    rawMessage: combined.slice(0, 1000),
    alertHash
  };
}

/**
 * Splits a single CSV line handling double-quoted fields (e.g. "1,250.00").
 */
function splitCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseNumericAmount(raw) {
  if (raw == null) return 0;
  const cleaned = String(raw).replace(/[₹,\s]/g, '').replace(/(?:INR|RS\.?|CR|DR)$/i, '');
  const val = parseFloat(cleaned);
  return Number.isFinite(val) ? val : 0;
}

/**
 * Parses an Indian bank statement CSV into credit rows { rowIndex, amount, utr, bookingRef, rawLine }.
 * Supports Credit/Deposit + Debit/Withdrawal columns or Cr/Dr type column.
 */
function parseBankStatementCsv(csvText = '') {
  const lines = String(csvText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) return [];

  // Locate header row (handles bank preamble lines before actual column headers)
  let headerIdx = -1;
  let headers = [];
  for (let i = 0; i < Math.min(lines.length, 25); i++) {
    const cols = splitCsvLine(lines[i]).map((c) => c.toLowerCase());
    const hasAmountCol = cols.some((c) => /(credit|deposit|amount|amt|cr\b)/.test(c));
    const hasContextCol = cols.some((c) => /(date|narration|description|particular|remark|ref|utr)/.test(c));
    if (hasAmountCol && hasContextCol) {
      headerIdx = i;
      headers = cols;
      break;
    }
  }

  if (headerIdx === -1) {
    headerIdx = 0;
    headers = splitCsvLine(lines[0]).map((c) => c.toLowerCase());
  }

  const findCol = (re) => headers.findIndex((h) => re.test(h));
  const creditCol = findCol(/\b(credit|deposit|cr\s*amt|credit\s*amount)\b/);
  const debitCol = findCol(/\b(debit|withdrawal|dr\s*amt|debit\s*amount)\b/);
  const amountCol = creditCol >= 0 ? creditCol : findCol(/\b(amount|amt|value)\b/);
  const typeCol = findCol(/\b(type|cr\/dr|dr\/cr|txn\s*type)\b/);
  const utrCol = findCol(/\b(utr|ref|reference|chq|txn\s*id|transaction\s*id)\b/);

  const credits = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const rowCols = splitCsvLine(lines[i]);
    if (rowCols.length === 0) continue;

    let amount = 0;
    if (creditCol >= 0) {
      amount = parseNumericAmount(rowCols[creditCol]);
      const debitVal = debitCol >= 0 ? parseNumericAmount(rowCols[debitCol]) : 0;
      if (amount <= 0 || (debitVal > 0 && amount === 0)) continue;
    } else if (amountCol >= 0) {
      const rawAmt = String(rowCols[amountCol] || '');
      if (/\bdr\b/i.test(rawAmt)) continue;
      if (typeCol >= 0 && /\b(dr|debit|withdrawal)\b/i.test(String(rowCols[typeCol] || ''))) continue;
      amount = parseNumericAmount(rawAmt);
      if (amount <= 0) continue;
    } else {
      continue;
    }

    const joined = rowCols.join(' ');
    const explicitUtrField = utrCol >= 0 ? String(rowCols[utrCol] || '') : '';
    const utrMatch =
      explicitUtrField.match(/\b([0-9]{12})\b/) ||
      joined.match(/(?:UPI\/|UTR[\s:=-]*|Ref[\s:=-]*)([0-9]{12})/i) ||
      joined.match(/\b([0-9]{12})\b/);
    const utr = utrMatch ? utrMatch[1] : null;

    const refMatch = joined.match(/\b((?:SLM|SCHED|BK|ORD|TEMP)[-_A-Z0-9]{4,36})\b/i);
    const bookingRef = refMatch ? normalizeBookingRef(refMatch[1]) : null;

    if (!utr && !bookingRef) continue;

    credits.push({
      rowIndex: i + 1,
      amount,
      utr,
      bookingRef,
      rawLine: joined.slice(0, 500)
    });
  }

  return credits;
}

async function ensureMerchantAlertsSchema(queryFn) {
  await queryFn(`
    CREATE TABLE IF NOT EXISTS merchant_credit_alerts (
      id SERIAL PRIMARY KEY,
      source_app VARCHAR(80),
      amount NUMERIC(10,2) NOT NULL,
      utr VARCHAR(64),
      booking_ref VARCHAR(120),
      sender_label VARCHAR(200),
      raw_message TEXT,
      alert_hash VARCHAR(64) UNIQUE,
      matched_payment_id INT NULL,
      matched_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

async function promotePaymentWithAlert(
  queryFn,
  { paymentId, alertId, utr, bookingId, verifiedByLabel = 'AUTO_BANK_EMAIL_ALERT', auditEvent = 'AUTO_BANK_EMAIL_VERIFIED' }
) {
  const claimRes = await queryFn(
    `
      UPDATE merchant_credit_alerts
      SET matched_payment_id = $1, matched_at = NOW()
      WHERE id = $2 AND matched_payment_id IS NULL
      RETURNING id
    `,
    [paymentId, alertId]
  );

  if (!claimRes.rows || claimRes.rows.length === 0) {
    return { verified: false, reason: 'alert_already_claimed' };
  }

  const payUpdate = await queryFn(
    `
      UPDATE payments
      SET verification_status = 'verified',
          verified_by = $3,
          verified_at = NOW(),
          status = '._held',
          ocr_detected_utr = COALESCE(ocr_detected_utr, $2)
      WHERE id = $1
      RETURNING *
    `,
    [paymentId, utr || null, verifiedByLabel]
  );

  try {
    await queryFn(
      `
        INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
        VALUES ($1, $2, $3, 'system', $4)
      `,
      [
        bookingId || payUpdate.rows?.[0]?.booking_id || 'PAYMENT',
        auditEvent,
        verifiedByLabel,
        JSON.stringify({ paymentId, alertId, utr: utr || null })
      ]
    );
  } catch (e) { }

  return {
    verified: true,
    payment: payUpdate.rows?.[0] || null
  };
}

/**
 * Stores an incoming bank email credit alert and auto-verifies matching pending/tech_confirmed QR payment.
 */
async function processIncomingMerchantAlert(
  queryFn,
  payload,
  log = console,
  options = {}
) {
  const parsed = parseMerchantNotification(payload);
  if (!parsed.isCredit) {
    return { stored: false, matched: false, reason: parsed.reason, parsed };
  }

  const verifiedByLabel = options.verifiedByLabel || 'AUTO_BANK_EMAIL_ALERT';
  const auditEvent = options.auditEvent || 'AUTO_BANK_EMAIL_VERIFIED';

  let alertRow = null;
  const insRes = await queryFn(
    `
      INSERT INTO merchant_credit_alerts (
        source_app, amount, utr, booking_ref, sender_label, raw_message, alert_hash
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (alert_hash) DO NOTHING
      RETURNING *
    `,
    [
      parsed.sourceApp,
      parsed.amount,
      parsed.utr,
      parsed.bookingRef,
      parsed.senderLabel,
      parsed.rawMessage,
      parsed.alertHash
    ]
  );

  let duplicate = false;
  if (insRes.rows && insRes.rows.length > 0) {
    alertRow = insRes.rows[0];
  } else {
    duplicate = true;
    const existingRes = await queryFn(
      `SELECT * FROM merchant_credit_alerts WHERE alert_hash = $1 LIMIT 1`,
      [parsed.alertHash]
    );
    alertRow = existingRes.rows?.[0] || null;
  }

  if (!alertRow) {
    return { stored: false, matched: false, reason: 'insert_failed' };
  }

  if (alertRow.matched_payment_id) {
    return {
      stored: !duplicate,
      duplicate,
      matched: true,
      alert: alertRow,
      matchedPaymentId: alertRow.matched_payment_id
    };
  }

  if (!parsed.utr && !parsed.bookingRef) {
    return { stored: !duplicate, duplicate, matched: false, alert: alertRow, reason: 'awaiting_utr_match' };
  }

  const candRes = await queryFn(
    `
      SELECT id, booking_id, amount_total, customer_utr, verification_status
      FROM payments
      WHERE payment_method = 'DYNAMIC_UPI_QR'
        AND COALESCE(verification_status, 'pending') IN ('pending', 'tech_confirmed')
        AND ABS(COALESCE(amount_total, 0) - $1) <= 0.50
        AND (
          ($2::text IS NOT NULL AND REGEXP_REPLACE(COALESCE(customer_utr, ''), '\\s', '', 'g') = $2)
          OR ($3::text IS NOT NULL AND UPPER(REGEXP_REPLACE(COALESCE(booking_id, ''), '-(?:ADV|FIN)$', '', 'i')) = $3)
        )
      ORDER BY
        CASE WHEN ($2::text IS NOT NULL AND REGEXP_REPLACE(COALESCE(customer_utr, ''), '\\s', '', 'g') = $2) THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT 1
    `,
    [parsed.amount, parsed.utr || null, parsed.bookingRef || null]
  );

  if (!candRes.rows || candRes.rows.length === 0) {
    return { stored: !duplicate, duplicate, matched: false, alert: alertRow, reason: 'no_pending_payment_yet' };
  }

  const payment = candRes.rows[0];
  const promoted = await promotePaymentWithAlert(queryFn, {
    paymentId: payment.id,
    alertId: alertRow.id,
    utr: parsed.utr,
    bookingId: payment.booking_id,
    verifiedByLabel,
    auditEvent
  });

  if (log && typeof log.info === 'function' && promoted.verified) {
    log.info(`Verified payment #${payment.id} (${payment.booking_id}) via ${verifiedByLabel}`);
  }

  return {
    stored: !duplicate,
    duplicate,
    matched: promoted.verified,
    alert: alertRow,
    payment: promoted.payment,
    matchedPaymentId: promoted.verified ? payment.id : null
  };
}

/**
 * Checks whether an unmatched bank email / CSV alert already arrived for a newly submitted payment.
 */
async function claimMatchingAlertForPayment(queryFn, { paymentId, bookingId, amount, utr }) {
  if (!paymentId || !Number.isFinite(Number(amount))) {
    return { matched: false };
  }

  const cleanUtr = utr ? String(utr).trim().replace(/\s+/g, '') : null;
  const normRef = normalizeBookingRef(bookingId);

  if (!cleanUtr && !normRef) {
    return { matched: false };
  }

  const alertRes = await queryFn(
    `
      SELECT *
      FROM merchant_credit_alerts
      WHERE matched_payment_id IS NULL
        AND ABS(COALESCE(amount, 0) - $1) <= 0.50
        AND created_at >= NOW() - INTERVAL '48 hours'
        AND (
          ($2::text IS NOT NULL AND utr = $2)
          OR ($3::text IS NOT NULL AND booking_ref = $3)
        )
      ORDER BY
        CASE WHEN ($2::text IS NOT NULL AND utr = $2) THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT 1
    `,
    [Number(amount), cleanUtr || null, normRef || null]
  );

  if (!alertRes.rows || alertRes.rows.length === 0) {
    return { matched: false };
  }

  const alert = alertRes.rows[0];
  const isCsv = alert.source_app === 'bank_csv';
  const promoted = await promotePaymentWithAlert(queryFn, {
    paymentId,
    alertId: alert.id,
    utr: alert.utr || cleanUtr,
    bookingId,
    verifiedByLabel: isCsv ? 'BANK_CSV_RECONCILED' : 'AUTO_BANK_EMAIL_ALERT',
    auditEvent: isCsv ? 'BANK_CSV_PAYMENT_VERIFIED' : 'AUTO_BANK_EMAIL_VERIFIED'
  });

  return {
    matched: promoted.verified,
    alert,
    payment: promoted.payment
  };
}

/**
 * Bulk-reconciles an uploaded end-of-day Bank Statement CSV against pending / tech_confirmed QR payments.
 */
async function reconcileBankCsvRows(queryFn, csvText, verifiedByAdmin = 'BANK_CSV_RECONCILED', log = console) {
  const creditRows = parseBankStatementCsv(csvText);
  let matchedCount = 0;
  let duplicateOrAlreadyMatched = 0;
  let unmatchedCount = 0;
  const verifiedPayments = [];

  for (const row of creditRows) {
    const res = await processIncomingMerchantAlert(
      queryFn,
      {
        appName: 'bank_csv',
        title: `Bank CSV Credit ₹${row.amount.toFixed(2)}`,
        text: `${row.rawLine} ${row.utr ? `UTR ${row.utr}` : ''} ${row.bookingRef || ''}`
      },
      log,
      {
        verifiedByLabel: 'BANK_CSV_RECONCILED',
        auditEvent: 'BANK_CSV_PAYMENT_VERIFIED'
      }
    );

    if (res.matched) {
      if (res.duplicate && !res.payment) {
        duplicateOrAlreadyMatched++;
      } else {
        matchedCount++;
        if (res.payment) verifiedPayments.push(res.payment);
      }
    } else if (res.duplicate) {
      duplicateOrAlreadyMatched++;
    } else {
      unmatchedCount++;
    }
  }

  return {
    validCreditRows: creditRows.length,
    matchedCount,
    duplicateOrAlreadyMatched,
    unmatchedCount,
    verifiedPayments
  };
}

module.exports = {
  normalizeBookingRef,
  parseMerchantNotification,
  parseBankEmailAlert: parseMerchantNotification,
  parseBankStatementCsv,
  ensureMerchantAlertsSchema,
  processIncomingMerchantAlert,
  claimMatchingAlertForPayment,
  reconcileBankCsvRows
};
