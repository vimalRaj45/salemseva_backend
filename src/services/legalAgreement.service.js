const crypto = require('crypto');
const { query } = require('../db/db');

function cleanPhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

// Canonical Legal Texts and SHA-256 Hash Generation
const CUSTOMER_TERMS_TEXT = `
Shazu One Customer Service Terms & Intermediary Disclaimer (Version 1.0.0)

1. Platform Nature and Intermediary Status:
Shazu One functions exclusively as an electronic intermediary under Section 79 of the Information Technology Act, 2000, read with the Information Technology (Intermediary Guidelines and Digital Media Ethics Code) Rules, 2021. Shazu One provides digital infrastructure connecting consumers residing in Salem, Tamil Nadu, with certified, independent service professionals. Shazu One does not directly employ technicians.

2. Diagnostic Visit & Inspection Fee:
Customer acknowledges that a fixed doorstep inspection visitation fee applies for the professional diagnostic visit. If service or replacement work is required, the technician presents a digital quotation. Work commences only upon explicit customer approval.

3. Cancellation and Refund Policy:
Customers may reschedule or cancel visits in accordance with the platform cancellation policy. Diagnostic inspection charges apply once a technician partner arrives on site.

4. Safety, Privacy and Dispute Resolution:
Shazu One adheres to the Digital Personal Data Protection Act and Section 43A of the IT Act. All transactions and disputes are subject to the exclusive jurisdiction of the competent courts in Salem, Tamil Nadu.
`.trim();

const TECHNICIAN_PARTNER_AGREEMENT_TEXT = `
Shazu One Independent Technician Partner Agreement (Version 1.0.0)

1. Independent Contractor Relationship:
The Partner enters into this agreement as an independent contractor and skilled service provider. Nothing in this agreement creates an employer-employee, master-servant, or partnership relationship between Shazu One and the Partner.

2. Service Quality, KYC Verification & Licensing:
The Partner agrees to maintain valid Aadhaar identity verification, trade competencies, and local certifications. The Partner cannot receive customer dispatch leads or go online until Shazu One Central Operations completes KYC review and grants operational verification.

3. Platform Facilitation Fee & Payout Settlement:
The Partner agrees to the transparent platform fee model and direct UPI payout disbursement structure for completed home service jobs in Salem.

4. Code of Conduct, Safety & Non-Solicitation:
The Partner agrees to maintain the highest standards of safety, honesty, and professional etiquette at customer premises. Direct off-platform customer poaching or cash diversion is strictly prohibited and subject to immediate administrative suspension.

5. Legal Admissibility & Jurisdiction:
This electronic agreement is executed pursuant to Section 10A of the Information Technology Act, 2000. All matters arising hereunder are subject to arbitration and the courts in Salem, Tamil Nadu.
`.trim();

const CUSTOMER_TERMS_HASH = crypto.createHash('sha256').update(CUSTOMER_TERMS_TEXT).digest('hex');
const TECH_AGREEMENT_HASH = crypto.createHash('sha256').update(TECHNICIAN_PARTNER_AGREEMENT_TEXT).digest('hex');

const ACTIVE_DOCUMENTS = {
  customer_terms: {
    type: 'customer_terms',
    version: '1.0.0',
    title: 'Customer Service Terms & Intermediary Disclaimer',
    summary: 'Transparent doorstep diagnostic pricing, quote-approval controls, and Salem local mediation.',
    content: CUSTOMER_TERMS_TEXT,
    contentHash: CUSTOMER_TERMS_HASH,
    effectiveDate: '2026-10-15T00:00:00.000Z',
    requiredCheckboxes: [
      { id: 'terms_acknowledged', label: 'I accept the Shazu One Customer Service Terms and Intermediary Disclaimer.' },
      { id: 'inspection_fee_acknowledged', label: 'I understand the doorstep diagnostic visitation fee is charged for technician evaluation.' },
      { id: 'quote_approval_acknowledged', label: 'I understand additional repair work requires my explicit quote approval.' }
    ]
  },
  technician_partner_agreement: {
    type: 'technician_partner_agreement',
    version: '1.0.0',
    title: 'Independent Technician Partner Agreement',
    summary: 'Independent contractor status, transparent platform commission, KYC compliance, and customer safety standards.',
    content: TECHNICIAN_PARTNER_AGREEMENT_TEXT,
    contentHash: TECH_AGREEMENT_HASH,
    effectiveDate: '2026-10-15T00:00:00.000Z',
    requiredCheckboxes: [
      { id: 'independent_contractor', label: 'I acknowledge I am an independent skilled service professional, not an employee.' },
      { id: 'commission_acknowledged', label: 'I agree to the transparent platform commission and direct payout settlement rules.' },
      { id: 'safety_and_conduct', label: 'I agree to strictly abide by customer safety, privacy, and non-solicitation guidelines.' }
    ]
  }
};

