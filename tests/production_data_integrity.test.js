/**
 * ============================================================================
 * SALEMSEVA / SHAZU ONE - PRODUCTION DATA INTEGRITY TEST
 * ============================================================================
 *
 * Answers one question for every write flow in the platform:
 *
 *     "The app said it saved. Did the data actually land, and can the
 *      admin / ops panel see it?"
 *
 * For each case the suite performs the same three-step proof:
 *
 *   1. SUBMIT      - call the public API exactly like the app does.
 *   2. DB PROOF    - read the row straight out of PostgreSQL and compare the
 *                    submitted values field by field.
 *   3. PANEL PROOF - call the read endpoint the admin panel uses and confirm
 *                    the same record is returned there.
 *
 * A silent failure (API returns success, row is missing) is the defect class
 * this suite exists to catch: registration, bookings, status changes, quote
 * flow, cancellations, file / aadhaar / bill uploads, feedback, support
 * tickets, reviews, coupons, admin team, services, reward settings, wallet
 * credits and admin enforcement actions.
 *
 * Severity model
 *   FAIL   Blocking. The write reported success but the data is missing,
 *          mismatched, or invisible in the panel. Sets exit code 1.
 *   WARN   The core record landed but an expected side effect / derived field
 *          did not (timestamps, wallet credit, storage fallback). Logged,
 *          non fatal unless --strict is passed.
 *   SKIP   Cannot be measured on this environment, with the reason logged.
 *
 * Output
 *   - Console transcript with a [PASS]/[FAIL]/[WARN]/[SKIP] tag per check.
 *   - tests/logs/data-integrity-<timestamp>.log        full transcript
 *   - tests/logs/data-integrity-<timestamp>.json       machine report for CI
 *
 * Usage
 *   node tests/production_data_integrity.test.js
 *   node tests/production_data_integrity.test.js --strict
 *   TEST_API_URL=https://api.shazuone.in node tests/production_data_integrity.test.js --no-spawn
 *
 * Flags
 *   --strict        Treat WARN as a failure (release gate mode).
 *   --keep-data     Do not remove the rows this run created.
 *   --no-spawn      Never start a local backend; fail if the API is down.
 *   --spawn-server  Always start a local backend for this run.
 *   --only=<name>   Run a single section (repeatable), e.g. --only=bookings.
 *
 * Exit codes
 *   0  every blocking check passed
 *   1  at least one blocking check failed
 *   2  could not run (database unreachable, API unreachable, schema missing)
 *
 * NOTE: this suite writes real rows. Everything it creates is tagged with a
 * unique run phone number and is deleted again on exit unless --keep-data.
 * Point TEST_API_URL at staging, never at live customer data.
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { query, pool } = require('../src/db/db');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BACKEND_ROOT = path.join(__dirname, '..');
const ARGS = new Set(process.argv.slice(2));
const ONLY = process.argv
  .filter(a => a.startsWith('--only='))
  .map(a => a.slice('--only='.length).toLowerCase());

// 127.0.0.1 rather than localhost: Node resolves localhost to ::1 first, while
// Fastify binds 0.0.0.0 here, so the health probe would fail on a healthy server.
const BASE_URL = (process.env.TEST_API_URL || `http://127.0.0.1:${process.env.PORT || 8080}`).replace(/\/+$/, '');
const API = `${BASE_URL}/api/v1`;
const IS_LOCAL = /localhost|127\.0\.0\.1/.test(BASE_URL);
const STRICT = ARGS.has('--strict') || process.env.INTEGRITY_STRICT === '1';
const KEEP_DATA = ARGS.has('--keep-data') || process.env.INTEGRITY_KEEP_DATA === '1';
const FORCE_SPAWN = ARGS.has('--spawn-server');
const NO_SPAWN = ARGS.has('--no-spawn');
const REQUEST_TIMEOUT = Number(process.env.INTEGRITY_TIMEOUT_MS || 25000);

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, `data-integrity-${STAMP}.log`);
const REPORT_FILE = path.join(LOG_DIR, `data-integrity-${STAMP}.json`);

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.writeFileSync(LOG_FILE, '');

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

const STATE = {
  startedAt: new Date().toISOString(),
  checks: { pass: 0, fail: 0, warn: 0, skip: 0 },
  failures: [],
  warnings: [],
  skips: [],
  sections: [],
  fatal: null,
  httpCalls: 0,
  slowestCall: { route: '-', ms: 0 },
  // The API requires a session token on every non-public route. The suite signs in once as
  // central ops, which is allowed everywhere, and reuses that token for every call.
  authToken: ''
};

const LEDGER = {
  phones: [],          // every phone number this run touched (raw variants)
  users: [],
  technicians: [],
  bookings: [],
  tickets: [],
  feedback: [],
  reviews: [],
  coupons: [],
  team: [],
  services: [],
  auditMarkers: []
};

const SEVERITY = { FAIL: 'FAIL', WARN: 'WARN', SKIP: 'SKIP', PASS: 'PASS' };

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

function emit(line) {
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) { /* logging must never break the run */ }
}

