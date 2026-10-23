const { pool } = require('./db');

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Starting migration for WhatsApp OTP and Passkey credentials...');

    // 1. Add is_phone_verified column to users and technicians
    await client.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS is_phone_verified BOOLEAN DEFAULT FALSE;
    `);

    await client.query(`
      ALTER TABLE technicians 
      ADD COLUMN IF NOT EXISTS is_phone_verified BOOLEAN DEFAULT FALSE;
    `);

    // 2. Create otp_verifications table
    await client.query(`
      CREATE TABLE IF NOT EXISTS otp_verifications (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(30) NOT NULL,
        otp_hash VARCHAR(128) NOT NULL,
        purpose VARCHAR(50) NOT NULL DEFAULT 'verification',
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        attempts INT DEFAULT 0,
        verified BOOLEAN DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS idx_otp_phone_purpose ON otp_verifications(phone, purpose);
    `);

    // 3. Create passkey_credentials table
    await client.query(`
      CREATE TABLE IF NOT EXISTS passkey_credentials (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(100) NOT NULL,
        phone VARCHAR(30) NOT NULL,
        credential_id TEXT NOT NULL UNIQUE,
        public_key TEXT NOT NULL,
        counter BIGINT NOT NULL DEFAULT 0,
        transports TEXT[],
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_passkey_phone ON passkey_credentials(phone);
      CREATE INDEX IF NOT EXISTS idx_passkey_user_id ON passkey_credentials(user_id);
    `);

    console.log('Migration completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
