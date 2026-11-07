const { query } = require('../db/db');
const { runMistralChat } = require('./cloudflare_ai.service');
const { getLiveFeeSettings } = require('./commission.service');
const knowledge = require('../config/ai_domain_knowledge.json');

function getSalemOpsContact() {
  return {
    phone: process.env.SALEM_OPS_PHONE || knowledge.salem_ops.phone || '+918807099288',
    whatsapp: process.env.SALEM_OPS_WHATSAPP || knowledge.salem_ops.whatsapp || '+918807099288',
    email: process.env.SALEM_OPS_EMAIL || knowledge.salem_ops.email || 'support@shazuone.com',
    hours: process.env.SALEM_OPS_HOURS || knowledge.salem_ops.hours || '8:00 AM - 9:00 PM IST (All 7 Days)',
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
 * Strips any leaked SQL queries, developer instructions, or raw database enums
 */
function cleanHumanReply(text, ops, deterministicFallback = '') {
  if (!text) return deterministicFallback || '';
  // Strip code blocks with SQL or programming languages
  let cleaned = text.replace(/```[\s\S]*?```/gi, '');
  // Strip lines starting with SQL keywords
  cleaned = cleaned.replace(/^\s*(?:SELECT|UPDATE|INSERT|DELETE|FROM|WHERE|JOIN|GROUP BY|ORDER BY|LIMIT|HAVING)\b.*$/gim, '');
  // Strip developer phrases like "To check the booking status...", "Execute this query:", etc.
  cleaned = cleaned.replace(/(?:to\s+check\s+the\s+booking\s+status[^.]*you\s+can\s+use[^.]*query:?|this\s+query\s+will\s+return[^.]*customer\.?|here\s*(?:is|are)?\s*(?:the)?\s*(?:valid\s*)?(?:sql\s*)?quer(?:y|ies)|look\s*up\s*(?:the\s*status\s*of)?\s*(?:your\s*booking\s*with)?\s*(?:the\s*following)?|run\s*the\s*following\s*query|you\s*can\s*use\s*the\s*following\s*sql\s*query)[^.]*[:.]?/gi, '');
  cleaned = cleaned.replace(/\n{2,}/g, '\n\n').trim();

  // If text contains technical SQL leakage or is unhelpful, reject it and use deterministic fallback
  if (/(\b(?:sql\s+query|sql\s+queries|select\s+.*from|database\s+schema)\b)/i.test(cleaned)) {
    return deterministicFallback || `Your service request is active in our system. You can track live technician arrival and dispatch status directly on your Shazu One tracking screen, or connect with our Salem Operations desk at ${ops.phone}.`;
  }

  // Convert raw database enums into human friendly phrasing
  cleaned = cleaned.replace(/status\s+is\s+["']?created["']?/gi, 'service request is confirmed and awaiting technician assignment');
  cleaned = cleaned.replace(/status\s+is\s+["']?matching["']?/gi, 'service is currently matching the nearest verified specialist in Salem');
  cleaned = cleaned.replace(/status\s+is\s+["']?accepted["']?/gi, 'specialist has accepted your request and is preparing for your slot');
  cleaned = cleaned.replace(/status\s+is\s+["']?en_route["']?/gi, 'specialist is on the way to your doorstep');
  cleaned = cleaned.replace(/status\s+is\s+["']?arrived["']?/gi, 'specialist has arrived at your address');
  cleaned = cleaned.replace(/status\s+is\s+["']?inspecting["']?/gi, 'specialist is conducting the diagnostic inspection');
  cleaned = cleaned.replace(/status\s+is\s+["']?in_progress["']?/gi, 'service is actively in progress');
  cleaned = cleaned.replace(/status\s+is\s+["']?completed["']?/gi, 'service was successfully completed and closed');

  if (cleaned.length < 15) {
    return deterministicFallback || `Your service request is active in our system. You can track live technician arrival and dispatch status directly on your Shazu One tracking screen, or connect with our Salem Operations desk at ${ops.phone}.`;
  }
  return cleaned;
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
 * Formats a friendly, human-reassuring description of a booking status
 */
function describeBookingStatus(b) {
  if (!b) return 'No active booking found.';
  const techName = b.tech_name || 'Assigned Specialist';
  const techPhone = b.tech_phone ? `(${b.tech_phone})` : '';
  const serviceTitle = b.service_name || b.service_category || 'Home Service';
  const slotText = b.scheduled_slot || 'scheduled appointment slot';
  const localityText = b.locality || 'Salem';

  switch (b.status) {
    case 'created':
    case 'matching':
      return `Your booking #${b.id} for ${serviceTitle} in ${localityText} has been confirmed. Our Salem central dispatch desk is currently assigning the nearest verified specialist for your ${slotText}. You will receive a WhatsApp and SMS confirmation once your technician is dispatched.`;
    case 'accepted':
      return `Your booking #${b.id} is confirmed. Specialist ${techName} ${techPhone} has accepted your service request and is preparing for your appointment slot: ${slotText}.`;
    case 'en_route':
      return `Specialist ${techName} ${techPhone} is currently on the way to your doorstep at ${b.service_address || localityText}. Estimated arrival is prompt for your ${slotText}.`;
    case 'arrived':
    case 'inspecting':
      return `Specialist ${techName} ${techPhone} has arrived at your address in ${localityText} and is currently inspecting your ${serviceTitle}.`;
    case 'quote_presented':
      return `Specialist ${techName} has completed the diagnostic inspection and prepared a digital job estimate for booking #${b.id}. Please review and approve it on your tracking screen to begin repairs.`;
    case 'quote_approved':
      return `Estimate approved. Specialist ${techName} is actively completing the requested repairs for booking #${b.id}.`;
    case 'completed':
      return `Your recent booking #${b.id} for ${serviceTitle} was successfully completed by ${techName}. The service was verified on site before completion OTP release.`;
    case 'cancelled':
      return `Booking #${b.id} has been cancelled. For any refund tracking or billing questions, our Salem Operations team is happy to assist.`;
    default:
      return `Your booking #${b.id} is active and being monitored by our Salem central dispatch team.`;
  }
}

/**
 * Fetches real-time deterministic database context for the given user
 */
async function fetchUserLiveContext({ role, userId, userPhone, userName }) {
  const cleanPhone = (userPhone || '').replace(/[^0-9]/g, '').slice(-10);
  let bookings = [];
  let activeBooking = null;
  let lastCompletedBooking = null;
  let lastCancelledBooking = null;
  let technicianProfile = null;
  let recentTickets = [];
  let activeTicket = null;

  try {
    // 1. Fetch Recent Support Tickets for this User/Phone
    const tktRes = await query(`
      SELECT id, ticket_number, creator_name, subject, category, priority, status,
             admin_notes, resolution_summary, created_at, updated_at
      FROM support_tickets
      WHERE ((creator_id IS NOT NULL AND creator_id = $1)
             OR (length($2) = 10 AND creator_phone LIKE '%' || $2))
      ORDER BY created_at DESC
      LIMIT 3
    `, [userId, cleanPhone]);
    recentTickets = tktRes.rows || [];
    activeTicket = recentTickets.find(t => !['resolved', 'closed'].includes(t.status)) || recentTickets[0] || null;

    if (role === 'technician') {
      const tRes = await query(`
        SELECT t.id, t.full_name, t.phone, t.primary_trade as trade,
               COALESCE(t.assigned_localities[1], 'Salem') as locality,
               t.rating_avg, t.is_online,
               b.id as active_booking_id, b.status as active_booking_status, b.locality as job_locality,
               b.service_address as job_address, b.scheduled_slot as job_slot,
               b.customer_name, b.customer_phone
        FROM technicians t
        LEFT JOIN bookings b ON b.technician_id = t.id AND b.status IN ('accepted', 'en_route', 'arrived', 'inspecting', 'quote_presented', 'quote_approved', 'in_progress')
        WHERE (t.id::text = $1 OR (length($2) = 10 AND t.phone LIKE '%' || $2))
        LIMIT 1
      `, [userId, cleanPhone]);
      if (tRes.rows.length > 0) {
        technicianProfile = tRes.rows[0];
      }
    } else {
      // Customer: fetch last 3 bookings
      const bRes = await query(`
        SELECT b.id, b.status, b.locality, b.service_address, b.scheduled_slot,
               b.visit_fee, b.advance_amount_paid, b.final_amount, b.created_at, b.completed_at,
               COALESCE(s.name_en, s.category, 'Home Service') as service_name, s.category as service_category,
               t.full_name as tech_name, t.phone as tech_phone, t.rating_avg as tech_rating
        FROM bookings b
        LEFT JOIN services s ON b.service_id = s.id
        LEFT JOIN technicians t ON b.technician_id = t.id
        WHERE ((b.customer_id IS NOT NULL AND b.customer_id::text = $1)
               OR (length($2) = 10 AND b.customer_phone LIKE '%' || $2))
        ORDER BY b.created_at DESC
        LIMIT 3
      `, [userId, cleanPhone]);
      bookings = bRes.rows || [];
      activeBooking = bookings.find(b => !['completed', 'cancelled'].includes(b.status)) || null;
      lastCompletedBooking = bookings.find(b => b.status === 'completed') || null;
      lastCancelledBooking = bookings.find(b => b.status === 'cancelled') || null;
    }
  } catch (err) {
    console.warn('[Support Agent] Context fetch error:', err.message);
  }

  return {
    bookings,
    activeBooking,
    lastCompletedBooking,
    lastCancelledBooking,
    technicianProfile,
    recentTickets,
    activeTicket
  };
}

/**
 * Builds schema prompt for Mistral 7B Text-to-SQL (preserved for API & tests)
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

  // 2. Fetch deterministic real-time context from PostgreSQL
  const {
    bookings,
    activeBooking,
    lastCompletedBooking,
    lastCancelledBooking,
    technicianProfile,
    recentTickets,
    activeTicket
  } = await fetchUserLiveContext({
    role,
    userId,
    userPhone,
    userName
  });

  // 3. Prepare Human-Readable Account Context for LLM
  let contextDescription = '';
  if (role === 'technician') {
    if (technicianProfile) {
      contextDescription = `Technician Name: ${technicianProfile.full_name || userName}, Trade: ${technicianProfile.trade || 'Specialist'}, Locality: ${technicianProfile.locality || 'Salem'}, Rating: ${technicianProfile.rating_avg || '5.0'}, Online: ${technicianProfile.is_online ? 'Yes' : 'No'}.\n`;
      if (technicianProfile.active_booking_id) {
        contextDescription += `Current Active Job Assignment: Booking #${technicianProfile.active_booking_id}, Status: ${technicianProfile.active_booking_status}, Customer: ${technicianProfile.customer_name || 'Customer'} (${technicianProfile.customer_phone || ''}), Address: ${technicianProfile.job_address || technicianProfile.job_locality || 'Salem'}, Slot: ${technicianProfile.job_slot || 'Today'}.`;
      } else {
        contextDescription += `Active Job Assignments: NONE (0 active jobs). You are currently online and available to receive new dispatch requests in your trade.`;
      }
    } else {
      contextDescription = `No registered technician profile found for this ID/phone.`;
    }
  } else {
    // Customer
    if (activeBooking) {
      contextDescription = `Active In-Progress Booking:\n`;
      contextDescription += `- Booking ID: #${activeBooking.id}\n`;
      contextDescription += `- Service: ${activeBooking.service_name || activeBooking.service_category || 'Home Service'}\n`;
      contextDescription += `- Locality: ${activeBooking.locality || 'Salem'}\n`;
      contextDescription += `- Scheduled Slot: ${activeBooking.scheduled_slot || 'Confirmed Slot'}\n`;
      contextDescription += `- Live Status: ${describeBookingStatus(activeBooking)}\n`;
      if (activeBooking.tech_name) {
        contextDescription += `- Assigned Specialist: ${activeBooking.tech_name} (Phone: ${activeBooking.tech_phone || 'Protected'})\n`;
      } else {
        contextDescription += `- Assigned Specialist: Currently matching nearest verified technician in ${activeBooking.locality || 'Salem'}\n`;
      }
      contextDescription += `- Visit Fee Paid: ₹${activeBooking.advance_amount_paid || activeBooking.visit_fee || 99}\n`;
    } else if (lastCompletedBooking) {
      contextDescription = `Active Bookings: NONE (Customer has NO ongoing or pending service).\n`;
      contextDescription += `Most Recent Completed Service:\n`;
      contextDescription += `- Booking ID: #${lastCompletedBooking.id}\n`;
      contextDescription += `- Service: ${lastCompletedBooking.service_name || 'Home Service'}\n`;
      contextDescription += `- Status: COMPLETED & CLOSED\n`;
      contextDescription += `- Serviced By: Specialist ${lastCompletedBooking.tech_name || 'Verified Technician'}\n`;
      contextDescription += `- Final Amount Paid: ₹${lastCompletedBooking.final_amount || lastCompletedBooking.visit_fee || 99}\n`;
      contextDescription += `CRITICAL INSTRUCTION: This service is fully finished, verified on site, and closed. Do NOT state that a specialist is allotted or on the way. Confirm that the service was completed.\n`;
    } else if (lastCancelledBooking) {
      contextDescription = `Active Bookings: NONE.\nPast Booking #${lastCancelledBooking.id} was cancelled. Refund processed per policy.\n`;
    } else {
      contextDescription = `Customer ${userName} has no active or past bookings registered on this account.\n`;
    }

    if (activeTicket) {
      contextDescription += `\nRecent Support Ticket:\n`;
      contextDescription += `- Ticket Number: #${activeTicket.ticket_number || activeTicket.id}\n`;
      contextDescription += `- Subject: ${activeTicket.subject || 'Service Inquiry'}\n`;
      contextDescription += `- Status: ${activeTicket.status.toUpperCase()} (${knowledge.ticket_statuses[activeTicket.status] || 'Under Review'})\n`;
      if (activeTicket.resolution_summary) {
        contextDescription += `- Resolution Notes: ${activeTicket.resolution_summary}\n`;
      }
    }
  }

  // 4. Construct direct, factual prompt for Mistral 7B (Template-less & Concise)
  const systemPrompt = `You are "Ask AI", the direct and factual customer support assistant for Shazu One in Salem, Tamil Nadu.

Current User: ${userName} (Persona: ${role}, Phone: ${userPhone || 'Registered Account'})

Real-Time Account Context from Database:
${contextDescription}

Platform Guidelines & Policies:
1. Cancellation: Free cancellation is allowed only at least 24 hours prior to the scheduled slot. Within 24 hours of service, cancellation is locked to protect technician schedules. Customers with urgent emergencies must contact Salem Operations (${ops.phone}).
2. Warranty: No post-completion warranty is provided on workmanship or services. Customers must personally inspect and verify the repair before releasing the completion OTP to the technician. Any hardware spare parts carry manufacturer (OEM) warranties.
3. Arrival Times: Technicians arrive promptly for the confirmed scheduled slot. Do NOT make unrealistic 15-25 minute rapid arrival promises.
4. Technician Referral: Technician referral incentive is provided up to ₹100 per verified referral, subject to document verification and trade review (not a guaranteed flat ₹100).
5. Salem Operations Hotline: ${ops.phone} (Available ${ops.hours}).

CRITICAL STYLE & CONTENT INSTRUCTIONS:
- Answer in 1 to 2 direct, factual sentences.
- Absolutely NEVER use polite introductory padding or conversational filler (e.g. do NOT say "I would be happy to help", "I understand your excitement", "Thank you for asking").
- Immediately state the facts: the exact booking ID, live status, specialist arrival details, or ticket status.
- For completed services: State clearly that the service was successfully completed and is closed. No technician is currently allotted.
- For support tickets: State the ticket number, subject, and current status immediately.
- Never generate, explain, or mention SQL queries, SELECT commands, database tables, or programming code.
- Never use raw database enums like 'status is "created"' or 'status is "matching"'. Use the human descriptions in the Real-Time Context.
- Zero marketing fluff, zero long paragraphs. Strictly factual, direct, and reliable.`;

  const userPrompt = `User asks: "${trimmedQuery}". Please reply factually and concisely in 1 to 2 sentences based on the context above.`;

  const llmResult = await runMistralChat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    { maxTokens: 180, temperature: 0.2 }
  );

  // Construct deterministic reliable fallback for any outage or LLM hallucination
  let deterministicFallback = '';
  const isTicketQuery = /ticket|complaint|issue|support\s*case/i.test(trimmedQuery);
  if (isTicketQuery && activeTicket) {
    deterministicFallback = `Your support ticket #${activeTicket.ticket_number || activeTicket.id} (${activeTicket.subject || 'Service inquiry'}) is currently ${activeTicket.status.toUpperCase()}. Salem Operations is actively tracking your request.`;
  } else if (activeBooking) {
    deterministicFallback = `${describeBookingStatus(activeBooking)} Confirmed slot: ${activeBooking.scheduled_slot || 'Today'}.`;
  } else if (lastCompletedBooking) {
    deterministicFallback = `Your service #${lastCompletedBooking.id} for ${lastCompletedBooking.service_name || 'Home Service'} was completed by Specialist ${lastCompletedBooking.tech_name || 'Verified Technician'}. You have no active technician allotted right now.`;
  } else if (technicianProfile) {
    deterministicFallback = technicianProfile.active_booking_id
      ? `You have an active dispatch #${technicianProfile.active_booking_id} in ${technicianProfile.job_locality || 'Salem'}.`
      : `You have 0 active job assignments right now and are ready to receive new dispatch requests.`;
  } else {
    deterministicFallback = `You have no active bookings on this account. You can schedule a verified technician anytime on our home screen, or reach Salem Operations at ${ops.phone}.`;
  }

  let finalReply = '';

  if (llmResult.success && llmResult.response) {
    // Clean any stray code, SQL mentions, or prompt leakage
    finalReply = cleanHumanReply(llmResult.response, ops, deterministicFallback);
  }

  // If Cloudflare AI was unavailable or reply was discarded, use the direct deterministic fallback
  if (!finalReply || finalReply.length < 15) {
    finalReply = deterministicFallback;
  }

  return {
    success: true,
    reply: finalReply,
    activeBooking: activeBooking ? {
      id: activeBooking.id,
      status: activeBooking.status,
      locality: activeBooking.locality,
      technicianName: activeBooking.tech_name,
      technicianPhone: activeBooking.tech_phone,
      scheduledSlot: activeBooking.scheduled_slot,
      serviceName: activeBooking.service_name
    } : null,
    recentCompletedBooking: (!activeBooking && lastCompletedBooking) ? {
      id: lastCompletedBooking.id,
      status: 'completed',
      serviceName: lastCompletedBooking.service_name,
      technicianName: lastCompletedBooking.tech_name,
      finalAmount: lastCompletedBooking.final_amount || lastCompletedBooking.visit_fee || 99,
      completedAt: lastCompletedBooking.completed_at
    } : null,
    recentTicket: activeTicket ? {
      id: activeTicket.id,
      ticketNumber: activeTicket.ticket_number || activeTicket.id,
      subject: activeTicket.subject,
      category: activeTicket.category,
      priority: activeTicket.priority,
      status: activeTicket.status,
      resolutionSummary: activeTicket.resolution_summary
    } : null,
    booking: activeBooking ? {
      id: activeBooking.id,
      status: activeBooking.status,
      locality: activeBooking.locality,
      technicianName: activeBooking.tech_name,
      technicianPhone: activeBooking.tech_phone
    } : null,
    escalateToOps: false,
    opsContact: ops
  };
}

module.exports = {
  getSalemOpsContact,
  isHumanEscalationRequest,
  validateAndSanitizeQuery,
  handleSupportQuery,
  describeBookingStatus
};
