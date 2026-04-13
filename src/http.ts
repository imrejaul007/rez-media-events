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

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}${ext}`;
    cb(null, uniqueName);
  },
});

const fileFilter = (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
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

app.use(express.json());

// Serve uploaded files — protected by internal token so only trusted services can fetch them.
app.use('/uploads', requireInternalToken, express.static(UPLOADS_DIR));

// GET /health
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'rez-media-events' });
});

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

      // Extract optional uploadedBy from Authorization header or query
      const uploadedBy =
        (req.headers['x-user-id'] as string | undefined) ??
        (req.query.uploadedBy as string | undefined) ??
        null;

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
