// Object storage (S3-compatible: Cloudflare R2, AWS S3, Backblaze B2, MinIO, ...).
// Files are stored PRIVATE; the app hands out short-lived signed URLs (see routes/files.js).
const {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand, HeadBucketCommand, CreateBucketCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const REQUIRED = ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
let client = null;

function missingVars() {
  return REQUIRED.filter((k) => !process.env[k]);
}

// Called at startup: refuse to run without storage (there is no local-disk fallback on purpose).
function assertConfigured() {
  const missing = missingVars();
  if (missing.length) {
    console.error(`\n[storage] Missing environment variable(s): ${missing.join(', ')}\n` +
      '          File uploads are stored in an S3-compatible bucket (Cloudflare R2 / AWS S3).\n' +
      '          See .env.example and README.md ("Object storage").\n');
    process.exit(1);
  }
}

function getClient() {
  if (client) return client;
  client = new S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE).toLowerCase() === 'true',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
    // R2 and some other S3 clones reject the newer default checksum headers.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return client;
}

const bucket = () => process.env.S3_BUCKET;

function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`no answer after ${ms / 1000} s`), { name: 'Timeout' })), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// Startup self-test: tells you immediately (in the log) if the credentials or bucket are wrong.
// With S3_AUTO_CREATE_BUCKET=true (meant for local development) a missing bucket is created for you.
async function checkConnection() {
  const autoCreate = String(process.env.S3_AUTO_CREATE_BUCKET).toLowerCase() === 'true';
  try {
    await withTimeout(getClient().send(new HeadBucketCommand({ Bucket: bucket() })), 10000);
    console.log(`[storage] connected to bucket "${bucket()}"`);
    return true;
  } catch (err) {
    const missing = err.name === 'NotFound' || err.name === 'NoSuchBucket' || (err.$metadata && err.$metadata.httpStatusCode === 404);
    if (missing && autoCreate) {
      try {
        await withTimeout(getClient().send(new CreateBucketCommand({ Bucket: bucket() })), 10000);
        console.log(`[storage] bucket "${bucket()}" did not exist, so it was created`);
        return true;
      } catch (createErr) {
        console.error(`[storage] could not create bucket "${bucket()}": ${createErr.name} — ${createErr.message}`);
        return false;
      }
    }
    console.error(`[storage] COULD NOT REACH BUCKET "${bucket()}": ${err.name} — ${err.message}\n` +
      '          Uploads will fail until S3_ENDPOINT / S3_BUCKET / keys are corrected' +
      (missing ? ' (the bucket does not exist: create it, or set S3_AUTO_CREATE_BUCKET=true for local development).' : '.'));
    return false;
  }
}

async function putObject(key, body, contentType) {
  await getClient().send(new PutObjectCommand({
    Bucket: bucket(), Key: key, Body: body,
    ContentType: contentType || 'application/octet-stream',
    ContentLength: body.length,
  }));
}

async function deleteKeys(keys) {
  const list = (keys || []).filter(Boolean);
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    try {
      await getClient().send(new DeleteObjectsCommand({
        Bucket: bucket(), Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
      }));
    } catch (err) {
      // Never fail a user action because of clean-up; the DB row is already gone.
      console.error('[storage] delete failed (objects may be orphaned):', err.message);
    }
  }
}

async function getObjectStream(key) {
  const res = await getClient().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  return res.Body; // Node Readable
}

function contentDisposition(name, inline) {
  const safe = String(name || 'file').replace(/[\r\n"]/g, '_');
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

async function signedUrl(key, { name, inline = false, contentType, expiresIn = 300 } = {}) {
  const cmd = new GetObjectCommand({
    Bucket: bucket(), Key: key,
    ResponseContentDisposition: contentDisposition(name, inline),
    ...(contentType ? { ResponseContentType: contentType } : {}),
  });
  return getSignedUrl(getClient(), cmd, { expiresIn });
}

module.exports = { assertConfigured, checkConnection, putObject, deleteKeys, getObjectStream, signedUrl };