class LegalAgreementService {
  getActiveDocument(documentType) {
    const doc = ACTIVE_DOCUMENTS[documentType];
    if (!doc) {
      throw new Error(`Unknown legal document type: ${documentType}`);
    }
    return doc;
  }

  // Fail-closed verification directly against Neon PostgreSQL
  async hasAcceptedActiveDocument({ phone, role = 'customer', documentType }) {
    const normalizedPhone = cleanPhone(phone);
    if (!normalizedPhone) {
      return {
        accepted: false,
        reason: 'missing_identity',
        error: 'Phone number is required to verify legal agreement acceptance'
      };
    }

    const docType = documentType || (role === 'technician' ? 'technician_partner_agreement' : 'customer_terms');
    const activeDoc = this.getActiveDocument(docType);

    try {
      // 1. Direct match on current active version
      const activeRes = await query(`
        SELECT id, document_version, document_hash, accepted_at
        FROM legal_acceptances
        WHERE user_phone = $1 AND document_type = $2 AND document_version = $3
        LIMIT 1
      `, [normalizedPhone, docType, activeDoc.version]);

      if (activeRes.rows && activeRes.rows.length > 0) {
        const row = activeRes.rows[0];
        return {
          accepted: true,
          documentType: docType,
          version: row.document_version,
          acceptedAt: row.accepted_at,
          activeVersion: activeDoc.version
        };
      }

      // 2. Check if user accepted an older superseded version
      const olderRes = await query(`
        SELECT document_version, accepted_at
        FROM legal_acceptances
        WHERE user_phone = $1 AND document_type = $2
        ORDER BY accepted_at DESC
        LIMIT 1
      `, [normalizedPhone, docType]);

      if (olderRes.rows && olderRes.rows.length > 0) {
        return {
          accepted: false,
          reason: 'version_superseded',
          acceptedVersion: olderRes.rows[0].document_version,
          requiredVersion: activeDoc.version,
          documentType: docType,
          redirectUrl: `/terms?mode=accept&role=${role}`
        };
      }

      return {
        accepted: false,
        reason: 'not_accepted',
        requiredVersion: activeDoc.version,
        documentType: docType,
        redirectUrl: `/terms?mode=accept&role=${role}`
      };
    } catch (dbErr) {
      // Fail closed: Database error blocks protected operation
      console.error('[Legal Agreement Service Fail-Closed] DB error:', dbErr.message);
      return {
        accepted: false,
        reason: 'database_unavailable',
        error: 'Legal compliance verification is temporarily unavailable. Please retry.'
      };
    }
  }

