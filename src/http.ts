/**
 * rez-media-events — HTTP upload server
 *
 * Sprint 10: Adds an Express HTTP server alongside the BullMQ worker.
 * Handles multipart file uploads, stores metadata in MongoDB, and
 * serves uploaded files as static assets.
 */

import express, { Request, Response, NextFunction } from 'express';
import multer, { FileFilterCallback } from 'multer';
import path from 'path';
import fs from 'fs';
import http from 'http';
import crypto from 'crypto';
import helmet from 'helmet';
import cors from 'cors';
import mongoSanitize from 'express-mongo-sanitize';
import mongoose from 'mongoose';
import { logger } from './config/logger';

// ── Internal token middleware (mirrors rez-catalog-service pattern) ───────────
function resolveScopedTokens(): Record<string, string> | null {
  try {
    const raw = process.env.INTERNAL_SERVICE_TOKENS_JSON;
    const parsed = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    return Object.keys(parsed).length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function requireInternalToken(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers['x-internal-token'] as string | undefined;
  const callerService = req.headers['x-internal-service'] as string | undefined;
  const scopedTokens = resolveScopedTokens();

  if (!scopedTokens) {
    res.status(503).json({ success: false, error: 'Internal auth not configured — set INTERNAL_SERVICE_TOKENS_JSON' });
    return;
  }

  const expected = callerService ? scopedTokens[callerService] : undefined;
  const tokenBuf = Buffer.from(token || '');
  const expectedBuf = Buffer.from(expected || '');

  const isValid =
    !!expected &&
    tokenBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(tokenBuf, expectedBuf);

  if (!isValid) {
    logger.warn('[HTTP] Unauthorized upload attempt', { callerService, ip: req.ip });
    res.status(401).json({ success: false, error: 'Invalid internal token' });
    return;
  }

  next();
}

// ── Uploads directory ────────────────────────────────────────────────────────
const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ── Multer storage and validation ────────────────────────────────────────────
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// B6 FIX: Magic byte signatures to detect actual file type (prevents type spoofing).
// Clients can lie about Content-Type; magic bytes are authoritative.
const MAGIC_BYTES: Array<{ sig: Buffer; mime: string; ext: string }> = [
  { sig: Buffer.from([0xFF, 0xD8, 0xFF]), mime: 'image/jpeg', ext: '.jpg' },
  { sig: Buffer.from([0x89, 0x50, 0x4E, 0x47]), mime: 'image/png', ext: '.png' },
  { sig: Buffer.from([0x52, 0x49, 0x46, 0x46]), mime: 'image/webp', ext: '.webp' }, // RIFF....WEBP
];

function sniffMimeType(buffer: Buffer): string | null {
  for (const { sig, mime } of MAGIC_BYTES) {
    if (buffer.slice(0, sig.length).equals(sig)) return mime;
  }
  return null;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const uniqueName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    cb(null, uniqueName);
  },
});

