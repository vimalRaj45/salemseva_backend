const { query } = require('./db');

async function migrateLegalAcceptances() {
  console.log('[Migration] Starting legal_acceptances table migration...');
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS legal_acceptances (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_phone VARCHAR(20) NOT NULL,
        user_role VARCHAR(20) NOT NULL,
        document_type VARCHAR(50) NOT NULL,
        document_version VARCHAR(20) NOT NULL,
        document_hash VARCHAR(64) NOT NULL,
        ip_address VARCHAR(64),
        user_agent TEXT,
        accepted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_user_acceptance UNIQUE (user_phone, document_type, document_version)
      );

      CREATE INDEX IF NOT EXISTS idx_legal_accept_check 
        ON legal_acceptances(user_phone, document_type, document_version);
    `);
    console.log('[Migration] Successfully created legal_acceptances table and unique index in Neon PostgreSQL.');
  } catch (err) {
    console.error('[Migration Error] Failed to create legal_acceptances table:', err.message);
    throw err;
  }
}

if (require.main === module) {
  migrateLegalAcceptances()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { migrateLegalAcceptances };
