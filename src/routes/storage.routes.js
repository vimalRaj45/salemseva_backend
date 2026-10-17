const { query } = require('../db/db');
const { uploadToS3, getObjectFromS3, bucketName, MAX_FILE_SIZE } = require('../services/storage.service');

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
        message: 'File successfully uploaded to Neon S3 storage',
        ...result
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 2. File Retrieval & Rendering Endpoint (Streams directly from Neon S3)
  fastify.get('/storage/view', async (req, reply) => {
    try {
      let objectKey = req.query.key;
      const rawUrl = req.query.url;

      if (!objectKey && rawUrl) {
        const parts = rawUrl.split(`${bucketName}/`);
        if (parts.length > 1) {
          objectKey = decodeURIComponent(parts.slice(1).join(`${bucketName}/`));
        } else {
          objectKey = rawUrl;
        }
      }

      if (!objectKey) {
        return reply.status(400).send({ success: false, error: 'Missing key or url query parameter.' });
      }

      const cleanKey = objectKey.replace(/^\/+/, '');
      const s3Obj = await getObjectFromS3(cleanKey);

      reply.header('Content-Type', s3Obj.contentType);
      if (s3Obj.contentLength) {
        reply.header('Content-Length', s3Obj.contentLength);
      }
      reply.header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=3600');
      reply.header('Content-Disposition', 'inline');
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Cross-Origin-Resource-Policy', 'cross-origin');

      return reply.send(s3Obj.stream);
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        return reply.status(404).send({ success: false, error: 'Object not found in Neon S3 bucket' });
      }
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 3. Direct Wildcard File Retrieval
  fastify.get('/storage/file/*', async (req, reply) => {
    try {
      const wildcard = req.params['*'];
      if (!wildcard) {
        return reply.status(400).send({ success: false, error: 'Missing object key path.' });
      }
      const s3Obj = await getObjectFromS3(wildcard);
      reply.header('Content-Type', s3Obj.contentType);
      if (s3Obj.contentLength) reply.header('Content-Length', s3Obj.contentLength);
      reply.header('Cache-Control', 'public, max-age=86400');
      reply.header('Content-Disposition', 'inline');
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
      return reply.send(s3Obj.stream);
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        return reply.status(404).send({ success: false, error: 'Object not found in Neon S3 bucket' });
      }
      fastify.log.error(err);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 4. Object Metadata Inspection
  fastify.get('/storage/info', async (req, reply) => {
    try {
      const key = req.query.key;
      if (!key) return reply.status(400).send({ success: false, error: 'Missing key query parameter.' });
      const s3Obj = await getObjectFromS3(key);
      return {
        success: true,
        key,
        contentType: s3Obj.contentType,
        contentLength: s3Obj.contentLength,
        lastModified: s3Obj.lastModified,
        metadata: s3Obj.metadata
      };
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        return reply.status(404).send({ success: false, error: 'Object not found in Neon S3 bucket' });
      }
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

      // Retrieve existing labor cost
      const qiRes = await query(`
        SELECT price, qty FROM quote_items 
        WHERE booking_id = $1 AND item_type != 'Spare Part'
      `, [bookingId]);
      
      let laborCost = qiRes.rows.reduce((sum, r) => sum + (parseFloat(r.price) || 0) * (r.qty || 1), 0);
      if (laborCost <= 0) laborCost = 250.00;

      const parsedAmount = parseFloat(billAmount) || null;
      const validBillAmt = parsedAmount !== null ? parsedAmount : 0;
      const platformFee = Math.round((validBillAmt + laborCost) * 0.05 * 100) / 100;
      const dynamicTotal = validBillAmt + laborCost + platformFee;

      // Update Booking in DB with parts bill, subtotal and recalculated total
      const updateRes = await query(`
        UPDATE bookings 
        SET parts_bill_url = $1,
            parts_bill_uploaded_at = NOW(),
            parts_bill_amount = COALESCE($2, parts_bill_amount),
            quote_subtotal = $3,
            final_amount = $4
        WHERE id = $5
        RETURNING *;
      `, [uploadRes.url, parsedAmount, validBillAmt + laborCost, dynamicTotal, bookingId]);

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
            billAmount: parsedAmount,
            laborCost,
            platformFee,
            finalAmount: dynamicTotal
          })
        ]);
      } catch (auditErr) {}

      return {
        success: true,
        message: 'Spare parts purchase bill successfully uploaded and attached to booking',
        bookingId,
        billUrl: uploadRes.url,
        uploadedAt: new Date().toISOString(),
        billAmount: parsedAmount,
        laborCost,
        platformFee,
        finalAmount: dynamicTotal,
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
        SELECT id, parts_bill_url, parts_bill_uploaded_at, parts_bill_amount, parts_mode, quote_subtotal, final_amount
        FROM bookings
        WHERE id = $1
      `, [bookingId]);

      if (res.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Booking not found' });
      }

      const row = res.rows[0];
      const billAmt = parseFloat(row.parts_bill_amount) || 0;
      
      const qiRes = await query(`
        SELECT price, qty FROM quote_items 
        WHERE booking_id = $1 AND item_type != 'Spare Part'
      `, [bookingId]);
      let laborCost = qiRes.rows.reduce((sum, r) => sum + (parseFloat(r.price) || 0) * (r.qty || 1), 0);
      if (laborCost <= 0) laborCost = 250.00;

      const subtotal = row.parts_mode === 'user_buys' ? laborCost : (billAmt + laborCost);
      const platformFee = Math.round(subtotal * 0.05 * 100) / 100;
      const totalAmount = subtotal + platformFee;

      return {
        success: true,
        bookingId: row.id,
        hasBill: Boolean(row.parts_bill_url),
        billUrl: row.parts_bill_url,
        uploadedAt: row.parts_bill_uploaded_at,
        billAmount: row.parts_bill_amount,
        laborCost,
        platformFee,
        totalAmount,
        partsMode: row.parts_mode,
        quoteSubtotal: row.quote_subtotal,
        finalAmount: row.final_amount
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
          WHERE REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+91', '') = REPLACE(REPLACE(REPLACE($2, ' ', ''), '-', ''), '+91', '')
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
