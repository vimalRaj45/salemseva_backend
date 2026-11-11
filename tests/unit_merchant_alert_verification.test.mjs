import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseBankEmailAlert,
  parseMerchantNotification,
  parseBankStatementCsv,
  normalizeBookingRef,
  processIncomingMerchantAlert,
  claimMatchingAlertForPayment,
  reconcileBankCsvRows
} = require('../src/services/merchantAlert.service.js');

describe('Unit Test: Bank Credit Email Alert Parsing', () => {
  it('parses bank credit email subject and body with amount, UTR, and booking reference', () => {
    const parsed = parseBankEmailAlert({
      from: 'alerts@hdfcbank.net',
      subject: 'Credit Alert: Rs.99.00 credited to A/c XX1234',
      body: 'Dear Customer, Rs.99.00 has been credited via UPI Ref No 412345678901 with remarks SLM-173001-ADV'
    });

    assert.equal(parsed.isCredit, true);
    assert.equal(parsed.sourceApp, 'bank_email');
    assert.equal(parsed.amount, 99);
    assert.equal(parsed.utr, '412345678901');
    assert.equal(parsed.bookingRef, 'SLM-173001');
  });

  it('supports legacy alias parseMerchantNotification and INR comma formatting', () => {
    const icici = parseMerchantNotification({
      from: 'icicibank@alerts.in',
      subject: 'INR 1,250.50 credited to your account',
      body: 'Info: UPI/601122334455/SCHED-88991-FIN'
    });

    assert.equal(icici.isCredit, true);
    assert.equal(icici.sourceApp, 'bank_email');
    assert.equal(icici.amount, 1250.5);
    assert.equal(icici.utr, '601122334455');
    assert.equal(icici.bookingRef, 'SCHED-88991');
  });

  it('ignores outgoing debit bank emails', () => {
    const debit = parseBankEmailAlert({
      from: 'alerts@hdfcbank.net',
      subject: 'Debit Alert: Rs. 500.00 debited',
      body: 'Rs. 500.00 debited from A/c **1234 sent to vendor UTR 499988887777'
    });
    assert.equal(debit.isCredit, false);
    assert.equal(debit.reason, 'debit_notification_ignored');
  });
});

describe('Unit Test: Bank Statement CSV Parsing', () => {
  it('parses HDFC/ICICI CSV rows with quoted comma amounts, UTR, and booking ref, ignoring debit rows', () => {
    const csv = [
      'Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance',
      '12/11/2026,UPI-KARTHIK-SLM-5501-ADV,445566778899,,99.00,15099.00',
      '12/11/2026,UPI-VENDOR-PAYOUT,998877665544,500.00,,14599.00',
      '12/11/2026,UPI/778899001122/SLM-9902-FIN,778899001122,,"1,250.50",15849.50'
    ].join('\n');

    const creditRows = parseBankStatementCsv(csv);
    assert.equal(creditRows.length, 2);
    assert.equal(creditRows[0].amount, 99);
    assert.equal(creditRows[0].utr, '445566778899');
    assert.equal(creditRows[0].bookingRef, 'SLM-5501');

    assert.equal(creditRows[1].amount, 1250.5);
    assert.equal(creditRows[1].utr, '778899001122');
    assert.equal(creditRows[1].bookingRef, 'SLM-9902');
  });
});

