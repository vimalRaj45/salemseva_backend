const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const KEYS_FILE = path.join(__dirname, 'vapid_keys.json');

let vapidKeys = null;

// 1. Check environment variables first
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapidKeys = {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY
  };
} else if (fs.existsSync(KEYS_FILE)) {
  // 2. Load from persisted file
  try {
    const raw = fs.readFileSync(KEYS_FILE, 'utf8');
    vapidKeys = JSON.parse(raw);
  } catch (e) {
    console.warn('Error reading VAPID keys file:', e.message);
  }
}

// 3. Generate persistent keys if not found
if (!vapidKeys || !vapidKeys.publicKey || !vapidKeys.privateKey) {
  vapidKeys = webpush.generateVAPIDKeys();
  try {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(vapidKeys, null, 2), 'utf8');
  } catch (e) {
    console.warn('Could not write VAPID keys file:', e.message);
  }
}

const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:support@shazuone.com';

try {
  webpush.setVapidDetails(
    vapidSubject,
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );
} catch (err) {
  console.warn('Web push VAPID configuration notice:', err.message);
}

module.exports = {
  webpush,
  vapidPublicKey: vapidKeys.publicKey,
  vapidPrivateKey: vapidKeys.privateKey,
  vapidSubject
};
