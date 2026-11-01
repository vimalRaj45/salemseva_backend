const { query, pool } = require('./db');

async function migrateCleanupCredits() {
  console.log('--- Running Migration: Clean up defunct credit tables and columns ---');
  try {
    // 1. Drop obsolete wallet_transactions table
    console.log('1. Dropping obsolete wallet_transactions table...');
    await query(`DROP TABLE IF EXISTS wallet_transactions CASCADE;`);
    console.log('   ✓ wallet_transactions dropped successfully.');

    // 2. Drop defunct credit columns from platform_settings
    console.log('2. Dropping defunct credit columns from platform_settings...');
    await query(`
      ALTER TABLE platform_settings DROP COLUMN IF EXISTS customer_referral_credits;
      ALTER TABLE platform_settings DROP COLUMN IF EXISTS review_reward_credits;
      ALTER TABLE platform_settings DROP COLUMN IF EXISTS feedback_reward_credits;
      ALTER TABLE platform_settings DROP COLUMN IF EXISTS feedback_rewards_enabled;
    `);
    console.log('   ✓ Defunct credit columns dropped from platform_settings.');

    console.log('--- Migration completed successfully ---');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrateCleanupCredits();