  // Idempotent acceptance recording in Neon PostgreSQL
  async recordAcceptance({ phone, userPhone, role, userRole, documentType, version, documentVersion, documentHash, ip, ipAddress, userAgent }) {
    const rawPhone = phone || userPhone;
    const normalizedPhone = cleanPhone(rawPhone);
    if (!normalizedPhone) {
      return { success: false, error: 'Valid 10-digit phone number is required' };
    }

    const resolvedRole = role || userRole || 'customer';
    const docType = documentType || (resolvedRole === 'technician' ? 'technician_partner_agreement' : 'customer_terms');
    const activeDoc = this.getActiveDocument(docType);

    const targetVersion = version || documentVersion || activeDoc.version;
    const targetHash = documentHash || activeDoc.contentHash;
    const resolvedIp = ip || ipAddress || '127.0.0.1';

    if (targetVersion !== activeDoc.version) {
      return {
        success: false,
        error: `Submitted version (${targetVersion}) does not match currently active version (${activeDoc.version})`
      };
    }

    if (targetHash !== activeDoc.contentHash) {
      return {
        success: false,
        error: 'Submitted document hash does not match canonical document hash'
      };
    }

    try {
      const insertSql = `
        INSERT INTO legal_acceptances (
          user_phone, user_role, document_type, document_version, document_hash, ip_address, user_agent, accepted_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
        ON CONFLICT (user_phone, document_type, document_version)
        DO UPDATE SET accepted_at = CURRENT_TIMESTAMP
        RETURNING *;
      `;

      const res = await query(insertSql, [
        normalizedPhone,
        resolvedRole,
        docType,
        activeDoc.version,
        activeDoc.contentHash,
        resolvedIp ? String(resolvedIp).slice(0, 64) : null,
        userAgent ? String(userAgent).slice(0, 500) : null
      ]);

      // Record in platform audit_logs
      try {
        await query(`
          INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
          VALUES ($1, 'LEGAL_AGREEMENT_ACCEPTED', $2, $3, $4)
        `, [
          `LEGAL-${normalizedPhone}`,
          normalizedPhone,
          role,
          JSON.stringify({
            documentType: docType,
            version: activeDoc.version,
            hash: activeDoc.contentHash,
            ip: ip || null,
            timestamp: new Date().toISOString()
          })
        ]);
      } catch (auditErr) {
        // Non-blocking for audit log
      }

      return {
        success: true,
        message: 'Legal agreement acceptance successfully recorded in Neon PostgreSQL',
        record: res.rows[0],
        documentType: docType,
        version: activeDoc.version
      };
    } catch (err) {
      console.error('[Legal Agreement Record Error]:', err.message);
      return { success: false, error: err.message };
    }
  }

  // Pre-handler guard for Customer Bookings
  async guardCustomerBooking({ phone }) {
    const status = await this.hasAcceptedActiveDocument({ phone, role: 'customer', documentType: 'customer_terms' });
    if (!status.accepted) {
      return {
        allowed: false,
        statusCode: 403,
        code: 'LEGAL_AGREEMENT_REQUIRED',
        error: 'You must review and accept the Shazu One Customer Service Terms before reserving a booking.',
        details: {
          reason: status.reason,
          documentType: 'customer_terms',
          requiredVersion: status.requiredVersion || '1.0.0',
          redirectUrl: `/terms?mode=accept&role=customer`
        }
      };
    }
    return { allowed: true, version: status.version };
  }

  // Pre-handler guard for Technician Operations
  async guardTechnicianOperation({ phone, techRow = null }) {
    const normalizedPhone = cleanPhone(phone);
    const status = await this.hasAcceptedActiveDocument({ phone: normalizedPhone, role: 'technician', documentType: 'technician_partner_agreement' });

    if (!status.accepted) {
      return {
        allowed: false,
        statusCode: 403,
        code: 'AGREEMENT_REQUIRED',
        error: 'You must accept the Shazu One Independent Technician Partner Agreement before proceeding.',
        details: {
          reason: status.reason,
          documentType: 'technician_partner_agreement',
          requiredVersion: status.requiredVersion || '1.0.0',
          redirectUrl: `/terms?mode=accept&role=technician`
        }
      };
    }

    // Require separate admin KYC approval
    if (techRow) {
      if (techRow.is_blocked) {
        return {
          allowed: false,
          statusCode: 403,
          code: 'ACCOUNT_SUSPENDED',
          error: `Your partner account has been suspended: ${techRow.block_reason || 'Administrative restriction'}.`
        };
      }

      if (!techRow.is_kyc_verified) {
        return {
          allowed: false,
          statusCode: 403,
          code: 'KYC_PENDING',
          error: 'KYC Verification Pending: You cannot perform duty operations until your documents are verified by Shazu One Central Operations.'
        };
      }
    }

    return { allowed: true, version: status.version };
  }
}

module.exports = new LegalAgreementService();
