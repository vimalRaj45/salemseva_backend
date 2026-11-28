import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pool } = require('../src/db/db');
const { extractS3Key, createTarHeader } = require('../src/services/storage.service');
const { runPurgeCycle, CLOSED_BOOKING_STATUSES } = require('../src/services/retentionPurge.service');

after(async () => {
  await pool.end().catch(() => {});
});

test('extractS3Key extracts key from proxy URLs, raw keys, and ignores data URIs', () => {
  assert.equal(
    extractS3Key('/api/v1/storage/view?key=chat_audio%2Fbooking_1_123.webm'),
    'chat_audio/booking_1_123.webm'
  );
  assert.equal(
    extractS3Key('https://salemseva-backend.onrender.com/api/v1/storage/view?key=chat_audio%2Fabc.webm'),
    'chat_audio/abc.webm'
  );
  assert.equal(extractS3Key('chat_audio/direct_key.webm'), 'chat_audio/direct_key.webm');
  assert.equal(extractS3Key('data:audio/webm;base64,SGVsbG8='), null);
  assert.equal(extractS3Key(''), null);
});

test('runPurgeCycle dryRun executes cleanly and returns structured retention counts', async () => {
  assert.ok(CLOSED_BOOKING_STATUSES.includes('completed'));
  assert.ok(CLOSED_BOOKING_STATUSES.includes('cancelled'));

  const res = await runPurgeCycle({ dryRun: true, chatDays: 7, notifDays: 30, tokenDays: 90 });
  assert.equal(res.dryRun, true);
  assert.equal(res.retentionDays.chatDays, 7);
  assert.equal(typeof res.deleted.chatMessages, 'number');
  assert.equal(typeof res.deleted.otps, 'number');
  assert.equal(typeof res.deleted.notifications, 'number');
  assert.equal(typeof res.deleted.fcmTokens, 'number');
});

test('createTarHeader builds valid 512-byte POSIX ustar header with checksum', () => {
  const hdr = createTarHeader('chat_audio/sample.webm', 1234, 1700000000000);
  assert.equal(hdr.length, 512);
  assert.equal(hdr.subarray(257, 262).toString('ascii'), 'ustar');
  assert.equal(hdr.subarray(0, 22).toString('utf8'), 'chat_audio/sample.webm');
});
