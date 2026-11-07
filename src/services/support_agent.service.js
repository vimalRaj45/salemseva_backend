const { query } = require('../db/db');
const { runMistralChat } = require('./cloudflare_ai.service');

function getSalemOpsContact() {
  return {
    phone: process.env.SALEM_OPS_PHONE || '+918807099288',
    whatsapp: process.env.SALEM_OPS_WHATSAPP || '+918807099288',
    email: process.env.SALEM_OPS_EMAIL || 'support@shazuone.com',
    hours: process.env.SALEM_OPS_HOURS || '8:00 AM - 9:00 PM IST (All 7 Days)',
    emergencyHotline: '+91 88070 99288',
    whatsappUrl: `https://wa.me/${(process.env.SALEM_OPS_WHATSAPP || '918807099288').replace(/[^0-9]/g, '')}?text=${encodeURIComponent('Hello Shazu One Salem Ops Support, I need assistance with my service.')}`
  };
}

/**
 * Checks if user query explicitly asks for human support / phone / whatsapp / escalation
 */
function isHumanEscalationRequest(queryText = '') {
  const q = String(queryText || '').toLowerCase();
  const escalationKeywords = [
    'human', 'agent', 'call', 'phone', 'whatsapp', 'talk to someone',
    'speak to person', 'ops', 'manager', 'escalate', 'contact number',
    'helpline', 'customer care', 'support team', 'complaint', 'refund dispute',
    'cheated', 'emergency'
  ];
  return escalationKeywords.some(kw => q.includes(kw));
}

/**
 * Validates that an SQL query is strictly read-only SELECT and contains tenant boundaries
 * @param {string} rawSql
 * @param {'customer'|'technician'} role
 * @param {string} userId
 * @returns {{isValid: boolean, sanitizedSql?: string, error?: string}}
 */
function validateAndSanitizeQuery(rawSql, role, userId) {
  if (!rawSql || typeof rawSql !== 'string') {
    return { isValid: false, error: 'No SQL query provided' };
  }

  const clean = rawSql.trim().replace(/;+$/, '').trim();

  // 1. Must start with SELECT
  if (!/^SELECT\b/i.test(clean)) {
    return { isValid: false, error: 'Only SELECT queries are permitted' };
  }

  // 2. Reject destructive and administrative keywords
  const forbiddenPatterns = [
    /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|EXEC|EXECUTE|CREATE|GRANT|REVOKE|COPY)\b/i,
    /--/,
    /\/\*/,
    /;/,
    /\b(pg_|information_schema)\b/i,
    /\b(UNION\s+ALL|UNION)\b/i
  ];

  for (const pattern of forbiddenPatterns) {
    if (pattern.test(clean)) {
      return { isValid: false, error: `Forbidden SQL syntax detected (${pattern.toString()})` };
    }
  }

  // 3. Role-based table whitelist
  const customerAllowedTables = ['bookings', 'payments', 'support_tickets', 'services'];
  const technicianAllowedTables = ['bookings', 'payments', 'technicians', 'daily_job_capacity', 'services'];
  const allowedTables = role === 'technician' ? technicianAllowedTables : customerAllowedTables;

  // Extract table names after FROM / JOIN
  const tableMatches = clean.match(/\b(FROM|JOIN)\s+([a-zA-Z0-9_]+)/gi) || [];
  for (const match of tableMatches) {
    const tableName = match.replace(/^(FROM|JOIN)\s+/i, '').trim().toLowerCase();
    if (!allowedTables.includes(tableName)) {
      return { isValid: false, error: `Access to table '${tableName}' is restricted for ${role} persona` };
    }
  }

  // 4. Enforce tenant boundary
  const hasCustomerBoundary = /customer_id|customer_phone/i.test(clean);
  const hasTechBoundary = /technician_id|\btechnicians\.id\b/i.test(clean);

  if (role === 'customer' && !hasCustomerBoundary && !clean.toLowerCase().includes('from services')) {
    return { isValid: false, error: 'Customer queries must be scoped to customer_id or customer_phone' };
  }

  if (role === 'technician' && !hasTechBoundary && !clean.toLowerCase().includes('from services')) {
    return { isValid: false, error: 'Technician queries must be scoped to technician_id' };
  }

  // 5. Enforce LIMIT 10 if not present or greater
  let finalSql = clean;
  if (!/\bLIMIT\s+\d+/i.test(finalSql)) {
    finalSql = `${finalSql} LIMIT 10`;
  }

  return {
    isValid: true,
    sanitizedSql: finalSql
  };
}

