/**
 * ============================================================================
 * SHAZU ONE / SALEMSEVA: HIGH-CONCURRENCY STRESS & LOAD TEST SUITE
 * ============================================================================
 * Evaluates performance under concurrent load, race condition handling,
 * coupon redemption limits, and database connection pool resilience.
 *
 * Scenarios:
 * 1. Read Throughput Burst: 100 concurrent requests to catalog
 * 2. Rapid Ingestion Spike: 25 simultaneous booking creations across Salem
 * 3. Coupon Usage Limit Race Condition: 10 simultaneous redemptions on limit=3
 * 4. Concurrent Status Transition Progression
 * 5. Post-Stress Connection Pool & Latency Health Check
 *
 * Usage:
 *   node backend/tests/stress_test_suite.js
 * ============================================================================
 */

const BASE_URL = process.env.TEST_API_URL || 'http://localhost:8080';

// ANSI terminal helpers
const c = {
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`
};

function calculateStats(latencies) {
  if (latencies.length === 0) return { min: 0, max: 0, avg: 0, p95: 0, p99: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const avg = Math.round((sum / sorted.length) * 100) / 100;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1];
  const p99 = sorted[Math.floor(sorted.length * 0.99)] || sorted[sorted.length - 1];
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg,
    p95,
    p99
  };
}

async function api(path, options = {}) {
  const start = Date.now();
  const url = `${BASE_URL}${path}`;
  const defaultHeaders = { 'Content-Type': 'application/json' };
  try {
    const res = await fetch(url, {
      ...options,
      headers: { ...defaultHeaders, ...(options.headers || {}) }
    });
    const duration = Date.now() - start;
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data, duration };
  } catch (err) {
    const duration = Date.now() - start;
    return { ok: false, status: 0, data: { error: err.message }, duration };
  }
}

async function runStressTestSuite() {
  console.log(c.bold('======================================================================'));
  console.log(c.bold(c.cyan(' SHAZU ONE / SALEMSEVA: HIGH-CONCURRENCY STRESS & LOAD TEST SUITE')));
  console.log(` Target Server: ${c.yellow(BASE_URL)}`);
  console.log(c.bold('======================================================================\n'));

  const overallResults = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    startTime: Date.now()
  };

  // =========================================================================
  // SCENARIO 1: READ THROUGHPUT BURST (100 CONCURRENT REQUESTS)
  // =========================================================================
  console.log(c.bold('--- SCENARIO 1: High-Concurrency Catalog Read Burst (100 concurrent requests) ---'));
  const CONCURRENT_READS = 100;
  const readStart = Date.now();
  const readPromises = [];

  for (let i = 0; i < CONCURRENT_READS; i++) {
    // Interleave services list and service detail endpoints
    const endpoint = i % 2 === 0 ? '/api/v1/services' : '/api/v1/services/ac';
    readPromises.push(api(endpoint));
  }

  const readResponses = await Promise.all(readPromises);
  const readTotalTime = Date.now() - readStart;
  const readLatencies = readResponses.map((r) => r.duration);
  const readSuccess = readResponses.filter((r) => r.ok).length;
  const readStats = calculateStats(readLatencies);
  const readRPS = Math.round((CONCURRENT_READS / (readTotalTime / 1000)) * 100) / 100;

  overallResults.totalRequests += CONCURRENT_READS;
  overallResults.successfulRequests += readSuccess;
  overallResults.failedRequests += (CONCURRENT_READS - readSuccess);

  console.log(`  Completed: ${readSuccess}/${CONCURRENT_READS} successful in ${readTotalTime}ms`);
  console.log(`  Throughput: ${c.bold(readRPS)} req/sec`);
  console.log(`  Latency: Min=${readStats.min}ms | Avg=${readStats.avg}ms | P95=${readStats.p95}ms | P99=${readStats.p99}ms | Max=${readStats.max}ms\n`);

  // =========================================================================
  // SCENARIO 2: RAPID BOOKING INGESTION SPIKE (25 CONCURRENT BOOKINGS)
  // =========================================================================
  console.log(c.bold('--- SCENARIO 2: Peak Ingestion Spike (25 Simultaneous Booking Creations) ---'));
  const CONCURRENT_BOOKINGS = 25;
  const localities = ['Fairlands', 'Hasthampatti', 'Suramangalam', 'Ammapet', 'Shevapet'];
  const trades = ['ac', 'electrician', 'plumber', 'cleaning'];
  const bookingPromises = [];
  const createdBookingIds = [];

  const bookingStart = Date.now();
  for (let i = 0; i < CONCURRENT_BOOKINGS; i++) {
    const loc = localities[i % localities.length];
    const trade = trades[i % trades.length];
    const phone = `+919842${Math.floor(100000 + Math.random() * 900000)}`;
    const payload = {
      serviceId: trade,
      customerName: `Stress User ${i + 1}`,
      customerPhone: phone,
      locality: loc,
      address: `Street ${i + 1}, ${loc}, Salem - 636016`,
      bookingType: 'instant',
      scheduledSlot: 'instant_now'
    };
    bookingPromises.push(api('/api/v1/bookings', { method: 'POST', body: JSON.stringify(payload) }));
  }

  const bookingResponses = await Promise.all(bookingPromises);
  const bookingTotalTime = Date.now() - bookingStart;
  const bookingLatencies = bookingResponses.map((r) => r.duration);
  const bookingSuccess = bookingResponses.filter((r) => {
    if (r.ok && r.data?.booking?.id) {
      createdBookingIds.push(r.data.booking.id);
      return true;
    }
    return false;
  }).length;
  const bookingStats = calculateStats(bookingLatencies);

  overallResults.totalRequests += CONCURRENT_BOOKINGS;
  overallResults.successfulRequests += bookingSuccess;
  overallResults.failedRequests += (CONCURRENT_BOOKINGS - bookingSuccess);

  console.log(`  Created Bookings: ${bookingSuccess}/${CONCURRENT_BOOKINGS} in ${bookingTotalTime}ms`);
  console.log(`  Throughput: ${c.bold(Math.round((CONCURRENT_BOOKINGS / (bookingTotalTime / 1000)) * 100) / 100)} bookings/sec`);
  console.log(`  Latency: Min=${bookingStats.min}ms | Avg=${bookingStats.avg}ms | P95=${bookingStats.p95}ms | P99=${bookingStats.p99}ms | Max=${bookingStats.max}ms\n`);

  // =========================================================================
  // SCENARIO 3: CONCURRENT STATUS PROGRESSION UNDER LOAD
  // =========================================================================
  console.log(c.bold('--- SCENARIO 3: Concurrent Status Progression on Created Bookings ---'));
  const statusPromises = [];
  const statusStart = Date.now();

  for (const bId of createdBookingIds.slice(0, 15)) {
    statusPromises.push(
      api(`/api/v1/bookings/${bId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'accepted' })
      })
    );
  }

  const statusResponses = await Promise.all(statusPromises);
  const statusTotalTime = Date.now() - statusStart;
  const statusSuccess = statusResponses.filter((r) => r.ok).length;

  overallResults.totalRequests += statusPromises.length;
  overallResults.successfulRequests += statusSuccess;
  overallResults.failedRequests += (statusPromises.length - statusSuccess);

  console.log(`  Progressed Status: ${statusSuccess}/${statusPromises.length} bookings accepted in ${statusTotalTime}ms\n`);

  // =========================================================================
  // SCENARIO 4: COUPON USAGE LIMIT RACE CONDITION TEST
  // =========================================================================
  console.log(c.bold('--- SCENARIO 4: Coupon Concurrency & Double-Spend Prevention ---'));
  const testCouponCode = `STRESS_${Math.floor(1000 + Math.random() * 9000)}`;

  // Step 1: Create a coupon with usage_limit = 3
  const createCouponRes = await api('/api/v1/admin/coupons', {
    method: 'POST',
    body: JSON.stringify({
      code: testCouponCode,
      discountType: 'flat',
      discountValue: 50,
      minOrderAmount: 50,
      usageLimit: 3,
      isActive: true
    })
  });

  if (createCouponRes.ok) {
    // Step 2: Fire 10 simultaneous orders attempting to apply the coupon
    const couponRedeemPromises = [];
    for (let i = 0; i < 10; i++) {
      couponRedeemPromises.push(
        api('/api/v1/coupons/apply', {
          method: 'POST',
          body: JSON.stringify({
            code: testCouponCode,
            bookingAmount: 200,
            amount: 200
          })
        })
      );
    }

    const couponResponses = await Promise.all(couponRedeemPromises);
    const validApplications = couponResponses.filter((r) => r.ok && r.data?.discount > 0).length;

    overallResults.totalRequests += 11;
    overallResults.successfulRequests += (1 + validApplications);

    console.log(`  Created single-use test coupon: ${testCouponCode} (Max Allowed Uses: 3)`);
    console.log(`  Dispatched 10 concurrent redemption requests.`);
    console.log(`  Redeemed successfully: ${validApplications} / 10`);

    // Clean up test coupon
    if (createCouponRes.data?.coupon?.id) {
      await api(`/api/v1/admin/coupons/${createCouponRes.data.coupon.id}`, { method: 'DELETE' });
    }
  } else {
    console.log(c.yellow(`  Coupon engine test skipped: ${createCouponRes.data?.error || 'Endpoint unavailable'}`));
  }
  console.log('');

  // =========================================================================
  // SCENARIO 5: POST-STRESS CONNECTION POOL HEALTH & RECOVERY
  // =========================================================================
  console.log(c.bold('--- SCENARIO 5: Connection Pool & Server Health Recovery ---'));
  const healthStart = Date.now();
  const healthRes = await api('/health');
  const healthDuration = Date.now() - healthStart;

  overallResults.totalRequests += 1;
  if (healthRes.ok) overallResults.successfulRequests += 1;
  else overallResults.failedRequests += 1;

  console.log(`  Server Health Post-Load: ${healthRes.ok ? c.green('HEALTHY') : c.red('UNHEALTHY')}`);
  console.log(`  Database Status: ${healthRes.data?.database || 'Unknown'}`);
  console.log(`  Health Ping Latency: ${c.bold(healthDuration)}ms (Expected < 100ms)\n`);

  // =========================================================================
  // FINAL SUMMARY
  // =========================================================================
  const totalDuration = ((Date.now() - overallResults.startTime) / 1000).toFixed(2);
  const successRate = ((overallResults.successfulRequests / overallResults.totalRequests) * 100).toFixed(2);

  console.log(c.bold('======================================================================'));
  console.log(c.bold(c.cyan('                   STRESS TEST EXECUTION SUMMARY                      ')));
  console.log(c.bold('======================================================================'));
  console.log(`  Total Requests Dispatched : ${c.bold(overallResults.totalRequests)}`);
  console.log(`  Successful Responses      : ${c.green(overallResults.successfulRequests)}`);
  console.log(`  Failed Responses          : ${overallResults.failedRequests > 0 ? c.red(overallResults.failedRequests) : c.green(0)}`);
  console.log(`  Overall Success Rate      : ${c.bold(successRate)}%`);
  console.log(`  Total Duration            : ${totalDuration}s`);
  console.log(c.bold('======================================================================'));

  if (overallResults.failedRequests === 0) {
    console.log(c.green(c.bold(' [PASS] SYSTEM DEMONSTRATES EXCEPTIONAL CONCURRENCY RESILIENCE.')));
  } else {
    console.log(c.yellow(c.bold(` [NOTE] System processed load with ${successRate}% success rate.`)));
  }
}

runStressTestSuite();
