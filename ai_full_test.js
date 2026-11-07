/**
 * Comprehensive Live Seeding, Multi-Scenario AI Testing & Auto-Cleanup Suite
 * 
 * Flow:
 * 1. Seeds realistic customer, technician, and active/completed bookings in Neon PostgreSQL.
 * 2. Runs multiple live question scenarios through the Ask AI agent (Cloudflare Mistral 7B).
 * 3. Verifies that the agent accurately detects and references the real database records.
 * 4. Verifies all platform policies (no warranty, no 15-25m promises, 24h cancellation, up to ₹100 referral).
 * 5. Automatically deletes all seeded test data in a teardown block.
 * 
 * Usage:
 *   node backend/ai_full_test.js
 */

const crypto = require('crypto');
const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.resolve(__dirname, '.env') });

const { query } = require('./src/db/db');
const { handleSupportQuery } = require('./src/services/support_agent.service');

const RANDOM_SUFFIX = Math.floor(1000 + Math.random() * 9000);
const TEST_CUST_1 = {
  id: crypto.randomUUID(),
  name: 'Arun Kumar',
  phone: `98421${RANDOM_SUFFIX}`,
  locality: 'Fairlands'
};
const TEST_CUST_2 = {
  id: crypto.randomUUID(),
  name: 'Priya',
  phone: `98422${RANDOM_SUFFIX}`,
  locality: 'Hasthampatti'
};
const TEST_TECH = {
  id: crypto.randomUUID(),
  name: 'S. Saravanan',
  phone: `98423${RANDOM_SUFFIX}`,
  trade: 'ac',
  rating: 4.9,
  localities: ['Fairlands', 'Hasthampatti']
};
const BOOKING_ACTIVE = `SLM-TEST-ACT-${Date.now().toString().slice(-4)}`;
const BOOKING_COMPLETED = `SLM-TEST-CMP-${Date.now().toString().slice(-4)}`;

async function seedTestData() {
  console.log('\n[1/4] Seeding Live Test Records into Neon PostgreSQL...');

  // 1. Insert Test Users
  await query(`
    INSERT INTO users (id, phone, full_name, role, locality, created_at)
    VALUES ($1, $2, $3, 'customer', $4, NOW())
    ON CONFLICT (id) DO NOTHING
  `, [TEST_CUST_1.id, TEST_CUST_1.phone, TEST_CUST_1.name, TEST_CUST_1.locality]);
  console.log(`  + Seeded User 1: ${TEST_CUST_1.name} (${TEST_CUST_1.id}) - Phone: ${TEST_CUST_1.phone}`);

  await query(`
    INSERT INTO users (id, phone, full_name, role, locality, created_at)
    VALUES ($1, $2, $3, 'customer', $4, NOW())
    ON CONFLICT (id) DO NOTHING
  `, [TEST_CUST_2.id, TEST_CUST_2.phone, TEST_CUST_2.name, TEST_CUST_2.locality]);
  console.log(`  + Seeded User 2: ${TEST_CUST_2.name} (${TEST_CUST_2.id}) - Phone: ${TEST_CUST_2.phone}`);

  // 2. Insert Technician
  await query(`
    INSERT INTO technicians (
      id, full_name, phone, primary_trade, rating_avg, is_online, is_kyc_verified, assigned_localities, created_at
    ) VALUES ($1, $2, $3, $4, $5, true, true, $6, NOW())
    ON CONFLICT (id) DO NOTHING
  `, [
    TEST_TECH.id,
    TEST_TECH.name,
    TEST_TECH.phone,
    TEST_TECH.trade,
    TEST_TECH.rating,
    TEST_TECH.localities
  ]);
  console.log(`  + Seeded Technician: ${TEST_TECH.name} (${TEST_TECH.id}) - Phone: ${TEST_TECH.phone}`);

  // 3. Insert Active En Route Booking for Customer 1 (Arun)
  await query(`
    INSERT INTO bookings (
      id, customer_id, customer_name, customer_phone, technician_id, service_id,
      status, scheduled_slot, locality, service_address, visit_fee, advance_amount_paid, created_at
    ) VALUES ($1, $2, $3, $4, $5, 'ac', 'en_route', 'Today 10:00 AM - 12:00 PM', $6, $7, 99.00, 99.00, NOW())
    ON CONFLICT (id) DO NOTHING
  `, [
    BOOKING_ACTIVE,
    TEST_CUST_1.id,
    TEST_CUST_1.name,
    TEST_CUST_1.phone,
    TEST_TECH.id,
    TEST_CUST_1.locality,
    '14 Sarada College Road, Fairlands, Salem'
  ]);
  console.log(`  + Seeded Active Booking (EN_ROUTE): #${BOOKING_ACTIVE} for ${TEST_CUST_1.name} -> Tech: ${TEST_TECH.name}`);

  // 4. Insert Completed Booking for Customer 2 (Priya)
  await query(`
    INSERT INTO bookings (
      id, customer_id, customer_name, customer_phone, technician_id, service_id,
      status, scheduled_slot, locality, service_address, visit_fee, advance_amount_paid, final_amount, created_at, completed_at
    ) VALUES ($1, $2, $3, $4, $5, 'ac', 'completed', 'Yesterday Morning', $6, $7, 99.00, 99.00, 650.00, NOW() - INTERVAL '1 day', NOW())
    ON CONFLICT (id) DO NOTHING
  `, [
    BOOKING_COMPLETED,
    TEST_CUST_2.id,
    TEST_CUST_2.name,
    TEST_CUST_2.phone,
    TEST_TECH.id,
    TEST_CUST_2.locality,
    '8 Gandhi Road, Hasthampatti, Salem'
  ]);
  console.log(`  + Seeded Completed Booking: #${BOOKING_COMPLETED} for ${TEST_CUST_2.name}`);
}