/**
 * Builds schema prompt for Mistral 7B Text-to-SQL
 */
function buildSchemaPrompt(role, userId, userPhone) {
  const ops = getSalemOpsContact();

  if (role === 'technician') {
    return `You are the Shazu One Technician AI Operations Assistant.
You assist service technicians in Salem with their job assignments, schedules, customer details, and payout statuses.

Database Schema (PostgreSQL):
- bookings (id, service_id, status, scheduled_slot, locality, address, customer_name, customer_phone, visit_fee_paid, final_total_amount, is_urgent_dispatch, created_at) WHERE technician_id = '${userId}'
- technicians (id, name, phone, trade, locality, rating, is_online, is_kyc_verified, daily_job_capacity, max_daily_capacity) WHERE id = '${userId}'
- payments (id, booking_id, amount_total, tech_payout_amount, status, verification_status, created_at) WHERE booking_id IN (SELECT id FROM bookings WHERE technician_id = '${userId}')
- daily_job_capacity (technician_id, work_date, current_assigned_jobs, max_allowed_jobs, is_active) WHERE technician_id = '${userId}'
- services (id, name, category, base_price)

RULES:
1. Always scope queries to technician_id = '${userId}'.
2. Write only valid PostgreSQL SELECT queries. Do not include markdown codeblocks or quotes if generating SQL.
3. If the technician asks about jobs, bookings, or money, provide concise facts.
4. If they ask about technician referral incentive: Explain that an incentive of UP TO ₹100 is provided per verified technician referral, subject to document verification and trade review (it is not a guaranteed flat ₹100).
5. If they need admin escalation or manager override, refer them to Salem Ops Helpline ${ops.phone}.`;
  }

  // Customer Schema
  return `You are the Shazu One Customer AI Support Assistant.
You assist customers in Salem with their home service bookings, payment confirmations, technician status, and service inquiries.

Database Schema (PostgreSQL):
- bookings (id, service_id, status, scheduled_slot, locality, address, visit_fee_paid, final_total_amount, payment_status, created_at) WHERE customer_id = '${userId}' OR customer_phone = '${userPhone || ''}'
- payments (id, booking_id, amount_total, status, payment_method, verification_status, customer_utr, created_at) WHERE booking_id IN (SELECT id FROM bookings WHERE customer_id = '${userId}' OR customer_phone = '${userPhone || ''}')
- support_tickets (id, booking_id, subject, issue_description, status, priority, resolution_notes, created_at) WHERE user_id = '${userId}'
- services (id, name, category, base_price, description)

RULES:
1. Always scope queries to customer_id = '${userId}' OR customer_phone = '${userPhone || ''}'.
2. Write only valid PostgreSQL SELECT queries. Do not include markdown codeblocks if generating SQL.
3. If they ask about cancellation: Cancellations are strictly permitted ONLY at least 24 hours prior to the scheduled service appointment. Within 24 hours of service, self-serve cancellation is locked, and the customer must contact Salem Operations Helpline ${ops.phone}.
4. WARRANTY POLICY: Absolutely NO post-service warranty is provided on completed services or workmanship. Customers inspect and verify the repair on site before releasing the completion OTP. Spare parts carry original manufacturer (OEM) warranties where applicable.
5. ARRIVAL SPEED: Do NOT promise arrival within 15-25 minutes. Technicians arrive according to the confirmed scheduled slot or prompt doorstep dispatch.
6. If they ask to speak to human/support or need urgent manual assistance, provide Salem Ops Helpline ${ops.phone}.`;
}

/**
 * Primary Support Agent Query Handler
 */
