const { pool, query } = require('./db');

async function seedAllCases() {
  console.log('Seeding Comprehensive Sample Data for ALL Cases across Shazu One...');

  try {
    // 1. Fetch available technicians
    const techRes = await query(`SELECT id, phone, primary_trade FROM technicians ORDER BY created_at ASC`);
    console.log(`Found ${techRes.rows.length} technicians in database.`);

    const primaryPlumber = techRes.rows.find(t => t.primary_trade === 'plumber') || techRes.rows[0];
    const primaryAc = techRes.rows.find(t => t.primary_trade === 'ac') || techRes.rows[0];
    const primaryElec = techRes.rows.find(t => t.primary_trade === 'electrician') || techRes.rows[0];

    const plumberId = primaryPlumber ? primaryPlumber.id : '84eac3ec-537b-4150-b0f8-71f34441ba60';
    const acId = primaryAc ? primaryAc.id : 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    const elecId = primaryElec ? primaryElec.id : 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';

    console.log(`Plumber Tech ID: ${plumberId}`);
    console.log(`AC Tech ID: ${acId}`);
    console.log(`Electrician Tech ID: ${elecId}`);

    // Ensure customer users exist and fetch their real DB IDs
    await query(`
      INSERT INTO users (phone, full_name, email, role, wallet_balance, default_address, locality)
      VALUES 
        ('+919842711234', 'Vimal Raj', 'vimal.raj@Shazu One.in', 'customer', 250.00, '14/2, 5th Cross, Fairlands, Salem - 636016', 'Fairlands'),
        ('+919842100001', 'Kavitha S.', 'kavitha.s@gmail.com', 'customer', 120.00, '22, Saradha College Rd, Meyyanur, Salem', 'Meyyanur'),
        ('+919443211111', 'Anand M.', 'anand.m@gmail.com', 'customer', 100.00, '58, Junction Main Road, Suramangalam, Salem', 'Suramangalam'),
        ('+919843299999', 'Deepa R.', 'deepa.r@gmail.com', 'customer', 75.00, '8A, Gorimedu Main Rd, Hasthampatti, Salem', 'Hasthampatti')
      ON CONFLICT (phone) DO UPDATE SET 
        full_name = EXCLUDED.full_name,
        wallet_balance = EXCLUDED.wallet_balance;
    `);

    const userRows = await query(`SELECT id, phone FROM users`);
    const userMap = {};
    userRows.rows.forEach(u => {
      const cl = (u.phone || '').replace(/[^0-9]/g, '').slice(-10);
      userMap[cl] = u.id;
    });

    const vimalId = userMap['9842711234'] || userRows.rows[0].id;
    const kavithaId = userMap['9842100001'] || userRows.rows[0].id;
    const anandId = userMap['9443211111'] || userRows.rows[0].id;
    const deepaId = userMap['9843299999'] || userRows.rows[0].id;

    // Comprehensive Bookings covering all lifecycle states & calendar dates
    const sampleBookings = [
      // CASE 1: TODAY'S ACTIVE CONFIRMED APPOINTMENT (Oct 17, 2026)
      {
        id: 'SLM-TODAY-01',
        technician_id: plumberId,
        customer_id: vimalId,
        service_id: 'plumber',
        selected_issue_id: 'plumb_leak',
        custom_issue_description: 'Severe pipe leakage under kitchen sink & motor vibration',
        status: 'accepted',
        booking_type: 'scheduled',
        customer_name: 'Vimal Raj',
        customer_phone: '+919842711234',
        service_address: '14/2, 5th Cross, Fairlands, Salem - 636016',
        locality: 'Fairlands, Salem',
        scheduled_slot: 'Today • 02:00 PM - 04:00 PM',
        visit_fee: 99.00,
        quote_subtotal: 450.00,
        final_amount: 549.00,
        customer_otp: '7241',
        created_at: new Date('2026-10-17T08:30:00Z')
      },

      // CASE 2: LIVE JOURNEY EN ROUTE WITH ACTIVE GPS (Oct 17, 2026)
      {
        id: 'SLM-LIVE-01',
        technician_id: acId,
        customer_id: kavithaId,
        service_id: 'ac',
        selected_issue_id: 'ac_cooling',
        custom_issue_description: 'Split AC low cooling in living room, blowing warm air',
        status: 'en_route',
        booking_type: 'instant',
        customer_name: 'Kavitha S.',
        customer_phone: '+919842100001',
        service_address: '22, Saradha College Rd, Meyyanur, Salem',
        locality: 'Meyyanur, Salem',
        scheduled_slot: 'Instant Today',
        visit_fee: 99.00,
        quote_subtotal: 900.00,
        final_amount: 999.00,
        customer_otp: '3819',
        created_at: new Date('2026-10-17T10:15:00Z')
      },

      // CASE 3: ON-SITE DIAGNOSTIC WITH QUOTE PRESENTED
      {
        id: 'SLM-QUOTE-01',
        technician_id: elecId,
        customer_id: anandId,
        service_id: 'electrician',
        selected_issue_id: 'elec_mcb',
        custom_issue_description: 'Main DB MCB tripping repeatedly when water heater turned on',
        status: 'quote_presented',
        booking_type: 'instant',
        customer_name: 'Anand M.',
        customer_phone: '+919443211111',
        service_address: '58, Junction Main Road, Suramangalam, Salem',
        locality: 'Suramangalam, Salem',
        scheduled_slot: 'Instant Today',
        visit_fee: 99.00,
        quote_subtotal: 650.00,
        final_amount: 749.00,
        customer_otp: '5192',
        created_at: new Date('2026-10-17T09:00:00Z')
      },

      // CASE 4: UPCOMING ADVANCE SCHEDULED APPOINTMENTS (Highlighting multiple dates in calendar!)
      // Date 1: Oct 21, 2026 (Wed)
      {
        id: 'SLM-SCH-21',
        technician_id: plumberId,
        customer_id: kavithaId,
        service_id: 'plumber',
        selected_issue_id: 'plumb_motor',
        custom_issue_description: 'Overhead tank sensor valve replacement and pipe threading',
        status: 'accepted',
        booking_type: 'scheduled',
        customer_name: 'Kavitha S.',
        customer_phone: '+919842100001',
        service_address: '22, Saradha College Rd, Meyyanur, Salem',
        locality: 'Meyyanur, Salem',
        scheduled_slot: '2026-10-21 • Wed, 21 Oct • 10:00 AM - 12:00 PM',
        visit_fee: 99.00,
        quote_subtotal: 550.00,
        final_amount: 649.00,
        customer_otp: '6284',
        created_at: new Date('2026-10-16T14:00:00Z')
      },

      // Date 2: Oct 24, 2026 (Sat)
      {
        id: 'SLM-SCH-24',
        technician_id: plumberId,
        customer_id: anandId,
        service_id: 'plumber',
        selected_issue_id: 'plumb_sanitary',
        custom_issue_description: 'Bathroom flush tank internal mechanism servicing',
        status: 'accepted',
        booking_type: 'scheduled',
        customer_name: 'Anand M.',
        customer_phone: '+919443211111',
        service_address: '58, Junction Main Road, Suramangalam, Salem',
        locality: 'Suramangalam, Salem',
        scheduled_slot: '2026-10-24 • Sat, 24 Oct • 02:00 PM - 04:00 PM',
        visit_fee: 99.00,
        quote_subtotal: 400.00,
        final_amount: 499.00,
        customer_otp: '8172',
        created_at: new Date('2026-10-16T16:30:00Z')
      },

      // Date 3: Oct 29, 2026 (Thu)
      {
        id: 'SLM-SCH-29',
        technician_id: plumberId,
        customer_id: deepaId,
        service_id: 'plumber',
        selected_issue_id: 'plumb_leak',
        custom_issue_description: 'Concealed CPVC pipe joint leakage in master bathroom',
        status: 'accepted',
        booking_type: 'scheduled',
        customer_name: 'Deepa R.',
        customer_phone: '+919843299999',
        service_address: '8A, Gorimedu Main Rd, Hasthampatti, Salem',
        locality: 'Hasthampatti, Salem',
        scheduled_slot: '2026-10-29 • Thu, 29 Oct • 06:00 PM - 08:00 PM',
        visit_fee: 99.00,
        quote_subtotal: 750.00,
        final_amount: 849.00,
        customer_otp: '9345',
        created_at: new Date('2026-10-17T07:00:00Z')
      },

      // Date 4: Oct 31, 2026 (Sat)
      {
        id: 'SLM-SCH-31',
        technician_id: plumberId,
        customer_id: vimalId,
        service_id: 'plumber',
        selected_issue_id: 'plumb_block',
        custom_issue_description: 'Drainage pipe descaling and kitchen sink trap clearing',
        status: 'accepted',
        booking_type: 'scheduled',
        customer_name: 'Vimal Raj',
        customer_phone: '+919842711234',
        service_address: '14/2, 5th Cross, Fairlands, Salem - 636016',
        locality: 'Fairlands, Salem',
        scheduled_slot: '2026-10-31 • Sat, 31 Oct • 11:00 AM - 01:00 PM',
        visit_fee: 99.00,
        quote_subtotal: 350.00,
        final_amount: 449.00,
        customer_otp: '4021',
        created_at: new Date('2026-10-17T09:30:00Z')
      },

      // CASE 5: OPEN CLAIMABLE CUSTOMER SCHEDULED LEADS (Unassigned, direct claim by any partner)
      {
        id: 'SLM-LEAD-22',
        technician_id: null,
        customer_id: anandId,
        service_id: 'plumber',
        selected_issue_id: 'plumb_leak',
        custom_issue_description: 'High-pressure water pump pipe leakage in commercial premises',
        status: 'matching',
        booking_type: 'scheduled',
        customer_name: 'Rajendran P.',
        customer_phone: '+919842055667',
        service_address: '34, Bazaar Street, Ammapet, Salem',
        locality: 'Ammapet, Salem',
        scheduled_slot: '2026-10-22 • Thu, 22 Oct • 04:00 PM - 06:00 PM',
        visit_fee: 99.00,
        quote_subtotal: 600.00,
        final_amount: 699.00,
        customer_otp: '1849',
        created_at: new Date('2026-10-17T10:00:00Z')
      },
      {
        id: 'SLM-LEAD-26',
        technician_id: null,
        customer_id: deepaId,
        service_id: 'plumber',
        selected_issue_id: 'plumb_motor',
        custom_issue_description: 'Borewell pump starter switch and capacitor checkup',
        status: 'matching',
        booking_type: 'scheduled',
        customer_name: 'Murugesan T.',
        customer_phone: '+919842344112',
        service_address: '12, Car Street, Shevapet, Salem',
        locality: 'Shevapet, Salem',
        scheduled_slot: '2026-10-26 • Mon, 26 Oct • 09:00 AM - 11:00 AM',
        visit_fee: 99.00,
        quote_subtotal: 500.00,
        final_amount: 599.00,
        customer_otp: '2938',
        created_at: new Date('2026-10-17T10:30:00Z')
      },

      // CASE 6: PAST COMPLETED JOBS (Past duty history with settled earnings & 5-star ratings)
      // Oct 10, 2026
      {
        id: 'SLM-PAST-10',
        technician_id: plumberId,
        customer_id: vimalId,
        service_id: 'plumber',
        selected_issue_id: 'plumb_leak',
        custom_issue_description: 'Complete replacement of damaged CPVC pipe line and brass tap',
        status: 'completed',
        booking_type: 'scheduled',
        customer_name: 'Vimal Raj',
        customer_phone: '+919842711234',
        service_address: '14/2, 5th Cross, Fairlands, Salem - 636016',
        locality: 'Fairlands, Salem',
        scheduled_slot: '2026-10-10 • Sat, 10 Oct • 10:00 AM - 12:00 PM',
        visit_fee: 99.00,
        quote_subtotal: 900.00,
        final_amount: 999.00,
        customer_otp: '7721',
        is_warranty_active: true,
        created_at: new Date('2026-10-10T09:00:00Z'),
        completed_at: new Date('2026-10-10T11:45:00Z')
      },

      // Oct 14, 2026
      {
        id: 'SLM-PAST-14',
        technician_id: plumberId,
        customer_id: kavithaId,
        service_id: 'plumber',
        selected_issue_id: 'plumb_sanitary',
        custom_issue_description: 'Jaquar dual flush internal mechanism kit replacement',
        status: 'completed',
        booking_type: 'scheduled',
        customer_name: 'Kavitha S.',
        customer_phone: '+919842100001',
        service_address: '22, Saradha College Rd, Meyyanur, Salem',
        locality: 'Meyyanur, Salem',
        scheduled_slot: '2026-10-14 • Wed, 14 Oct • 03:00 PM - 05:00 PM',
        visit_fee: 99.00,
        quote_subtotal: 750.00,
        final_amount: 849.00,
        customer_otp: '3190',
        is_warranty_active: true,
        created_at: new Date('2026-10-14T14:00:00Z'),
        completed_at: new Date('2026-10-14T16:20:00Z')
      }
    ];

    for (const b of sampleBookings) {
      await query(`
        INSERT INTO bookings (
          id, technician_id, customer_id, service_id, selected_issue_id, 
          custom_issue_description, status, booking_type, customer_name, customer_phone,
          service_address, locality, scheduled_slot, visit_fee, quote_subtotal, final_amount,
          customer_otp, is_warranty_active, created_at, completed_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
        )
        ON CONFLICT (id) DO UPDATE SET
          technician_id = EXCLUDED.technician_id,
          status = EXCLUDED.status,
          scheduled_slot = EXCLUDED.scheduled_slot,
          quote_subtotal = EXCLUDED.quote_subtotal,
          final_amount = EXCLUDED.final_amount,
          created_at = EXCLUDED.created_at,
          completed_at = EXCLUDED.completed_at;
      `, [
        b.id,
        b.technician_id,
        b.customer_id,
        b.service_id,
        b.selected_issue_id,
        b.custom_issue_description,
        b.status,
        b.booking_type,
        b.customer_name,
        b.customer_phone,
        b.service_address,
        b.locality,
        b.scheduled_slot,
        b.visit_fee,
        b.quote_subtotal,
        b.final_amount,
        b.customer_otp,
        Boolean(b.is_warranty_active),
        b.created_at,
        b.completed_at || null
      ]);
      console.log(` Seeded/Updated Booking: ${b.id} (${b.status}) for ${b.scheduled_slot}`);
    }

    // Seed Quote Items for the live and past bookings
    await query(`
      INSERT INTO quote_items (id, booking_id, item_name, item_type, price, qty, is_oem_part, created_at)
      VALUES
        ('ba000000-0000-0000-0000-000000000101', 'SLM-QUOTE-01', 'Legrand 32A Double-Pole MCB (OEM)', 'Spare Part', 420.00, 1, TRUE, NOW()),
        ('ba000000-0000-0000-0000-000000000102', 'SLM-QUOTE-01', 'Main DB Phase Line Rewiring & Insulation', 'Labor', 230.00, 1, FALSE, NOW()),
        ('ba000000-0000-0000-0000-000000000103', 'SLM-PAST-10', 'Astral CPVC Heavy 1" Concealed Ball Valve', 'Spare Part', 450.00, 1, TRUE, NOW() - INTERVAL '7 days'),
        ('ba000000-0000-0000-0000-000000000104', 'SLM-PAST-10', 'High-Pressure Pipe Joint Threading', 'Labor', 450.00, 1, FALSE, NOW() - INTERVAL '7 days'),
        ('ba000000-0000-0000-0000-000000000105', 'SLM-PAST-14', 'Jaquar Dual Flush Internal Mechanism Kit', 'Spare Part', 550.00, 1, TRUE, NOW() - INTERVAL '3 days'),
        ('ba000000-0000-0000-0000-000000000106', 'SLM-PAST-14', 'Sanitary Fitting & Pressure Leak Test', 'Labor', 200.00, 1, FALSE, NOW() - INTERVAL '3 days')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Seed Payments for completed bookings
    await query(`
      INSERT INTO payments (id, booking_id, razorpay_order_id, razorpay_payment_id, amount_total, tech_payout_amount, platform_commission, status, payment_method, payout_utr, settled_at, created_at)
      VALUES
        ('ca000000-0000-0000-0000-000000000101', 'SLM-PAST-10', 'order_past_10', 'pay_past_10', 999.00, 979.02, 19.98, 'settled', 'UPI (Instant Escrow)', 'UTR-SLM-1010-UPI', NOW() - INTERVAL '7 days', NOW() - INTERVAL '7 days'),
        ('ca000000-0000-0000-0000-000000000102', 'SLM-PAST-14', 'order_past_14', 'pay_past_14', 849.00, 832.02, 16.98, 'settled', 'UPI (Instant Escrow)', 'UTR-SLM-1410-UPI', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Seed Real-Time Chat Message for SLM-LIVE-01
    await query(`
      INSERT INTO chat_messages (id, booking_id, sender_role, message_text, created_at)
      VALUES (
        'fa000000-0000-0000-0000-000000000199', 'SLM-LIVE-01', 'technician',
        'Vanakkam! Meyyanur Saradha College road la irukken, innum 8 mins la reach aagiduven.',
        NOW() - INTERVAL '4 minutes'
      )
      ON CONFLICT (id) DO NOTHING;
    `);

    console.log(' All sample cases seeded successfully into Neon PostgreSQL!');
  } catch (err) {
    console.error(' Seeding failed:', err);
  } finally {
    await pool.end();
  }
}

seedAllCases();
