import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAndSanitizeQuery,
  isHumanEscalationRequest,
  getSalemOpsContact,
  handleSupportQuery
} from '../src/services/support_agent.service.js';

test('Unit Test: AI Support Agent Deterministic SQL Guard & Role Boundaries', async (t) => {
  await t.test('should permit valid scoped SELECT queries for customer persona', () => {
    const validCustomerSql = "SELECT id, service_id, status FROM bookings WHERE customer_id = 'cust_123' ORDER BY created_at DESC";
    const result = validateAndSanitizeQuery(validCustomerSql, 'customer', 'cust_123');

    assert.equal(result.isValid, true);
    assert.match(result.sanitizedSql, /^SELECT\b/i);
    assert.match(result.sanitizedSql, /\bLIMIT 10\b/i);
  });

  await t.test('should permit valid scoped SELECT queries for technician persona', () => {
    const validTechSql = "SELECT id, status, scheduled_slot FROM bookings WHERE technician_id = 'tech_456'";
    const result = validateAndSanitizeQuery(validTechSql, 'technician', 'tech_456');

    assert.equal(result.isValid, true);
    assert.match(result.sanitizedSql, /^SELECT\b/i);
    assert.match(result.sanitizedSql, /\bLIMIT 10\b/i);
  });

  await t.test('should strictly reject write operations (INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE)', () => {
    const maliciousWrites = [
      "UPDATE bookings SET status = 'completed' WHERE id = 'b1'",
      "DELETE FROM payments WHERE booking_id = 'b1'",
      "DROP TABLE users",
      "ALTER TABLE bookings DROP COLUMN status",
      "TRUNCATE TABLE support_tickets",
      "INSERT INTO bookings (id) VALUES ('hack')"
    ];

    for (const sql of maliciousWrites) {
      const res = validateAndSanitizeQuery(sql, 'customer', 'cust_123');
      assert.equal(res.isValid, false, `Failed to reject: ${sql}`);
      assert.ok(res.error);
    }
  });

  await t.test('should reject semicolon chaining, comments, and SQL injection delimiters', () => {
    const injectionAttempts = [
      "SELECT id FROM bookings WHERE customer_id = 'cust_123'; DROP TABLE users",
      "SELECT * FROM bookings WHERE customer_id = 'cust_123' -- bypass",
      "SELECT * FROM bookings WHERE customer_id = 'cust_123' /* comment */",
      "SELECT id FROM pg_tables WHERE schemaname = 'public'",
      "SELECT column_name FROM information_schema.columns"
    ];

    for (const sql of injectionAttempts) {
      const res = validateAndSanitizeQuery(sql, 'customer', 'cust_123');
      assert.equal(res.isValid, false, `Failed to block injection: ${sql}`);
    }
  });

  await t.test('should enforce customer tenant isolation (prevent queries without customer_id or phone)', () => {
    const crossTenantQuery = "SELECT id, status, final_total_amount FROM bookings WHERE status = 'completed'";
    const res = validateAndSanitizeQuery(crossTenantQuery, 'customer', 'cust_123');

    assert.equal(res.isValid, false);
    assert.match(res.error, /customer_id or customer_phone/i);
  });

  await t.test('should block customer from querying technician-restricted tables', () => {
    const forbiddenCustomerQuery = "SELECT phone, address FROM technicians WHERE id = 'tech_99'";
    const res = validateAndSanitizeQuery(forbiddenCustomerQuery, 'customer', 'cust_123');

    assert.equal(res.isValid, false);
    assert.match(res.error, /restricted for customer persona/i);
  });
});

test('Unit Test: Human Escalation & Salem Ops Routing', async (t) => {
  await t.test('should detect explicit requests for human agent or operations contact', () => {
    assert.equal(isHumanEscalationRequest('I want to talk to a human agent'), true);
    assert.equal(isHumanEscalationRequest('Please give me customer care phone number'), true);
    assert.equal(isHumanEscalationRequest('connect me to manager or ops team'), true);
    assert.equal(isHumanEscalationRequest('can I chat with whatsapp support'), true);
    assert.equal(isHumanEscalationRequest('what are your AC cleaning packages?'), false);
  });

  await t.test('should return official Salem Operations contact details', () => {
    const ops = getSalemOpsContact();
    assert.ok(ops.phone);
    assert.ok(ops.whatsapp);
    assert.ok(ops.whatsappUrl.startsWith('https://wa.me/'));
    assert.ok(ops.email);
    assert.ok(ops.hours);
  });

  await t.test('should route human escalation requests to Salem Ops immediately', async () => {
    const result = await handleSupportQuery({
      queryText: 'I need to speak to a human manager about my booking delay',
      role: 'customer',
      userId: 'user_1'
    });

    assert.equal(result.success, true);
    assert.equal(result.escalateToOps, true);
    assert.ok(result.opsContact.phone);
    assert.ok(result.reply.includes('Salem Operations Support Team'));
  });

  await t.test('should translate raw database statuses into friendly reassuring language', async () => {
    const { describeBookingStatus } = await import('../src/services/support_agent.service.js');
    const createdStatus = describeBookingStatus({
      id: 'SLM-70016',
      status: 'created',
      locality: 'Fairlands',
      service_name: 'AC Master Service',
      scheduled_slot: '10:00 AM - 12:00 PM'
    });
    assert.match(createdStatus, /confirmed/i);
    assert.match(createdStatus, /assigning the nearest verified specialist/i);
    assert.doesNotMatch(createdStatus, /status is "created"/i);

    const enRouteStatus = describeBookingStatus({
      id: 'SLM-70016',
      status: 'en_route',
      locality: 'Fairlands',
      service_name: 'AC Master Service',
      tech_name: 'K. Ramesh',
      tech_phone: '+919443210002'
    });
    assert.match(enRouteStatus, /on the way to your doorstep/i);
    assert.match(enRouteStatus, /K\. Ramesh/i);
  });
});