async function handleSupportQuery({
  queryText,
  role = 'customer',
  userId = 'guest',
  userPhone = '',
  userName = 'User'
}) {
  const ops = getSalemOpsContact();
  const trimmedQuery = String(queryText || '').trim();

  if (!trimmedQuery) {
    return {
      success: true,
      reply: 'Please ask a question or tap the microphone to speak with our AI support.',
      escalateToOps: false,
      opsContact: ops
    };
  }

  // 1. Check for immediate explicit escalation
  if (isHumanEscalationRequest(trimmedQuery)) {
    return {
      success: true,
      reply: `Our Salem Operations Support Team is available to assist you directly. You can call or message our hotline anytime between ${ops.hours}.`,
      escalateToOps: true,
      opsContact: ops
    };
  }

  // 2. Generate SQL or policy response using Mistral 7B
  const schemaSystemPrompt = buildSchemaPrompt(role, userId, userPhone);

  const queryGenMessages = [
    { role: 'system', content: schemaSystemPrompt },
    {
      role: 'user',
      content: `The user asked: "${trimmedQuery}".
If this question requires fetching database records, output ONLY a single valid SELECT query.
If this question is a general greeting or platform policy inquiry (e.g. warranty, working hours, pricing), output a direct helpful answer without SQL.`
    }
  ];

  const llmResult = await runMistralChat(queryGenMessages, { maxTokens: 256, temperature: 0.1 });

  // If Cloudflare AI quota is exhausted or failed, gracefully fall back to Salem Ops
  if (!llmResult.success) {
    console.warn('[Support Agent] Cloudflare AI unavailable, falling back to Ops contact:', llmResult.error);
    return {
      success: true,
      reply: 'Our AI support assistant is currently at high demand. Our dedicated Salem Operations team is standing by to help you directly right now.',
      escalateToOps: true,
      creditExhausted: Boolean(llmResult.creditExhausted),
      opsContact: ops
    };
  }

  const rawOutput = (llmResult.response || '').trim();

  // 3. Check if LLM output is a SELECT query
  const sqlMatch = rawOutput.match(/(?:SELECT\b[\s\S]+)/i);

  if (sqlMatch) {
    const candidateSql = sqlMatch[0].replace(/```sql|```/gi, '').trim();
    const guardCheck = validateAndSanitizeQuery(candidateSql, role, userId);

    if (guardCheck.isValid) {
      try {
        console.log(`[Support Agent] Executing safe scoped query: ${guardCheck.sanitizedSql}`);
        const dbResult = await query(guardCheck.sanitizedSql);
        const records = dbResult.rows || [];

        // 4. Synthesize natural answer from records
        const answerMessages = [
          {
            role: 'system',
            content: `You are the Shazu One Support Assistant for ${role}s in Salem. Summarize the following database results clearly, warmly, and concisely for ${userName}. Do not show raw SQL.`
          },
          {
            role: 'user',
            content: `User query: "${trimmedQuery}".
Database query results: ${JSON.stringify(records.slice(0, 5))}.
Please provide a helpful, natural response to the user.`
          }
        ];

        const answerResult = await runMistralChat(answerMessages, { maxTokens: 350, temperature: 0.3 });

        if (answerResult.success && answerResult.response) {
          return {
            success: true,
            reply: answerResult.response.trim(),
            dataSnapshot: records.slice(0, 3),
            escalateToOps: false,
            opsContact: ops
          };
        }
      } catch (dbErr) {
        console.warn('[Support Agent] DB query execution failed:', dbErr.message);
      }
    } else {
      console.warn('[Support Agent] SQL Guard rejected candidate query:', guardCheck.error);
    }
  }

  // 5. Default natural reply or friendly fallback
  return {
    success: true,
    reply: rawOutput || 'I found your service request. For any urgent changes or direct dispatcher assistance, our Salem Operations team is available.',
    escalateToOps: false,
    opsContact: ops
  };
}

module.exports = {
  getSalemOpsContact,
  isHumanEscalationRequest,
  validateAndSanitizeQuery,
  handleSupportQuery
};