function log(level, scope, message, detail) {
  const tag = `[${level.padEnd(4)}]`;
  let line = `${stamp()} ${tag} ${scope ? scope + ' | ' : ''}${message}`;
  if (detail !== undefined && detail !== null && detail !== '') {
    line += ` -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  }
  emit(line);
}

function info(scope, message, detail) { log('INFO', scope, message, detail); }
function debug(scope, message, detail) { log('DBG ', scope, message, detail); }

function sectionStart(name, title) {
  emit('');
  emit('='.repeat(78));
  emit(` ${title}`);
  emit('='.repeat(78));
  const entry = { name, title, startedAt: Date.now(), pass: 0, fail: 0, warn: 0, skip: 0 };
  STATE.sections.push(entry);
  return entry;
}

function currentSection() {
  return STATE.sections[STATE.sections.length - 1] || null;
}

function record(level, name, detail) {
  const sec = currentSection();
  STATE.checks[level === 'PASS' ? 'pass' : level === 'FAIL' ? 'fail' : level === 'WARN' ? 'warn' : 'skip'] += 1;
  if (sec) {
    if (level === 'PASS') sec.pass += 1;
    else if (level === 'FAIL') sec.fail += 1;
    else if (level === 'WARN') sec.warn += 1;
    else sec.skip += 1;
  }
  if (level === 'FAIL') STATE.failures.push({ section: sec?.name || '-', check: name, detail });
  if (level === 'WARN') STATE.warnings.push({ section: sec?.name || '-', check: name, detail });
  if (level === 'SKIP') STATE.skips.push({ section: sec?.name || '-', check: name, detail });
  log(level, sec?.name, name, detail);
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function fmt(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sameNumber(a, b, tolerance = 0.01) {
  const x = toNum(a);
  const y = toNum(b);
  if (x === null || y === null) return false;
  return Math.abs(x - y) <= tolerance;
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '').slice(-10);
}

/** Boolean check. */
function check(name, condition, detail) {
  record(condition ? SEVERITY.PASS : SEVERITY.FAIL, name, detail);
  return Boolean(condition);
}

/** Soft check: logged as WARN instead of FAIL when false. */
function checkSoft(name, condition, detail) {
  if (condition) record(SEVERITY.PASS, name, detail);
  else record(SEVERITY.WARN, name, detail);
  return Boolean(condition);
}

/** Exact field comparison, numeric aware. */
function checkField(name, actual, expected) {
  const ok = typeof expected === 'number'
    ? sameNumber(actual, expected)
    : String(actual ?? '') === String(expected ?? '');
  record(ok ? SEVERITY.PASS : SEVERITY.FAIL, name, ok ? fmt(actual) : `expected ${fmt(expected)}, got ${fmt(actual)}`);
  return ok;
}

/** Non-empty string / non-null value. */
function checkPresent(name, value) {
  const ok = value !== null && value !== undefined && String(value).trim() !== '';
  record(ok ? SEVERITY.PASS : SEVERITY.FAIL, name, ok ? fmt(value) : 'value is empty or null');
  return ok;
}

function skip(name, reason) {
  record(SEVERITY.SKIP, name, reason);
}

/** Compares a set of DB columns against expected values in one call. */
function checkRow(prefix, row, expectedMap) {
  if (!row) {
    record(SEVERITY.FAIL, `${prefix} / row exists`, 'no row returned by the database query');
    return false;
  }
  let allOk = true;
  for (const [column, expected] of Object.entries(expectedMap)) {
    const ok = typeof expected === 'number'
      ? sameNumber(row[column], expected)
      : String(row[column] ?? '') === String(expected ?? '');
    allOk = allOk && ok;
    record(ok ? SEVERITY.PASS : SEVERITY.FAIL, `${prefix} / ${column}`,
      ok ? fmt(row[column]) : `expected ${fmt(expected)}, db has ${fmt(row[column])}`);
  }
  return allOk;
}

/** Presence of a row (null-safe). */
function checkFound(prefix, row, note) {
  const ok = Boolean(row);
  record(ok ? SEVERITY.PASS : SEVERITY.FAIL, `${prefix} / found in DB`, ok ? (note || 'yes') : 'row absent');
  return ok;
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

async function dbRows(sql, params = []) {
  const res = await query(sql, params);
  return res.rows || [];
}

async function dbOne(sql, params = []) {
  const rows = await dbRows(sql, params);
  return rows[0] || null;
}

async function dbCount(sql, params = []) {
  const row = await dbOne(sql, params);
  return row ? Number(Object.values(row)[0]) : 0;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function api(method, route, body, options = {}) {
  const url = route.startsWith('http') ? route : `${API}${route}`;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || REQUEST_TIMEOUT);
  let status = 0;
  let data = null;
  let text = '';
  let transportError = null;

  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(STATE.authToken ? { Authorization: `Bearer ${STATE.authToken}` } : {}),
        ...(process.env.INTERNAL_API_KEY ? { 'x-internal-key': process.env.INTERNAL_API_KEY } : {}),
        ...(options.headers || {})
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    status = res.status;
    text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = { _nonJsonBody: text.slice(0, 400) };
    }
  } catch (err) {
    transportError = err.name === 'AbortError' ? `timeout after ${options.timeout || REQUEST_TIMEOUT}ms` : err.message;
  } finally {
    clearTimeout(timer);
  }

  const ms = Date.now() - started;
  STATE.httpCalls += 1;
  if (ms > STATE.slowestCall.ms) STATE.slowestCall = { route: `${method} ${route}`, ms };

  const result = { method, route, url, status, ok: status >= 200 && status < 300, data, ms, transportError };
  debug('http', `${method} ${route} -> ${transportError ? 'TRANSPORT ERROR' : status}`, `${ms}ms`);

  if (transportError) {
    log('FAIL', currentSection()?.name, `transport error on ${method} ${route}`, transportError);
  } else if (!result.ok) {
    const msg = data && (data.error || data.message) ? (data.error || data.message) : text.slice(0, 300);
    debug('http', `error body ${method} ${route}`, msg);
  }
  return result;
}

const get = (route, options) => api('GET', route, undefined, options);
const post = (route, body, options) => api('POST', route, body ?? {}, options);
const put = (route, body, options) => api('PUT', route, body ?? {}, options);
const patch = (route, body, options) => api('PATCH', route, body ?? {}, options);
const del = (route, options) => api('DELETE', route, undefined, options);

// /health is mounted at the server root, not under /api/v1.
const ping = (options = { timeout: 4000 }) => api('GET', `${BASE_URL}/health`, undefined, options);

/** Asserts an HTTP call succeeded, logging the server message when it did not. */
function checkHttp(prefix, res, expectedStatuses = [200, 201]) {
  const ok = expectedStatuses.includes(res.status);
  const detail = ok
    ? `${res.status} in ${res.ms}ms`
    : `HTTP ${res.status || 'transport'} ${res.transportError || JSON.stringify(res.data || {}).slice(0, 300)}`;
  record(ok ? SEVERITY.PASS : SEVERITY.FAIL, `${prefix} / HTTP ${expectedStatuses.join('|')}`, detail);
  return ok;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const RUN_TAG = String(Date.now()).slice(-7);
let phoneCounter = 0;

/** Unique, valid 10 digit Indian mobile that can never collide with real data. */
function newPhone() {
  phoneCounter += 1;
  const tail = String(Date.now()).slice(-5) + String(phoneCounter).padStart(2, '0');
  return `9${RUN_TAG.slice(-2)}${tail.slice(-8)}`.slice(0, 10);
}

function track(...phones) {
  for (const p of phones) {
    if (p && !LEDGER.phones.includes(String(p))) LEDGER.phones.push(String(p));
  }
}

const PNG_1PX_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wH3kQAAAABJRU5ErkJggg==';

const ACTOR = { customerPhone: null, customerName: null, techPhone: null, techId: null, techName: null };

// ---------------------------------------------------------------------------
// Cleanup: deletes only rows this run created
// ---------------------------------------------------------------------------

async function cleanup() {
  const phones = LEDGER.phones.slice();
  const digits = phones.map(digitsOnly).filter(Boolean);

  if (!phones.length && !LEDGER.bookings.length) return;

  emit('');
  info('cleanup', `removing rows created by this run (${phones.length} phones, ${LEDGER.bookings.length} bookings)`);

  const step = async (label, sql, params) => {
    try {
      const res = await query(sql, params);
      if (res.rowCount) debug('cleanup', `${label}: ${res.rowCount} row(s)`);
    } catch (err) {
      log('WARN', 'cleanup', `${label} failed`, err.message);
    }
  };

  await step('payments', 'DELETE FROM payments WHERE booking_id = ANY($1)', [LEDGER.bookings]);
  await step('quote_items', 'DELETE FROM quote_items WHERE booking_id = ANY($1)', [LEDGER.bookings]);
  await step('booking_reschedule_logs', 'DELETE FROM booking_reschedule_logs WHERE booking_id = ANY($1)', [LEDGER.bookings]);
  await step('chat_messages', 'DELETE FROM chat_messages WHERE booking_id = ANY($1)', [LEDGER.bookings]);
  await step('audit_logs (booking)', 'DELETE FROM audit_logs WHERE booking_id = ANY($1)', [LEDGER.bookings]);
  await step('audit_logs (actor)', 'DELETE FROM audit_logs WHERE booking_id = ANY($1)', [LEDGER.auditMarkers]);
  await step('reviews', 'DELETE FROM reviews WHERE booking_id = ANY($1)', [LEDGER.bookings]);
  await step('bookings', 'DELETE FROM bookings WHERE id = ANY($1)', [LEDGER.bookings]);
  await step('support_tickets', 'DELETE FROM support_tickets WHERE id = ANY($1)', [LEDGER.tickets]);
  await step('platform_feedback', 'DELETE FROM platform_feedback WHERE id = ANY($1)', [LEDGER.feedback]);
  await step('coupons', 'DELETE FROM coupons WHERE code = ANY($1)', [LEDGER.coupons]);
  await step('admin_team', 'DELETE FROM admin_team WHERE id = ANY($1)', [LEDGER.team]);
  await step('services', 'DELETE FROM services WHERE id = ANY($1)', [LEDGER.services]);
  await step('wallet_transactions',
    `DELETE FROM wallet_transactions WHERE RIGHT(REGEXP_REPLACE(user_phone, '\\D', '', 'g'), 10) = ANY($1)`,
    [digits]);
  await step('technician_payouts',
    `DELETE FROM technician_payouts WHERE RIGHT(REGEXP_REPLACE(technician_phone, '\\D', '', 'g'), 10) = ANY($1)`,
    [digits]);
  await step('otp_verifications',
    `DELETE FROM otp_verifications WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = ANY($1)`,
    [digits]);
  await step('push_subscriptions',
    `DELETE FROM push_subscriptions WHERE RIGHT(REGEXP_REPLACE(user_phone, '\\D', '', 'g'), 10) = ANY($1)`,
    [digits]);
  await step('technicians',
    `DELETE FROM technicians WHERE id = ANY($1) OR RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = ANY($2)`,
    [LEDGER.technicians, digits]);
  await step('users',
    `DELETE FROM users WHERE id = ANY($1) OR (role <> 'admin' AND RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = ANY($2))`,
    [LEDGER.users, digits]);

  info('cleanup', 'done');
}

// ---------------------------------------------------------------------------
// Preflight: database, schema, API
// ---------------------------------------------------------------------------

const REQUIRED_SCHEMA = {
  users: ['id', 'phone', 'full_name', 'role', 'wallet_balance', 'password_hash', 'is_blocked'],
  technicians: ['id', 'phone', 'full_name', 'primary_trade', 'is_online', 'is_kyc_verified', 'aadhaar_card_url'],
  bookings: ['id', 'service_id', 'customer_phone', 'customer_name', 'status', 'final_amount', 'parts_bill_url', 'customer_otp'],
  payments: ['id', 'booking_id', 'amount_total', 'tech_payout_amount', 'platform_commission', 'status'],
  quote_items: ['id', 'booking_id', 'item_name', 'price', 'qty'],
  audit_logs: ['id', 'booking_id', 'event_type', 'metadata'],
  platform_feedback: ['id', 'user_phone', 'message', 'status'],
  support_tickets: ['id', 'ticket_number', 'creator_phone', 'status', 'resolved_at'],
  reviews: ['id', 'booking_id', 'rating', 'ops_manager_escalated'],
  coupons: ['id', 'code', 'times_used'],
  admin_team: ['id', 'email', 'role'],
  services: ['id', 'name_en', 'visit_fee', 'is_active'],
  platform_settings: ['id', 'review_reward_credits', 'feedback_reward_credits'],
  wallet_transactions: ['id', 'user_phone', 'amount', 'type', 'category']
};

async function preflight() {
  sectionStart('preflight', 'PREFLIGHT - DATABASE, SCHEMA AND API REACHABILITY');

  let dbOk = false;
  try {
    const row = await dbOne('SELECT current_database() AS db, NOW() AS now');
    dbOk = Boolean(row);
    info('preflight', 'database connected', `${row.db} at ${row.now.toISOString ? row.now.toISOString() : row.now}`);
    check('PostgreSQL reachable', true, row.db);
  } catch (err) {
    check('PostgreSQL reachable', false, err.message);
    STATE.fatal = `database unreachable: ${err.message}`;
    return;
  }
  if (!dbOk) return;

  // Schema must carry every column the flows below assert on, otherwise a
  // missing migration masquerades as a data loss failure.
  let missing = 0;
  for (const [table, columns] of Object.entries(REQUIRED_SCHEMA)) {
    const rows = await dbRows(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1`,
      [table]
    );
    if (!rows.length) {
      record(SEVERITY.FAIL, `schema / table ${table}`, 'table does not exist');
      missing += 1;
      continue;
    }
    const present = new Set(rows.map(r => r.column_name));
    const absent = columns.filter(c => !present.has(c));
    if (absent.length) {
      record(SEVERITY.FAIL, `schema / table ${table}`, `missing columns: ${absent.join(', ')}`);
      missing += absent.length;
    } else {
      debug('preflight', `schema ok: ${table}`, `${columns.length} columns`);
    }
  }
  check('Schema matches expectations', missing === 0, missing === 0 ? 'all required tables and columns present' : `${missing} missing`);

  // API
  let health = await ping();
  if (!health.ok && IS_LOCAL && !NO_SPAWN && !FORCE_SPAWN) {
    info('preflight', 'backend not running, starting it for this run');
    const started = await startServer();
    if (started) health = await ping();
  } else if (FORCE_SPAWN) {
    const started = await startServer();
    if (started) health = await ping();
  }

  check('API reachable', health.ok && health.data?.status === 'HEALTHY',
    health.ok ? `${BASE_URL} reports ${health.data?.status}` : `${BASE_URL} -> HTTP ${health.status || health.transportError}`);
  if (!health.ok) {
    STATE.fatal = `API unreachable at ${BASE_URL}. Start the backend or pass TEST_API_URL / --spawn-server.`;
    return;
  }
  info('preflight', 'run identifiers', { runTag: RUN_TAG, strict: STRICT, keepData: KEEP_DATA, log: path.basename(LOG_FILE) });

  await signIn();
}

// One admin session for the whole run. Every endpoint this suite touches is either public
// or reachable by an administrator, so a single token covers all fifteen sections.
async function signIn() {
  const password = process.env.ADMIN_PASSWORD || '';
  if (!password) {
    record(SEVERITY.FAIL, 'auth / admin sign-in',
      'ADMIN_PASSWORD is not set. The API now rejects unauthenticated requests, so the suite cannot run without it.');
    STATE.fatal = 'ADMIN_PASSWORD missing from the environment';
    return false;
  }

  const res = await api('POST', '/auth/login', { identifier: 'admin', password, role: 'admin' });
  if (!res.ok || !res.data?.sessionToken) {
    record(SEVERITY.FAIL, 'auth / admin sign-in',
      `POST /auth/login -> HTTP ${res.status || res.transportError}: ${res.data?.error || 'no session token returned'}`);
    STATE.fatal = 'admin sign-in failed';
    return false;
  }

  STATE.authToken = res.data.sessionToken;
  check('Admin session token issued', true, `${STATE.authToken.slice(0, 12)}... role=${res.data.user?.role || 'unknown'}`);

  // Prove the guard is actually on: the same endpoint with no token must be refused.
  const saved = STATE.authToken;
  STATE.authToken = '';
  const unauthenticated = await api('GET', '/admin/overview');
  STATE.authToken = saved;
  check('Unauthenticated admin call is refused', unauthenticated.status === 401,
    `GET /admin/overview without a token -> HTTP ${unauthenticated.status}`);

  // And prove a non-admin session cannot reach the admin surface.
  const customerPhone = newPhone();
  const registered = await api('POST', '/auth/register', {
    name: `Integrity Guard ${RUN_TAG}`,
    phone: customerPhone,
    password: 'GuardCheck@12345',
    role: 'customer'
  });
  if (registered.ok) {
    const customerLogin = await api('POST', '/auth/login', {
      identifier: customerPhone,
      password: 'GuardCheck@12345',
      role: 'customer'
    });
    if (customerLogin.ok && customerLogin.data?.sessionToken) {
      STATE.authToken = customerLogin.data.sessionToken;
      const forbidden = await api('GET', '/admin/overview');
      STATE.authToken = saved;
      check('Customer session cannot reach /admin', forbidden.status === 403,
        `GET /admin/overview with a customer token -> HTTP ${forbidden.status}`);
      // LEDGER.users holds row ids, so the phone goes through track() for cleanup.
      track(customerPhone);
    } else {
      STATE.authToken = saved;
      record(SEVERITY.WARN, 'auth / role guard',
        `customer login for the role check failed: ${customerLogin.data?.error || customerLogin.status}`);
    }
  } else {
    record(SEVERITY.WARN, 'auth / role guard',
      `customer registration for the role check failed: ${registered.data?.error || registered.status}`);
  }

  return true;
}

let SERVER_PROC = null;

