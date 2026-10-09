const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function seed() {
  console.log('🌱 Starting Neon PostgreSQL DB Initialization & Seeding...');
  const client = await pool.connect();
  
  try {
    // 1. Read and apply schema
    const schemaPath = path.join(__dirname, '..', '..', '..', 'neon_schema.sql');
    if (fs.existsSync(schemaPath)) {
      const sql = fs.readFileSync(schemaPath, 'utf8');
      console.log('Executing neon_schema.sql...');
      await client.query(sql);
      console.log('✅ Tables created successfully.');
    }

    // 2. Seed Services Catalog
    console.log('Seeding Services Catalog...');
    await client.query(`
      INSERT INTO services (id, name_en, name_ta, category, visit_fee, est_price_range_en, est_price_range_ta, icon, color_hex)
      VALUES 
        ('ac', 'AC Repair & Service', 'ஏசி பழுதுபார்ப்பு & சர்வீஸ்', 'Cooling & Appliances', 99.00, '₹299 - ₹1,499', '₹299 - ₹1,499', 'ac_unit', '#0284c7'),
        ('electrician', 'Electrician & Wiring', 'எலக்ட்ரீசியன் & வயரிங்', 'Home Power & Safety', 99.00, '₹199 - ₹999', '₹199 - ₹999', 'electric_bolt', '#0d9488'),
        ('plumber', 'Plumber & Sanitary', 'பிளம்பர் & குழாய் வேலை', 'Sanitary & Motors', 99.00, '₹149 - ₹799', '₹149 - ₹799', 'plumbing', '#0284c7'),
        ('cleaning', 'Home & Bath Cleaning', 'வீடு & பாத்ரூம் சுத்தம்', 'Sanitization', 99.00, '₹349 - ₹2,499', '₹349 - ₹2,499', 'cleaning_services', '#059669')
      ON CONFLICT (id) DO UPDATE SET 
        name_en = EXCLUDED.name_en,
        name_ta = EXCLUDED.name_ta,
        visit_fee = EXCLUDED.visit_fee;
    `);

    // 3. Seed Service Issues for all 4 trades
    console.log('Seeding Service Issues for all 4 categories...');
    await client.query(`
      INSERT INTO service_issues (id, service_id, name_en, name_ta, icon, est_range, is_custom)
      VALUES
        -- AC Issues
        ('ac_cooling', 'ac', 'Not Cooling / Low Cooling Problem', 'குளிர்ச்சி இல்லை / குறைவான குளிர்ச்சி', 'mode_cool', '₹350 - ₹750', FALSE),
        ('ac_water', 'ac', 'Water Leakage from Indoor Unit', 'உள் யூனிட்டில் தண்ணீர் கசிவு', 'water_drop', '₹249 - ₹499', FALSE),
        ('ac_noise', 'ac', 'Unusual Vibration or Rattling Noise', 'அதிக சத்தம் / அதிரும் பிரச்சனை', 'volume_up', '₹199 - ₹399', FALSE),
        ('ac_power', 'ac', 'AC Not Turning ON / Power Dead', 'ஏசி ஆன் ஆகவில்லை / பவர் பிரச்சனை', 'power_off', '₹299 - ₹899', FALSE),
        ('ac_custom', 'ac', 'Other AC Issue (Type your problem)', 'மற்ற ஏசி பிரச்சனை (விவரிக்கவும்)', 'edit_note', 'Quote on Inspection', TRUE),

        -- Electrician Issues
        ('elec_mcb', 'electrician', 'MCB Tripping / Power Short Circuit', 'MCB ட்ரிப் / மின் கசிவு பிரச்சனை', 'bolt', '₹199 - ₹499', FALSE),
        ('elec_fan', 'electrician', 'Ceiling Fan / Light / Exhaust Fitting', 'மின்விசிறி / விளக்கு பொருத்துதல்', 'tungsten', '₹149 - ₹349', FALSE),
        ('elec_switch', 'electrician', 'Switchboard Sparking / Socket Repair', 'சுவிட்ச்போர்டு தீப்பொறி / பழுது', 'electrical_services', '₹149 - ₹399', FALSE),
        ('elec_wiring', 'electrician', 'Full Home Inverter / 3-Phase Rewiring', 'இன்வெர்ட்டர் / 3-பேஸ் வயரிங் வேலை', 'cable', '₹499 - ₹1,499', FALSE),
        ('elec_custom', 'electrician', 'Other Electrical Problem', 'மற்ற எலக்ட்ரிக்கல் பிரச்சனை', 'edit_note', 'Quote on Inspection', TRUE),

        -- Plumber Issues
        ('plumb_motor', 'plumber', 'Water Motor Pump / Tank Overflow Issue', 'தண்ணீர் மோட்டார் பம்ப் / டேங்க் நிரம்புதல்', 'water_pump', '₹249 - ₹699', FALSE),
        ('plumb_leak', 'plumber', 'Concealed Pipe & Tap Water Leakage', 'குழாய் உடைப்பு / தண்ணீர் கசிவு', 'water_drop', '₹149 - ₹399', FALSE),
        ('plumb_block', 'plumber', 'Drainage Clog & Kitchen Sink Blockage', 'சாக்கடை அடைப்பு / சின்க் அடைப்பு', 'plumbing', '₹199 - ₹499', FALSE),
        ('plumb_sanitary', 'plumber', 'Flush Tank & Toilet Sanitary Fitting', 'டாய்லெட் பிளஷ் டேங்க் / பைப் ஃபிட்டிங்', 'bathtub', '₹199 - ₹599', FALSE),
        ('plumb_custom', 'plumber', 'Other Plumbing Issue', 'மற்ற பிளம்பிங் பிரச்சனை', 'edit_note', 'Quote on Inspection', TRUE),

        -- Cleaning Issues
        ('clean_deep', 'cleaning', 'Full House Deep Sanitization & Dusting', 'முழு வீடு டீப் கிளீனிங்', 'cleaning_services', '₹999 - ₹2,499', FALSE),
        ('clean_bath', 'cleaning', 'Bathroom Acid Wash & Tile Descaling', 'பாத்ரூம் டைல்ஸ் & கறை நீக்கம்', 'wash', '₹349 - ₹699', FALSE),
        ('clean_kitchen', 'cleaning', 'Kitchen Chimney & Oil Stain Degreasing', 'சமையலறை சிம்னி & எண்ணெய் கறை நீக்கம்', 'countertops', '₹499 - ₹899', FALSE),
        ('clean_sofa', 'cleaning', 'Sofa & Fabric Mattress Shampooing', 'சோபா & மெத்தை ஷாம்பூ வாஷ்', 'chair', '₹399 - ₹799', FALSE),
        ('clean_custom', 'cleaning', 'Other Specialized Cleaning', 'மற்ற தனிப்பயன் சுத்தம்', 'edit_note', 'Quote on Inspection', TRUE)
      ON CONFLICT (id) DO UPDATE SET
        name_en = EXCLUDED.name_en,
        name_ta = EXCLUDED.name_ta;
    `);

    // 3.1 Seed Real Spares & Labor Catalog for each Service
    console.log('Seeding Real OEM Spares & Labor Catalog in PostgreSQL...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS service_spares_catalog (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        service_id VARCHAR(50) REFERENCES services(id) ON DELETE CASCADE,
        item_name VARCHAR(150) NOT NULL,
        item_type VARCHAR(30) NOT NULL,
        unit_price NUMERIC(10,2) NOT NULL,
        is_oem_part BOOLEAN DEFAULT FALSE,
        part_number VARCHAR(50),
        dealer_name VARCHAR(100) DEFAULT 'Salem Wholesale Spares Hub (Fairlands)',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO service_spares_catalog (id, service_id, item_name, item_type, unit_price, is_oem_part, part_number, dealer_name)
      VALUES
        -- AC Spares & Labor
        ('da000000-0000-0000-0000-000000000001', 'ac', 'Epcos 45uF AC Run Capacitor (OEM)', 'Spare Part', 450.00, TRUE, 'EPC-45UF-AC', 'Salem AC Spares Hub (Fairlands)'),
        ('da000000-0000-0000-0000-000000000002', 'ac', 'Compressor Terminal & Wiring Cleaning', 'Labor', 300.00, FALSE, 'LAB-WIR-CLN', 'Certified Salem Partner Labor'),
        ('da000000-0000-0000-0000-000000000003', 'ac', 'Gas Leakage Pressure Testing', 'Diagnostic', 150.00, FALSE, 'DIAG-GAS-PRS', 'Digital Gauge Diagnostic'),
        ('da000000-0000-0000-0000-000000000004', 'ac', 'Indoor Unit Copper Flare Nut & Insulation', 'Spare Part', 350.00, TRUE, 'CPR-FLR-02', 'Salem Refrigeration Supplies'),
        ('da000000-0000-0000-0000-000000000005', 'ac', 'Outdoor Condenser Jet Pressure Wash', 'Labor', 400.00, FALSE, 'LAB-CND-JET', 'High Pressure Service Kit'),

        -- Electrician Spares & Labor
        ('da000000-0000-0000-0000-000000000011', 'electrician', 'Legrand 32A Double-Pole MCB (OEM)', 'Spare Part', 420.00, TRUE, 'LEG-32A-DP', 'Salem Electrical Traders (Shevapet)'),
        ('da000000-0000-0000-0000-000000000012', 'electrician', 'Main DB Phase Line Rewiring & Insulation', 'Labor', 230.00, FALSE, 'LAB-DB-REW', 'Licensed Wireman Service'),
        ('da000000-0000-0000-0000-000000000013', 'electrician', 'Load & Earth Leakage Diagnostic Test', 'Diagnostic', 100.00, FALSE, 'DIAG-ELCB-01', 'Digital Earth Megger Test'),
        ('da000000-0000-0000-0000-000000000014', 'electrician', 'Anchor Roma 16A Heavy Switch & Socket Set', 'Spare Part', 280.00, TRUE, 'ANC-ROM-16', 'Shevapet Electrical Mart'),

        -- Plumber Spares & Labor
        ('da000000-0000-0000-0000-000000000021', 'plumber', 'Astral CPVC Heavy 1" Concealed Ball Valve', 'Spare Part', 450.00, TRUE, 'AST-CPVC-01', 'Salem Pipe & Sanitary Mart'),
        ('da000000-0000-0000-0000-000000000022', 'plumber', 'High-Pressure Pipe Joint Threading', 'Labor', 250.00, FALSE, 'LAB-P-THR', 'Heavy Pipe Threading Work'),
        ('da000000-0000-0000-0000-000000000023', 'plumber', 'Pressure Leakage Test', 'Diagnostic', 100.00, FALSE, 'DIAG-HYD-01', 'Hydrostatic Pressure Test'),
        ('da000000-0000-0000-0000-000000000024', 'plumber', 'Jaquar Dual Flush Internal Mechanism Kit', 'Spare Part', 550.00, TRUE, 'JAQ-FLSH-02', 'Jaquar Authorised Salem Depot'),

        -- Cleaning Spares & Labor
        ('da000000-0000-0000-0000-000000000031', 'cleaning', 'Full Bathroom Acid Wash & Tile Descaling Chemicals', 'Spare Part', 300.00, TRUE, 'CHM-DSC-01', 'EcoClean Salem Depot'),
        ('da000000-0000-0000-0000-000000000032', 'cleaning', 'Deep Grout Scrubbing & Machine Floor Buffing', 'Labor', 450.00, FALSE, 'LAB-GRT-BUF', 'Industrial Floor Scrubber'),
        ('da000000-0000-0000-0000-000000000033', 'cleaning', 'Anti-Bacterial Sanitization Fogging', 'Diagnostic', 150.00, FALSE, 'FOG-SAN-01', 'Hospital-Grade Fogging Kit')
      ON CONFLICT (id) DO UPDATE SET
        item_name = EXCLUDED.item_name,
        unit_price = EXCLUDED.unit_price,
        is_oem_part = EXCLUDED.is_oem_part;
    `);

    // 4. Seed Verified Technicians for EACH Trade in Salem
    console.log('Seeding Dedicated Verified Technicians for AC, Electrician, Plumber, and Cleaning...');
    await client.query(`
      INSERT INTO technicians (
        id, full_name, phone, primary_trade, years_experience, 
        is_kyc_verified, upi_vpa, is_online, current_lat, current_lng, 
        rating_avg, rating_count, jobs_completed_count, star_points, star_tier, assigned_localities, preferred_lang
      )
      VALUES 
        -- AC Specialists
        ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'K. Ramesh', '+919443288901', 'ac', 7, TRUE, 'ramesh.tech@oksbi', TRUE, 11.6643, 78.1460, 4.92, 142, 428, 24, 'Gold Partner (Salem)', ARRAY['Fairlands', 'Hasthampatti', 'Suramangalam', 'Meyyanur'], 'ta'),
        ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'Murugan S.', '+919842166720', 'ac', 5, TRUE, 'murugan.ac@okaxis', TRUE, 11.6710, 78.1520, 4.88, 98, 312, 18, 'Silver Partner', ARRAY['Hasthampatti', 'Fairlands', 'Gorimedu'], 'ta'),

        -- Electricians
        ('c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'S. Senthil Kumar', '+919842144551', 'electrician', 9, TRUE, 'senthil.electric@okicici', TRUE, 11.6580, 78.1380, 4.95, 175, 530, 27, 'Master Electrician (Salem)', ARRAY['Suramangalam', 'Junction', 'Fairlands', 'Meyyanur'], 'ta'),
        ('d3eebc99-9c0b-4ef8-bb6d-6bb9bd380a44', 'M. Karthik', '+919443188220', 'electrician', 6, TRUE, 'karthik.power@okhdfc', TRUE, 11.6520, 78.1650, 4.89, 110, 340, 15, 'Gold Partner', ARRAY['Ammapet', 'Gugai', 'Shevapet'], 'ta'),

        -- Plumbers
        ('e4eebc99-9c0b-4ef8-bb6d-6bb9bd380a55', 'P. Velumani', '+919789033442', 'plumber', 11, TRUE, 'velumani.plumber@oksbi', TRUE, 11.6450, 78.1390, 4.94, 210, 610, 29, 'Master Plumber (Salem)', ARRAY['Shevapet', 'Gugai', 'Fairlands', 'Suramangalam'], 'ta'),
        ('f5eebc99-9c0b-4ef8-bb6d-6bb9bd380a66', 'R. Selvam', '+919842511993', 'plumber', 8, TRUE, 'selvam.pipe@okaxis', TRUE, 11.6410, 78.1550, 4.87, 85, 285, 14, 'Silver Partner', ARRAY['Gugai', 'Dadagapatty', 'Shevapet'], 'ta'),

        -- Cleaning Specialists
        ('a6eebc99-9c0b-4ef8-bb6d-6bb9bd380a77', 'A. Manikandan', '+919442077884', 'cleaning', 5, TRUE, 'mani.clean@okicici', TRUE, 11.6680, 78.1490, 4.91, 130, 410, 22, 'Sanitization Lead', ARRAY['Fairlands', 'Alagapuram', 'Meyyanur'], 'ta'),
        ('b7eebc99-9c0b-4ef8-bb6d-6bb9bd380a88', 'D. Priya & Team', '+919843266115', 'cleaning', 7, TRUE, 'priya.cleaning@okhdfc', TRUE, 11.6740, 78.1580, 4.96, 160, 520, 28, 'Elite Home Care', ARRAY['Hasthampatti', 'Fairlands', 'Gorimedu'], 'ta')
      ON CONFLICT (id) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        primary_trade = EXCLUDED.primary_trade,
        rating_avg = EXCLUDED.rating_avg,
        jobs_completed_count = EXCLUDED.jobs_completed_count,
        is_online = EXCLUDED.is_online,
        star_points = EXCLUDED.star_points,
        assigned_localities = EXCLUDED.assigned_localities;
    `);

    // 5. Seed Customer Users & Wallets
    console.log('Seeding Customers and initial wallet balances in PostgreSQL...');
    await client.query(`
      INSERT INTO users (id, phone, full_name, email, role, wallet_balance, referral_code, default_address, locality, preferred_lang)
      VALUES 
        ('c0000000-0000-0000-0000-000000000001', '+919842711234', 'Vimal Raj', 'vimal.raj@salemseva.in', 'customer', 150.00, 'SALEM100', '14/2, 5th Cross, Fairlands, Salem - 636016', 'Fairlands', 'ta'),
        ('c0000000-0000-0000-0000-000000000002', '+919842100001', 'Kavitha S.', 'kavitha.s@gmail.com', 'customer', 50.00, 'KAVITHA50', '22, Saradha College Rd, Meyyanur, Salem', 'Meyyanur', 'ta'),
        ('c0000000-0000-0000-0000-000000000003', '+919443211111', 'Anand M.', 'anand.m@gmail.com', 'customer', 100.00, 'ANAND100', '58, Junction Main Road, Suramangalam, Salem', 'Suramangalam', 'ta'),
        ('c0000000-0000-0000-0000-000000000004', '+919843299999', 'Deepa R.', 'deepa.r@gmail.com', 'customer', 75.00, 'DEEPA75', '8A, Gorimedu Main Rd, Hasthampatti, Salem', 'Hasthampatti', 'ta')
      ON CONFLICT (phone) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        wallet_balance = EXCLUDED.wallet_balance,
        default_address = EXCLUDED.default_address,
        locality = EXCLUDED.locality,
        referral_code = EXCLUDED.referral_code;
    `);

    // 6. Seed Customer Wallet Transactions
    console.log('Seeding Customer Wallet Transactions in PostgreSQL...');
    await client.query(`
      INSERT INTO wallet_transactions (id, user_id, user_phone, title, amount, type, category, description, created_at)
      VALUES
        ('fa000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', '+919842711234', 'Welcome Signup Bonus', 50.00, 'CREDIT', 'SIGNUP_BONUS', 'Instant +50 Seva Credits for registering on SalemSeva', NOW() - INTERVAL '7 days'),
        ('fa000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001', '+919842711234', 'Referral: Kavitha (1st Service Done)', 100.00, 'CREDIT', 'REFERRAL_REWARD', 'Friend Kavitha completed AC service in Meyyanur (+100 Credits)', NOW() - INTERVAL '3 days')
      ON CONFLICT (id) DO NOTHING;
    `);

    // 7. Seed Technician Referrals & Incentives
    console.log('Seeding Technician Referral Ledger in PostgreSQL...');
    await client.query(`
      INSERT INTO technician_referrals (id, referrer_phone, referrer_tech_id, referred_name, referred_phone, referred_trade, referred_locality, status, incentive_amount, payout_status, upi_ref, created_at)
      VALUES
        ('da000000-0000-0000-0000-000000000001', '+919443288901', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Murugan S.', '+919842166720', 'HVAC & Refrigeration', 'Hasthampatti, Salem', 'Verified & Active', 250.00, 'SETTLED_TO_UPI', 'UPI-7749201-OKAXIS', NOW() - INTERVAL '6 days'),
        ('da000000-0000-0000-0000-000000000002', '+919443288901', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'S. Senthil Kumar', '+919842144551', 'Senior Electrician', 'Suramangalam, Salem', 'Verified & Active', 250.00, 'AVAILABLE_FOR_PAYOUT', NULL, NOW() - INTERVAL '3 days'),
        ('da000000-0000-0000-0000-000000000003', '+919443288901', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'P. Velumani', '+919789033442', 'Master Plumber', 'Shevapet, Salem', 'Verified & Active', 250.00, 'AVAILABLE_FOR_PAYOUT', NULL, NOW() - INTERVAL '1 day')
      ON CONFLICT (id) DO NOTHING;
    `);

    // 8. Seed Technician Payouts
    console.log('Seeding Technician Payouts in PostgreSQL...');
    await client.query(`
      INSERT INTO technician_payouts (id, technician_phone, technician_id, amount, upi_id, status, utr_ref, description, created_at)
      VALUES
        ('ea000000-0000-0000-0000-000000000001', '+919443288901', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 250.00, 'ramesh.tech@oksbi', 'DISBURSED_100%', 'TXN-SLM-948201', 'Instant UPI Payout for Murugan S. referral onboard', NOW() - INTERVAL '6 days')
      ON CONFLICT (id) DO NOTHING;
    `);

    // 9. Seed Active Live Booking & Chat Message
    console.log('Seeding Active Live Booking & Chat Messages in PostgreSQL...');
    await client.query(`
      INSERT INTO bookings (
        id, customer_id, technician_id, service_id, selected_issue_id, 
        status, customer_name, customer_phone, service_address, locality,
        customer_lat, customer_lng, visit_fee, quote_subtotal, final_amount, parts_mode, customer_otp, created_at, completed_at
      )
      VALUES (
        'SLM-84920', 'c0000000-0000-0000-0000-000000000001', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'ac', 'ac_cooling',
        'en_route', 'S. Kumar', '+919842711234', '14/2, 5th Cross, Fairlands, Salem - 636016', 'Fairlands',
        11.6643, 78.1460, 99.00, 900.00, 999.00, 'tech_buys', '4892', NOW() - INTERVAL '25 minutes', NULL
      ),
      (
        'SLM-73658', 'c0000000-0000-0000-0000-000000000001', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'ac', 'ac_cooling',
        'completed', 'Vimal Raj', '+919842711234', '14/2, 5th Cross, Fairlands, Salem - 636016', 'Ammapet',
        11.6643, 78.1460, 99.00, 900.00, 999.00, 'tech_buys', '4892', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days'
      ),
      (
        'SLM-61294', 'c0000000-0000-0000-0000-000000000001', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'electrician', 'elec_mcb',
        'completed', 'Vimal Raj', '+919842711234', '14/2, 5th Cross, Fairlands, Salem - 636016', 'Hasthampatti',
        11.6700, 78.1500, 99.00, 750.00, 849.00, 'tech_buys', '4892', NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days'
      )
      ON CONFLICT (id) DO UPDATE SET 
        status = EXCLUDED.status,
        quote_subtotal = EXCLUDED.quote_subtotal,
        final_amount = EXCLUDED.final_amount,
        parts_mode = EXCLUDED.parts_mode;

      -- Seed Quote Items for SLM-73658 & SLM-84920
      INSERT INTO quote_items (id, booking_id, item_name, item_type, price, qty, is_oem_part, created_at)
      VALUES
        ('ba000000-0000-0000-0000-000000000001', 'SLM-73658', 'Epcos 45uF AC Run Capacitor (OEM)', 'Spare Part', 450.00, 1, TRUE, NOW() - INTERVAL '2 days'),
        ('ba000000-0000-0000-0000-000000000002', 'SLM-73658', 'Compressor Terminal & Wiring Cleaning', 'Labor', 300.00, 1, FALSE, NOW() - INTERVAL '2 days'),
        ('ba000000-0000-0000-0000-000000000003', 'SLM-73658', 'Gas Leakage Pressure Testing', 'Diagnostic', 150.00, 1, FALSE, NOW() - INTERVAL '2 days'),
        ('ba000000-0000-0000-0000-000000000004', 'SLM-84920', 'Epcos 45uF AC Run Capacitor (OEM)', 'Spare Part', 450.00, 1, TRUE, NOW() - INTERVAL '20 minutes'),
        ('ba000000-0000-0000-0000-000000000005', 'SLM-84920', 'Compressor Terminal & Wiring Cleaning', 'Labor', 300.00, 1, FALSE, NOW() - INTERVAL '20 minutes'),
        ('ba000000-0000-0000-0000-000000000006', 'SLM-84920', 'Gas Leakage Pressure Testing', 'Diagnostic', 150.00, 1, FALSE, NOW() - INTERVAL '20 minutes')
      ON CONFLICT (id) DO NOTHING;

      -- Seed Payments for Completed Booking SLM-73658 (Part 1 Visit + Part 2 Spares/Labor)
      INSERT INTO payments (id, booking_id, razorpay_order_id, razorpay_payment_id, amount_total, tech_payout_amount, platform_commission, status, payment_method, payout_utr, settled_at, created_at)
      VALUES
        ('ca000000-0000-0000-0000-000000000001', 'SLM-73658', 'order_visit_73658', 'pay_visit_73658', 99.00, 99.00, 0.00, 'settled', 'UPI (Instant Escrow)', 'UTR-VISIT-73658', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days'),
        ('ca000000-0000-0000-0000-000000000002', 'SLM-73658', 'order_final_73658', 'pay_final_73658', 900.00, 765.00, 135.00, 'settled', 'UPI (Instant Escrow)', 'UTR-FINAL-73658', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO chat_messages (id, booking_id, sender_role, message_text, created_at)
      VALUES (
        'fa000000-0000-0000-0000-000000000099', 'SLM-84920', 'technician',
        'Vanakkam! Hasthampatti la irundhu kelambiten, 12 mins la arrival.',
        NOW() - INTERVAL '5 minutes'
      )
      ON CONFLICT (id) DO NOTHING;
    `);

    console.log('✨ Seed completed successfully with persistent customer wallets, technician referrals, and trade technicians!');
  } catch (err) {
    console.error('❌ Seeding failed:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