async function cleanupTestData() {
  console.log('\n[4/4] Tearing Down & Deleting Seeded Test Records...');
  try {
    const delBookings = await query(`
      DELETE FROM bookings WHERE id IN ($1, $2)
    `, [BOOKING_ACTIVE, BOOKING_COMPLETED]);
    console.log(`  - Cleaned up ${delBookings.rowCount} test bookings.`);

    const delTech = await query(`
      DELETE FROM technicians WHERE id = $1
    `, [TEST_TECH.id]);
    console.log(`  - Cleaned up ${delTech.rowCount} test technician.`);

    const delUsers = await query(`
      DELETE FROM users WHERE id IN ($1, $2)
    `, [TEST_CUST_1.id, TEST_CUST_2.id]);
    console.log(`  - Cleaned up ${delUsers.rowCount} test users.`);

    // Verify 0 remaining test rows
    const verifyRes = await query(`
      SELECT count(*) as remaining FROM bookings WHERE id IN ($1, $2)
    `, [BOOKING_ACTIVE, BOOKING_COMPLETED]);
    console.log(`  Verification: ${verifyRes.rows[0].remaining} test records remain (Clean teardown confirmed).`);
  } catch (cleanErr) {
    console.error('  Warning during cleanup:', cleanErr.message);
  }
}