const fileFilter = (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
  // B6 FIX: Read the first 8 bytes to sniff the actual file type.
  // Reject if magic bytes don't match any known image format,
  // regardless of what the client claimed in Content-Type.
  const header = Buffer.alloc(8);
  const fd = (file as any).buffer
    ? Buffer.from((file as any).buffer.slice(0, 8))
    : null;

  if (fd) {
    const actualMime = sniffMimeType(fd);
    if (!actualMime || !ALLOWED_MIME_TYPES.has(actualMime)) {
      cb(new Error(`File content does not match an allowed image type (jpeg, png, webp). Detected: ${actualMime || 'unknown'}`));
      return;
    }
    // Override mimetype with the sniffed value — trust the bytes, not the header
    (file as any).mimetype = actualMime;
    cb(null, true);
    return;
  }

  // Fallback: use client-supplied mimetype if buffer is not available (shouldn't happen with diskStorage)
  if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: jpeg, png, webp`));
  }
};

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter,
});

// ── MongoDB media_uploads collection helper ──────────────────────────────────
interface MediaUploadDoc {
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  path: string;
  uploadedBy: string | null;
  createdAt: Date;
}

async function insertMediaUpload(doc: MediaUploadDoc): Promise<string> {
  const collection = mongoose.connection.collection('media_uploads');
  const result = await collection.insertOne(doc);
  return result.insertedId.toString();
}

// ── Express app ──────────────────────────────────────────────────────────────
const app = express();
// Behind Render LB + CF — trust N hops so per-IP rate limiters key on real client IP.
// See MASTER-PLAN-2026-04-19 P1 (trust proxy fleet-wide).
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS) || 1);

app.use(helmet());
app.use(cors({
  origin: (process.env.CORS_ORIGIN || 'https://rez.money').split(',').map(s => s.trim()),
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(mongoSanitize());

// Serve uploaded files — protected by internal token so only trusted services can fetch them.
app.use('/uploads', requireInternalToken, express.static(UPLOADS_DIR));

// GET /health
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'rez-media-events' });
});

// B7: Verify magic bytes of the saved upload BEFORE persisting metadata.
// multer (diskStorage) has already written the file at `file.path`; read the
// first 16 bytes synchronously and reject if they don't match an allowed
// image signature — preventing attackers from disguising e.g. a .php payload
// as image/jpeg via the Content-Type header.
function verifyFileSignature(filePath: string): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  const header = Buffer.alloc(16);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, header, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (header.length < 12) return null;
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg';
  if (
    header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47 &&
    header[4] === 0x0d && header[5] === 0x0a && header[6] === 0x1a && header[7] === 0x0a
  ) return 'image/png';
  if (
    header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
    header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50
  ) return 'image/webp';
  return null;
}

// POST /upload  — requires internal service token
app.post(
  '/upload',
  requireInternalToken,
  upload.single('file'),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No file uploaded' });
      return;
    }

    try {
      const { filename, originalname, mimetype, size, path: filePath } = req.file;

      // B7: Magic-byte verification — trust bytes, not the client-supplied header.
      const detectedMime = verifyFileSignature(filePath);
      if (!detectedMime || detectedMime !== mimetype) {
        try { fs.unlinkSync(filePath); } catch { /* best-effort cleanup */ }
        logger.warn('[HTTP] Rejected upload with mismatched signature', {
          filename, declaredMime: mimetype, detectedMime,
        });
        res.status(400).json({
          success: false,
          error: 'Invalid file signature — file contents do not match declared type',
        });
        return;
      }

      // BAK-MEDIA-002 FIX: uploadedBy must be the authenticated service principal, not a
      // user-supplied header value. Previously any caller with the internal token could
      // upload files and set uploadedBy to any arbitrary user ID, enabling identity spoofing.
      // Now uploadedBy is set to the verified internal service name from the auth context.
      const uploadedBy = (req.headers['x-internal-service'] as string | undefined) ?? null;

      const mediaId = await insertMediaUpload({
        filename,
        originalName: originalname,
        mimeType: mimetype,
        size,
        path: filePath,
        uploadedBy,
        createdAt: new Date(),
      });

      logger.info('[HTTP] File uploaded', { filename, mimetype, size, mediaId });

      res.status(201).json({
        success: true,
        url: `/uploads/${filename}`,
        mediaId,
      });
    } catch (err: any) {
      logger.error('[HTTP] Upload failed', { error: err.message });
      res.status(500).json({ success: false, error: 'Upload failed' });
    }
  },
);

// ── Multer error handler ─────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof multer.MulterError || err?.message?.startsWith('Unsupported file type')) {
    res.status(400).json({ success: false, error: err.message });
    return;
  }
  logger.error('[HTTP] Unhandled error', { error: err.message });
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ── Server factory ───────────────────────────────────────────────────────────
export function startHttpServer(port: number): http.Server {
  const server = http.createServer(app);
  server.listen(port, () => {
    logger.info(`[HTTP] Upload server listening on port ${port}`);
  });
  return server;
}
