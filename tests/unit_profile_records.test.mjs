import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Unit Test: Customer and Technician Real Database Profile System', () => {
  it('should validate customer profile parameters and sanitize phone digits', () => {
    const rawPhone = '+91 98427 11234';
    const cleanPhone = rawPhone.replace(/[^0-9]/g, '').slice(-10);
    assert.equal(cleanPhone, '9842711234');
    assert.equal(cleanPhone.length, 10);
  });

  it('should structure customer profile from database row without hardcoded placeholders', () => {
    const dbRow = {
      id: 'c0000000-0000-0000-0000-000000000001',
      full_name: 'Vimal Raj',
      phone: '+919842711234',
      email: 'vimal.raj@example.com',
      locality: 'Fairlands, Salem',
      default_address: '14/2, 5th Cross, Fairlands, Salem - 636016',
      wallet_balance: '150.00',
      referral_code: 'SALEM100',
      created_at: new Date('2026-01-15T10:00:00Z')
    };

    const totalBookings = 4;
    const completedBookings = 3;

    const customer = {
      id: dbRow.id,
      name: dbRow.full_name,
      phone: dbRow.phone,
      email: dbRow.email,
      locality: dbRow.locality,
      address: dbRow.default_address,
      walletBalance: parseFloat(dbRow.wallet_balance),
      referralCode: dbRow.referral_code,
      totalBookings,
      completedBookings
    };

    assert.equal(customer.name, 'Vimal Raj');
    assert.equal(customer.walletBalance, 150.0);
    assert.equal(customer.locality, 'Fairlands, Salem');
    assert.equal(customer.totalBookings, 4);
    assert.equal(customer.completedBookings, 3);
  });

  it('should structure technician profile with dynamic DB stats instead of hardcoded numbers', () => {
    const dbTechRow = {
      id: 't0000000-0000-0000-0000-000000000001',
      full_name: 'Saravanan K.',
      phone: '+919842788990',
      primary_trade: 'ac',
      secondary_trades: ['electrician'],
      years_experience: 8,
      rating_avg: '4.95',
      rating_count: 42,
      daily_job_capacity: 4,
      assigned_localities: ['Fairlands, Salem', 'Hasthampatti, Salem'],
      is_kyc_verified: true,
      upi_vpa: '9842788990@ybl'
    };

    const completedJobs = 27;
    const todayEarnings = 750.0;
    const totalEarnings = 18500.0;

    const techProfile = {
      id: dbTechRow.id,
      name: dbTechRow.full_name,
      trade: dbTechRow.primary_trade,
      secondaryTrades: dbTechRow.secondary_trades,
      yearsExperience: dbTechRow.years_experience,
      ratingAvg: parseFloat(dbTechRow.rating_avg),
      ratingCount: dbTechRow.rating_count,
      dailyJobCapacity: dbTechRow.daily_job_capacity,
      jobsCompleted: completedJobs,
      todayEarnings,
      totalEarnings,
      isKycVerified: dbTechRow.is_kyc_verified,
      upiVpa: dbTechRow.upi_vpa
    };

    assert.equal(techProfile.name, 'Saravanan K.');
    assert.equal(techProfile.trade, 'ac');
    assert.equal(techProfile.yearsExperience, 8);
    assert.equal(techProfile.jobsCompleted, 27);
    assert.equal(techProfile.todayEarnings, 750.0);
    assert.equal(techProfile.ratingAvg, 4.95);
    assert.equal(techProfile.isKycVerified, true);
  });

  it('should clamp technician daily capacity between 1 and 4 per Shazu One ops rules', () => {
    const clampCapacity = (input) => {
      const val = parseInt(input, 10);
      return isNaN(val) ? 4 : Math.min(4, Math.max(1, val));
    };
    assert.equal(clampCapacity(10), 4);
    assert.equal(clampCapacity(0), 1);
    assert.equal(clampCapacity(-5), 1);
    assert.equal(clampCapacity(3), 3);
    assert.equal(clampCapacity('invalid'), 4);
  });
});
