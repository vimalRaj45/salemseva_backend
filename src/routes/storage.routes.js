const { query } = require('../db/db');
const { uploadToS3, MAX_FILE_SIZE } = require('../services/storage.service');

async function storageRoutes(fastify, options) {
  // Ensure database columns exist in Neon PostgreSQL
  try {
    await query(`
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS parts_bill_url TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS parts_bill_uploaded_at TIMESTAMP WITH TIME ZONE;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS parts_bill_amount NUMERIC(10,2);
      ALTER TABLE technicians ADD COLUMN IF NOT EXISTS aadhaar_card_url TEXT;
      ALTER TABLE technicians ADD COLUMN IF NOT EXISTS aadhaar_uploaded_at TIMESTAMP WITH TIME ZONE;
    `);
  } catch (dbInitErr) {
    fastify.log.warn('Storage schema initialization notice:', dbInitErr.message);
  }

  // 1. General Upload Endpoint (Base64 / S3 Upload)
  fastify.post('/storage/upload', async (req, reply) => {
    try {
      const {
        fileData,
        mimeType = 'image/jpeg',
        folder = 'uploads',
        referenceId = 'doc',
        fileName = ''
      } = req.body || {};

      if (!fileData) {
        return reply.status(400).send({ success: false, error: 'Missing fileData (Buffer or Base64 required).' });
      }

      const result = await uploadToS3({
        fileData,
        mimeType,
        folder,
        referenceId,
        fileName
      });

      return {
        success: true,
        message: 'File successfully uploaded to S3 storage',
        ...result
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 2. Technician Spare Parts Bill Upload on Quote Acceptance
  fastify.post('/partner/bookings/:id/upload-bill', async (req, reply) => {
    try {
      const bookingId = req.params.id;
      const {
        fileData,
        mimeType = 'image/jpeg',
        billAmount,
        fileName = 'receipt.jpg'
      } = req.body || {};

      if (!fileData) {
        return reply.status(400).send({ success: false, error: 'Bill image/document data is required.' });
      }

      // Upload to S3 under 'bills' folder
      const uploadRes = await uploadToS3({
        fileData,
        mimeType,
        folder: 'bills',
        referenceId: bookingId,
        fileName
      });

      // Update Booking in DB
      const parsedAmount = parseFloat(billAmount) || null;
      const updateRes = await query(`
        UPDATE bookings 
        SET parts_bill_url = $1,
            parts_bill_uploaded_at = NOW(),
            parts_bill_amount = COALESCE($2, parts_bill_amount)
        WHERE id = $3
        RETURNING *;
      `, [uploadRes.url, parsedAmount, bookingId]);

      // Record Audit Log
      try {
        await query(`
          INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
          VALUES ($1, 'PARTS_BILL_UPLOADED', 'tech_partner', 'technician', $2)
        `, [
          bookingId,
          JSON.stringify({
            billUrl: uploadRes.url,
            storageType: uploadRes.storageType,
            size: uploadRes.size,
            billAmount: parsedAmount
          })
        ]);
      } catch (auditErr) {}

      return {
        success: true,
        message: 'Spare parts purchase bill successfully uploaded and attached to booking',
        bookingId,
        billUrl: uploadRes.url,
        uploadedAt: new Date().toISOString(),
        booking: updateRes.rows[0] || null
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 3. Get Parts Bill Details for a Booking
  fastify.get('/partner/bookings/:id/bill', async (req, reply) => {
    try {
      const bookingId = req.params.id;
      const res = await query(`
        SELECT id, parts_bill_url, parts_bill_uploaded_at, parts_bill_amount, parts_mode, quote_subtotal
        FROM bookings
        WHERE id = $1
      `, [bookingId]);

      if (res.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Booking not found' });
      }

      const row = res.rows[0];
      return {
        success: true,
        bookingId: row.id,
        hasBill: Boolean(row.parts_bill_url),
        billUrl: row.parts_bill_url,
        uploadedAt: row.parts_bill_uploaded_at,
        billAmount: row.parts_bill_amount,
        partsMode: row.parts_mode,
        quoteSubtotal: row.quote_subtotal
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 4. Technician Aadhaar KYC Document Upload
  fastify.post('/partner/aadhaar/upload', async (req, reply) => {
    try {
      const {
        fileData,
        mimeType = 'image/jpeg',
        phone,
        fileName = 'aadhaar.jpg'
      } = req.body || {};

      if (!fileData) {
        return reply.status(400).send({ success: false, error: 'Aadhaar image file data is required.' });
      }

      const cleanPhone = (phone || '').replace(/[\s\-\(\)]/g, '') || 'unknown';

      // Upload to S3 under 'aadhaar' folder
      const uploadRes = await uploadToS3({
        fileData,
        mimeType,
        folder: 'aadhaar',
        referenceId: cleanPhone,
        fileName
      });

      // Update technician record if phone provided
      let updatedTech = null;
      if (cleanPhone && cleanPhone !== 'unknown') {
        const updateRes = await query(`
          UPDATE technicians 
          SET aadhaar_card_url = $1,
              aadhaar_uploaded_at = NOW()
          WHERE REPLACE(REPLACE(phone, ' ', ''), '-', '') = $2
          RETURNING *;
        `, [uploadRes.url, cleanPhone]);
        updatedTech = updateRes.rows[0] || null;
      }

      // Record Audit Log
      try {
        await query(`
          INSERT INTO audit_logs (booking_id, event_type, actor_id, actor_type, metadata)
          VALUES ($1, 'AADHAAR_KYC_UPLOADED', $2, 'technician', $3)
        `, [
          `TECH-KYC-${cleanPhone}`,
          cleanPhone,
          JSON.stringify({
            aadhaarUrl: uploadRes.url,
            storageType: uploadRes.storageType,
            size: uploadRes.size
          })
        ]);
      } catch (auditErr) {}

      return {
        success: true,
        message: 'Aadhaar KYC document uploaded successfully to S3 storage',
        aadhaarCardUrl: uploadRes.url,
        uploadedAt: new Date().toISOString(),
        technician: updatedTech
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });
}

module.exports = storageRoutes;
