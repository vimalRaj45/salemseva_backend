const zlib = require('zlib');
const { PassThrough } = require('stream');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  CreateBucketCommand,
  HeadBucketCommand
} = require('@aws-sdk/client-s3');

// Clean environment variables (remove any extraneous quotes)
const clean = (val) => (val ? val.replace(/^["']|["']$/g, '').trim() : '');

const endpoint = clean(process.env.AWS_ENDPOINT_URL_S3) || 'https://br-twilight-dawn-b5thktcp.storage.c-7.us-east-2.aws.neon.tech';
const accessKeyId = clean(process.env.AWS_ACCESS_KEY_ID);
const secretAccessKey = clean(process.env.AWS_SECRET_ACCESS_KEY);
const region = clean(process.env.AWS_REGION) || 'us-east-2';
const bucketName = clean(process.env.S3_BUCKET_NAME) || 'docs';

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

// Allow base64 fallback so voice notes and documents are never blocked if cloud S3 is temporarily unreachable
const ALLOW_BASE64_FALLBACK = process.env.ALLOW_BASE64_FALLBACK !== '0';

// The client declares the MIME type and it was passed straight to S3 as ContentType, which
// allows an HTML or SVG payload to be served from our own origin. Only these are accepted.
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'application/pdf',
  'audio/webm',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac'
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
    // Support data URLs with optional parameters such as data:audio/webm;codecs=opus;base64,...
    const matches = fileData.match(/^data:([A-Za-z0-9.+\/-]+)(?:;[^,;]+)*;base64,(.+)$/);
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
    throw new Error(`Unsupported file type: ${normalizedMime || 'unknown'}. Allowed: JPEG, PNG, WEBP, PDF, WEBM, OGG, WAV, MP3, M4A, AAC.`);
  }
  mimeType = normalizedMime;

  // 3. Resolve File Extension
  let ext = 'jpg';
  if (mimeType.includes('png')) ext = 'png';
  else if (mimeType.includes('webp')) ext = 'webp';
  else if (mimeType.includes('pdf')) ext = 'pdf';
  else if (mimeType.includes('webm')) ext = 'webm';
  else if (mimeType.includes('ogg')) ext = 'ogg';
  else if (mimeType.includes('wav') || mimeType.includes('wave')) ext = 'wav';
  else if (mimeType.includes('mp4') || mimeType.includes('m4a') || mimeType.includes('aac')) ext = 'm4a';
  else if (mimeType.includes('mpeg') || mimeType.includes('mp3')) ext = 'mp3';
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

/**
 * Extract S3 object key from a proxy URL (/api/v1/storage/view?key=...), S3 URL, or raw key.
 * Returns null for data: URIs or empty values.
 */
function extractS3Key(keyOrUrl) {
  if (!keyOrUrl || typeof keyOrUrl !== 'string') return null;
  const trimmed = keyOrUrl.trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return null;

  if (trimmed.includes('/storage/view')) {
    try {
      const parsed = new URL(trimmed, 'http://localhost');
      const k = parsed.searchParams.get('key');
      if (k) return k.replace(/^\/+/, '');
    } catch (_) {}
  }

  if (trimmed.includes(`${bucketName}/`)) {
    const parts = trimmed.split(`${bucketName}/`);
    if (parts.length > 1 && parts[1]) {
      return decodeURIComponent(parts.slice(1).join(`${bucketName}/`)).replace(/^\/+/, '');
    }
  }

  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return trimmed.replace(/^\/+/, '');
  }
  return null;
}

/**
 * Delete an object from S3-compatible storage by key or storage URL.
 */
async function deleteFromS3(keyOrUrl) {
  const cleanKey = extractS3Key(keyOrUrl);
  if (!cleanKey || !s3Client) return { deleted: false, key: cleanKey };
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: cleanKey }));
    return { deleted: true, key: cleanKey };
  } catch (err) {
    console.warn(`[Storage] Failed to delete S3 object ${cleanKey}:`, err.message);
    return { deleted: false, key: cleanKey, error: err.message };
  }
}

/**
 * List all objects in the configured S3 bucket (paginated).
 */