describe('Unit Test: Two-Way Auto-Verification, CSV Bulk Verify & Single-Use Alert Guard', () => {
  function createMockDb() {
    const state = {
      alerts: [],
      payments: [],
      audits: [],
      nextAlertId: 1
    };

    const queryFn = async (sql, params = []) => {
      if (sql.includes('INSERT INTO merchant_credit_alerts')) {
        const existing = state.alerts.find((a) => a.alert_hash === params[6]);
        if (existing) return { rows: [] };
        const row = {
          id: state.nextAlertId++,
          source_app: params[0],
          amount: params[1],
          utr: params[2],
          booking_ref: params[3],
          sender_label: params[4],
          raw_message: params[5],
          alert_hash: params[6],
          matched_payment_id: null,
          matched_at: null,
          created_at: new Date().toISOString()
        };
        state.alerts.push(row);
        return { rows: [row] };
      }

      if (sql.includes('SELECT * FROM merchant_credit_alerts WHERE alert_hash')) {
        const found = state.alerts.find((a) => a.alert_hash === params[0]);
        return { rows: found ? [found] : [] };
      }

      if (sql.includes('FROM payments') && sql.includes('DYNAMIC_UPI_QR')) {
        const [amount, utr, bookingRef] = params;
        const found = state.payments.find((p) => {
          const st = p.verification_status || 'pending';
          const amtOk = Math.abs(Number(p.amount_total) - Number(amount)) <= 0.5;
          const utrOk = utr && String(p.customer_utr || '').replace(/\s/g, '') === utr;
          const refOk = bookingRef && normalizeBookingRef(p.booking_id) === bookingRef;
          return p.payment_method === 'DYNAMIC_UPI_QR' && ['pending', 'tech_confirmed'].includes(st) && amtOk && (utrOk || refOk);
        });
        return { rows: found ? [found] : [] };
      }

      if (sql.includes('FROM merchant_credit_alerts') && sql.includes('matched_payment_id IS NULL')) {
        const [amount, utr, bookingRef] = params;
        const found = state.alerts.find((a) => {
          const amtOk = Math.abs(Number(a.amount) - Number(amount)) <= 0.5;
          const utrOk = utr && a.utr === utr;
          const refOk = bookingRef && a.booking_ref === bookingRef;
          return a.matched_payment_id === null && amtOk && (utrOk || refOk);
        });
        return { rows: found ? [found] : [] };
      }

      if (sql.includes('UPDATE merchant_credit_alerts') && sql.includes('SET matched_payment_id')) {
        const [paymentId, alertId] = params;
        const row = state.alerts.find((a) => a.id === alertId && a.matched_payment_id === null);
        if (!row) return { rows: [] };
        row.matched_payment_id = paymentId;
        row.matched_at = new Date().toISOString();
        return { rows: [{ id: row.id }] };
      }

      if (sql.includes('UPDATE payments') && sql.includes("SET verification_status = 'verified'")) {
        const [paymentId, utr, verifiedByLabel] = params;
        const pay = state.payments.find((p) => p.id === paymentId);
        if (!pay) return { rows: [] };
        pay.verification_status = 'verified';
        pay.verified_by = verifiedByLabel || 'AUTO_BANK_EMAIL_ALERT';
        pay.ocr_detected_utr = pay.ocr_detected_utr || utr || null;
        return { rows: [pay] };
      }

      if (sql.includes('INSERT INTO audit_logs')) {
        state.audits.push({ booking_id: params[0], metadata: params[1] });
        return { rows: [] };
      }

      return { rows: [] };
    };

    return { state, queryFn };
  }

  it('auto-verifies when customer submits UTR first and bank credit email arrives after', async () => {
    const { state, queryFn } = createMockDb();
    state.payments.push({
      id: 101,
      booking_id: 'SLM-5501',
      amount_total: 99,
      customer_utr: '445566778899',
      payment_method: 'DYNAMIC_UPI_QR',
      verification_status: 'pending'
    });

    const res = await processIncomingMerchantAlert(queryFn, {
      from: 'alerts@hdfcbank.net',
      subject: 'Rs.99.00 credited to your A/c',
      body: 'UPI Ref No 445566778899'
    });

    assert.equal(res.matched, true);
    assert.equal(res.matchedPaymentId, 101);
    assert.equal(state.payments[0].verification_status, 'verified');
    assert.equal(state.payments[0].verified_by, 'AUTO_BANK_EMAIL_ALERT');
  });

  it('auto-verifies when bank email arrives first and partner physically confirms 2nd payment later', async () => {
    const { state, queryFn } = createMockDb();

    // 1. Bank credit email lands first while customer pays Partner QR at doorstep
    const alertRes = await processIncomingMerchantAlert(queryFn, {
      from: 'alerts@icicibank.com',
      subject: 'Account Credited with INR 850.00',
      body: 'Txn ID 778899001122 Ref: SLM-9902-FIN'
    });
    assert.equal(alertRes.stored, true);
    assert.equal(alertRes.matched, false);

    // 2. Technician clicks Confirm Collection (even without typing UTR)
    state.payments.push({
      id: 202,
      booking_id: 'SLM-9902',
      amount_total: 850,
      customer_utr: 'TECH-M9902',
      payment_method: 'DYNAMIC_UPI_QR',
      verification_status: 'tech_confirmed'
    });

    const claim1 = await claimMatchingAlertForPayment(queryFn, {
      paymentId: 202,
      bookingId: 'SLM-9902',
      amount: 850,
      utr: null
    });
    assert.equal(claim1.matched, true);
    assert.equal(state.payments[0].verification_status, 'verified');

    // 3. Single-use guard: another booking of same amount cannot claim the same alert again
    state.payments.push({
      id: 203,
      booking_id: 'SLM-9902',
      amount_total: 850,
      customer_utr: 'TECH-M9902-2',
      payment_method: 'DYNAMIC_UPI_QR',
      verification_status: 'tech_confirmed'
    });
    const claim2 = await claimMatchingAlertForPayment(queryFn, {
      paymentId: 203,
      bookingId: 'SLM-9902',
      amount: 850,
      utr: '778899001122'
    });
    assert.equal(claim2.matched, false);
    assert.equal(state.payments[1].verification_status, 'tech_confirmed');
  });

  it('bulk-verifies pending and tech_confirmed payments via end-of-day Bank Statement CSV', async () => {
    const { state, queryFn } = createMockDb();
    state.payments.push(
      {
        id: 401,
        booking_id: 'SLM-4001',
        amount_total: 99,
        customer_utr: '551122334455',
        payment_method: 'DYNAMIC_UPI_QR',
        verification_status: 'pending'
      },
      {
        id: 402,
        booking_id: 'SLM-4002',
        amount_total: 1250,
        customer_utr: 'TECH-M4002',
        payment_method: 'DYNAMIC_UPI_QR',
        verification_status: 'tech_confirmed'
      }
    );

    const csv = [
      'Date,Description,Reference,Debit,Credit',
      '12/11/2026,UPI/551122334455/SLM-4001-ADV,551122334455,,99.00',
      '12/11/2026,UPI/770011223344/SLM-4002-FIN,770011223344,,"1,250.00"',
      '12/11/2026,ATM WITHDRAWAL,100020003000,300.00,'
    ].join('\n');

    const result = await reconcileBankCsvRows(queryFn, csv, 'ADMIN_USER');
    assert.equal(result.validCreditRows, 2);
    assert.equal(result.matchedCount, 2);
    assert.equal(result.unmatchedCount, 0);
    assert.equal(state.payments[0].verification_status, 'verified');
    assert.equal(state.payments[0].verified_by, 'BANK_CSV_RECONCILED');
    assert.equal(state.payments[1].verification_status, 'verified');
    assert.equal(state.payments[1].verified_by, 'BANK_CSV_RECONCILED');
  });

  it('rejects amount mismatch even if UTR is present', async () => {
    const { state, queryFn } = createMockDb();
    state.payments.push({
      id: 301,
      booking_id: 'SLM-7001',
      amount_total: 499,
      customer_utr: '111122223333',
      payment_method: 'DYNAMIC_UPI_QR',
      verification_status: 'pending'
    });

    const res = await processIncomingMerchantAlert(queryFn, {
      from: 'alerts@hdfcbank.net',
      subject: 'Rs.99.00 credited',
      body: 'Google Transaction ID: 111122223333'
    });
    assert.equal(res.matched, false);
    assert.equal(state.payments[0].verification_status, 'pending');
  });

  it('supports UUID payment IDs when matching alerts against payments table', async () => {
    const { state, queryFn } = createMockDb();
    const uuidPaymentId = '7f6d2c1a-4b90-4f12-9a33-8e1f2a3b4c5d';
    state.payments.push({
      id: uuidPaymentId,
      booking_id: 'SLM-41487',
      amount_total: 99,
      customer_utr: '998877665544',
      payment_method: 'DYNAMIC_UPI_QR',
      verification_status: 'pending'
    });

    const res = await processIncomingMerchantAlert(queryFn, {
      from: 'alerts@hdfcbank.net',
      subject: 'Rs.99.00 credited',
      body: 'UPI/998877665544/SLM-41487'
    });

    assert.equal(res.matched, true);
    assert.equal(res.matchedPaymentId, uuidPaymentId);
    assert.equal(state.alerts[0].matched_payment_id, uuidPaymentId);
    assert.equal(state.payments[0].verification_status, 'verified');
  });
});
