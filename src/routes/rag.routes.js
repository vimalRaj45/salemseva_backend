const { query } = require('../db/db');

const SALEM_LOCALITIES = [
  'Fairlands', 'Hasthampatti', 'Suramangalam', 'Ammapet',
  'Shevapet', 'Gugai', 'Alagapuram', 'Meyyanur',
  'Kondalampatti', 'Kannankurichi', 'Gorimedu', 'Steel Plant Area'
];

const TRADES = ['ac', 'electrician', 'plumber', 'cleaning'];

function sanitizeInput(str = '') {
  return String(str || '').trim();
}

async function ragRoutes(fastify, options) {
  // POST /admin/rag/query - Intelligent schema RAG retrieval for operations copilot
  fastify.post('/admin/rag/query', async (req, reply) => {
    try {
      const { query: rawQuery = '', filterScope = 'all' } = req.body || {};
      const queryText = sanitizeInput(rawQuery);

      if (!queryText) {
        return reply.status(400).send({
          success: false,
          error: 'Please enter a search query or question.'
        });
      }

      // 1. Entity & Intent Extraction
      const phoneMatch = queryText.match(/(?:\+91[\-\s]?)?[6-9]\d{9}\b/);
      const extractedPhone = phoneMatch ? phoneMatch[0].replace(/[^0-9]/g, '').slice(-10) : null;

      const uuidMatch = queryText.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
      const extractedUuid = uuidMatch ? uuidMatch[0] : null;

      const slmMatch = queryText.match(/SLM-[A-Za-z0-9\-]+/i);
      const extractedSlm = slmMatch ? slmMatch[0] : null;

      const detectedLocality = SALEM_LOCALITIES.find(loc => 
        new RegExp(`\\b${loc}\\b`, 'i').test(queryText)
      ) || null;

      const detectedTrade = TRADES.find(tr => 
        new RegExp(`\\b${tr}\\b`, 'i').test(queryText)
      ) || null;

      const lower = queryText.toLowerCase();
      const isBookingIntent = lower.includes('booking') || lower.includes('job') || lower.includes('order') || lower.includes('trip') || extractedSlm || extractedUuid;
      const isTechIntent = lower.includes('tech') || lower.includes('partner') || lower.includes('mechanic') || lower.includes('kyc') || lower.includes('fleet');
      const isCustomerIntent = lower.includes('customer') || lower.includes('user') || lower.includes('client');
      const isPaymentIntent = lower.includes('pay') || lower.includes('qr') || lower.includes('escrow') || lower.includes('settle') || lower.includes('utr') || lower.includes('disburse');
      const isTicketIntent = lower.includes('ticket') || lower.includes('complaint') || lower.includes('support') || lower.includes('issue') || lower.includes('review');

      const searchTerm = `%${queryText.replace(/[%_]/g, '')}%`;
      const searchWords = queryText.split(/\s+/).filter(w => w.length > 2 && !['the', 'and', 'for', 'all', 'show', 'need', 'this', 'with', 'from'].includes(w.toLowerCase()));
      const primaryKeyword = searchWords[0] ? `%${searchWords[0]}%` : searchTerm;

      const results = {
        bookings: [],
        customers: [],
        technicians: [],
        payments: [],
        tickets: [],
        metrics: {}
      };

      // 2. Fetch System Snapshot KPIs
      try {
        const [bMetrics, tMetrics, pMetrics] = await Promise.all([
          query(`SELECT 
                   COUNT(*)::int as total,
                   COUNT(CASE WHEN status = 'unassigned' OR status = 'pending' THEN 1 END)::int as unassigned,
                   COUNT(CASE WHEN status = 'in_progress' OR status = 'en_route' THEN 1 END)::int as active_now
                 FROM bookings`),
          query(`SELECT 
                   COUNT(*)::int as total,
                   COUNT(CASE WHEN is_kyc_verified = FALSE THEN 1 END)::int as pending_kyc,
                   COUNT(CASE WHEN is_online = TRUE THEN 1 END)::int as online_now
                 FROM technicians`),
          query(`SELECT 
                   COUNT(CASE WHEN verification_status = 'pending' THEN 1 END)::int as pending_qr
                 FROM payments`)
        ]);
        results.metrics = {
          totalBookings: bMetrics.rows[0]?.total || 0,
          unassignedBookings: bMetrics.rows[0]?.unassigned || 0,
          activeTrips: bMetrics.rows[0]?.active_now || 0,
          totalTechnicians: tMetrics.rows[0]?.total || 0,
          pendingKycTechs: tMetrics.rows[0]?.pending_kyc || 0,
          onlineTechnicians: tMetrics.rows[0]?.online_now || 0,
          pendingQrVerifications: pMetrics.rows[0]?.pending_qr || 0
        };
      } catch (_) {}

      // 3. Query Bookings
      if (filterScope === 'all' || filterScope === 'bookings' || isBookingIntent || extractedPhone || extractedUuid) {
        try {
          const bRes = await query(`
            SELECT b.id, b.service_id, b.status, b.locality, b.scheduled_slot,
                   b.final_total_amount, b.created_at, b.customer_phone,
                   u.full_name as customer_name,
                   t.full_name as technician_name, t.phone as technician_phone
            FROM bookings b
            LEFT JOIN users u ON u.id = b.customer_id
            LEFT JOIN technicians t ON t.id = b.technician_id
            WHERE ($1::text IS NOT NULL AND b.id::text = $1)
               OR ($2::text IS NOT NULL AND RIGHT(REGEXP_REPLACE(b.customer_phone, '[^0-9]', '', 'g'), 10) = $2)
               OR ($3::text IS NOT NULL AND LOWER(b.locality) LIKE LOWER($3))
               OR ($4::text IS NOT NULL AND LOWER(b.service_id) = LOWER($4))
               OR ($5::text IS NOT NULL AND (u.full_name ILIKE $5 OR b.locality ILIKE $5 OR b.customer_phone ILIKE $5))
            ORDER BY b.created_at DESC
            LIMIT 15
          `, [
            extractedUuid || extractedSlm,
            extractedPhone,
            detectedLocality ? `%${detectedLocality}%` : null,
            detectedTrade,
            primaryKeyword
          ]);
          results.bookings = bRes.rows;
        } catch (e) {
          fastify.log.warn('RAG bookings query note:', e.message);
        }
      }

      // 4. Query Customers
      if (filterScope === 'all' || filterScope === 'customers' || isCustomerIntent || extractedPhone) {
        try {
          const cRes = await query(`
            SELECT id, full_name, phone, email, role, locality, default_address,
                   referral_code, referred_by, created_at,
                   (SELECT COUNT(*)::int FROM bookings WHERE customer_id = users.id OR RIGHT(REGEXP_REPLACE(customer_phone, '[^0-9]', '', 'g'), 10) = RIGHT(REGEXP_REPLACE(users.phone, '[^0-9]', '', 'g'), 10)) as booking_count
            FROM users
            WHERE role = 'customer'
              AND (
                ($1::text IS NOT NULL AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $1)
                OR ($2::text IS NOT NULL AND (full_name ILIKE $2 OR locality ILIKE $2 OR email ILIKE $2 OR referral_code ILIKE $2))
              )
            ORDER BY created_at DESC
            LIMIT 10
          `, [extractedPhone, primaryKeyword]);
          results.customers = cRes.rows;
        } catch (e) {
          fastify.log.warn('RAG customers query note:', e.message);
        }
      }

      // 5. Query Technicians Fleet
      if (filterScope === 'all' || filterScope === 'technicians' || isTechIntent || lower.includes('kyc') || detectedTrade) {
        try {
          const kycFilter = lower.includes('pending') && lower.includes('kyc');
          const tRes = await query(`
            SELECT id, full_name, phone, email, primary_trade, secondary_trades,
                   is_kyc_verified, is_online, rating_avg, rating_count,
                   jobs_completed_count, star_tier, assigned_localities, created_at
            FROM technicians
            WHERE ($1::boolean IS TRUE AND is_kyc_verified = FALSE)
               OR (
                 ($2::text IS NOT NULL AND primary_trade = $2)
                 OR ($3::text IS NOT NULL AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $3)
                 OR ($4::text IS NOT NULL AND (full_name ILIKE $4 OR primary_trade ILIKE $4))
               )
            ORDER BY created_at DESC
            LIMIT 10
          `, [
            kycFilter,
            detectedTrade,
            extractedPhone,
            primaryKeyword
          ]);
          results.technicians = tRes.rows;
        } catch (e) {
          fastify.log.warn('RAG technicians query note:', e.message);
        }
      }

      // 6. Query Payments / Escrow
      if (filterScope === 'all' || filterScope === 'payments' || isPaymentIntent || lower.includes('qr') || lower.includes('utr')) {
        try {
          const pRes = await query(`
            SELECT id, booking_id, customer_phone, amount, payment_method,
                   customer_utr, verification_status, status, rejection_reason, created_at
            FROM payments
            WHERE ($1::text IS NOT NULL AND RIGHT(REGEXP_REPLACE(customer_phone, '[^0-9]', '', 'g'), 10) = $1)
               OR ($2::text IS NOT NULL AND (customer_utr ILIKE $2 OR customer_phone ILIKE $2))
               OR (verification_status = 'pending')
            ORDER BY created_at DESC
            LIMIT 10
          `, [extractedPhone, primaryKeyword]);
          results.payments = pRes.rows;
        } catch (e) {
          fastify.log.warn('RAG payments query note:', e.message);
        }
      }

      // 7. Query Support Tickets
      if (filterScope === 'all' || filterScope === 'tickets' || isTicketIntent) {
        try {
          const tkRes = await query(`
            SELECT id, ticket_number, customer_phone, issue_type, priority,
                   status, description, resolution_notes, created_at
            FROM support_tickets
            WHERE ($1::text IS NOT NULL AND RIGHT(REGEXP_REPLACE(customer_phone, '[^0-9]', '', 'g'), 10) = $1)
               OR ($2::text IS NOT NULL AND (ticket_number ILIKE $2 OR description ILIKE $2))
               OR (status = 'open' OR status = 'in_progress')
            ORDER BY created_at DESC
            LIMIT 10
          `, [extractedPhone, primaryKeyword]);
          results.tickets = tkRes.rows;
        } catch (e) {
          fastify.log.warn('RAG tickets query note:', e.message);
        }
      }

      // 8. Generate Fast Action Links
      const suggestedActions = [];

      if (results.bookings.length > 0) {
        const topB = results.bookings[0];
        suggestedActions.push({
          label: `Open Live Dispatch Queue (${results.bookings.length} jobs)`,
          tab: 'ops',
          filter: topB.customer_name || topB.customer_phone || topB.locality || '',
          bookingId: topB.id
        });
      }

      if (results.customers.length > 0) {
        const topC = results.customers[0];
        suggestedActions.push({
          label: `View Customer Dossier: ${topC.full_name || topC.phone}`,
          tab: 'customers',
          search: topC.phone || topC.full_name,
          customerId: topC.id
        });
      }

      if (results.technicians.length > 0) {
        const topT = results.technicians[0];
        suggestedActions.push({
          label: `Inspect Technician Fleet: ${topT.full_name || topT.primary_trade}`,
          tab: 'technicians',
          filter: topT.full_name || topT.primary_trade,
          techId: topT.id
        });
      }

      if (results.payments.length > 0) {
        suggestedActions.push({
          label: `Review Settlements & QR Verifications (${results.payments.length})`,
          tab: 'settlements',
          filter: 'pending'
        });
      }

      if (results.tickets.length > 0) {
        suggestedActions.push({
          label: `Inspect Support Desk (${results.tickets.length} tickets)`,
          tab: 'tickets',
          filter: results.tickets[0].ticket_number || ''
        });
      }

      // 9. Format Clean Context for Puter.js LLM
      const contextBlocks = [];

      if (results.bookings.length > 0) {
        contextBlocks.push(
          `Bookings (${results.bookings.length}):\n` +
          results.bookings.map(b => 
            `- ID: ${b.id.slice(0, 8)}... | Status: ${b.status} | Locality: ${b.locality} | Service: ${b.service_id} | Amount: INR ${b.final_total_amount || 0} | Customer: ${b.customer_name || 'N/A'} (${b.customer_phone || 'N/A'}) | Tech: ${b.technician_name || 'Unassigned'}`
          ).join('\n')
        );
      }

      if (results.customers.length > 0) {
        contextBlocks.push(
          `Customers (${results.customers.length}):\n` +
          results.customers.map(c => 
            `- Name: ${c.full_name} | Phone: ${c.phone} | Locality: ${c.locality} | Total Bookings: ${c.booking_count}`
          ).join('\n')
        );
      }

      if (results.technicians.length > 0) {
        contextBlocks.push(
          `Technicians (${results.technicians.length}):\n` +
          results.technicians.map(t => 
            `- Name: ${t.full_name} | Phone: ${t.phone} | Trade: ${t.primary_trade} | KYC: ${t.is_kyc_verified ? 'Verified' : 'PENDING'} | Online: ${t.is_online ? 'YES' : 'NO'} | Rating: ${t.rating_avg} (${t.jobs_completed_count} jobs)`
          ).join('\n')
        );
      }

      if (results.payments.length > 0) {
        contextBlocks.push(
          `Payments (${results.payments.length}):\n` +
          results.payments.map(p => 
            `- ID: ${p.id.slice(0, 8)}... | Amount: INR ${p.amount} | Method: ${p.payment_method} | UTR: ${p.customer_utr || 'None'} | Verification: ${p.verification_status}`
          ).join('\n')
        );
      }

      if (results.tickets.length > 0) {
        contextBlocks.push(
          `Support Tickets (${results.tickets.length}):\n` +
          results.tickets.map(tk => 
            `- Ticket: ${tk.ticket_number} | Priority: ${tk.priority} | Status: ${tk.status} | Issue: ${tk.issue_type} | Customer: ${tk.customer_phone}`
          ).join('\n')
        );
      }

      const ragContext = contextBlocks.length > 0 
        ? contextBlocks.join('\n\n')
        : 'No specific matching database records found for this query in Salem Seva.';

      return {
        success: true,
        query: queryText,
        extracted: {
          phone: extractedPhone,
          uuid: extractedUuid,
          slm: extractedSlm,
          locality: detectedLocality,
          trade: detectedTrade
        },
        metrics: results.metrics,
        data: results,
        ragContext,
        suggestedActions
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({
        success: false,
        error: 'RAG search query execution error.'
      });
    }
  });
}

module.exports = ragRoutes;
