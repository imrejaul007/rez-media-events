/**
 * rez-media-events — HTTP upload server
 *
 * Handles multipart file uploads, validates MIME by magic bytes, streams the
 * file directly to Cloudinary (no ephemeral disk), and stores metadata in
 * MongoDB. Files are served from Cloudinary CDN.
 *
 * B6 (MASTER-PLAN-2026-04-19):
 *   - multer.memoryStorage (no write to Render's ephemeral disk)
 *   - magic-byte MIME sniff in the handler AFTER multer populates `file.buffer`
 *     (multer's fileFilter runs BEFORE the buffer is available with memoryStorage)
 *   - Cloudinary client centralized in src/config/cloudinary.ts
 *   - Legacy /uploads/* route returns 410 Gone
 */

import express, { Request, Response, NextFunction } from 'express';
import multer, { FileFilterCallback } from 'multer';
import http from 'http';
import crypto from 'crypto';
import helmet from 'helmet';
import cors from 'cors';
import mongoSanitize from 'express-mongo-sanitize';
import mongoose from 'mongoose';
import { logger } from './config/logger';
import { uploadBufferToCloudinary } from './config/cloudinary';

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
  // MED-SEC-FIX: Reject blank tokens before timing comparison.
  // A blank token padded to the expected length matches timingSafeEqual, bypassing auth.
  const tokenStr = token || '';
  if (tokenStr.trim().length === 0) {
    logger.warn('[HTTP] Unauthorized upload attempt — blank token', { callerService, ip: req.ip });
    res.status(401).json({ success: false, error: 'Invalid internal token' });
    return;
  }
  const tokenBuf = Buffer.from(tokenStr);
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

// ── Multer memory storage ────────────────────────────────────────────────────
// B6: multer.memoryStorage keeps the file in RAM on req.file.buffer — no disk
// writes. Note: with memoryStorage, file.buffer is NOT yet populated inside
// the `fileFilter` callback; it becomes available only after multer has fully
// consumed the multipart stream. Therefore the magic-byte sniff MUST run in
// the handler, not in fileFilter.
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const MAGIC_BYTES: Array<{ sig: Buffer; mime: string }> = [
  { sig: Buffer.from([0xFF, 0xD8, 0xFF]), mime: 'image/jpeg' },
  { sig: Buffer.from([0x89, 0x50, 0x4E, 0x47]), mime: 'image/png' },
  { sig: Buffer.from([0x52, 0x49, 0x46, 0x46]), mime: 'image/webp' }, // RIFF....WEBP
];

function sniffMimeType(buffer: Buffer): string | null {
  for (const { sig, mime } of MAGIC_BYTES) {
    if (buffer.length >= sig.length && buffer.slice(0, sig.length).equals(sig)) {
      return mime;
    }
  }
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
    // Client-declared mimetype check — cheap early reject. The real defence
    // is the magic-byte sniff in the handler below.
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: jpeg, png, webp`));
      return;
    }
    cb(null, true);
  },
});

// ── MongoDB media_uploads collection helper ──────────────────────────────────
interface MediaUploadDoc {
  originalName: string;
  mimeType: string;
  size: number;
  cloudinaryUrl: string;
  cloudinaryPublicId: string;
  width: number;
  height: number;
  uploadedBy: string | null;
  createdAt: Date;
}

async function insertMediaUpload(doc: MediaUploadDoc): Promise<string> {
  const collection = mongoose.connection.collection<MediaUploadDoc>('media_uploads');
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

// GET /health
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'rez-media-events' });
});

// GET /uploads/* — legacy local-disk route, now permanently gone.
// B6: Files are served from Cloudinary CDN. Any consumer still reading from
// /uploads/* has a stale cached URL and should refresh from the originating
// record (which now stores the Cloudinary secure_url).
app.use('/uploads', requireInternalToken, (_req: Request, res: Response) => {
  res.status(410).json({
    success: false,
    error: 'Legacy local-file route removed — files now live on Cloudinary. Refresh the record to get the secure_url.',
    code: 'LEGACY_UPLOADS_GONE',
  });
});

// POST /upload  — requires internal service token
// Magic-byte validation runs AFTER multer has populated req.file.buffer.
app.post(
  '/upload',
  requireInternalToken,
  upload.single('file'),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No file uploaded' });
      return;
    }

    const { buffer, originalname, mimetype: declaredMime, size } = req.file;

    if (!buffer || buffer.length === 0) {
      res.status(400).json({ success: false, error: 'Empty file upload' });
      return;
    }

    // Magic-byte sniff — trust the bytes, not the client-supplied header.
    const actualMime = sniffMimeType(buffer);
    if (!actualMime || !ALLOWED_MIME_TYPES.has(actualMime)) {
      logger.warn('[HTTP] Magic-byte MIME mismatch', {
        declaredMime,
        detected: actualMime ?? 'unknown',
        originalname,
        size,
      });
      res.status(400).json({
        success: false,
        error: `File content does not match an allowed image type. Detected: ${actualMime ?? 'unknown'}. Allowed: jpeg, png, webp`,
      });
      return;
    }

    const uploadedBy = (req.headers['x-internal-service'] as string | undefined) ?? null;

    let cloudinaryResult;
    try {
      cloudinaryResult = await uploadBufferToCloudinary(buffer, {
        mimeType: actualMime,
        folder: 'rez/media-events',
        originalFilename: originalname,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[HTTP] Cloudinary upload failed', { error: message, originalname, size });
      res.status(502).json({ success: false, error: 'Upload service unavailable' });
      return;
    }

    try {
      const mediaId = await insertMediaUpload({
        originalName: originalname,
        mimeType: actualMime,
        size,
        cloudinaryUrl: cloudinaryResult.url,
        cloudinaryPublicId: cloudinaryResult.publicId,
        width: cloudinaryResult.width,
        height: cloudinaryResult.height,
        uploadedBy,
        createdAt: new Date(),
      });

      logger.info('[HTTP] File uploaded', {
        mediaId,
        cloudinaryUrl: cloudinaryResult.url,
        size,
      });

      res.status(201).json({
        success: true,
        url: cloudinaryResult.url,
        publicId: cloudinaryResult.publicId,
        width: cloudinaryResult.width,
        height: cloudinaryResult.height,
        mediaId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[HTTP] Mongo insert failed after Cloudinary upload', {
        error: message,
        publicId: cloudinaryResult.publicId,
      });
      // The Cloudinary asset exists — surface the URL so the caller can still
      // persist it and the asset isn't orphaned.
      res.status(201).json({
        success: true,
        url: cloudinaryResult.url,
        publicId: cloudinaryResult.publicId,
        width: cloudinaryResult.width,
        height: cloudinaryResult.height,
        mediaId: null,
        warning: 'Upload succeeded but metadata persistence failed',
      });
    }
  },
);

// ── Multer error handler ─────────────────────────────────────────────────────
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof multer.MulterError || message.startsWith('Unsupported file type')) {
    res.status(400).json({ success: false, error: message });
    return;
  }
  logger.error('[HTTP] Unhandled error', { error: message });
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
