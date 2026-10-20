const { query } = require('../db/db');
const crypto = require('crypto');

function hashPassword(pwd) {
  if (!pwd) return '';
  return crypto.createHash('sha256').update(pwd.trim()).digest('hex');
}

// In-memory Concurrent Session Registry
// Format: { [cleanPhone]: { sessionToken: string, loggedInAt: number, lastActive: number, role: string } }
const activeUserSessions = {};

async function authRoutes(fastify, options) {
  // 1. Production Credentials-Based Login Endpoint (Username / Phone / Email + Password)
  fastify.post('/auth/login', async (req, reply) => {
    try {
      const { 
        identifier = '', 
        phone = '', 
        username = '', 
        email = '', 
        password = '', 
        role: requestedRole = '' 
      } = req.body || {};

      const rawInput = (identifier || phone || username || email || '').trim();
      const cleanPhone = rawInput.replace(/[\s\-\(\)\+]/g, '').slice(-10);

      if (!rawInput && !cleanPhone) {
        return reply.status(400).send({ 
          success: false, 
          error: 'Please enter your mobile number, username, or email' 
        });
      }

      // Role-aware lookup: if customer portal, check customer account first; if partner portal, check technician account first
      let userRecord = null;
      let userRole = requestedRole === 'technician' || requestedRole === 'partner' ? 'technician' : 'customer';

      const checkTechnician = async () => {
        const techRes = await query(`
          SELECT * FROM technicians 
          WHERE (
            $1::text <> '' AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $1
          )
          OR (LOWER(email) = LOWER($2) AND $2::text <> '')
          OR (LOWER(full_name) = LOWER($2) AND $2::text <> '')
          LIMIT 1
        `, [cleanPhone || '', rawInput.toLowerCase()]);

        if (techRes.rows.length > 0) {
          const t = techRes.rows[0];
          const hashedInput = hashPassword(password);
          
          if (t.password_hash) {
            if (hashedInput !== t.password_hash) {
              return { error: 'Incorrect password for this technician account. Please verify and retry.', status: 401 };
            }
          } else if (!password || password.trim().length < 4) {
            return { error: 'Password is required to sign in.', status: 401 };
          } else {
            await query(`UPDATE technicians SET password_hash = $1 WHERE id = $2`, [hashedInput, t.id]);
          }

          if (t.is_blocked) {
            return { error: `Your partner account has been suspended by Shazu One Central Operations. Reason: ${t.block_reason || 'Administrative compliance review'}`, status: 403 };
          }

          const tradeNames = {
            ac: 'AC Repair & Cooling Expert',
            electrician: 'Electrician & Wiring Specialist',
            plumber: 'Plumbing & Drainage Specialist',
            cleaning: 'Home & Bathroom Cleaning Pro'
          };

          return {
            user: {
              id: t.id,
              role: 'technician',
              name: t.full_name || t.name || 'Certified Partner',
              phone: t.phone || `+91 ${cleanPhone}`,
              email: t.email || `${(t.full_name || 'tech').toLowerCase().replace(/[^a-z]/g, '')}@shazuone.in`,
              trade: t.primary_trade || t.trade || 'ac',
              tradeName: tradeNames[t.primary_trade || t.trade] || 'Home Services Specialist',
              upiId: t.upi_vpa,
              upi_vpa: t.upi_vpa,
              aadhaarCardUrl: t.aadhaar_card_url,
              aadhaarNumber: t.aadhaar_number,
              isKycVerified: Boolean(t.is_kyc_verified),
              is_kyc_verified: Boolean(t.is_kyc_verified),
              status: t.is_kyc_verified ? 'Verified' : 'Pending Verification',
              isOnline: Boolean(t.is_online),
              ratingAvg: t.rating_avg != null ? parseFloat(t.rating_avg) : 0.0,
              jobsCompleted: t.jobs_completed_count != null ? parseInt(t.jobs_completed_count, 10) : 0,
              todayEarnings: 0,
              today_earnings: 0,
              serviceArea: (t.assigned_localities && t.assigned_localities[0]) ? `${t.assigned_localities[0]}, Salem` : 'Fairlands, Salem',
              assignedLocalities: t.assigned_localities || ['Fairlands']
            },
            role: 'technician'
          };
        }
        return null;
      };

      const checkCustomer = async () => {
        const custRes = await query(`
          SELECT * FROM users 
          WHERE (
            $1::text <> '' AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $1
          )
          OR (LOWER(email) = LOWER($2) AND $2::text <> '')
          OR (LOWER(full_name) = LOWER($2) AND $2::text <> '')
          LIMIT 1
        `, [cleanPhone || '', rawInput.toLowerCase()]);

        if (custRes.rows.length > 0) {
          const u = custRes.rows[0];
          const hashedInput = hashPassword(password);

          if (u.password_hash) {
            if (hashedInput !== u.password_hash) {
              return { error: 'Incorrect password. Please verify and retry.', status: 401 };
            }
          } else if (!password || password.trim().length < 4) {
            return { error: 'Password is required to sign in.', status: 401 };
          } else {
            await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hashedInput, u.id]);
          }

          if (u.is_blocked) {
            return { error: `Your account has been suspended by Shazu One Central Operations. Reason: ${u.block_reason || 'Administrative review'}`, status: 403 };
          }

          return {
            user: {
              id: u.id,
              role: u.role || 'customer',
              name: u.full_name || 'Salem Customer',
              phone: u.phone || (cleanPhone ? `+91 ${cleanPhone}` : ''),
              email: u.email || `${(u.full_name || 'user').toLowerCase().replace(/[^a-z]/g, '')}@shazuone.in`,
              locality: u.locality || 'Fairlands, Salem',
              address: u.default_address || 'Fairlands, Salem - 636016',
              walletBalance: parseFloat(u.wallet_balance || 100)
            },
            role: u.role || 'customer'
          };
        }
        return null;
      };

      // Execute role-prioritized check
      if (requestedRole === 'customer') {
        const custResult = await checkCustomer();
        if (custResult?.error) return reply.status(custResult.status).send({ success: false, error: custResult.error });
        if (custResult?.user) {
          userRecord = custResult.user;
          userRole = custResult.role;
        } else {
          const techResult = await checkTechnician();
          if (techResult?.error) return reply.status(techResult.status).send({ success: false, error: techResult.error });
          if (techResult?.user) {
            userRecord = techResult.user;
            userRole = techResult.role;
          }
        }
      } else {
        // Default or technician requested: check technician first
        const techResult = await checkTechnician();
        if (techResult?.error) return reply.status(techResult.status).send({ success: false, error: techResult.error });
        if (techResult?.user) {
          userRecord = techResult.user;
          userRole = techResult.role;
        } else {
          const custResult = await checkCustomer();
          if (custResult?.error) return reply.status(custResult.status).send({ success: false, error: custResult.error });
          if (custResult?.user) {
            userRecord = custResult.user;
            userRole = custResult.role;
          }
        }
      }

      // Dedicated Shazu One Central Ops Admin authentication
      if (!userRecord) {
        if (cleanPhone === '9842099999' || rawInput.toLowerCase() === 'admin' || rawInput.toLowerCase() === 'ops.admin@shazuone.in') {
          if (!password || hashPassword(password) !== hashPassword('salem123')) {
            return reply.status(401).send({ success: false, error: 'Incorrect admin credentials' });
          }
          userRole = 'admin';
          userRecord = {
            id: 'adm-ops-001',
            role: 'admin',
            name: 'Shazu One Central Ops Admin',
            phone: '+91 98420 99999',
            email: 'ops.admin@shazuone.in',
            locality: 'Central HQ, Salem',
            isVerified: true
          };
        }
      }

      // Reject non-existent accounts: Never auto-login unregistered users
      if (!userRecord) {
        return reply.status(401).send({
          success: false,
          error: 'Account not found with these credentials. Please register first or check your mobile number / password.'
        });
      }

      // Session registration
      const sessionPhone = (userRecord.phone || cleanPhone).replace(/[\s\-\(\)\+]/g, '').slice(-10);
      const sessionToken = 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2, 12);

      activeUserSessions[sessionPhone] = {
        sessionToken,
        role: userRole,
        loggedInAt: Date.now(),
        lastActive: Date.now()
      };

      return {
        success: true,
        sessionToken,
        user: userRecord,
        message: 'Login successful'
      };
    } catch (e) {
      fastify.log.error(e);
      return reply.status(500).send({ success: false, error: e.message });
    }
  });

  // 2. Production Account Registration Endpoint
  fastify.post('/auth/register', async (req, reply) => {
    try {
      const {
        name = '',
        phone = '',
        email = '',
        password = '',
        role = 'customer',
        trade = 'ac',
        locality = 'Fairlands, Salem',
        address = '',
        aadhaar = '',
        referralCode = ''
      } = req.body || {};

      const cleanPhone = (phone || '').replace(/[\s\-\(\)\+]/g, '').slice(-10);
      if (!cleanPhone || cleanPhone.length !== 10) {
        return reply.status(400).send({ success: false, error: 'Valid 10-digit mobile number is required' });
      }

      if (!password || password.trim().length < 6) {
        return reply.status(400).send({ 
          success: false, 
          error: 'Password is required and must be at least 6 characters' 
        });
      }

      // Allow same mobile number for 1 customer account AND 1 partner/technician account
      // Enforce: at most ONCE as customer, at most ONCE as technician
      const isTechRole = (role === 'technician' || role === 'partner');

      if (isTechRole) {
        // Check if already registered as technician
        const techCheck = await query(`
          SELECT phone FROM technicians 
          WHERE RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $1
          LIMIT 1
        `, [cleanPhone]);

        if (techCheck.rows.length > 0) {
          return reply.status(409).send({
            success: false,
            error: `Mobile number +91 ${cleanPhone} is already registered as a Partner/Technician. Each mobile number can only have one partner account. Please sign in instead.`
          });
        }

        if (email && email.trim()) {
          const emailCheck = await query(`
            SELECT email FROM technicians WHERE LOWER(email) = LOWER($1) LIMIT 1
          `, [email.trim()]);
          if (emailCheck.rows.length > 0) {
            return reply.status(409).send({
              success: false,
              error: `Email address ${email.trim()} is already registered with another partner account. Please use a different email or sign in.`
            });
          }
        }
      } else {
        // Customer registration: check if already registered as customer
        const custCheck = await query(`
          SELECT phone FROM users 
          WHERE role = 'customer' AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $1
          LIMIT 1
        `, [cleanPhone]);

        if (custCheck.rows.length > 0) {
          return reply.status(409).send({
            success: false,
            error: `Mobile number +91 ${cleanPhone} is already registered as a Customer. Each mobile number can only have one customer account. Please sign in instead.`
          });
        }

        if (email && email.trim()) {
          const emailCheck = await query(`
            SELECT email FROM users WHERE role = 'customer' AND LOWER(email) = LOWER($1) LIMIT 1
          `, [email.trim()]);
          if (emailCheck.rows.length > 0) {
            return reply.status(409).send({
              success: false,
              error: `Email address ${email.trim()} is already registered with another customer account. Please use a different email or sign in.`
            });
          }
        }
      }

      const pwdHash = hashPassword(password);
      const formattedPhone = `+91 ${cleanPhone}`;
      let createdUser = null;

      if (role === 'technician' || role === 'partner') {
        const tradeNames = {
          ac: 'AC Repair & Cooling Expert',
          electrician: 'Electrician & Wiring Specialist',
          plumber: 'Plumbing & Drainage Specialist',
          cleaning: 'Home & Bathroom Cleaning Pro'
        };

        createdUser = {
          id: `tech-${Date.now()}`,
          role: 'technician',
          name: name || 'Salem Technician Partner',
          phone: formattedPhone,
          email: email || `${(name || 'tech').toLowerCase().replace(/[^a-z]/g, '')}@shazuone.in`,
          trade: trade || 'ac',
          tradeName: tradeNames[trade] || 'Home Services Specialist',
          isKycVerified: false,
          isOnline: false,
          ratingAvg: 0.0,
          jobsCompleted: 0,
          todayEarnings: 0,
          aadhaarNumber: aadhaar || 'Pending Upload',
          serviceArea: locality,
          assignedLocalities: [locality.split(',')[0].trim()]
        };

        // Insert into DB without overwriting existing data
        try {
          const insertTechRes = await query(`
            INSERT INTO technicians (full_name, phone, email, primary_trade, is_kyc_verified, is_online, assigned_localities, password_hash, rating_avg, rating_count, jobs_completed_count)
            VALUES ($1, $2, $3, $4, FALSE, FALSE, $5, $6, 0.00, 0, 0)
            RETURNING id
          `, [createdUser.name, createdUser.phone, createdUser.email, createdUser.trade, createdUser.assignedLocalities, pwdHash]);
          
          if (insertTechRes.rows[0]?.id) {
            createdUser.id = insertTechRes.rows[0].id;
          }

          await query(`
            INSERT INTO users (full_name, phone, email, role, locality, password_hash)
            VALUES ($1, $2, $3, 'technician', $4, $5)
            ON CONFLICT (phone) DO NOTHING
          `, [createdUser.name, createdUser.phone, createdUser.email, createdUser.serviceArea, pwdHash]);
        } catch (dbErr) {
          fastify.log.warn('Could not insert tech to DB:', dbErr.message);
        }
      } else {
        createdUser = {
          id: `cust-${Date.now()}`,
          role: 'customer',
          name: name || 'Salem Customer',
          phone: formattedPhone,
          email: email || `${(name || 'customer').toLowerCase().replace(/[^a-z]/g, '')}@shazuone.in`,
          locality: locality || 'Fairlands, Salem',
          address: address || `${locality}, Salem - 636016`,
          walletBalance: 100, // ₹100 Welcome reward
          firstTimeUser: true,
          referralCodeUsed: referralCode ? referralCode.toUpperCase() : null
        };

        // Insert into DB
        try {
          const insertCustRes = await query(`
            INSERT INTO users (full_name, phone, email, role, locality, default_address, wallet_balance, password_hash)
            VALUES ($1, $2, $3, 'customer', $4, $5, 100.00, $6)
            RETURNING id
          `, [createdUser.name, createdUser.phone, createdUser.email, createdUser.locality, createdUser.address, pwdHash]);

          if (insertCustRes.rows[0]?.id) {
            createdUser.id = insertCustRes.rows[0].id;
          }
        } catch (dbErr) {
          fastify.log.warn('Could not insert user to DB:', dbErr.message);
        }
      }

      const sessionToken = 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2, 12);
      activeUserSessions[cleanPhone] = {
        sessionToken,
        role: createdUser.role,
        loggedInAt: Date.now(),
        lastActive: Date.now()
      };

      return {
        success: true,
        sessionToken,
        user: createdUser,
        message: 'Account created successfully'
      };
    } catch (e) {
      fastify.log.error(e);
      return reply.status(500).send({ success: false, error: e.message });
    }
  });

  // 3. Active Session Heartbeat & Concurrent Session Verification
  fastify.post('/auth/session/verify', async (req, reply) => {
    try {
      const { phone = '', sessionToken = '', role = 'customer' } = req.body || {};
      const cleanPhone = (phone || '').replace(/[\s\-\(\)\+]/g, '').slice(-10);

      if (!cleanPhone) {
        return { success: true, active: true };
      }

      const activeSession = activeUserSessions[cleanPhone];

      if (activeSession && sessionToken && activeSession.sessionToken !== sessionToken) {
        return {
          success: false,
          code: 'SESSION_TERMINATED',
          error: 'Your account was logged in on another device. You have been logged out for security.',
          activeOnOtherDevice: true
        };
      }

      if (!activeSession && sessionToken) {
        activeUserSessions[cleanPhone] = {
          sessionToken,
          role,
          loggedInAt: Date.now(),
          lastActive: Date.now()
        };
      } else if (activeSession) {
        activeSession.lastActive = Date.now();
      }

      return {
        success: true,
        active: true
      };
    } catch (e) {
      fastify.log.error(e);
      return { success: true, active: true };
    }
  });

  // 4. User Explicit Logout
  fastify.post('/auth/logout', async (req, reply) => {
    const { phone = '' } = req.body || {};
    const cleanPhone = (phone || '').replace(/[\s\-\(\)\+]/g, '').slice(-10);
    if (cleanPhone && activeUserSessions[cleanPhone]) {
      delete activeUserSessions[cleanPhone];
    }
    return { success: true, message: 'Logged out successfully' };
  });
}

module.exports = authRoutes;