async function listS3Objects({ prefix = '' } = {}) {
  if (!s3Client) {
    throw new Error('S3 Client is not initialized');
  }

  const cleanPrefix = String(prefix || '').replace(/^\/+/, '');
  const items = [];
  let continuationToken;

  do {
    const command = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: cleanPrefix || undefined,
      MaxKeys: 1000,
      ContinuationToken: continuationToken
    });
    const res = await s3Client.send(command);
    for (const obj of res.Contents || []) {
      const key = obj.Key || '';
      const folder = key.includes('/') ? key.split('/')[0] : 'root';
      items.push({
        key,
        folder,
        fileName: key.split('/').pop() || key,
        size: Number(obj.Size || 0),
        lastModified: obj.LastModified ? new Date(obj.LastModified).toISOString() : null,
        viewUrl: `/api/v1/storage/view?key=${encodeURIComponent(key)}`
      });
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  items.sort((a, b) => new Date(b.lastModified || 0) - new Date(a.lastModified || 0));
  return items;
}

/**
 * Delete multiple S3 objects by keys (in batches of 1000).
 */
async function deleteS3Objects(keys = []) {
  if (!s3Client) {
    throw new Error('S3 Client is not initialized');
  }
  const cleanKeys = [...new Set((keys || []).map(extractS3Key).filter(Boolean))];
  if (cleanKeys.length === 0) return { deletedCount: 0, keys: [] };

  let deletedCount = 0;
  for (let i = 0; i < cleanKeys.length; i += 1000) {
    const batch = cleanKeys.slice(i, i + 1000);
    const res = await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: bucketName,
        Delete: {
          Objects: batch.map(Key => ({ Key })),
          Quiet: false
        }
      })
    );
    deletedCount += (res.Deleted || []).length;
  }
  return { deletedCount, keys: cleanKeys };
}

function createTarHeader(filePath, size, mtimeMs = Date.now()) {
  const header = Buffer.alloc(512, 0);
  let name = String(filePath || 'file').replace(/^\/+/, '');
  let prefix = '';

  if (Buffer.byteLength(name) > 100) {
    const parts = name.split('/');
    const file = parts.pop();
    prefix = parts.join('/').slice(0, 155);
    name = file.slice(0, 100);
  }

  header.write(name.slice(0, 100), 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write(Math.floor(mtimeMs / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii'); // checksum placeholder
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  if (prefix) {
    header.write(prefix, 345, 155, 'utf8');
  }

  let chksum = 0;
  for (let i = 0; i < 512; i++) chksum += header[i];
  header.write(chksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

async function streamToBuffer(body) {
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Streams a compressed .tar.gz archive of S3 objects.
 */
function createS3TarGzStream({ prefix = '', keys = null } = {}) {
  const tarStream = new PassThrough();
  const gzipStream = zlib.createGzip({ level: 6 });
  tarStream.pipe(gzipStream);

  (async () => {
    try {
      let targetKeys = Array.isArray(keys) && keys.length > 0
        ? [...new Set(keys.map(extractS3Key).filter(Boolean))]
        : (await listS3Objects({ prefix })).map(o => o.key);

      for (const key of targetKeys) {
        try {
          const obj = await getObjectFromS3(key);
          const buf = await streamToBuffer(obj.stream);
          const mtime = obj.lastModified ? new Date(obj.lastModified).getTime() : Date.now();
          tarStream.write(createTarHeader(key, buf.length, mtime));
          if (buf.length > 0) {
            tarStream.write(buf);
            const remainder = buf.length % 512;
            if (remainder !== 0) {
              tarStream.write(Buffer.alloc(512 - remainder, 0));
            }
          }
        } catch (itemErr) {
          console.warn(`[Storage Archive] Skipping ${key}:`, itemErr.message);
        }
      }

      // End-of-archive: two 512-byte zero blocks
      tarStream.write(Buffer.alloc(1024, 0));
      tarStream.end();
    } catch (err) {
      tarStream.destroy(err);
    }
  })();

  return gzipStream;
}

module.exports = {
  uploadToS3,
  getObjectFromS3,
  deleteFromS3,
  deleteS3Objects,
  listS3Objects,
  createS3TarGzStream,
  createTarHeader,
  extractS3Key,
  bucketName,
  endpoint,
  MAX_FILE_SIZE
};
