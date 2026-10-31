const { query } = require('./db');

async function migrate() {
  try {
    console.log('Running migration: Add daily_job_capacity to technicians...');
    await query(`
      ALTER TABLE technicians 
      ADD COLUMN IF NOT EXISTS daily_job_capacity INT DEFAULT 4;
    `);
    console.log('Migration completed successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Migration error:', err.message);
    process.exit(1);
  }
}

migrate();
