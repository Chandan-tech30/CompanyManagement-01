// Multer configuration. Files are buffered in memory and then streamed to object
// storage by services/files.js — nothing is ever written to the local disk.
const multer = require('multer');
const path = require('path');
const { UserError } = require('./errors');

const MB = 1024 * 1024;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 25;
const MAX_MEDIA_MB = Number(process.env.MAX_MEDIA_MB) || 50;
const MAX_FILES = Number(process.env.MAX_FILES_PER_UPLOAD) || 50;

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'];
const MEDIA_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov', '.m4v', '.ogv'];
// Anything is allowed for work files (source code, docs, archives...) except programs that run on click.
const BLOCKED_EXT = ['.exe', '.msi', '.bat', '.cmd', '.scr', '.com', '.pif', '.vbs', '.dll'];

function make({ maxMb, allow, deny }) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxMb * MB, files: MAX_FILES },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (allow && !allow.includes(ext)) {
        return cb(new UserError(`"${file.originalname}" — file type ${ext || '(none)'} is not allowed here. Allowed: ${allow.join(', ')}`));
      }
      if (deny && deny.includes(ext)) {
        return cb(new UserError(`"${file.originalname}" — ${ext} files are blocked for security reasons.`));
      }
      cb(null, true);
    },
  });
}

const imageUploader = make({ maxMb: 10, allow: IMAGE_EXT });
const workUploader = make({ maxMb: MAX_UPLOAD_MB, deny: BLOCKED_EXT });
const mediaUploader = make({ maxMb: MAX_MEDIA_MB, allow: MEDIA_EXT });

// Where multer keeps the browser's folder structure: `paths[i]` belongs to `files[i]`.
function collectUploads(req) {
  const files = req.files || [];
  let paths = req.body && req.body.paths;
  if (paths == null) paths = [];
  else if (!Array.isArray(paths)) paths = [paths];
  return files.map((file, i) => ({ file, relPath: paths[i] || '' }));
}

function multerMessage(err) {
  switch (err.code) {
    case 'LIMIT_FILE_SIZE': return `A file is too large (limit ${MAX_UPLOAD_MB} MB per file, ${MAX_MEDIA_MB} MB for announcement media).`;
    case 'LIMIT_FILE_COUNT': return `Too many files in one upload (limit ${MAX_FILES}).`;
    case 'LIMIT_UNEXPECTED_FILE': return 'Unexpected file field in the upload.';
    default: return `Upload problem: ${err.message}`;
  }
}

module.exports = {
  imageUploader,
  uploadWork: workUploader.array('files', MAX_FILES),
  uploadMedia: mediaUploader.array('files', 10),
  collectUploads, multerMessage, MAX_UPLOAD_MB, MAX_MEDIA_MB, MAX_FILES,
};