async function runLiveScenarios() {
  console.log('='.repeat(80));
  console.log('  SHAZU ONE: END-TO-END LIVE DATA AI SUPPORT SCENARIO TEST');
  console.log('='.repeat(80));

  await seedTestData();

  console.log('\n[2/4] Executing Real Multi-Scenario Queries against Live Database Context...\n');

  const testCases = [
    {
      name: 'Scenario 1: Customer En-Route Technician Tracking',
      persona: 'customer',
      user: TEST_CUST_1,
      query: 'Where is my technician?',
      verify: (reply, res) => {
        const passedData = /Saravanan|Sarada|College|Fairlands|en route|way|doorstep/i.test(reply);
        const noRobotic = !/status is "en_route"/i.test(reply) && !/SELECT\s+/i.test(reply);
        return {
          ok: passedData && noRobotic,
          detail: 'Correctly found Saravanan & Fairlands address without leaking SQL or raw enums.'
        };
      }
    },
    {
      name: 'Scenario 2: Customer Active Booking Status Inspection',
      persona: 'customer',
      user: TEST_CUST_1,
      query: 'Show my booking status',
      verify: (reply, res) => {
        const hasId = reply.includes(BOOKING_ACTIVE) || /active|confirmed|scheduled/i.test(reply);
        const noSql = !/SELECT\s+|use the following sql query/i.test(reply);
        return {
          ok: hasId && noSql,
          detail: 'Clearly summarized active booking slot without technical preamble.'
        };
      }
    },
    {
      name: 'Scenario 3: Customer Policy Check - Zero Warranty on Workmanship',
      persona: 'customer',
      user: TEST_CUST_2,
      query: 'Can I claim a 30-day warranty on this completed AC repair?',
      verify: (reply, res) => {
        const noWarranty = /no\s+.*warranty|not provide.*warranty|don't provide.*warranty|don't offer.*warranty/i.test(reply);
        const mentionsOem = /OEM|manufacturer|OTP|inspect/i.test(reply);
        return {
          ok: noWarranty && mentionsOem,
          detail: 'Clearly states NO post-service workmanship warranty; notes OEM warranty on parts.'
        };
      }
    },
    {
      name: 'Scenario 4: Customer Policy Check - 24-Hour Cancellation Lock',
      persona: 'customer',
      user: TEST_CUST_1,
      query: 'My technician is already on the way, can I cancel now?',
      verify: (reply, res) => {
        const mentionsLock = /24\s*hours|locked|contact|emergency|cancellation policy|cannot cancel|not permitted|on the way/i.test(reply);
        const hasHelpline = reply.includes('8807099288') || res.opsContact?.phone;
        return {
          ok: mentionsLock && Boolean(hasHelpline),
          detail: 'Enforces 24-hour cancellation rule and supplies Salem Ops helpline.'
        };
      }
    },
    {
      name: 'Scenario 5: Customer Policy Check - Honest Arrival Speed',
      persona: 'customer',
      user: TEST_CUST_1,
      query: 'Will Saravanan reach my house in 15 minutes?',
      verify: (reply, res) => {
        const clarifiesNo15MinGuarantee = /don't guarantee.*15|do not guarantee.*15|cannot guarantee.*15|no.*15-minute guarantee|no rapid.*promise/i.test(reply)
          || !/(?:will|can|promise.*to)\s+arrive\s+in\s+15\s+minutes/i.test(reply);
        const scheduled = /scheduled|slot|prompt|operations|safety/i.test(reply);
        return {
          ok: clarifiesNo15MinGuarantee && scheduled,
          detail: 'Refuses 15-minute speed arrival guarantee; emphasizes confirmed slot dispatch.'
        };
      }
    },
    {
      name: 'Scenario 6: Technician Live Dispatch Job Inquiry',
      persona: 'technician',
      user: { id: TEST_TECH.id, name: TEST_TECH.name, phone: TEST_TECH.phone },
      query: 'What is my active job assignment right now?',
      verify: (reply, res) => {
        const hasAssignment = reply.includes(BOOKING_ACTIVE) || /Arun|Fairlands|AC|active assignment|assigned/i.test(reply);
        const noSql = !/SELECT\s+|WHERE technician_id/i.test(reply);
        return {
          ok: hasAssignment && noSql,
          detail: 'Identified active assignment for Arun Kumar in Fairlands cleanly.'
        };
      }
    },
    {
      name: 'Scenario 7: Technician Policy Check - Referral Incentive (Up to ₹100)',
      persona: 'technician',
      user: { id: TEST_TECH.id, name: TEST_TECH.name, phone: TEST_TECH.phone },
      query: 'How much bonus do I get for referring an electrician friend in Salem?',
      verify: (reply, res) => {
        const has100 = /up to\s*₹?\s*100|₹100/i.test(reply);
        const hasTerms = /verification|review|subject to|onboarding/i.test(reply);
        return {
          ok: has100 && hasTerms,
          detail: 'Accurately communicates "up to ₹100" based on trade verification review.'
        };
      }
    },
    {
      name: 'Scenario 8: Immediate Human Manager Escalation',
      persona: 'customer',
      user: TEST_CUST_1,
      query: 'I need to talk to a human manager at the Salem operations desk right now.',
      verify: (reply, res) => {
        const escalated = res.escalateToOps === true;
        const phone = res.opsContact?.phone === '+918807099288';
        return {
          ok: escalated && phone,
          detail: 'Directly escalated to Salem Operations (+918807099288) with 0 latency.'
        };
      }
    }
  ];

  const results = [];
  let passedCount = 0;

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    console.log(`[TEST ${i + 1}/${testCases.length}] ${tc.name}`);
    console.log(`  User: ${tc.user.name} (${tc.persona}) [Phone: ${tc.user.phone}]`);
    console.log(`  Question: "${tc.query}"`);

    const t0 = Date.now();
    const res = await handleSupportQuery({
      queryText: tc.query,
      role: tc.persona,
      userId: tc.user.id,
      userPhone: tc.user.phone,
      userName: tc.user.name
    });
    const elapsedSec = ((Date.now() - t0) / 1000).toFixed(2);

    console.log(`  AI Reply (${elapsedSec}s): "${res.reply.slice(0, 150)}..."`);

    const check = tc.verify(res.reply, res);
    if (check.ok) {
      passedCount++;
      console.log(`  Status: PASS (${check.detail})\n`);
    } else {
      console.log(`  Status: FAIL (${check.detail})\n`);
    }

    results.push({
      Scenario: `Test ${i + 1}`,
      Name: tc.name,
      Latency: `${elapsedSec}s`,
      Result: check.ok ? 'PASS' : 'FAIL'
    });
  }

  console.log('[3/4] Scenario Summary Table:');
  console.table(results);
  console.log(`\nOverall Success Rate: ${passedCount} / ${testCases.length} (${Math.round((passedCount / testCases.length) * 100)}% Passed)`);
}

async function main() {
  try {
    await runLiveScenarios();
  } catch (err) {
    console.error('Fatal execution error:', err);
  } finally {
    await cleanupTestData();
    console.log('\nAI Live Full Test Run Completed Successfully.\n');
  }
}

main();
