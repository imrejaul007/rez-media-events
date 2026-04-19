/**
 * rez-media-events — HTTP upload server
 *
 * Sprint 10: Adds an Express HTTP server alongside the BullMQ worker.
 * Handles multipart file uploads, uploads to Cloudinary, stores metadata
 * in MongoDB. Files are served directly from Cloudinary CDN (no local storage).
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

// ── Cloudinary upload helper ─────────────────────────────────────────────────
// B6 FIX: Upload directly from memory to Cloudinary — no ephemeral disk storage.
// Cloudinary serves files from CDN; files survive container restarts and deploys.
async function uploadToCloudinary(
  buffer: Buffer,
  mimeType: string,
  originalName: string,
): Promise<{ url: string; publicId: string; format: string; width: number; height: number }> {
  const cloudinary = await import('cloudinary');
  cloudinary.v2.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.v2.uploader.upload_stream(
      {
        folder: 'rez-media/uploads',
        resource_type: 'image',
        format: mimeType.split('/')[1] || 'jpg',
        original_filename: originalName,
      },
      (error, result) => {
        if (error || !result) {
          reject(error || new Error('Cloudinary upload returned no result'));
          return;
        }
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          format: result.format,
          width: result.width,
          height: result.height,
        });
      },
    );
    uploadStream.end(buffer);
  });
}

// ── Multer memory storage + magic-byte validation ────────────────────────────
// B6 FIX: Store file in memory only. Cloudinary receives the buffer directly
// — no write to ephemeral disk, no subsequent read from disk.
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const MAGIC_BYTES: Array<{ sig: Buffer; mime: string }> = [
  { sig: Buffer.from([0xFF, 0xD8, 0xFF]), mime: 'image/jpeg' },
  { sig: Buffer.from([0x89, 0x50, 0x4E, 0x47]), mime: 'image/png' },
  { sig: Buffer.from([0x52, 0x49, 0x46, 0x46]), mime: 'image/webp' }, // RIFF....WEBP
];

function sniffMimeType(buffer: Buffer): string | null {
  for (const { sig, mime } of MAGIC_BYTES) {
    if (buffer.slice(0, sig.length).equals(sig)) return mime;
  }
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
    const buf = Buffer.from((file as any).buffer?.slice(0, 12) ?? []);
    if (buf.length === 0) {
      cb(new Error('Empty file upload'));
      return;
    }
    const actualMime = sniffMimeType(buf);
    if (!actualMime || !ALLOWED_MIME_TYPES.has(actualMime)) {
      cb(new Error(
        `File content does not match an allowed image type. Detected: ${actualMime || 'unknown'}. Allowed: jpeg, png, webp`,
      ));
      return;
    }
    // Trust the bytes, not the client-supplied header
    (file as any).mimetype = actualMime;
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
  const collection = mongoose.connection.collection('media_uploads');
  const result = await collection.insertOne(doc as any);
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

// POST /upload  — requires internal service token
// B6 FIX: Upload directly from memory to Cloudinary — no ephemeral disk.
// Magic-byte validation is in the multer fileFilter (runs before this handler).
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
      const { buffer, originalname, mimetype, size } = req.file;

      const uploadedBy = (req.headers['x-internal-service'] as string | undefined) ?? null;

      const cloudinaryResult = await uploadToCloudinary(
        Buffer.from(buffer ?? []),
        mimetype,
        originalname,
      );

      const mediaId = await insertMediaUpload({
        originalName: originalname,
        mimeType: mimetype,
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
