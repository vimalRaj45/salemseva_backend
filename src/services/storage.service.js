const { S3Client, PutObjectCommand, GetObjectCommand, CreateBucketCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');

// Clean environment variables (remove any extraneous quotes)
const clean = (val) => (val ? val.replace(/^["']|["']$/g, '').trim() : '');

const endpoint = clean(process.env.AWS_ENDPOINT_URL_S3) || 'https://br-twilight-dawn-b5thktcp.storage.c-7.us-east-2.aws.neon.tech';
const accessKeyId = clean(process.env.AWS_ACCESS_KEY_ID) || 'nak_live_760937633e7a4e9b94a222c79dbe6ab1';
const secretAccessKey = clean(process.env.AWS_SECRET_ACCESS_KEY) || 'nsk_live_35a2b7a09dbee48b3fa7e0e59fcec698febd310ab599cd43b7467596332e091c';
const region = clean(process.env.AWS_REGION) || 'us-east-2';
const bucketName = clean(process.env.S3_BUCKET_NAME) || 'Shazu One-uploads';

let s3Client = null;

try {
  s3Client = new S3Client({
    endpoint,
    region,
    credentials: {
      accessKeyId,
      secretAccessKey
    },
    forcePathStyle: true
  });
} catch (err) {
  console.warn('S3Client initialization warning:', err.message);
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB strict limit

// Uploads that silently degrade to a data URI in a text column were reported as successful
// while nothing reached object storage. The fallback now has to be requested explicitly.
const ALLOW_BASE64_FALLBACK = process.env.ALLOW_BASE64_FALLBACK === '1';

// The client declares the MIME type and it was passed straight to S3 as ContentType, which
// allows an HTML or SVG payload to be served from our own origin. Only these are accepted.
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'application/pdf'
]);

/**
 * Ensure bucket exists in S3-compatible storage
 */
async function ensureBucketExists(bucket) {
  if (!s3Client) return;
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (err) {
    try {
      await s3Client.send(new CreateBucketCommand({ Bucket: bucket }));
      console.log(`Created S3 bucket: ${bucket}`);
    } catch (createErr) {
      // Ignore if already owned or not permitted
    }
  }
}

/**
 * Upload buffer or base64 file to S3-compatible storage
 * @param {Object} options
 * @param {Buffer|string} options.fileData - Buffer or base64 data string
 * @param {string} options.mimeType - e.g. 'image/jpeg', 'image/png', 'application/pdf'
 * @param {string} options.folder - 'bills' | 'aadhaar' | 'proofs'
 * @param {string} options.referenceId - booking ID or tech phone
 * @param {string} [options.fileName] - optional original file name
 */
async function uploadToS3({ fileData, mimeType = 'image/jpeg', folder = 'uploads', referenceId = 'doc', fileName = '' }) {
  let buffer;

  if (Buffer.isBuffer(fileData)) {
    buffer = fileData;
  } else if (typeof fileData === 'string') {
    // If it's a data URL like data:image/jpeg;base64,...
    const matches = fileData.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (matches && matches.length === 3) {
      mimeType = matches[1];
      buffer = Buffer.from(matches[2], 'base64');
    } else {
      buffer = Buffer.from(fileData, 'base64');
    }
  } else {
    throw new Error('Invalid fileData format. Expected Buffer or base64 string.');
  }

  // 1. Strict 5 MB Size Enforcement
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(`File size (${(buffer.length / (1024 * 1024)).toFixed(2)} MB) exceeds 5 MB limit.`);
  }

  // 2. Reject anything that is not a document type we serve
  const normalizedMime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(normalizedMime)) {
    throw new Error(`Unsupported file type: ${normalizedMime || 'unknown'}. Allowed: JPEG, PNG, WEBP, PDF.`);
  }
  mimeType = normalizedMime;

  // 3. Resolve File Extension
  let ext = 'jpg';
  if (mimeType.includes('png')) ext = 'png';
  else if (mimeType.includes('webp')) ext = 'webp';
  else if (mimeType.includes('pdf')) ext = 'pdf';
  else if (fileName && fileName.includes('.')) ext = fileName.split('.').pop().toLowerCase();

  const cleanRef = String(referenceId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  const objectKey = `${folder}/${cleanRef}_${timestamp}_${randomSuffix}.${ext}`;

  // 3. Upload to S3-Compatible Storage
  try {
    await ensureBucketExists(bucketName);

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      Body: buffer,
      ContentType: mimeType,
      Metadata: {
        referenceId: cleanRef,
        folder,
        uploadedAt: new Date().toISOString()
      }
    });

    await s3Client.send(command);

    // Build accessible S3 endpoint and application proxy URLs
    const rawS3Url = `${endpoint.replace(/\/$/, '')}/${bucketName}/${objectKey}`;
    const proxyUrl = `/api/v1/storage/view?key=${encodeURIComponent(objectKey)}`;

    return {
      success: true,
      url: proxyUrl,
      rawS3Url,
      key: objectKey,
      bucket: bucketName,
      size: buffer.length,
      mimeType,
      storageType: 'S3_NEON'
    };
  } catch (s3Error) {
    if (!ALLOW_BASE64_FALLBACK) {
      console.error('Storage upload failed and the base64 fallback is disabled:', s3Error.message);
      throw new Error(`Storage upload failed: ${s3Error.message}`);
    }
    console.warn('Direct S3 upload failed, using the base64 fallback:', s3Error.message);
    
    // Resilient fallback: Return clean Data URI so user experience is 100% uninterrupted
    const fallbackDataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
    return {
      success: true,
      url: fallbackDataUrl,
      key: objectKey,
      bucket: 'local_fallback',
      size: buffer.length,
      mimeType,
      storageType: 'BASE64_FALLBACK',
      warning: s3Error.message
    };
  }
}

/**
 * Retrieve an object stream and metadata from Neon S3 storage
 * @param {string} key
 */
async function getObjectFromS3(key) {
  if (!s3Client) {
    throw new Error('S3 Client is not initialized');
  }
  const cleanKey = (key || '').replace(/^\/+/, '');
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: cleanKey
  });
  const response = await s3Client.send(command);
  return {
    stream: response.Body,
    contentType: response.ContentType || 'application/octet-stream',
    contentLength: response.ContentLength,
    metadata: response.Metadata,
    lastModified: response.LastModified
  };
}

module.exports = {
  uploadToS3,
  getObjectFromS3,
  bucketName,
  endpoint,
  MAX_FILE_SIZE
};