async function startServer() {
  try {
    SERVER_PROC = spawn(process.execPath, ['src/server.js'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, PORT: String(new URL(BASE_URL).port || 8080) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    SERVER_PROC.stdout.on('data', d => debug('server', String(d).trim().slice(0, 300)));
    SERVER_PROC.stderr.on('data', d => debug('server:err', String(d).trim().slice(0, 300)));
    SERVER_PROC.on('exit', code => debug('server', `exited with code ${code}`));

    // The auth routes pull in the WhatsApp socket stack, which can take up to a
    // minute to finish loading on a cold start. Wait generously, not 30s.
    let foreignResponder = 0;
    for (let i = 1; i <= 90; i += 1) {
      await new Promise(r => setTimeout(r, 1000));
      const res = await ping({ timeout: 3000 });
      if (res.ok) {
        info('preflight', 'backend started', `${BASE_URL} (pid ${SERVER_PROC.pid}) after ${i}s`);
        return true;
      }
      if (res.status === 404) {
        foreignResponder += 1;
        if (foreignResponder >= 10) {
          log('WARN', 'preflight',
            `${BASE_URL} is answered by another process that has no /health route`,
            'stop that process or pass TEST_API_URL pointing at this backend');
          return false;
        }
      }
      if (i % 15 === 0) info('preflight', `waiting for backend to bind ${BASE_URL}`, `${i}s elapsed`);
    }
    log('WARN', 'preflight', 'backend did not become healthy within 90s');
    return false;
  } catch (err) {
    log('WARN', 'preflight', 'could not start backend', err.message);
    return false;
  }
}

async function stopServer() {
  if (!SERVER_PROC) return;
  try {
    SERVER_PROC.kill();
    info('teardown', 'local backend stopped');
  } catch (_) { /* already gone */ }
  SERVER_PROC = null;
}

// ---------------------------------------------------------------------------
// Section 1: Registration -> users table -> admin customers panel
// ---------------------------------------------------------------------------

async function registrationSection() {
  sectionStart('registration', 'REGISTRATION - CUSTOMER AND PARTNER ACCOUNTS');

  const phone = newPhone();
  const formattedPhone = `+91 ${phone}`;
  const email = `integrity.${RUN_TAG}.${phone}@shazuone.test`;
  const name = `Integrity Customer ${RUN_TAG}`;
  const locality = 'Fairlands, Salem';
  const address = `12 Integrity Street, Fairlands, Salem - 636016`;
  const password = 'Salem@12345';
  track(phone, formattedPhone);

  ACTOR.customerPhone = formattedPhone;
  ACTOR.customerName = name;

  const res = await post('/auth/register', {
    name, phone: formattedPhone, email, password, role: 'customer', locality, address
  });

  checkHttp('register customer', res);
  if (!res.ok) {
    // The route swallows DB errors and still returns 200 in the happy path,
    // so a non 2xx here is an explicit validation or crash failure.
    record(SEVERITY.FAIL, 'register customer / business error', res.data?.error || 'no error message');
    return;
  }
  check('register customer / reports success', res.data?.success === true, res.data?.message);
  checkPresent('register customer / session token issued', res.data?.sessionToken);

  // ---- DB proof
  const user = await dbOne('SELECT * FROM users WHERE phone = $1', [formattedPhone]);
  if (user) LEDGER.users.push(user.id);

  checkFound('register customer', user, formattedPhone);
  if (user) {
    checkRow('register customer', user, {
      full_name: name,
      email,
      role: 'customer',
      locality,
      default_address: address,
      wallet_balance: 100
    });
    checkPresent('register customer / password_hash stored', user.password_hash);
    check('register customer / welcome credit is a number in DB',
      sameNumber(user.wallet_balance, 100), `wallet_balance=${user.wallet_balance}`);
    check('register customer / response id matches DB id',
      String(res.data?.user?.id) === String(user.id), `api=${res.data?.user?.id} db=${user.id}`);
  } else {
    record(SEVERITY.FAIL, 'register customer / row persisted',
      'the registration endpoint answered success but no users row exists for this phone');
  }

  // ---- Panel proof: /admin/customers is what the ops directory renders
  const panel = await get('/admin/customers');
  checkHttp('admin customers panel', panel);
  if (panel.ok) {
    const list = panel.data?.customers || [];
    const rows = list.filter(c => digitsOnly(c.customer_phone) === digitsOnly(phone));
    check('admin customers / registered customer is listed', rows.length >= 1,
      `${rows.length} row(s) for ${phone}`);
    if (rows.length === 1) {
      checkField('admin customers / customer_name', rows[0].customer_name, name);
      checkField('admin customers / locality', rows[0].locality, locality);
      checkField('admin customers / total_orders', rows[0].total_orders, 0);
    } else if (rows.length > 1) {
      record(SEVERITY.FAIL, 'admin customers / single identity per phone',
        `${rows.length} duplicate rows for one phone: ${rows.map(r => r.customer_phone).join(' | ')}`);
    }
  }

  // ---- Duplicate guard: same phone must be rejected, not silently ignored
  const dup = await post('/auth/register', { name, phone: formattedPhone, email, password, role: 'customer', locality, address });
  check('register customer / duplicate phone rejected', dup.status === 409,
    `HTTP ${dup.status} ${dup.data?.error || ''}`.slice(0, 160));

  // ---- Partner registration
  const techPhone = newPhone();
  const techFormatted = `+91 ${techPhone}`;
  const techEmail = `integrity.partner.${RUN_TAG}.${techPhone}@shazuone.test`;
  const techName = `Integrity Partner ${RUN_TAG}`;
  track(techPhone, techFormatted);

  ACTOR.techPhone = techFormatted;
  ACTOR.techName = techName;

  const techRes = await post('/auth/register', {
    name: techName, phone: techFormatted, email: techEmail, password,
    role: 'technician', trade: 'ac', locality: 'Suramangalam, Salem', aadhaar: '123456789012'
  });

  checkHttp('register partner', techRes);
  check('register partner / reports success', techRes.ok && techRes.data?.success === true, techRes.data?.message);

  const tech = await dbOne('SELECT * FROM technicians WHERE phone = $1', [techFormatted]);
  if (tech) {
    LEDGER.technicians.push(tech.id);
    ACTOR.techId = tech.id;
  }
  checkFound('register partner', tech, techFormatted);
  if (tech) {
    checkRow('register partner', tech, {
      full_name: techName,
      email: techEmail,
      primary_trade: 'ac',
      is_kyc_verified: false,
      is_online: false
    });
    checkPresent('register partner / password_hash stored', tech.password_hash);
    check('register partner / locality saved', Array.isArray(tech.assigned_localities) && tech.assigned_localities.length > 0,
      JSON.stringify(tech.assigned_localities));
    if (!tech.aadhaar_number) {
      record(SEVERITY.FAIL, 'register partner / aadhaar payload persisted',
        'the Aadhaar number sent at registration is returned in the API response but never written to technicians.aadhaar_number, so the ops KYC screen shows a blank document number');
    } else {
      checkField('register partner / aadhaar_number', tech.aadhaar_number, '123456789012');
    }
  } else {
    record(SEVERITY.FAIL, 'register partner / row persisted',
      'the partner registration endpoint answered success but no technicians row exists');
  }

  const mirror = await dbOne(`SELECT * FROM users WHERE phone = $1 AND role = 'technician'`, [techFormatted]);
  checkFound('register partner / mirror row in users', mirror, 'users table must expose the partner to admin lookups');
  if (mirror) LEDGER.users.push(mirror.id);

  const techPanel = await get('/admin/technicians');
  checkHttp('admin technicians panel', techPanel);
  if (techPanel.ok && tech) {
    const list = techPanel.data?.technicians || [];
    const listed = list.find(t => String(t.id) === String(tech.id));
    check('admin technicians / new partner is listed', Boolean(listed),
      listed ? `listed as ${listed.full_name}` : 'not present in /admin/technicians response');
    if (listed) {
      checkField('admin technicians / full_name', listed.full_name, techName);
      checkField('admin technicians / phone', listed.phone, techFormatted);
      checkField('admin technicians / is_kyc_verified', Boolean(listed.is_kyc_verified), false);
    }
  }
}

// ---------------------------------------------------------------------------
// Section 2: Login
// ---------------------------------------------------------------------------

async function loginSection() {
  sectionStart('login', 'LOGIN - CREDENTIAL VERIFICATION AND SESSION');

  if (!ACTOR.customerPhone) {
    skip('customer login', 'registration section did not create a customer');
    return;
  }

  const res = await post('/auth/login', {
    identifier: ACTOR.customerPhone, password: 'Salem@12345', role: 'customer'
  });
  checkHttp('login customer', res);
  if (res.ok) {
    check('login customer / identity returned', digitsOnly(res.data?.user?.phone) === digitsOnly(ACTOR.customerPhone),
      res.data?.user?.phone);
    check('login customer / role is customer', res.data?.user?.role === 'customer', res.data?.user?.role);
  }

  const wrong = await post('/auth/login', { identifier: ACTOR.customerPhone, password: 'wrong-password-123', role: 'customer' });
  check('login customer / wrong password rejected', wrong.status === 401, `HTTP ${wrong.status}`);

  if (!ACTOR.techPhone) {
    skip('partner login', 'registration section did not create a partner');
    return;
  }
  const techLogin = await post('/auth/login', { identifier: ACTOR.techPhone, password: 'Salem@12345', role: 'technician' });
  checkHttp('login partner', techLogin);
  if (techLogin.ok) {
    check('login partner / role is technician', techLogin.data?.user?.role === 'technician', techLogin.data?.user?.role);
  }
}

// ---------------------------------------------------------------------------
// Section 3: Booking creation -> bookings table -> admin overview and trace
// ---------------------------------------------------------------------------

const BOOKING = {
  id: null,
  serviceId: 'ac',
  address: '44 Integrity Avenue, Fairlands, Salem - 636016',
  locality: 'Fairlands',
  slot: '10:00 AM - 12:00 PM',
  couponCode: null,
  plainPhoneBookingId: null
};

async function bookingSection() {
  sectionStart('bookings', 'BOOKING CREATE - PAYLOAD, DATABASE ROW AND OPS VISIBILITY');

  if (!ACTOR.customerPhone) {
    skip('create booking', 'no registered customer available');
    return;
  }

  // A coupon is created first so the booking can prove discount persistence.
  const code = `INTEG${RUN_TAG}`;
  const couponRes = await post('/admin/coupons', {
    code, discountType: 'flat', discountValue: 20, minOrderAmount: 0,
    description: 'Integrity run discount', isActive: true
  });
  checkHttp('create coupon for booking', couponRes);
  if (couponRes.ok) {
    LEDGER.coupons.push(code);
    BOOKING.couponCode = code;
  }

  const payload = {
    serviceId: BOOKING.serviceId,
    issueId: 'ac_cooling',
    customIssueText: 'Integrity check cooling failure',
    customerName: ACTOR.customerName,
    customerPhone: ACTOR.customerPhone,
    address: BOOKING.address,
    locality: BOOKING.locality,
    lat: 11.6738,
    lng: 78.146,
    isUrgentDispatch: false,
    couponCode: BOOKING.couponCode,
    scheduledSlot: BOOKING.slot
  };

  const res = await post('/bookings/create', payload);
  checkHttp('create booking', res);
  if (!res.ok) {
    record(SEVERITY.FAIL, 'create booking / booking returned', res.data?.error || 'no booking in response');
    return;
  }
  check('create booking / reports success', res.data?.success === true, res.data?.message);

  const bookingId = res.data?.booking?.id;
  BOOKING.id = bookingId;
  checkPresent('create booking / booking id returned', bookingId);
  if (!bookingId) return;
  LEDGER.bookings.push(bookingId);

  // ---- DB proof: every submitted field must be stored verbatim
  const row = await dbOne('SELECT * FROM bookings WHERE id = $1', [bookingId]);
  checkFound('create booking', row, bookingId);
  if (row) {
    checkRow('create booking', row, {
      service_id: payload.serviceId,
      selected_issue_id: payload.issueId,
      customer_name: payload.customerName,
      customer_phone: payload.customerPhone,
      service_address: payload.address,
      locality: payload.locality,
      scheduled_slot: payload.scheduledSlot,
      status: 'created',
      is_urgent_dispatch: false
    });
    check('create booking / coordinates stored',
      sameNumber(row.customer_lat, 11.6738) && sameNumber(row.customer_lng, 78.146),
      `${row.customer_lat}, ${row.customer_lng}`);
    check('create booking / visit fee stored', sameNumber(row.visit_fee, 99), row.visit_fee);
    check('create booking / 4 digit safety OTP stored',
      /^\d{4}$/.test(String(row.customer_otp || '')), row.customer_otp);
    if (BOOKING.couponCode) {
      checkField('create booking / coupon_code', row.coupon_code, BOOKING.couponCode);
      check('create booking / coupon discount applied', sameNumber(row.coupon_discount, 20), row.coupon_discount);
      check('create booking / final amount reflects discount', sameNumber(row.final_amount, 79), row.final_amount);
    }
    check('create booking / status is a valid enum value',
      ['created', 'matching', 'accepted'].includes(String(row.status)), row.status);
  }

  // ---- Audit trail written by the create handler
  const audit = await dbOne(
    `SELECT * FROM audit_logs WHERE booking_id = $1 AND event_type = 'BOOKING_CREATED'`, [bookingId]
  );
  checkFound('create booking / audit log', audit, 'BOOKING_CREATED');
  if (audit) {
    const meta = typeof audit.metadata === 'string' ? JSON.parse(audit.metadata) : audit.metadata;
    check('create booking / audit metadata carries the amount',
      meta && sameNumber(meta.finalAmount, row?.final_amount), JSON.stringify(meta || {}).slice(0, 160));
  }

  // ---- Customer app read path
  const history = await get('/bookings/history');
  checkHttp('booking history', history);
  if (history.ok) {
    const found = (history.data?.bookings || []).find(b => String(b.id) === String(bookingId));
    check('booking history / new booking is listed', Boolean(found), bookingId);
    if (found) checkField('booking history / status', found.status, row?.status);
  }

  const track = await get(`/bookings/${bookingId}/track`);
  checkHttp('booking track', track);
  if (track.ok) {
    check('booking track / same booking returned', String(track.data?.booking?.id) === String(bookingId), track.data?.booking?.id);
  }

  // ---- Admin panel read paths
  const overview = await get('/admin/overview');
  checkHttp('admin overview panel', overview);
  if (overview.ok) {
    const listed = (overview.data?.recentBookings || []).find(b => String(b.id) === String(bookingId));
    check('admin overview / booking is listed', Boolean(listed), `${(overview.data?.recentBookings || []).length} recent rows`);
    if (listed) {
      checkField('admin overview / final_amount', listed.final_amount, row?.final_amount);
      checkField('admin overview / customer_name', listed.customer_name, payload.customerName);
    }
  }

  const trace = await get(`/admin/bookings/${bookingId}/trace`);
  checkHttp('admin booking trace', trace);
  if (trace.ok) {
    checkField('admin trace / booking id', trace.data?.booking?.id, bookingId);
    checkField('admin trace / status', trace.data?.booking?.status, row?.status);
    check('admin trace / audit logs attached', (trace.data?.auditLogs || []).length >= 1,
      `${(trace.data?.auditLogs || []).length} entries`);
  }

  // ---- Identity integrity: the ops directory must show ONE customer row
  const dbOrders = await dbCount(
    `SELECT count(*) FROM bookings WHERE RIGHT(REGEXP_REPLACE(customer_phone, '\\D', '', 'g'), 10) = $1`,
    [digitsOnly(ACTOR.customerPhone)]
  );
  const panel = await get('/admin/customers');
  if (panel.ok) {
    const rows = (panel.data?.customers || [])
      .filter(c => digitsOnly(c.customer_phone) === digitsOnly(ACTOR.customerPhone));
    check('admin customers / one row per customer identity', rows.length === 1,
      `${rows.length} row(s) for ${digitsOnly(ACTOR.customerPhone)}: ${rows.map(r => `${r.customer_phone}(orders=${r.total_orders})`).join(' | ')}`);
    if (rows.length === 1) {
      checkField('admin customers / total_orders matches database', Number(rows[0].total_orders), dbOrders);
    } else if (rows.length > 1) {
      const merged = rows.reduce((sum, r) => sum + Number(r.total_orders || 0), 0);
      record(SEVERITY.FAIL, 'admin customers / orders attributed to the registered account',
        `registration stores "${ACTOR.customerPhone}" while bookings store another format, so the panel splits one customer into ${rows.length} rows (${merged} orders total, spread across rows)`);
    }
  }

  // ---- Normalisation stress: booking with the bare 10 digit number
  const plainPhone = digitsOnly(ACTOR.customerPhone);
  const plainRes = await post('/bookings/create', { ...payload, couponCode: null, customerPhone: plainPhone });
  checkHttp('create booking with bare 10-digit phone', plainRes);
  if (plainRes.ok && plainRes.data?.booking?.id) {
    BOOKING.plainPhoneBookingId = plainRes.data.booking.id;
    LEDGER.bookings.push(BOOKING.plainPhoneBookingId);

    const plainRow = await dbOne('SELECT * FROM bookings WHERE id = $1', [BOOKING.plainPhoneBookingId]);
    checkFound('booking with bare phone / row persisted', plainRow, BOOKING.plainPhoneBookingId);

    const afterPanel = await get('/admin/customers');
    if (afterPanel.ok) {
      const rows = (afterPanel.data?.customers || [])
        .filter(c => digitsOnly(c.customer_phone) === digitsOnly(ACTOR.customerPhone));
      check('admin customers / phone formats do not split one customer', rows.length === 1,
        `${rows.length} rows after a booking was placed with "${plainPhone}": ${rows.map(r => r.customer_phone).join(' | ')}`);
    }
  }

  // ---- Validation guards must reject, not silently accept
  const noAddress = await post('/bookings/create', { ...payload, address: '' });
  check('create booking / missing address rejected', noAddress.status === 400, `HTTP ${noAddress.status}`);

  const outOfRegion = await post('/bookings/create', { ...payload, address: 'Anna Nagar, Chennai - 600040' });
  check('create booking / outside Salem region rejected', outOfRegion.status === 400,
    `HTTP ${outOfRegion.status} ${outOfRegion.data?.error || ''}`.slice(0, 180));
}

// ---------------------------------------------------------------------------
// Section 4: Status lifecycle, quote flow, completion
// ---------------------------------------------------------------------------

async function statusLifecycleSection() {
  sectionStart('status', 'STATUS CHANGES - EVERY TRANSITION PERSISTED AND TRACEABLE');

  if (!BOOKING.id || !ACTOR.techId) {
    skip('status lifecycle', 'booking or technician from earlier sections is missing');
    return;
  }
  const id = BOOKING.id;

  const assertTransition = async (label, target, expectedStatus) => {
    const res = await post(`/bookings/${id}/status`, { status: target, technicianId: ACTOR.techId });
    checkHttp(`status ${label}`, res);
    if (!res.ok) return null;

    const row = await dbOne('SELECT * FROM bookings WHERE id = $1', [id]);
    checkField(`status ${label} / db status`, row?.status, expectedStatus);

    const audit = await dbOne(
      `SELECT * FROM audit_logs WHERE booking_id = $1 AND event_type = $2`, [id, `STATUS_${target.toUpperCase()}`]
    );
    checkFound(`status ${label} / audit log`, audit, `STATUS_${target.toUpperCase()}`);

    const trace = await get(`/admin/bookings/${id}/trace`);
    if (trace.ok) checkField(`status ${label} / admin trace status`, trace.data?.booking?.status, expectedStatus);
    return row;
  };

  const accepted = await assertTransition('accepted', 'accepted', 'accepted');
  if (accepted) {
    check('status accepted / technician assigned', String(accepted.technician_id) === String(ACTOR.techId),
      `${accepted.technician_id} vs ${ACTOR.techId}`);
    checkPresent('status accepted / matched_at stamped', accepted.matched_at);
  }

  await assertTransition('en_route', 'en_route', 'en_route');

  const arrived = await assertTransition('arrived', 'arrived', 'arrived');
  if (arrived) {
    checkSoft('status arrived / arrived_at stamped on arrival',
      Boolean(arrived.arrived_at),
      arrived.arrived_at ? String(arrived.arrived_at) : 'arrived_at is NULL after the arrived transition');
  }

  // ---- Safety OTP gate (arrival -> inspecting)
  const beforeOtp = await dbOne('SELECT customer_otp FROM bookings WHERE id = $1', [id]);
  const badOtp = await post(`/bookings/${id}/verify-otp`, { otp: '0000', type: 'arrival' });
  check('verify OTP / wrong pin rejected', badOtp.status === 400, `HTTP ${badOtp.status}`);

  const goodOtp = await post(`/bookings/${id}/verify-otp`, { otp: beforeOtp?.customer_otp, type: 'arrival' });
  checkHttp('verify OTP arrival', goodOtp);
  const inspected = await dbOne('SELECT * FROM bookings WHERE id = $1', [id]);
  checkField('verify OTP arrival / db status', inspected?.status, 'inspecting');
  checkPresent('verify OTP arrival / arrived_at stamped', inspected?.arrived_at);

  const otpAudit = await dbOne(
    `SELECT * FROM audit_logs WHERE booking_id = $1 AND event_type = 'CUSTOMER_VERIFIED_TECH_DOORSTEP_OTP'`, [id]
  );
  checkFound('verify OTP arrival / audit log', otpAudit, 'CUSTOMER_VERIFIED_TECH_DOORSTEP_OTP');

  // ---- Guard: a quote cannot be presented without line items
  const premature = await post(`/bookings/${id}/status`, { status: 'quote_presented' });
  check('status quote_presented / blocked without quote items', premature.status === 400,
    `HTTP ${premature.status} ${premature.data?.error || ''}`.slice(0, 160));

  // ---- Real quote from the partner app
  const quoteRes = await post('/partner/quote', {
    bookingId: id,
    partsMode: 'tech_buys',
    items: [
      { name: 'Compressor relay replacement', type: 'Spare Part', price: 150, qty: 1, isOem: false },
      { name: 'Doorstep labour and gas top-up', type: 'Labor', price: 400, qty: 1 }
    ]
  });
  checkHttp('create partner quote', quoteRes);

  const quoteRows = await dbRows('SELECT * FROM quote_items WHERE booking_id = $1 ORDER BY price ASC', [id]);
  check('quote / line items persisted', quoteRows.length === 2, `${quoteRows.length} item(s)`);
  if (quoteRows.length === 2) {
    checkField('quote / first item name', quoteRows[0].item_name, 'Compressor relay replacement');
    checkField('quote / first item price', Number(quoteRows[0].price), 150);
    checkField('quote / second item name', quoteRows[1].item_name, 'Doorstep labour and gas top-up');
  }

  const quoted = await dbOne('SELECT * FROM bookings WHERE id = $1', [id]);
  checkField('quote / booking status', quoted?.status, 'quote_presented');
  check('quote / subtotal stored', sameNumber(quoted?.quote_subtotal, 550), quoted?.quote_subtotal);
  checkPresent('quote / quote_presented_at stamped', quoted?.quote_presented_at);

  const quotePanel = await get(`/bookings/${id}/quote`);
  checkHttp('quote read endpoint', quotePanel);
  if (quotePanel.ok) {
    const returned = quotePanel.data?.items || quotePanel.data?.quoteItems || [];
    check('quote / line items visible to the apps', returned.length === 2, `${returned.length} item(s)`);
  }

  // Keep the quote state for the file upload section, then approve.
  const approve = await post(`/bookings/${id}/approve-quote`, {});
  checkHttp('approve quote', approve);
  const approved = await dbOne('SELECT * FROM bookings WHERE id = $1', [id]);
  checkField('approve quote / db status', approved?.status, 'quote_approved');

  const completeOtp = await dbOne('SELECT customer_otp FROM bookings WHERE id = $1', [id]);
  const completion = await post(`/bookings/${id}/verify-otp`, {
    otp: completeOtp?.customer_otp, type: 'completion'
  });
  checkHttp('verify OTP completion', completion);

  const completed = await dbOne('SELECT * FROM bookings WHERE id = $1', [id]);
  checkField('completion / db status', completed?.status, 'completed');
  checkPresent('completion / completed_at stamped', completed?.completed_at);

  const completionAudit = await dbOne(
    `SELECT * FROM audit_logs WHERE booking_id = $1 AND event_type = 'COMPLETION_OTP_VERIFIED'`, [id]
  );
  checkFound('completion / audit log', completionAudit, 'COMPLETION_OTP_VERIFIED');

  const finishedTrace = await get(`/admin/bookings/${id}/trace`);
  if (finishedTrace.ok) {
    checkField('completion / admin trace status', finishedTrace.data?.booking?.status, 'completed');
    check('completion / admin trace keeps the full audit trail',
      (finishedTrace.data?.auditLogs || []).length >= 6, `${(finishedTrace.data?.auditLogs || []).length} entries`);
  }

  // ---- Admin cancel path on a separate booking (cannot cancel a completed one)
  const cancelRes = await post('/bookings/create', {
    serviceId: 'ac', customerName: ACTOR.customerName, customerPhone: ACTOR.customerPhone,
    address: BOOKING.address, locality: BOOKING.locality, scheduledSlot: BOOKING.slot
  });
  checkHttp('create booking for cancellation', cancelRes);
  const cancelId = cancelRes.data?.booking?.id;
  if (cancelId) {
    LEDGER.bookings.push(cancelId);
    const cancel = await post(`/bookings/${cancelId}/cancel`, {
      reason: 'Customer changed plans', reasonDetails: 'Integrity run cancellation', cancelledBy: 'customer'
    });
    checkHttp('cancel booking', cancel);

    const cancelled = await dbOne('SELECT * FROM bookings WHERE id = $1', [cancelId]);
    checkField('cancel booking / db status', cancelled?.status, 'cancelled');
    checkField('cancel booking / cancelled_by', cancelled?.cancelled_by, 'customer');
    checkField('cancel booking / cancellation_reason', cancelled?.cancellation_reason, 'Customer changed plans');
    checkPresent('cancel booking / cancelled_at stamped', cancelled?.cancelled_at);
    check('cancel booking / refund amount computed', sameNumber(cancelled?.refund_amount, Number(cancelled?.final_amount) * 0.96),
      `refund=${cancelled?.refund_amount} final=${cancelled?.final_amount}`);

    const cancelTrace = await get(`/admin/bookings/${cancelId}/trace`);
    if (cancelTrace.ok) checkField('cancel booking / admin trace status', cancelTrace.data?.booking?.status, 'cancelled');

    const guard = await post(`/bookings/${cancelId}/status`, { status: 'accepted' });
    check('cancel booking / cancelled booking cannot advance', guard.status === 400, `HTTP ${guard.status}`);
  }
}

// ---------------------------------------------------------------------------
// Section 5: Files - generic upload, aadhaar KYC, parts bill
// ---------------------------------------------------------------------------

async function filesSection() {
  sectionStart('files', 'FILE UPLOADS - STORAGE, AADHAAR KYC AND PARTS BILL');

  // ---- Generic upload + retrieval
  const upload = await post('/storage/upload', {
    fileData: PNG_1PX_B64, mimeType: 'image/png', folder: 'uploads',
    referenceId: `integrity_${RUN_TAG}`, fileName: 'integrity.png'
  });
  checkHttp('storage upload', upload);
  if (upload.ok) {
    checkPresent('storage upload / key returned', upload.data?.key);
    check('storage upload / stored in durable S3', upload.data?.storageType === 'S3_NEON',
      `storageType=${upload.data?.storageType}${upload.data?.warning ? ` (${upload.data.warning})` : ''}`);
    check('storage upload / byte size matches payload', Number(upload.data?.size) === Buffer.from(PNG_1PX_B64, 'base64').length,
      `${upload.data?.size} bytes`);

    if (upload.data?.key && upload.data?.storageType === 'S3_NEON') {
      const info = await get(`/storage/info?key=${encodeURIComponent(upload.data.key)}`);
      checkHttp('storage info', info);
      if (info.ok) {
        checkField('storage info / content type', info.data?.contentType, 'image/png');
        checkField('storage info / key', info.data?.key, upload.data.key);
      }
      const view = await get(`/storage/view?key=${encodeURIComponent(upload.data.key)}`);
      check('storage view / object streams back', view.status === 200, `HTTP ${view.status}`);
    }
  }

  // ---- Aadhaar KYC document -> technicians.aadhaar_card_url -> admin panel
  if (ACTOR.techPhone && ACTOR.techId) {
    const aadhaar = await post('/partner/aadhaar/upload', {
      fileData: PNG_1PX_B64, mimeType: 'image/png', phone: ACTOR.techPhone, fileName: 'aadhaar.png'
    });
    checkHttp('aadhaar upload', aadhaar);

    const tech = await dbOne('SELECT * FROM technicians WHERE id = $1', [ACTOR.techId]);
    checkPresent('aadhaar upload / technicians.aadhaar_card_url', tech?.aadhaar_card_url);
    checkPresent('aadhaar upload / technicians.aadhaar_uploaded_at', tech?.aadhaar_uploaded_at);
    if (aadhaar.ok) {
      checkField('aadhaar upload / response url equals stored url', tech?.aadhaar_card_url, aadhaar.data?.url || aadhaar.data?.aadhaarCardUrl);
    }

    const panel = await get('/admin/technicians');
    if (panel.ok) {
      const listed = (panel.data?.technicians || []).find(t => String(t.id) === String(ACTOR.techId));
      check('aadhaar upload / document visible in admin technicians', Boolean(listed?.aadhaar_card_url),
        listed?.aadhaar_card_url ? 'url present' : 'aadhaar_card_url empty in panel payload');
      if (listed) check('aadhaar upload / panel shows same document',
        String(listed.aadhaar_card_url) === String(tech?.aadhaar_card_url), 'url mismatch between DB and panel');
    }
  } else {
    skip('aadhaar upload', 'no partner account available');
  }

  // ---- Parts bill -> bookings.parts_bill_* -> admin trace
  if (!BOOKING.id) {
    skip('parts bill upload', 'no booking available');
    return;
  }
  const bill = await post(`/partner/bookings/${BOOKING.id}/upload-bill`, {
    fileData: PNG_1PX_B64, mimeType: 'image/png', billAmount: 150, fileName: 'bill.png'
  });
  checkHttp('parts bill upload', bill);

  const row = await dbOne('SELECT * FROM bookings WHERE id = $1', [BOOKING.id]);
  checkPresent('parts bill / bookings.parts_bill_url', row?.parts_bill_url);
  checkPresent('parts bill / bookings.parts_bill_uploaded_at', row?.parts_bill_uploaded_at);
  check('parts bill / amount stored', sameNumber(row?.parts_bill_amount, 150), row?.parts_bill_amount);
  check('parts bill / quote subtotal recomputed from bill plus labour', sameNumber(row?.quote_subtotal, 550), row?.quote_subtotal);

  const trace = await get(`/admin/bookings/${BOOKING.id}/trace`);
  if (trace.ok) {
    checkPresent('parts bill / visible in admin booking trace', trace.data?.booking?.parts_bill_url);
  }

  const billRead = await get(`/partner/bookings/${BOOKING.id}/bill`);
  check('parts bill / partner bill endpoint responds', [200, 404].includes(billRead.status),
    `HTTP ${billRead.status}`);

  const audit = await dbOne(
    `SELECT * FROM audit_logs WHERE booking_id = $1 AND event_type = 'PARTS_BILL_UPLOADED'`, [BOOKING.id]
  );
  checkFound('parts bill / audit log', audit, 'PARTS_BILL_UPLOADED');
}

// ---------------------------------------------------------------------------
// Section 6: Platform feedback -> platform_feedback -> admin feedback desk
// ---------------------------------------------------------------------------

async function feedbackSection() {
  sectionStart('feedback', 'FEEDBACK - SUBMIT, ADMIN DESK VISIBILITY, STATUS UPDATE');

  if (!ACTOR.customerPhone) {
    skip('submit feedback', 'no registered customer available');
    return;
  }

  const message = `Integrity feedback ${RUN_TAG}: the technician arrived on time and explained the repair clearly.`;
  const subject = `Integrity feedback ${RUN_TAG}`;

  const res = await post('/feedback/submit', {
    userId: LEDGER.users[0] || null,
    userName: ACTOR.customerName,
    userPhone: ACTOR.customerPhone,
    role: 'customer',
    feedbackType: 'service_quality',
    rating: 5,
    subject,
    message,
    locality: 'Fairlands, Salem'
  });
  checkHttp('submit feedback', res);
  if (!res.ok) {
    record(SEVERITY.FAIL, 'submit feedback / record returned', res.data?.error || 'no feedback in response');
    return;
  }

  const id = res.data?.feedback?.id;
  checkPresent('submit feedback / id returned', id);
  if (!id) return;
  LEDGER.feedback.push(id);
  LEDGER.auditMarkers.push(`SYSTEM-FEEDBACK-${id}`);

  const row = await dbOne('SELECT * FROM platform_feedback WHERE id = $1', [id]);
  checkFound('submit feedback', row, `platform_feedback#${id}`);
  if (row) {
    checkRow('submit feedback', row, {
      user_phone: ACTOR.customerPhone,
      user_name: ACTOR.customerName,
      role: 'customer',
      feedback_type: 'service_quality',
      rating: 5,
      subject,
      message,
      status: 'new'
    });
  }

  const panel = await get('/feedback/list');
  checkHttp('admin feedback panel', panel);
  if (panel.ok) {
    const listed = (panel.data?.feedbacks || panel.data?.feedback || []).find(f => String(f.id) === String(id));
    check('admin feedback / new entry is listed', Boolean(listed), `${(panel.data?.count ?? 0)} entries`);
    if (listed) checkField('admin feedback / message', listed.message, message);
  }

  const filtered = await get('/feedback?role=customer&status=new');
  if (filtered.ok) {
    const listed = (filtered.data?.feedbacks || []).filter(f => String(f.id) === String(id));
    check('admin feedback / role and status filters return the entry', listed.length === 1, `${listed.length} match(es)`);
  }

  const audit = await dbOne(
    `SELECT * FROM audit_logs WHERE booking_id = $1 AND event_type = 'PLATFORM_FEEDBACK_SUBMITTED'`,
    [`SYSTEM-FEEDBACK-${id}`]
  );
  checkFound('submit feedback / audit log', audit, 'PLATFORM_FEEDBACK_SUBMITTED');

  // Wallet reward is an expected side effect of feedback; silent loss is money lost.
  const reward = await dbOne(
    `SELECT * FROM wallet_transactions
     WHERE RIGHT(REGEXP_REPLACE(user_phone, '\\D', '', 'g'), 10) = $1 AND category = 'FEEDBACK_REWARD'
     ORDER BY created_at DESC LIMIT 1`,
    [digitsOnly(ACTOR.customerPhone)]
  );
  checkSoft('submit feedback / wallet reward credited', Boolean(reward),
    reward ? `${reward.amount} credits` : 'no FEEDBACK_REWARD ledger row: the phone match in the reward update misses the registered "+91 " format');

  const update = await post(`/feedback/${id}/status`, { status: 'resolved', adminNotes: 'Closed by integrity run' });
  checkHttp('update feedback status', update);
  const resolved = await dbOne('SELECT * FROM platform_feedback WHERE id = $1', [id]);
  checkField('update feedback status / db status', resolved?.status, 'resolved');
  checkField('update feedback status / admin notes', resolved?.admin_notes, 'Closed by integrity run');
}

// ---------------------------------------------------------------------------
// Section 7: Support tickets -> support_tickets -> admin ticket queue
// ---------------------------------------------------------------------------

async function ticketsSection() {
  sectionStart('tickets', 'SUPPORT TICKETS - CREATE, USER VIEW, ADMIN QUEUE, RESOLVE');

  if (!ACTOR.customerPhone) {
    skip('create ticket', 'no registered customer available');
    return;
  }

  const subject = `Integrity ticket ${RUN_TAG}`;
  const description = 'Doorstep technician reported a part delay, requesting an ops callback.';
  const phone = ACTOR.customerPhone;

  const res = await post('/tickets/create', {
    creatorName: ACTOR.customerName,
    creatorRole: 'customer',
    creatorPhone: phone,
    bookingId: BOOKING.id || null,
    category: 'booking',
    priority: 'high',
    subject,
    description,
    locality: 'Fairlands, Salem'
  });
  checkHttp('create ticket', res);
  if (!res.ok) {
    record(SEVERITY.FAIL, 'create ticket / record returned', res.data?.error || 'no ticket in response');
    return;
  }

  const id = res.data?.ticket?.id;
  checkPresent('create ticket / ticket id', id);
  if (!id) return;
  LEDGER.tickets.push(id);

  const row = await dbOne('SELECT * FROM support_tickets WHERE id = $1', [id]);
  checkFound('create ticket', row, id);
  if (row) {
    checkRow('create ticket', row, {
      creator_name: ACTOR.customerName,
      creator_phone: phone,
      creator_role: 'customer',
      category: 'booking',
      priority: 'high',
      subject,
      description,
      status: 'open'
    });
    checkField('create ticket / booking reference', row.booking_id, BOOKING.id);
    checkPresent('create ticket / ticket number generated', row.ticket_number);
    checkField('create ticket / ticket number echoed', res.data?.ticketNumber, row.ticket_number);
  }

  const audit = await dbOne(
    `SELECT * FROM audit_logs WHERE booking_id = $1 AND event_type = 'TICKET_CREATED'`, [BOOKING.id || 'SUPPORT']
  );
  checkFound('create ticket / audit log', audit, 'TICKET_CREATED');

  const mine = await get(`/tickets/user/${encodeURIComponent(phone)}`);
  checkHttp('ticket user view', mine);
  if (mine.ok) {
    const listed = (mine.data?.tickets || []).find(t => String(t.id) === String(id));
    check('ticket user view / ticket listed for the customer', Boolean(listed), `${(mine.data?.count ?? 0)} ticket(s)`);
  }

  const queue = await get('/admin/tickets?limit=200');
  checkHttp('admin ticket queue', queue);
  if (queue.ok) {
    const listed = (queue.data?.tickets || []).find(t => String(t.id) === String(id));
    check('admin ticket queue / ticket is listed', Boolean(listed), `${(queue.data?.count ?? 0)} ticket(s)`);
    if (listed) {
      checkField('admin ticket queue / priority', listed.priority, 'high');
      checkField('admin ticket queue / subject', listed.subject, subject);
    }
  }

  const filtered = await get('/admin/tickets?status=open&category=booking&limit=200');
  if (filtered.ok) {
    const listed = (filtered.data?.tickets || []).filter(t => String(t.id) === String(id));
    check('admin ticket queue / status and category filters work', listed.length === 1, `${listed.length} match(es)`);
  }

  const resolve = await patch(`/admin/tickets/${id}/resolve`, {
    status: 'resolved',
    adminNotes: 'Called the customer and released the part.',
    resolutionSummary: 'Part delivered, service completed.',
    resolvedBy: 'Integrity Ops'
  });
  const resolveOk = checkHttp('resolve ticket', resolve);

  if (!resolveOk) {
    skip('resolve ticket / persistence', 'the endpoint returned an error, so there is no resolution to verify');
  } else {
    const resolved = await dbOne('SELECT * FROM support_tickets WHERE id = $1', [id]);
    checkField('resolve ticket / db status', resolved?.status, 'resolved');
    checkField('resolve ticket / resolved_by', resolved?.resolved_by, 'Integrity Ops');
    checkField('resolve ticket / admin_notes', resolved?.admin_notes, 'Called the customer and released the part.');
    checkPresent('resolve ticket / resolved_at stamped', resolved?.resolved_at);
  }

  const guard = await post('/tickets/create', { creatorPhone: phone, category: 'booking' });
  check('create ticket / missing subject rejected', guard.status === 400, `HTTP ${guard.status}`);
}

// ---------------------------------------------------------------------------
// Section 8: Reviews -> reviews -> public reviews and ops escalation
// ---------------------------------------------------------------------------

async function reviewsSection() {
  sectionStart('reviews', 'REVIEWS - RATING, ESCALATION AND PUBLIC LISTING');

  if (!BOOKING.id) {
    skip('submit review', 'no completed booking available');
    return;
  }

  const comment = `Integrity review ${RUN_TAG}: fast, tidy and explained the fix.`;
  const res = await post('/reviews/submit', {
    bookingId: BOOKING.id, rating: 5, comment, tags: ['Punctual', 'Neat work']
  });
  checkHttp('submit 5 star review', res);
  if (!res.ok) {
    record(SEVERITY.FAIL, 'submit 5 star review / record returned', res.data?.error || 'no review in response');
  }

  const row = await dbOne('SELECT * FROM reviews WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1', [BOOKING.id]);
  checkFound('submit 5 star review', row, BOOKING.id);
  if (row) LEDGER.reviews.push(row.id);
  if (row) {
    checkRow('submit 5 star review', row, {
      booking_id: BOOKING.id,
      rating: 5,
      comment,
      is_below_3_star: false,
      ops_manager_escalated: false
    });
    check('submit 5 star review / tags stored',
      Array.isArray(row.tags) && row.tags.includes('Punctual'), JSON.stringify(row.tags));
  }

  const bookingRow = await dbOne('SELECT status FROM bookings WHERE id = $1', [BOOKING.id]);
  checkField('submit review / booking marked completed', bookingRow?.status, 'completed');

  const list = await get('/reviews?limit=100');
  checkHttp('public reviews list', list);
  if (list.ok && row) {
    const listed = (list.data?.reviews || []).find(r => String(r.id) === String(row.id));
    check('public reviews / new review is listed', Boolean(listed), `${(list.data?.count ?? 0)} review(s)`);
    if (listed) checkField('public reviews / comment', listed.comment, comment);
  }

  const stats = await get('/reviews/stats');
  if (stats.ok) {
    const total = Number(stats.data?.stats?.total_reviews ?? stats.data?.total_reviews ?? 0);
    check('public review stats / total count is positive', total >= 1, `total_reviews=${total}`);
  }

  const reward = await dbOne(
    `SELECT * FROM wallet_transactions
     WHERE RIGHT(REGEXP_REPLACE(user_phone, '\\D', '', 'g'), 10) = $1 AND category = 'REVIEW_REWARD'
     ORDER BY created_at DESC LIMIT 1`,
    [digitsOnly(ACTOR.customerPhone)]
  );
  checkSoft('submit review / wallet reward credited', Boolean(reward),
    reward ? `${reward.amount} credits` : 'no REVIEW_REWARD ledger row: the reward update targets bookings.customer_id, which booking create never populates');

  // ---- Low rating escalation into the ops queue
  const lowRes = await post('/bookings/create', {
    serviceId: 'ac', customerName: ACTOR.customerName, customerPhone: ACTOR.customerPhone,
    address: BOOKING.address, locality: BOOKING.locality, scheduledSlot: BOOKING.slot
  });
  const lowBookingId = lowRes.data?.booking?.id;
  if (!lowBookingId) {
    skip('submit 2 star review', 'could not create a booking for the escalation check');
    return;
  }
  LEDGER.bookings.push(lowBookingId);

  const lowReview = await post('/reviews/submit', {
    bookingId: lowBookingId, rating: 2, comment: 'Integrity escalation check', tags: ['Delay'],
    rootCauseTags: ['Late arrival']
  });
  checkHttp('submit 2 star review', lowReview);

  const lowRow = await dbOne('SELECT * FROM reviews WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1', [lowBookingId]);
  checkFound('submit 2 star review', lowRow, lowBookingId);
  if (lowRow) {
    checkRow('submit 2 star review', lowRow, {
      rating: 2,
      is_below_3_star: true,
      ops_manager_escalated: true
    });
  }

  const overview = await get('/admin/overview');
  if (overview.ok) {
    const pending = Number(overview.data?.metrics?.disputesPending ?? overview.data?.disputesPending ?? 0);
    check('admin overview / escalated disputes counted', pending >= 1, `disputesPending=${pending}`);
  }
}

// ---------------------------------------------------------------------------
// Section 9: Coupons - admin CRUD and discount persistence on a booking
// ---------------------------------------------------------------------------

async function couponsSection() {
  sectionStart('coupons', 'COUPONS - CREATE, EDIT, APPLY, DELETE');

  const code = `INTDEL${RUN_TAG}`;
  const created = await post('/admin/coupons', {
    code, discountType: 'percent', discountValue: 10, minOrderAmount: 0,
    maxDiscountCap: 50, description: 'Integrity delete path', isActive: true, usageLimit: 100
  });
  checkHttp('create coupon', created);
  if (!created.ok) return;
  LEDGER.coupons.push(code);

  const row = await dbOne('SELECT * FROM coupons WHERE code = $1', [code]);
  checkFound('create coupon', row, code);
  if (row) {
    checkRow('create coupon', row, {
      code,
      discount_type: 'percent',
      discount_value: 10,
      min_order_amount: 0,
      max_discount_cap: 50,
      is_active: true,
      usage_limit: 100,
      times_used: 0
    });
  }

  const panel = await get('/admin/coupons');
  checkHttp('admin coupon panel', panel);
  if (panel.ok) {
    const listed = (panel.data?.coupons || []).find(c => c.code === code);
    check('admin coupon panel / new coupon is listed', Boolean(listed), `${(panel.data?.count ?? 0)} coupon(s)`);
    if (listed) {
      checkField('admin coupon panel / discount type', listed.discountType, 'percent');
      checkField('admin coupon panel / discount value', listed.discountValue, 10);
      checkField('admin coupon panel / active flag', listed.isActive, true);
    }
  }

  // ---- Usage counter increments when a booking applies the coupon
  const useRes = await post('/bookings/create', {
    serviceId: 'ac', customerName: ACTOR.customerName, customerPhone: ACTOR.customerPhone,
    address: BOOKING.address, locality: BOOKING.locality, couponCode: code, scheduledSlot: BOOKING.slot
  });
  const usedBookingId = useRes.data?.booking?.id;
  if (usedBookingId) {
    LEDGER.bookings.push(usedBookingId);
    const booked = await dbOne('SELECT * FROM bookings WHERE id = $1', [usedBookingId]);
    checkField('coupon applied / booking stores the code', booked?.coupon_code, code);
    check('coupon applied / 10 percent of the 99 fee discounted', sameNumber(booked?.coupon_discount, 9.9),
      booked?.coupon_discount);
    const afterUse = await dbOne('SELECT times_used FROM coupons WHERE code = $1', [code]);
    checkField('coupon applied / times_used incremented', Number(afterUse?.times_used), 1);
  } else {
    record(SEVERITY.FAIL, 'coupon applied / booking created', useRes.data?.error || 'no booking returned');
  }

  // ---- Edit
  const update = await put(`/admin/coupons/${row?.id}`, {
    discountValue: 35, isActive: false, description: 'Integrity edited'
  });
  checkHttp('update coupon', update);
  const updated = await dbOne('SELECT * FROM coupons WHERE code = $1', [code]);
  checkField('update coupon / discount_value', Number(updated?.discount_value), 35);
  checkField('update coupon / is_active', updated?.is_active, false);
  checkField('update coupon / description', updated?.description, 'Integrity edited');

  // ---- Delete
  const removed = await del(`/admin/coupons/${row?.id}`);
  checkHttp('delete coupon', removed);
  const gone = await dbOne('SELECT * FROM coupons WHERE code = $1', [code]);
  check('delete coupon / row removed from DB', gone === null, gone ? 'row still present' : 'removed');
  const panelAfter = await get('/admin/coupons');
  if (panelAfter.ok) {
    const listed = (panelAfter.data?.coupons || []).find(c => c.code === code);
    check('delete coupon / removed from admin panel', !listed, listed ? 'still listed' : 'not listed');
  }
}

// ---------------------------------------------------------------------------
// Section 10: Internal team RBAC
// ---------------------------------------------------------------------------

async function teamSection() {
  sectionStart('team', 'ADMIN TEAM - INVITE, EDIT, DELETE');

  const email = `integrity.${RUN_TAG}@shazuone.test`;
  const created = await post('/admin/team', {
    name: `Integrity Dispatcher ${RUN_TAG}`,
    email,
    phone: '+91 94400 00000',
    role: 'ops_dispatcher',
    hub_locality: 'Integrity Hub',
    permissions: ['dispatch', 'tracking']
  });
  checkHttp('create team member', created);
  if (!created.ok) {
    record(SEVERITY.FAIL, 'create team member / member returned', created.data?.error || 'no member in response');
    return;
  }

  const memberId = created.data?.member?.id || created.data?.id;
  checkPresent('create team member / id returned', memberId);
  if (!memberId) return;
  LEDGER.team.push(memberId);

  const row = await dbOne('SELECT * FROM admin_team WHERE id = $1', [memberId]);
  checkFound('create team member', row, email);
  if (row) {
    checkRow('create team member', row, {
      email,
      role: 'ops_dispatcher',
      hub_locality: 'Integrity Hub',
      status: 'active'
    });
    check('create team member / permissions stored',
      Array.isArray(row.permissions) ? row.permissions.includes('dispatch') : String(row.permissions).includes('dispatch'),
      JSON.stringify(row.permissions));
  }

  const panel = await get('/admin/team');
  checkHttp('admin team panel', panel);
  if (panel.ok) {
    const listed = (panel.data?.team || []).find(m => String(m.id) === String(memberId));
    check('admin team panel / member is listed', Boolean(listed), `${(panel.data?.count ?? 0)} member(s)`);
  }

  const updated = await put(`/admin/team/${memberId}`, { role: 'finance_officer', status: 'suspended' });
  checkHttp('update team member', updated);
  const afterUpdate = await dbOne('SELECT * FROM admin_team WHERE id = $1', [memberId]);
  checkField('update team member / role', afterUpdate?.role, 'finance_officer');
  checkField('update team member / status', afterUpdate?.status, 'suspended');

  const removed = await del(`/admin/team/${memberId}`);
  checkHttp('delete team member', removed);
  const gone = await dbOne('SELECT * FROM admin_team WHERE id = $1', [memberId]);
  check('delete team member / row removed', gone === null, gone ? 'row still present' : 'removed');
}

// ---------------------------------------------------------------------------
// Section 11: Admin enforcement actions (KYC, online, block)
// ---------------------------------------------------------------------------

async function adminOpsSection() {
  sectionStart('ops', 'ADMIN ENFORCEMENT - KYC, ONLINE TOGGLE, BLOCK AND UNBLOCK');

  if (!ACTOR.techId || !ACTOR.techPhone) {
    skip('admin ops on partner', 'no partner account available');
  } else {
    const online = await post(`/admin/technicians/${ACTOR.techId}/toggle-online`, {});
    checkHttp('toggle partner online', online);
    const onlineRow = await dbOne('SELECT is_online FROM technicians WHERE id = $1', [ACTOR.techId]);
    checkField('toggle partner online / db flag', onlineRow?.is_online, true);

    const kyc = await post(`/admin/technicians/${ACTOR.techId}/verify-kyc`, { action: 'approve' });
    checkHttp('approve partner KYC', kyc);
    const kycRow = await dbOne('SELECT * FROM technicians WHERE id = $1', [ACTOR.techId]);
    checkField('approve partner KYC / is_kyc_verified', kycRow?.is_kyc_verified, true);
    checkPresent('approve partner KYC / kyc_verified_at', kycRow?.kyc_verified_at);

    const kycMarker = `TECH-KYC-${ACTOR.techPhone}`;
    LEDGER.auditMarkers.push(kycMarker);
    const kycAudit = await dbOne(
      `SELECT * FROM audit_logs WHERE booking_id = $1 AND event_type = 'TECH_KYC_APPROVED'`, [kycMarker]
    );
    checkFound('approve partner KYC / audit log', kycAudit, 'TECH_KYC_APPROVED');

    const blockTech = await post(`/admin/technicians/${ACTOR.techId}/toggle-block`, { isBlocked: true, reason: 'Integrity block test' });
    checkHttp('block partner', blockTech);
    const blockedTech = await dbOne('SELECT * FROM technicians WHERE id = $1', [ACTOR.techId]);
    checkField('block partner / is_blocked', blockedTech?.is_blocked, true);
    checkField('block partner / block_reason', blockedTech?.block_reason, 'Integrity block test');
    checkPresent('block partner / blocked_at', blockedTech?.blocked_at);

    await post(`/admin/technicians/${ACTOR.techId}/toggle-block`, { isBlocked: false });
    const unblockedTech = await dbOne('SELECT * FROM technicians WHERE id = $1', [ACTOR.techId]);
    checkField('unblock partner / is_blocked', unblockedTech?.is_blocked, false);

    const panel = await get('/admin/technicians?is_kyc=true');
    if (panel.ok) {
      const listed = (panel.data?.technicians || []).find(t => String(t.id) === String(ACTOR.techId));
      check('admin technicians / KYC filter returns the verified partner', Boolean(listed), `${(panel.data?.count ?? 0)} verified`);
    }
  }

  if (!ACTOR.customerPhone) {
    skip('admin ops on customer', 'no registered customer available');
    return;
  }

  const block = await post(`/admin/customers/${encodeURIComponent(ACTOR.customerPhone)}/toggle-block`, {
    isBlocked: true, reason: 'Integrity block test'
  });
  checkHttp('block customer', block);

  const blocked = await dbOne('SELECT * FROM users WHERE phone = $1', [ACTOR.customerPhone]);
  checkField('block customer / is_blocked', blocked?.is_blocked, true);
  checkField('block customer / block_reason', blocked?.block_reason, 'Integrity block test');
  checkPresent('block customer / blocked_at', blocked?.blocked_at);

  const blockMarker = `USER-BLOCK-+91${digitsOnly(ACTOR.customerPhone)}`;
  LEDGER.auditMarkers.push(blockMarker);
  const blockAudit = await dbOne(
    `SELECT * FROM audit_logs WHERE booking_id = $1 AND event_type = 'CUSTOMER_BLOCKED'`, [blockMarker]
  );
  checkFound('block customer / audit log', blockAudit, 'CUSTOMER_BLOCKED');

  const panel = await get('/admin/customers');
  if (panel.ok) {
    const listed = (panel.data?.customers || []).find(c => digitsOnly(c.customer_phone) === digitsOnly(ACTOR.customerPhone));
    checkField('block customer / admin panel shows the block', Boolean(listed?.is_blocked), true);
  }

  const blockedBooking = await post('/bookings/create', {
    serviceId: 'ac', customerName: ACTOR.customerName, customerPhone: ACTOR.customerPhone,
    address: BOOKING.address, locality: BOOKING.locality, scheduledSlot: BOOKING.slot
  });
  check('block customer / booking is refused while blocked', blockedBooking.status === 403,
    `HTTP ${blockedBooking.status} ${blockedBooking.data?.error || ''}`.slice(0, 160));

  const unblock = await post(`/admin/customers/${encodeURIComponent(ACTOR.customerPhone)}/toggle-block`, { isBlocked: false });
  checkHttp('unblock customer', unblock);
  const restored = await dbOne('SELECT * FROM users WHERE phone = $1', [ACTOR.customerPhone]);
  checkField('unblock customer / is_blocked', restored?.is_blocked, false);
  checkField('unblock customer / block_reason cleared', restored?.block_reason, null);
}

// ---------------------------------------------------------------------------
// Section 12: Service catalogue
// ---------------------------------------------------------------------------

async function servicesSection() {
  sectionStart('services', 'SERVICE CATALOGUE - CREATE, EDIT, DELETE');

  const id = `integrity-${RUN_TAG}`;
  const created = await post('/admin/services', {
    id,
    name_en: `Integrity Service ${RUN_TAG}`,
    name_ta: `Integrity Service ${RUN_TAG}`,
    category: 'Home Maintenance',
    visitFee: 149,
    estPriceRangeEn: 'INR 299 - INR 1,499',
    estPriceRangeTa: 'INR 299 - INR 1,499',
    icon: 'home_repair_service',
    colorHex: '#0284c7',
    isActive: true
  });
  checkHttp('create service', created);
  if (!created.ok) {
    record(SEVERITY.FAIL, 'create service / service returned', created.data?.error || 'no service in response');
    return;
  }
  LEDGER.services.push(id);

  const row = await dbOne('SELECT * FROM services WHERE id = $1', [id]);
  checkFound('create service', row, id);
  if (row) {
    checkRow('create service', row, {
      name_en: `Integrity Service ${RUN_TAG}`,
      category: 'Home Maintenance',
      visit_fee: 149,
      is_active: true
    });
  }

  const panel = await get('/admin/services');
  checkHttp('admin services panel', panel);
  if (panel.ok) {
    const listed = (panel.data?.services || []).find(s => s.id === id);
    check('admin services / new service is listed', Boolean(listed), `${(panel.data?.count ?? 0)} service(s)`);
    if (listed) checkField('admin services / inspection fee', listed.visitFee, 149);
  }

  const updated = await put(`/admin/services/${id}`, { visitFee: 199, isActive: false });
  checkHttp('update service', updated);
  const afterUpdate = await dbOne('SELECT * FROM services WHERE id = $1', [id]);
  checkField('update service / visit_fee', Number(afterUpdate?.visit_fee), 199);
  checkField('update service / is_active', afterUpdate?.is_active, false);

  const fee = await patch(`/admin/services/${id}/fee`, { visitFee: 249 });
  checkHttp('update service fee', fee);
  const afterFee = await dbOne('SELECT visit_fee FROM services WHERE id = $1', [id]);
  checkField('update service fee / visit_fee', Number(afterFee?.visit_fee), 249);

  const removed = await del(`/admin/services/${id}`);
  checkHttp('delete service', removed);
  const gone = await dbOne('SELECT * FROM services WHERE id = $1', [id]);
  check('delete service / row removed', gone === null, gone ? 'row still present' : 'removed');
}

// ---------------------------------------------------------------------------
// Section 13: Reward and commission settings
// ---------------------------------------------------------------------------

async function settingsSection() {
  sectionStart('settings', 'PLATFORM SETTINGS - READ, UPDATE, PERSIST, RESTORE');

  const before = await get('/admin/reward-config');
  checkHttp('read reward settings', before);
  if (!before.ok) return;

  const original = before.data?.settings || {};
  const originalReview = Number(original.review_reward_credits);
  const originalCommission = Number(original.platform_commission_percent);
  const testReview = originalReview === 33 ? 34 : 33;

  const update = await post('/admin/settings/rewards', {
    review_reward_credits: testReview,
    platform_commission_percent: 3,
    updated_by: `integrity_run_${RUN_TAG}`
  });
  checkHttp('update reward settings', update);

  const row = await dbOne(`SELECT * FROM platform_settings WHERE id = 'reward_settings'`);
  checkFound('update reward settings', row, 'platform_settings#reward_settings');
  if (row) {
    checkField('update reward settings / review_reward_credits', Number(row.review_reward_credits), testReview);
    checkField('update reward settings / platform_commission_percent', Number(row.platform_commission_percent), 3);
    checkField('update reward settings / updated_by', row.updated_by, `integrity_run_${RUN_TAG}`);
  }

  const after = await get('/admin/settings/rewards');
  if (after.ok) {
    const settings = after.data?.settings || {};
    checkField('reward settings panel / review_reward_credits', Number(settings.review_reward_credits), testReview);
    checkField('reward settings panel / platform_commission_percent', Number(settings.platform_commission_percent), 3);
  }

  const publicView = await get('/settings/rewards');
  if (publicView.ok) {
    checkField('public reward settings / review_reward_credits', Number(publicView.data?.settings?.review_reward_credits), testReview);
  }

  // Restore the operator's original configuration; the suite must not leave
  // production pricing altered.
  const restore = await post('/admin/settings/rewards', {
    review_reward_credits: originalReview,
    platform_commission_percent: originalCommission,
    updated_by: 'integrity_run_restore'
  });
  checkHttp('restore reward settings', restore);
  const restored = await dbOne(`SELECT * FROM platform_settings WHERE id = 'reward_settings'`);
  checkField('restore reward settings / review_reward_credits', Number(restored?.review_reward_credits), originalReview);
  checkField('restore reward settings / platform_commission_percent', Number(restored?.platform_commission_percent), originalCommission);
}

// ---------------------------------------------------------------------------
// Section 14: Customer wallet and ledger
// ---------------------------------------------------------------------------

async function walletSection() {
  sectionStart('wallet', 'WALLET - CREDIT, DEBIT, LEDGER AND CUSTOMER VIEW');

  if (!ACTOR.customerPhone) {
    skip('wallet credit', 'no registered customer available');
    return;
  }

  const beforeRow = await dbOne('SELECT wallet_balance FROM users WHERE phone = $1', [ACTOR.customerPhone]);
  const beforeBalance = Number(beforeRow?.wallet_balance || 0);

  const credit = await post('/wallet/customer/credit', {
    phone: ACTOR.customerPhone,
    amount: 75,
    title: `Integrity credit ${RUN_TAG}`,
    description: 'Integrity run wallet credit',
    category: 'REWARD'
  });
  checkHttp('wallet credit', credit);

  const afterCredit = await dbOne('SELECT wallet_balance FROM users WHERE phone = $1', [ACTOR.customerPhone]);
  check('wallet credit / balance increased by the credited amount',
    sameNumber(Number(afterCredit?.wallet_balance), beforeBalance + 75),
    `before=${beforeBalance} after=${afterCredit?.wallet_balance}`);

  const ledgerRow = await dbOne(
    `SELECT * FROM wallet_transactions
     WHERE RIGHT(REGEXP_REPLACE(user_phone, '\\D', '', 'g'), 10) = $1
     ORDER BY created_at DESC LIMIT 1`,
    [digitsOnly(ACTOR.customerPhone)]
  );
  checkFound('wallet credit / ledger row', ledgerRow, 'wallet_transactions');
  if (ledgerRow) {
    checkField('wallet credit / type', ledgerRow.type, 'CREDIT');
    checkField('wallet credit / category', ledgerRow.category, 'REWARD');
    checkField('wallet credit / amount', Number(ledgerRow.amount), 75);
    checkField('wallet credit / title', ledgerRow.title, `Integrity credit ${RUN_TAG}`);
  }

  const view = await get(`/wallet/customer?phone=${encodeURIComponent(ACTOR.customerPhone)}`);
  checkHttp('wallet customer view', view);
  if (view.ok) {
    check('wallet view / balance matches database',
      sameNumber(Number(view.data?.balance), Number(afterCredit?.wallet_balance)),
      `api=${view.data?.balance} db=${afterCredit?.wallet_balance}`);
    const hit = (view.data?.transactions || []).find(t => sameNumber(t.amount, 75) && t.type === 'CREDIT');
    check('wallet view / credited transaction is listed', Boolean(hit), `${(view.data?.transactions || []).length} transaction(s)`);
  }

  // ---- Identity guard: looking a wallet up with a bare phone must not clone the customer
  const bareView = await get(`/wallet/customer?phone=${digitsOnly(ACTOR.customerPhone)}`);
  check('wallet view with bare phone / responds', [200, 404, 400].includes(bareView.status), `HTTP ${bareView.status}`);
  const identities = await dbCount(
    `SELECT count(*) FROM users WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1`,
    [digitsOnly(ACTOR.customerPhone)]
  );
  check('wallet view with bare phone / does not duplicate the customer', identities === 1,
    `${identities} users rows exist for this number after a bare-digit wallet lookup`);

  // ---- Debit against a real booking
  if (!BOOKING.id) {
    skip('wallet debit', 'no booking available');
    return;
  }
  const debit = await post('/wallet/customer/debit', {
    phone: ACTOR.customerPhone, amount: 30, bookingId: BOOKING.id
  });
  checkHttp('wallet debit', debit);
  const afterDebit = await dbOne('SELECT wallet_balance FROM users WHERE phone = $1', [ACTOR.customerPhone]);
  check('wallet debit / balance reduced by the debited amount',
    sameNumber(Number(afterDebit?.wallet_balance), Number(afterCredit?.wallet_balance) - Number(debit.data?.debitedAmount || 0)),
    `after=${afterDebit?.wallet_balance} debited=${debit.data?.debitedAmount}`);

  const debitTx = await dbOne(
    `SELECT * FROM wallet_transactions
     WHERE RIGHT(REGEXP_REPLACE(user_phone, '\\D', '', 'g'), 10) = $1 AND type = 'DEBIT'
     ORDER BY created_at DESC LIMIT 1`,
    [digitsOnly(ACTOR.customerPhone)]
  );
  checkFound('wallet debit / ledger row', debitTx, 'wallet_transactions DEBIT');
  if (debitTx) checkField('wallet debit / category', debitTx.category, 'CHECKOUT_BURN');

  const missingBooking = await post('/wallet/customer/debit', { phone: ACTOR.customerPhone, amount: 10 });
  check('wallet debit / booking id required', missingBooking.status === 400, `HTTP ${missingBooking.status}`);
}

// ---------------------------------------------------------------------------
// Report and runner
// ---------------------------------------------------------------------------

function summary() {
  emit('');
  emit('='.repeat(78));
  emit(' DATA INTEGRITY SUMMARY');
  emit('='.repeat(78));
  emit(` Verdict        : ${STATE.failures.length === 0 ? 'PASS (no blocking defect)' : 'FAIL (blocking defects found)'}`);
  emit(` Checks         : ${STATE.checks.pass} passed, ${STATE.checks.fail} failed, ${STATE.checks.warn} warnings, ${STATE.checks.skip} skipped`);
  emit(` HTTP calls     : ${STATE.httpCalls} (slowest ${STATE.slowestCall.route} at ${STATE.slowestCall.ms}ms)`);
  emit(` Sections       : ${STATE.sections.length}`);
  emit('');

  emit(' Per section');
  for (const s of STATE.sections) {
    const status = s.fail > 0 ? 'FAIL' : s.warn > 0 ? 'WARN' : 'PASS';
    emit(`   [${status.padEnd(4)}] ${s.name.padEnd(14)} pass=${String(s.pass).padStart(3)} fail=${String(s.fail).padStart(3)} warn=${String(s.warn).padStart(2)} skip=${s.skip}  (${s.title})`);
  }

  if (STATE.failures.length) {
    emit('');
    emit(' BLOCKING DEFECTS');
    STATE.failures.forEach((f, i) => {
      emit(`   ${i + 1}. [${f.section}] ${f.check}`);
      emit(`      ${f.detail}`);
    });
  }

  if (STATE.warnings.length) {
    emit('');
    emit(' WARNINGS (data landed, side effect or derived field missing)');
    STATE.warnings.forEach((w, i) => {
      emit(`   ${i + 1}. [${w.section}] ${w.check}`);
      emit(`      ${w.detail}`);
    });
  }

  if (STATE.skips.length) {
    emit('');
    emit(' SKIPPED');
    STATE.skips.forEach((s, i) => emit(`   ${i + 1}. [${s.section}] ${s.check}: ${s.detail}`));
  }

  emit('');
  emit(` Transcript : ${LOG_FILE}`);
  emit(` Report     : ${REPORT_FILE}`);
  emit('='.repeat(78));
}

function writeReport() {
  const report = {
    runId: RUN_TAG,
    startedAt: STATE.startedAt,
    finishedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    strict: STRICT,
    keptData: KEEP_DATA,
    verdict: STATE.failures.length === 0 ? 'PASS' : 'FAIL',
    fatal: STATE.fatal,
    totals: STATE.checks,
    http: { calls: STATE.httpCalls, slowest: STATE.slowestCall },
    sections: STATE.sections.map(s => ({
      name: s.name, title: s.title, pass: s.pass, fail: s.fail, warn: s.warn, skip: s.skip,
      durationMs: Date.now() - s.startedAt
    })),
    failures: STATE.failures,
    warnings: STATE.warnings,
    skips: STATE.skips,
    dataCreated: {
      phones: LEDGER.phones,
      bookings: LEDGER.bookings,
      technicians: LEDGER.technicians,
      users: LEDGER.users
    },
    logFile: LOG_FILE
  };
  try {
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  } catch (err) {
    log('WARN', 'report', 'could not write JSON report', err.message);
  }
  return report;
}

const SECTIONS = [
  ['registration', registrationSection],
  ['login', loginSection],
  ['bookings', bookingSection],
  ['status', statusLifecycleSection],
  ['files', filesSection],
  ['feedback', feedbackSection],
  ['tickets', ticketsSection],
  ['reviews', reviewsSection],
  ['coupons', couponsSection],
  ['team', teamSection],
  ['ops', adminOpsSection],
  ['services', servicesSection],
  ['settings', settingsSection],
  ['wallet', walletSection]
];

async function main() {
  emit('');
  emit('======================================================================');
  emit(' SHAZU ONE - PRODUCTION DATA INTEGRITY TEST');
  emit(' Every write is proven twice: in PostgreSQL and in the admin panel.');
  emit('======================================================================');
  info('run', 'starting', { target: BASE_URL, runTag: RUN_TAG, strict: STRICT, keepData: KEEP_DATA });

  try {
    await preflight();

    if (!STATE.fatal) {
      for (const [name, fn] of SECTIONS) {
        if (ONLY.length && !ONLY.includes(name)) continue;
        try {
          await fn();
        } catch (err) {
          record(SEVERITY.FAIL, `${name} section crashed`, err.message);
          log('DBG ', name, 'stack', err.stack?.split('\n').slice(0, 4).join(' | '));
        }
      }
    } else {
      emit('');
      log('FAIL', 'run', 'aborted before any flow was tested', STATE.fatal);
    }
  } catch (err) {
    STATE.fatal = err.message;
    log('FAIL', 'run', 'unexpected runner failure', err.stack);
  } finally {
    try {
      if (KEEP_DATA) info('cleanup', 'skipped because --keep-data was passed');
      else await cleanup();
    } catch (err) {
      log('WARN', 'cleanup', 'cleanup failed', err.message);
    }
    await stopServer();
    try { await pool.end(); } catch (_) { /* already closed */ }
  }

  summary();
  writeReport();

  if (STATE.fatal) process.exit(2);
  if (STATE.failures.length > 0) process.exit(1);
  if (STRICT && STATE.warnings.length > 0) {
    emit(` Strict mode: ${STATE.warnings.length} warning(s) treated as failures.`);
    process.exit(1);
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  SECTIONS,
  STATE,
  LEDGER,
  api,
  get,
  post,
  dbOne,
  dbRows,
  dbCount,
  check,
  checkSoft,
  checkField,
  checkHttp,
  checkFound,
  checkPresent,
  sectionStart,
  skip,
  record,
  digitsOnly,
  newPhone,
  BASE_URL
};
