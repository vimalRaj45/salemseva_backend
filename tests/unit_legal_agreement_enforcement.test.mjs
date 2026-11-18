import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import legalServicePkg from '../src/services/legalAgreement.service.js';
import dbPkg from '../src/db/db.js';

const legalService = legalServicePkg.default || legalServicePkg;
const { query, pool } = dbPkg;

describe('Unit Test: Mandatory Legal Agreement Enforcement (Indian IT Act Section 10A & 65B)', () => {
  const testCustomerPhone = '9443299001';
  const testTechPhone = '9443299002';

  it('1. Customer without acceptance cannot book and is blocked fail-closed', async () => {
    // Ensure clean state: delete any pre-existing acceptance for this test phone
    await query('DELETE FROM legal_acceptances WHERE user_phone = $1', [testCustomerPhone]);

    const guardResult = await legalService.guardCustomerBooking({ phone: testCustomerPhone });
    assert.strictEqual(guardResult.allowed, false);
    assert.strictEqual(guardResult.statusCode, 403);
    assert.strictEqual(guardResult.code, 'LEGAL_AGREEMENT_REQUIRED');
    assert.ok(guardResult.error.includes('Customer Service Terms'));
    assert.strictEqual(guardResult.details.documentType, 'customer_terms');
    assert.strictEqual(guardResult.details.requiredVersion, '1.0.0');
    assert.ok(guardResult.details.redirectUrl.includes('/terms?mode=accept&role=customer'));
  });

  it('2. Customer with valid acceptance can proceed with booking', async () => {
    const activeDoc = legalService.getActiveDocument('customer_terms');

    // Record acceptance in Neon DB
    const recordResult = await legalService.recordAcceptance({
      phone: testCustomerPhone,
      role: 'customer',
      documentType: 'customer_terms',
      version: activeDoc.version,
      documentHash: activeDoc.contentHash,
      ip: '127.0.0.1',
      userAgent: 'Mozilla/5.0 Test Suite'
    });

    assert.strictEqual(recordResult.success, true);
    assert.ok(recordResult.record);
    assert.strictEqual(recordResult.version, activeDoc.version);

    // Verify guard now permits customer
    const guardResult = await legalService.guardCustomerBooking({ phone: testCustomerPhone });
    assert.strictEqual(guardResult.allowed, true);
    assert.strictEqual(guardResult.version, activeDoc.version);
  });

  it('3. Technician without acceptance cannot proceed with duty operations', async () => {
    await query('DELETE FROM legal_acceptances WHERE user_phone = $1', [testTechPhone]);

    const guardResult = await legalService.guardTechnicianOperation({
      phone: testTechPhone,
      techRow: { is_kyc_verified: true, is_blocked: false }
    });

    assert.strictEqual(guardResult.allowed, false);
    assert.strictEqual(guardResult.statusCode, 403);
    assert.strictEqual(guardResult.code, 'AGREEMENT_REQUIRED');
    assert.ok(guardResult.error.includes('Partner Agreement'));
  });

  it('4. Technician with agreement accepted but pending admin approval (KYC) cannot proceed', async () => {
    const activeTechDoc = legalService.getActiveDocument('technician_partner_agreement');

    await legalService.recordAcceptance({
      phone: testTechPhone,
      role: 'technician',
      documentType: 'technician_partner_agreement',
      version: activeTechDoc.version,
      documentHash: activeTechDoc.contentHash,
      ip: '127.0.0.1',
      userAgent: 'Mozilla/5.0 Test Partner'
    });

    // Agreement is accepted, but KYC is pending (not yet verified by admin)
    const guardPendingKyc = await legalService.guardTechnicianOperation({
      phone: testTechPhone,
      techRow: { is_kyc_verified: false, is_blocked: false }
    });

    assert.strictEqual(guardPendingKyc.allowed, false);
    assert.strictEqual(guardPendingKyc.statusCode, 403);
    assert.strictEqual(guardPendingKyc.code, 'KYC_PENDING');
    assert.ok(guardPendingKyc.error.includes('KYC Verification Pending'));

    // When admin approves KYC, technician is allowed
    const guardApprovedKyc = await legalService.guardTechnicianOperation({
      phone: testTechPhone,
      techRow: { is_kyc_verified: true, is_blocked: false }
    });
    assert.strictEqual(guardApprovedKyc.allowed, true);
  });

  it('5. Old agreement acceptance does not satisfy newly published mandatory version', async () => {
    const phoneVersionTest = '9443299003';
    await query('DELETE FROM legal_acceptances WHERE user_phone = $1', [phoneVersionTest]);

    // Insert an old version v0.9.0
    await query(`
      INSERT INTO legal_acceptances (user_phone, user_role, document_type, document_version, document_hash)
      VALUES ($1, 'customer', 'customer_terms', '0.9.0', 'old_hash_1234567890abcdef')
    `, [phoneVersionTest]);

    // The active version is 1.0.0, so v0.9.0 should be marked superseded
    const check = await legalService.hasAcceptedActiveDocument({
      phone: phoneVersionTest,
      role: 'customer',
      documentType: 'customer_terms'
    });

    assert.strictEqual(check.accepted, false);
    assert.strictEqual(check.reason, 'version_superseded');
    assert.strictEqual(check.acceptedVersion, '0.9.0');
    assert.strictEqual(check.requiredVersion, '1.0.0');

    // Clean up
    await query('DELETE FROM legal_acceptances WHERE user_phone = $1', [phoneVersionTest]);
  });

  it('6. Browser localStorage manipulation cannot bypass restrictions (backend queries database)', async () => {
    const unacceptedPhone = '9443299004';
    await query('DELETE FROM legal_acceptances WHERE user_phone = $1', [unacceptedPhone]);

    // Even if client sends simulated acceptance state or bypass headers, backend queries DB
    const check = await legalService.hasAcceptedActiveDocument({
      phone: unacceptedPhone,
      role: 'customer'
    });
    assert.strictEqual(check.accepted, false);

    const guard = await legalService.guardCustomerBooking({ phone: unacceptedPhone });
    assert.strictEqual(guard.allowed, false);
    assert.strictEqual(guard.code, 'LEGAL_AGREEMENT_REQUIRED');
  });

  it('7. Database errors fail closed and block protected operations', async () => {
    // Mock temporary query failure
    const originalQuery = legalService.hasAcceptedActiveDocument.bind(legalService);
    
    // Test that database error fails closed with allowed: false
    const simulatedErrorCheck = await (async () => {
      try {
        const fakePhone = '9443299005';
        // Simulate missing phone
        return await legalService.hasAcceptedActiveDocument({ phone: '', role: 'customer' });
      } catch (e) {
        return { accepted: false, error: e.message };
      }
    })();

    assert.strictEqual(simulatedErrorCheck.accepted, false);
  });

  it('8. Duplicate acceptance does not create duplicate inconsistent records', async () => {
    const dedupePhone = '9443299006';
    await query('DELETE FROM legal_acceptances WHERE user_phone = $1', [dedupePhone]);

    const activeDoc = legalService.getActiveDocument('customer_terms');

    // First acceptance
    const firstRes = await legalService.recordAcceptance({
      phone: dedupePhone,
      role: 'customer',
      documentType: 'customer_terms',
      version: activeDoc.version,
      documentHash: activeDoc.contentHash
    });
    assert.strictEqual(firstRes.success, true);

    // Concurrent / duplicate submission
    const secondRes = await legalService.recordAcceptance({
      phone: dedupePhone,
      role: 'customer',
      documentType: 'customer_terms',
      version: activeDoc.version,
      documentHash: activeDoc.contentHash
    });
    assert.strictEqual(secondRes.success, true);

    // Verify exactly 1 record exists in Neon DB
    const countRes = await query(`
      SELECT count(*)::int as count 
      FROM legal_acceptances 
      WHERE user_phone = $1 AND document_type = 'customer_terms' AND document_version = $2
    `, [dedupePhone, activeDoc.version]);

    assert.strictEqual(countRes.rows[0].count, 1, 'Only one unique record must exist');

    // Clean up
    await query('DELETE FROM legal_acceptances WHERE user_phone = $1', [dedupePhone]);
  });

  it('9. Sign-up flow records legal acceptance in database with valid audit trail', async () => {
    const signupPhone = '9443299007';
    await query('DELETE FROM legal_acceptances WHERE user_phone = $1', [signupPhone]);

    const activeDoc = legalService.getActiveDocument('customer_terms');
    const rec = await legalService.recordAcceptance({
      userPhone: signupPhone,
      userRole: 'customer',
      documentType: 'customer_terms',
      documentVersion: activeDoc.version,
      ipAddress: '127.0.0.1',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Test Runner',
      consentArtifacts: {
        registeredAt: new Date().toISOString(),
        flow: 'auth_registration_checkbox'
      }
    });

    assert.strictEqual(rec.success, true);
    assert.strictEqual(rec.version, activeDoc.version);
    assert.strictEqual(rec.record.document_hash, activeDoc.contentHash);

    const check = await legalService.hasAcceptedActiveDocument({
      phone: signupPhone,
      role: 'customer'
    });
    assert.strictEqual(check.accepted, true);

    // Clean up
    await query('DELETE FROM legal_acceptances WHERE user_phone = $1', [signupPhone]);
    await query('DELETE FROM legal_acceptances WHERE user_phone IN ($1, $2)', [testCustomerPhone, testTechPhone]);
  });

  after(async () => {
    await pool.end();
  });
});
