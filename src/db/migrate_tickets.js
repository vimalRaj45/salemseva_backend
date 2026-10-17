const { query, pool } = require('./db');

async function migrateTickets() {
  console.log('--- Migrating support_tickets table ---');
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id VARCHAR(64) PRIMARY KEY,
        ticket_number VARCHAR(32) UNIQUE NOT NULL,
        creator_id VARCHAR(64),
        creator_role VARCHAR(20) NOT NULL,
        creator_name VARCHAR(128) NOT NULL,
        creator_phone VARCHAR(20) NOT NULL,
        booking_id VARCHAR(64),
        category VARCHAR(50) NOT NULL,
        priority VARCHAR(20) DEFAULT 'normal',
        subject VARCHAR(200) NOT NULL,
        description TEXT NOT NULL,
        voice_note_url TEXT,
        attachment_url TEXT,
        locality VARCHAR(64) DEFAULT 'Salem',
        status VARCHAR(30) DEFAULT 'open',
        admin_notes TEXT,
        resolution_summary TEXT,
        resolved_by VARCHAR(64),
        resolved_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_tickets_creator_phone ON support_tickets(creator_phone);
      CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status);
      CREATE INDEX IF NOT EXISTS idx_tickets_booking_id ON support_tickets(booking_id);
    `);
    console.log('support_tickets table and indexes verified successfully!');
  } catch (err) {
    console.error('Migration error:', err);
  } finally {
    await pool.end();
  }
}

migrateTickets();
