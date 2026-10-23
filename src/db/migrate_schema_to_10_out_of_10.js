const { query, pool } = require('./db');

async function migrateToTenOutOfTen() {
  console.log('🚀 Upgrading Shazu One Database Schema to 10/10 Enterprise Standard...');
  try {
    // ----------------------------------------------------
    // STEP 1: Foreign Key Integrity on Newer Tables
    // ----------------------------------------------------
    console.log('1. Applying strict Foreign Keys & Cascades...');
    
    // Check if passkey_credentials table exists and has user_id
    await query(`
      DO $$
      BEGIN
        -- Passkey credentials FK
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'passkey_credentials') THEN
          -- Drop existing constraint if already there
          ALTER TABLE passkey_credentials DROP CONSTRAINT IF EXISTS fk_passkey_user;
          
          -- Clean up any invalid or non-UUID entries if any exist
          DELETE FROM passkey_credentials WHERE user_id IS NULL OR user_id NOT IN (SELECT id::text FROM users);
          
          -- Alter column to UUID if not already UUID
          ALTER TABLE passkey_credentials 
            ALTER COLUMN user_id TYPE UUID USING user_id::uuid;
            
          ALTER TABLE passkey_credentials
            ADD CONSTRAINT fk_passkey_user 
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
        END IF;

        -- Support tickets FKs
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'support_tickets') THEN
          ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS fk_ticket_booking;
          
          -- Clean orphaned booking_ids
          UPDATE support_tickets SET booking_id = NULL 
          WHERE booking_id IS NOT NULL AND booking_id NOT IN (SELECT id FROM bookings);

          ALTER TABLE support_tickets 
            ADD CONSTRAINT fk_ticket_booking 
            FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    console.log('   ✓ Foreign key integrity established.');

    // ----------------------------------------------------
    // STEP 2: Automatic updated_at Function and Triggers
    // ----------------------------------------------------
    console.log('2. Setting up automatic updated_at timestamp triggers...');
    await query(`
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
          NEW.updated_at = CURRENT_TIMESTAMP;
          RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      -- Trigger on users
      DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
      CREATE TRIGGER trg_users_updated_at
      BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

      -- Trigger on support_tickets
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'support_tickets') THEN
          DROP TRIGGER IF EXISTS trg_support_tickets_updated_at ON support_tickets;
          CREATE TRIGGER trg_support_tickets_updated_at
          BEFORE UPDATE ON support_tickets
          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
        END IF;
      END $$;
    `);
    console.log('   ✓ Automatic updated_at triggers active.');

    // ----------------------------------------------------
    // STEP 3: Soft-Delete Protection for Financial & User Data
    // ----------------------------------------------------
    console.log('3. Configuring Soft-Delete columns and Payment audit lock...');
    await query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
      ALTER TABLE technicians ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;

      -- Payments should never be accidentally deleted if booking record is affected
      ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_booking_id_fkey;
      ALTER TABLE payments 
        ADD CONSTRAINT payments_booking_id_fkey 
        FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE RESTRICT;
    `);
    console.log('   ✓ Soft-delete columns and financial integrity constraints added.');

    // ----------------------------------------------------
    // STEP 4: Business Logic Check Constraints
    // ----------------------------------------------------
    console.log('4. Adding Check Constraints to prevent corrupt data...');
    await query(`
      DO $$
      BEGIN
        -- 1. Rating constraint: 1.0 to 5.0
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'reviews') THEN
          ALTER TABLE reviews DROP CONSTRAINT IF EXISTS chk_review_rating_range;
          ALTER TABLE reviews 
            ADD CONSTRAINT chk_review_rating_range 
            CHECK (rating >= 1.0 AND rating <= 5.0);
        END IF;

        -- 2. Non-negative wallet balance
        ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_user_wallet_non_negative;
        ALTER TABLE users 
          ADD CONSTRAINT chk_user_wallet_non_negative 
          CHECK (wallet_balance >= 0.00);

        -- 3. Strictly positive payment amounts
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'payments') THEN
          ALTER TABLE payments DROP CONSTRAINT IF EXISTS chk_payment_amount_positive;
          ALTER TABLE payments 
            ADD CONSTRAINT chk_payment_amount_positive 
            CHECK (amount_total > 0.00);
        END IF;
      END $$;
    `);
    console.log('   ✓ Check constraints applied.');

    console.log('\n🎉 SUCCESS: Database schema upgraded to 10/10 Enterprise Grade!');
  } catch (err) {
    console.error('❌ Migration Error:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrateToTenOutOfTen();
